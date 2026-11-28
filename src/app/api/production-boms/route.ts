import { NextResponse } from "next/server";
import { requirePermissions, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { listBoms, saveBom } from "@/lib/fashion-production-service";
import { bomBody, productionFailure, productionScope } from "@/lib/fashion-production-http";

/** GH #1567 6B — the branch's bills of materials for fashion production. */
export const GET = withTenantScope(async () => {
  const scope = await productionScope(await requirePermissions(PERMISSIONS.inventoryView));
  if (scope.error) return scope.error;
  try {
    return NextResponse.json({ boms: await listBoms(scope.actor, scope.locationId) });
  } catch (error) {
    return productionFailure(error);
  }
});

export const POST = withTenantScope(async (request: Request) => {
  const scope = await productionScope(await requirePermissions(PERMISSIONS.inventoryAdjust));
  if (scope.error) return scope.error;
  const body = bomBody.safeParse(await request.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  try {
    return NextResponse.json(await saveBom(scope.actor, scope.locationId, body.data), { status: 201 });
  } catch (error) {
    return productionFailure(error);
  }
});
