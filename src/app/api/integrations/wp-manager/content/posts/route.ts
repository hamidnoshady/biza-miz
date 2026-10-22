import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { wooClientFor } from "@/lib/integrations/connections-service";
import { getAccessibleConnection } from "@/lib/integrations/connection-access";
import { writeIntegrationAudit } from "@/lib/integrations/audit";
import {
  enqueueWpPostUpsert,
  findWpContentCreateRequest,
  getWpContent,
  upsertWpContent,
  type WpContentPayload,
} from "@/lib/integrations/wp-content-service";

/**
 * Read one post/page with its raw editor fields. The collection endpoint never
 * returns every body: a site with a hundred long pages must not download all
 * of that HTML merely to draw twenty titles.
 */
export const GET = withTenantScope(async (request: Request) => {
  const { session, error } = await requirePermission(PERMISSIONS.woocommerceView);
  if (error) return error;

  const url = new URL(request.url);
  const connectionId = url.searchParams.get("connectionId") ?? "";
  const postType = url.searchParams.get("type");
  const remoteId = url.searchParams.get("id") ?? "";
  if (!connectionId) return NextResponse.json({ error: "missing_connection" }, { status: 400 });
  if (postType !== "post" && postType !== "page") {
    return NextResponse.json({ error: "invalid_content_type" }, { status: 400 });
  }
  if (!/^[1-9]\d*$/.test(remoteId)) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  const connection = await getAccessibleConnection(session, connectionId);
  if (!connection || connection.provider !== "woocommerce") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const row = await getWpContent(session.businessId, connectionId, postType, remoteId);
  if (!row) return NextResponse.json({ error: "post_not_found" }, { status: 404 });
  return NextResponse.json({ row });
});

/**
 * Create or update a WordPress post/page.
 *
 * Plugin mode: a `post_upsert` outbox row the plugin applies on its next
 * pull — the app cannot reach WordPress there, and the job carries the same
 * retry/backoff/dead-letter trail as every other push. REST mode: the app
 * writes wp/v2 directly with the store's credentials and immediately mirrors
 * the response so the list cannot remain stale after a successful save.
 *
 * The field list is closed: a raw object written to a live site is a typo away
 * from a site-wide mistake. Routing fields (`id`, `post_type`) are deliberately
 * kept out of the wp/v2 body; core accepts content fields only.
 */
const CONTENT_FIELDS = ["title", "content", "excerpt", "slug", "status"] as const;
const ALLOWED_STATUS = ["publish", "draft", "pending", "private", "future"] as const;
const FIELD_LIMITS: Partial<Record<(typeof CONTENT_FIELDS)[number], number>> = {
  title: 500,
  slug: 200,
  excerpt: 20_000,
  content: 1_500_000,
};

function contentTimestamp(raw: unknown, assumeUtc = false): number | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const text = raw.trim();
  const normalized = assumeUtc && !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text) ? `${text}Z` : text;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function remoteContentTimestamp(payload: Record<string, unknown>): number | null {
  return contentTimestamp(payload.modified_gmt, true) ?? contentTimestamp(payload.modified);
}

export const POST = withTenantScope(async (request: Request) => {
  const { session, error } = await requirePermission(PERMISSIONS.woocommerceManage);
  if (error) return error;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const connectionId = typeof body.connectionId === "string" ? body.connectionId : "";
  if (!connectionId) return NextResponse.json({ error: "missing_connection" }, { status: 400 });
  if (body.post_type !== "post" && body.post_type !== "page") {
    return NextResponse.json({ error: "invalid_content_type" }, { status: 400 });
  }
  const postType = body.post_type;
  const remoteId = body.id === undefined ? undefined : String(body.id).trim();
  const numericRemoteId = remoteId === undefined ? undefined : Number(remoteId);
  const expectedRemoteUpdatedAt = body.expectedRemoteUpdatedAt === undefined
    ? null
    : typeof body.expectedRemoteUpdatedAt === "string" && Number.isFinite(Date.parse(body.expectedRemoteUpdatedAt))
      ? new Date(body.expectedRemoteUpdatedAt).toISOString()
      : "invalid";
  if (expectedRemoteUpdatedAt === "invalid") {
    return NextResponse.json({ error: "invalid_expected_version" }, { status: 400 });
  }
  if (remoteId && expectedRemoteUpdatedAt === null) {
    return NextResponse.json({ error: "expected_content_version_required" }, { status: 428 });
  }
  if (
    remoteId !== undefined &&
    (!/^[1-9]\d*$/.test(remoteId) || !Number.isSafeInteger(numericRemoteId) || numericRemoteId! <= 0)
  ) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  const patch: Record<string, string> = {};
  for (const field of CONTENT_FIELDS) {
    if (body[field] === undefined) continue;
    if (typeof body[field] !== "string") {
      return NextResponse.json({ error: "invalid_field" }, { status: 400 });
    }
    const value = body[field];
    const limit = FIELD_LIMITS[field];
    if (limit && value.length > limit) {
      return NextResponse.json({ error: `${field}_too_long` }, { status: 400 });
    }
    patch[field] = value;
  }
  if (patch.status && !ALLOWED_STATUS.includes(patch.status as (typeof ALLOWED_STATUS)[number])) {
    return NextResponse.json({ error: "invalid_status" }, { status: 400 });
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "empty_patch" }, { status: 400 });
  }
  if (!remoteId && !patch.title?.trim()) {
    return NextResponse.json({ error: "title_required" }, { status: 400 });
  }
  if (patch.title !== undefined && !patch.title.trim()) {
    return NextResponse.json({ error: "title_required" }, { status: 400 });
  }

  const connection = await getAccessibleConnection(session, connectionId);
  if (!connection || connection.provider !== "woocommerce") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (connection.status === "paused") {
    return NextResponse.json({ error: "connection_paused" }, { status: 409 });
  }
  const requestId = typeof body.requestId === "string" ? body.requestId.toLowerCase() : "";
  if (!remoteId && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(requestId)) {
    return NextResponse.json({ error: "missing_or_invalid_create_request_id" }, { status: 400 });
  }

  if (connection.link_mode === "plugin") {
    if (remoteId && expectedRemoteUpdatedAt) {
      const mirrored = await getWpContent(session.businessId, connectionId, postType, remoteId);
      if (!mirrored || !mirrored.remoteUpdatedAt || Date.parse(mirrored.remoteUpdatedAt) !== Date.parse(expectedRemoteUpdatedAt)) {
        return NextResponse.json({ error: "content_version_changed", refreshRequired: true }, { status: 409 });
      }
    }
    const queueOutcome = await enqueueWpPostUpsert(connection, postType, remoteId, remoteId ? undefined : requestId, patch);
    if (queueOutcome === "unsupported") {
      return NextResponse.json({ error: "plugin_content_unsupported" }, { status: 409 });
    }
    if (queueOutcome === "in_flight") {
      return NextResponse.json({ error: "content_edit_in_flight_retry" }, { status: 409 });
    }
    if (queueOutcome === "already_applied") {
      return NextResponse.json({ ok: true, queued: false, alreadyApplied: true });
    }
    const outboxRemoteId = remoteId ?? `new-${requestId}`;
    await writeIntegrationAudit({
      businessId: session.businessId,
      connectionId,
      action: "content.post_upsert_queued",
      entityType: "post_upsert",
      remoteId: outboxRemoteId,
    });
    return NextResponse.json({ ok: true, queued: true });
  }

  try {
    if (!remoteId) {
      const existingId = await findWpContentCreateRequest(session.businessId, connectionId, postType, requestId);
      if (existingId) return NextResponse.json({ ok: true, queued: false, alreadyApplied: true, remoteId: existingId });
    }
    const client = wooClientFor(connection);
    const wpEndpoint = postType === "page" ? "pages" : "posts";
    if (remoteId && expectedRemoteUpdatedAt) {
      const current = await client.wpGetPost(wpEndpoint, numericRemoteId!);
      const actualVersion = remoteContentTimestamp(current);
      if (actualVersion === null || actualVersion !== Date.parse(expectedRemoteUpdatedAt)) {
        await upsertWpContent(connection, {
          ...current,
          id: remoteId,
          type: postType,
        } as WpContentPayload);
        return NextResponse.json({ error: "content_version_changed", refreshRequired: true }, { status: 409 });
      }
    }
    const result = await client.wpUpsertPost(wpEndpoint, patch, numericRemoteId);
    const savedId = String(result.id ?? numericRemoteId ?? "");
    if (!/^[1-9]\d*$/.test(savedId)) throw new Error("invalid_wordpress_response");
    const resultPayload = {
      ...result,
      type: typeof result.type === "string" ? result.type : postType,
      id: savedId,
      ...(!remoteId ? { _create_request_id: requestId } : {}),
    } as WpContentPayload;
    await upsertWpContent(connection, resultPayload);
    await writeIntegrationAudit({
      businessId: session.businessId,
      connectionId,
      action: "content.post_saved",
      entityType: postType,
      remoteId: savedId,
    });
    return NextResponse.json({ ok: true, queued: false, remoteId: savedId });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 502 });
  }
});
