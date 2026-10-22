import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { query } from "@/lib/db";
import { PERMISSIONS } from "@/lib/permissions";
import { wooClientFor } from "@/lib/integrations/connections-service";
import { getAccessibleConnection } from "@/lib/integrations/connection-access";
import {
  countWpContent,
  enqueueContentExport,
  listWpContent,
  syncWpContentRest,
} from "@/lib/integrations/wp-content-service";
import { isWpMediaKind, type WpMediaKind } from "@/lib/integrations/wp-media";

function cursorTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^[1-9]\d{3}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3,6}Z$/.test(value) || !Number.isFinite(Date.parse(value))) return false;
  return new Date(value).toISOString() === `${value.slice(0, 23)}Z`;
}

/**
 * WordPress content (posts/pages/media) mirrored for one connection.
 *
 * GET reads the local mirror — identical for both link modes. POST is
 * «همگام‌سازی محتوا»: in plugin mode it queues a `content_export` job the
 * plugin applies on its next pull (the app has no store credentials there);
 * in REST mode it reads wp/v2 directly with the WooCommerce consumer keys.
 */
export const GET = withTenantScope(async (request: Request) => {
  const { session, error } = await requirePermission(PERMISSIONS.woocommerceView);
  if (error) return error;

  const url = new URL(request.url);
  const connectionId = url.searchParams.get("connectionId");
  const type = url.searchParams.get("type");
  const search = (url.searchParams.get("search") ?? "").trim().slice(0, 200);
  const kindParam = url.searchParams.get("kind");
  if (!connectionId) return NextResponse.json({ error: "missing_connection" }, { status: 400 });
  if (type && !["post", "page", "attachment"].includes(type)) {
    return NextResponse.json({ error: "invalid_content_type" }, { status: 400 });
  }
  if (kindParam && !isWpMediaKind(kindParam)) {
    return NextResponse.json({ error: "invalid_media_kind" }, { status: 400 });
  }

  const connection = await getAccessibleConnection(session, connectionId);
  if (!connection || connection.provider !== "woocommerce") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // The post/page editor uses page/pageSize while the media library uses
  // limit/offset for incremental “load more”. Supporting both here keeps one
  // mirror endpoint without making either screen translate its UI model.
  const parsedPage = Number.parseInt(url.searchParams.get("page") ?? "1", 10);
  const parsedPageSize = Number.parseInt(url.searchParams.get("pageSize") ?? "20", 10);
  const page = Math.min(2001, Math.max(1, Number.isFinite(parsedPage) ? parsedPage : 1));
  const pageSize = Math.min(50, Math.max(10, Number.isFinite(parsedPageSize) ? parsedPageSize : 20));
  const parsedLimit = Number.parseInt(url.searchParams.get("limit") ?? String(pageSize), 10);
  const parsedOffset = Number.parseInt(url.searchParams.get("offset") ?? String((page - 1) * pageSize), 10);
  const limit = Math.min(199, Math.max(1, Number.isFinite(parsedLimit) ? parsedLimit : pageSize));
  const offset = Math.min(1_000_000, Math.max(0, Number.isFinite(parsedOffset) ? parsedOffset : 0));
  const mediaKind = kindParam && kindParam !== "all"
    ? kindParam as Exclude<WpMediaKind, "all">
    : undefined;
  const filters = {
    wpType: type ?? undefined,
    search: search || undefined,
    mediaKind,
  } as const;
  if (type === "attachment" && url.searchParams.get("cursorMode") === "1") {
    let position: { asOf: string; after?: { createdAt: string; id: string }; scope: string };
    const scope = JSON.stringify([connectionId, search, mediaKind ?? null]);
    try {
      const raw = url.searchParams.get("cursor");
      if (raw && raw.length > 2000) throw new Error("invalid_cursor");
      position = raw ? JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) : { asOf: new Date().toISOString(), scope };
      if (position.scope !== scope || !cursorTimestamp(position.asOf) || (position.after && (!cursorTimestamp(position.after.createdAt) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(position.after.id)))) throw new Error("invalid_cursor");
    } catch { return NextResponse.json({ error: "invalid_cursor" }, { status: 400 }); }
    const pageRows = await listWpContent(session.businessId, connectionId, { ...filters, limit: Math.min(limit + 1, 200), asOf: position.asOf, after: position.after });
    const hasMore = pageRows.length > limit;
    const rows = pageRows.slice(0, limit);
    const after = rows.at(-1)?.pagePosition;
    const nextCursor = hasMore && after ? Buffer.from(JSON.stringify({ ...position, after })).toString("base64url") : null;
    const total = await countWpContent(session.businessId, connectionId, filters);
    const { rows: stamps } = await query<{ last_media_sync_at: string | null }>(`SELECT last_media_sync_at FROM integration_connections WHERE business_id = $1 AND id = $2`, [session.businessId, connectionId]);
    return NextResponse.json({ rows, total, nextCursor, syncedAt: stamps[0]?.last_media_sync_at ?? null });
  }
  const [rows, total] = await Promise.all([
    listWpContent(session.businessId, connectionId, { ...filters, limit, offset }),
    countWpContent(session.businessId, connectionId, filters),
  ]);
  return NextResponse.json({ rows, total, page, pageSize, limit, offset, syncedAt: connection.last_content_sync_at });
});

export const POST = withTenantScope(async (request: Request) => {
  const { session, error } = await requirePermission(PERMISSIONS.woocommerceManage);
  if (error) return error;

  let body: { connectionId?: string; action?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!body.connectionId) return NextResponse.json({ error: "missing_connection" }, { status: 400 });
  const connection = await getAccessibleConnection(session, body.connectionId);
  if (!connection || connection.provider !== "woocommerce") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (connection.status === "paused") {
    return NextResponse.json({ error: "connection_paused" }, { status: 409 });
  }

  if (connection.link_mode === "plugin") {
    await enqueueContentExport(session.businessId, body.connectionId);
    return NextResponse.json({ ok: true, queued: true });
  }

  try {
    const client = wooClientFor(connection);
    const outcome = await syncWpContentRest(connection, client);
    return NextResponse.json({ ok: true, ...outcome });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 502 });
  }
});
