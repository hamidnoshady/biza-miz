import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { wooClientFor } from "@/lib/integrations/connections-service";
import { getAccessibleConnection } from "@/lib/integrations/connection-access";
import { query } from "@/lib/db";
import { writeIntegrationAudit } from "@/lib/integrations/audit";
import { pluginSupportsJobType } from "@/lib/integrations/plugin-capabilities";
import {
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

  if (connection.link_mode === "plugin") {
    // Same stranded-job rule as the media route: the lease query filters by
    // the plugin's advertised job types, so queueing `post_upsert` past an
    // older plugin would leave a row nothing ever picks up. Refuse honestly.
    if (!pluginSupportsJobType(connection.plugin_capabilities, "post_upsert")) {
      return NextResponse.json({ error: "plugin_content_unsupported" }, { status: 409 });
    }
    const outboxRemoteId = remoteId ?? `new-${randomUUID()}`;
    const operationId = remoteId ? null : `wp-post:${connectionId}:${outboxRemoteId}`;
    const jobPayload = { ...patch, post_type: postType, ...(remoteId ? { id: remoteId } : {}), ...(operationId ? { __operationId: operationId } : {}) };
    await query(
      `INSERT INTO integration_outbox_events (business_id, connection_id, entity_type, remote_id, payload, operation_id)
       VALUES ($1, $2, 'post_upsert', $3, $4::jsonb, $5)
       ON CONFLICT (connection_id, entity_type, remote_id)
       DO UPDATE SET payload = EXCLUDED.payload, operation_id = COALESCE(integration_outbox_events.operation_id, EXCLUDED.operation_id), status = 'pending', attempts = 0,
                     next_attempt_at = now(), last_error = NULL, leased_until = NULL, updated_at = now()`,
      [session.businessId, connectionId, outboxRemoteId, JSON.stringify(jobPayload), operationId],
    );
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
    const client = wooClientFor(connection);
    const wpEndpoint = postType === "page" ? "pages" : "posts";
    const result = await client.wpUpsertPost(wpEndpoint, patch, numericRemoteId);
    const savedId = String(result.id ?? numericRemoteId ?? "");
    if (!/^[1-9]\d*$/.test(savedId)) throw new Error("invalid_wordpress_response");
    const resultPayload = {
      ...result,
      type: typeof result.type === "string" ? result.type : postType,
      id: savedId,
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
