import { NextResponse } from "next/server";
import { requirePermissions, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import {
  listSizePackSales,
  listSizePacks,
  listStyles,
  lookupSizePackByBarcode,
  saveSizePack,
  styleMatrix,
} from "@/lib/fashion-size-pack-service";
import { packBody, sizePackFailure, sizePackScope, uuid } from "@/lib/fashion-size-pack-http";

const VIEWS = new Set(["lookup", "styles", "matrix", "sales"]);

/**
 * GH #1567 6C — size packs. One read route with views on purpose (each route
 * adds ~0.15 MiB to the desktop runtime, which sits at its size gate):
 *
 * - `GET [?active=1]` — the branch's packs, availability derived from the variants.
 * - `GET ?view=lookup&code=` — the till's scan fallback: an active pack by its
 *   barcode, or null. Needs `orders.create` (a cashier), not `inventory.view`.
 * - `GET ?view=styles` — the pack builder's styles for the branch.
 * - `GET ?view=matrix&styleId=` — that style's size × colour variants with stock and price.
 * - `GET ?view=sales[&orderId=]` — sold packs with per-variant returned
 *   quantities (snapshot, never recomputed).
 */
export const GET = withTenantScope(async (request: Request) => {
  const params = new URL(request.url).searchParams;
  const view = params.get("view");
  if (view !== null && !VIEWS.has(view)) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const scope = await sizePackScope(view === "lookup"
    ? await requirePermissions(PERMISSIONS.ordersCreate)
    : await requirePermissions(PERMISSIONS.inventoryView));
  if (scope.error) return scope.error;
  try {
    if (view === "lookup") {
      const code = params.get("code")?.trim() ?? "";
      if (code.length < 1 || code.length > 64) return NextResponse.json({ error: "bad_request" }, { status: 400 });
      return NextResponse.json({ pack: await lookupSizePackByBarcode(scope.actor, scope.locationId, code) });
    }
    if (view === "styles") {
      return NextResponse.json({ styles: await listStyles(scope.actor, scope.locationId) });
    }
    if (view === "matrix") {
      const styleId = uuid.safeParse(params.get("styleId"));
      if (!styleId.success) return NextResponse.json({ error: "bad_request" }, { status: 400 });
      return NextResponse.json(await styleMatrix(scope.actor, scope.locationId, styleId.data));
    }
    if (view === "sales") {
      const raw = params.get("orderId");
      const orderId = raw ? uuid.safeParse(raw) : null;
      if (orderId && !orderId.success) return NextResponse.json({ error: "bad_request" }, { status: 400 });
      return NextResponse.json({ sales: await listSizePackSales(scope.actor, scope.locationId, { orderId: orderId?.data }) });
    }
    const activeOnly = params.get("active") === "1";
    return NextResponse.json({ packs: await listSizePacks(scope.actor, scope.locationId, { activeOnly }) });
  } catch (error) {
    return sizePackFailure(error);
  }
});

export const POST = withTenantScope(async (request: Request) => {
  const scope = await sizePackScope(await requirePermissions(PERMISSIONS.inventoryAdjust));
  if (scope.error) return scope.error;
  const body = packBody.safeParse(await request.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  try {
    return NextResponse.json({ pack: await saveSizePack(scope.actor, scope.locationId, body.data) }, { status: 201 });
  } catch (error) {
    return sizePackFailure(error);
  }
});
