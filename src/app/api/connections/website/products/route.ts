import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { query } from "@/lib/db";
import { isUuid } from "@/lib/menu-validation";
import { WebsiteAdapterError } from "@/lib/website/adapter";
import { getWebsiteConnectionRow, listWebsiteConnectionRows, WebsiteNotConnectedError } from "@/lib/website/connection-service";
import { listWebsiteCatalog } from "@/lib/website/catalog-service";
import { setProductSync } from "@/lib/website/sync-service";

function connectionIdFrom(value: unknown): string | null | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return typeof value === "string" && isUuid(value) ? value : null;
}

/** Every local product with its sync mark for one selected connection. */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.cmsView);
  if (error) return error;

  const connectionId = connectionIdFrom(request.nextUrl.searchParams.get("connectionId"));
  if (connectionId === null) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const connection = connectionId
    ? await getWebsiteConnectionRow(session.businessId, connectionId)
    : (await listWebsiteConnectionRows(session.businessId, true))[0] ?? null;
  if (connectionId && (!connection || connection.status !== "active")) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const requested = request.nextUrl.searchParams.get("locationId");
  if (requested && !isUuid(requested)) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  let locationId = connection?.sync_location_id ?? null;
  if (requested) {
    const owned = await query(`SELECT 1 FROM locations WHERE id = $1 AND business_id = $2`, [requested, session.businessId]);
    if (!owned.rowCount) return NextResponse.json({ error: "location_mismatch" }, { status: 403 });
    if (connection?.sync_location_id && requested !== connection.sync_location_id) {
      return NextResponse.json({ error: "location_mismatch" }, { status: 403 });
    }
    locationId = requested;
  }
  if (!locationId) {
    const { rows } = await query<{ id: string }>(
      `SELECT id FROM locations WHERE business_id = $1 AND is_active ORDER BY created_at, id LIMIT 1`,
      [session.businessId],
    );
    locationId = rows[0]?.id ?? null;
  }
  if (!locationId) return NextResponse.json({ products: [], locationId: null, connectionId: connection?.id ?? null });
  const products = await listWebsiteCatalog(session.businessId, locationId, connection?.id);
  return NextResponse.json({ products, locationId, connectionId: connection?.id ?? null });
});

interface MarkBody {
  localKind?: unknown;
  localId?: unknown;
  enabled?: unknown;
  connectionId?: unknown;
}

/** Explicit per-site publication opt-in/out. Opting out queues a withdrawal. */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.cmsConfigure);
  if (error) return error;

  let body: MarkBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const localKind = body.localKind === "item" || body.localKind === "menu_item" ? body.localKind : null;
  const localId = typeof body.localId === "string" && isUuid(body.localId) ? body.localId : null;
  const connectionId = connectionIdFrom(body.connectionId);
  if (!localKind || !localId || typeof body.enabled !== "boolean" || connectionId === null) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  try {
    // The service records the mark and its durable upsert/withdrawal together
    // with the connection identity; a disabled item is never left purchasable.
    await setProductSync(session.businessId, localKind, localId, body.enabled, connectionId);
  } catch (err) {
    if (err instanceof WebsiteNotConnectedError) return NextResponse.json({ error: "not_connected" }, { status: 409 });
    if (err instanceof WebsiteAdapterError && err.code === "not_found") return NextResponse.json({ error: "not_found" }, { status: 404 });
    throw err;
  }
  return NextResponse.json({ ok: true });
});
