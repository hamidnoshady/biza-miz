import { NextResponse } from "next/server";
import { requirePermissions, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { lookupSizePackByBarcode } from "@/lib/fashion-size-pack-service";
import { sizePackFailure, sizePackScope } from "@/lib/fashion-size-pack-http";

/** GH #1567 6C — the till's scan fallback: an active pack by its barcode, or null. */
export const GET = withTenantScope(async (request: Request) => {
  const scope = await sizePackScope(await requirePermissions(PERMISSIONS.ordersCreate));
  if (scope.error) return scope.error;
  const code = new URL(request.url).searchParams.get("code")?.trim() ?? "";
  if (code.length < 1 || code.length > 64) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  try {
    return NextResponse.json({ pack: await lookupSizePackByBarcode(scope.actor, scope.locationId, code) });
  } catch (error) {
    return sizePackFailure(error);
  }
});
