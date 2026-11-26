import { NextResponse } from "next/server";
import { requirePermissions, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { listSizePackSales } from "@/lib/fashion-size-pack-service";
import { sizePackFailure, sizePackScope, uuid } from "@/lib/fashion-size-pack-http";

/** GH #1567 6C — sold packs with per-variant returned quantities (snapshot, never recomputed). */
export const GET = withTenantScope(async (request: Request) => {
  const scope = await sizePackScope(await requirePermissions(PERMISSIONS.inventoryView));
  if (scope.error) return scope.error;
  const raw = new URL(request.url).searchParams.get("orderId");
  const orderId = raw ? uuid.safeParse(raw) : null;
  if (orderId && !orderId.success) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  try {
    return NextResponse.json({ sales: await listSizePackSales(scope.actor, scope.locationId, { orderId: orderId?.data }) });
  } catch (error) {
    return sizePackFailure(error);
  }
});
