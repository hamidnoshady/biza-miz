import { NextResponse } from "next/server";
import { requirePermissions, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { listStyles, styleMatrix } from "@/lib/fashion-size-pack-service";
import { sizePackFailure, sizePackScope, uuid } from "@/lib/fashion-size-pack-http";

/**
 * GH #1567 6C — the pack builder's data: without `styleId`, the branch's styles;
 * with it, that style's size × colour variants with stock and price.
 */
export const GET = withTenantScope(async (request: Request) => {
  const scope = await sizePackScope(await requirePermissions(PERMISSIONS.inventoryView));
  if (scope.error) return scope.error;
  const raw = new URL(request.url).searchParams.get("styleId");
  if (!raw) {
    try {
      return NextResponse.json({ styles: await listStyles(scope.actor, scope.locationId) });
    } catch (error) {
      return sizePackFailure(error);
    }
  }
  const styleId = uuid.safeParse(raw);
  if (!styleId.success) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  try {
    return NextResponse.json(await styleMatrix(scope.actor, scope.locationId, styleId.data));
  } catch (error) {
    return sizePackFailure(error);
  }
});
