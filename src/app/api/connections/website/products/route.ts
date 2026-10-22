import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { query } from "@/lib/db";
import { getWebsiteConnectionRow } from "@/lib/website/connection-service";
import { listWebsiteCatalog } from "@/lib/website/catalog-service";
import { enqueueWebsiteEvent, setProductSync } from "@/lib/website/sync-service";

async function locationFor(businessId: string, requested: string | null): Promise<string | null> {
  const row = await getWebsiteConnectionRow(businessId);
  if (requested) return requested;
  if (row?.sync_location_id) return row.sync_location_id;
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM locations WHERE business_id = $1 AND is_active ORDER BY created_at LIMIT 1`,
    [businessId],
  );
  return rows[0]?.id ?? null;
}

/** Every local product (menu items and retail items) with its sync mark. */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.cmsView);
  if (error) return error;

  const locationId = await locationFor(session.businessId, request.nextUrl.searchParams.get("locationId"));
  if (!locationId) return NextResponse.json({ products: [], locationId: null });
  const products = await listWebsiteCatalog(session.businessId, locationId);
  return NextResponse.json({ products, locationId });
});

interface MarkBody {
  localKind?: unknown;
  localId?: unknown;
  enabled?: unknown;
}

/**
 * The owner's mark. Marking a product queues its first `product.upsert` at
 * once; unmarking stops future pushes (the remote product stays — a site
 * product vanishing because a checkbox moved is the wrong surprise).
 */
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
  const localId = typeof body.localId === "string" && /^[0-9a-f-]{36}$/i.test(body.localId) ? body.localId : null;
  if (!localKind || !localId || typeof body.enabled !== "boolean") {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  await setProductSync(session.businessId, localKind, localId, body.enabled);
  // The owner's explicit mark re-arms even a dead row — it is the same
  // intention as pressing «تلاش مجدد».
  if (body.enabled) await enqueueWebsiteEvent(session.businessId, "product.upsert", localKind, localId, { force: true });
  return NextResponse.json({ ok: true });
});
