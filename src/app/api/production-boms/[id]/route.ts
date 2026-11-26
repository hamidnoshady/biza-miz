import { NextResponse } from "next/server";
import { requirePermissions, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { deactivateBom, saveBom } from "@/lib/fashion-production-service";
import { bomBody, productionFailure, productionScope, uuid } from "@/lib/fashion-production-http";

type Context = { params: Promise<{ id: string }> };

/** GH #1567 6B — replace a BOM (orders already created keep their own snapshot). */
export const PUT = withTenantScope(async (request: Request, context: Context) => {
  const scope = await productionScope(await requirePermissions(PERMISSIONS.inventoryAdjust));
  if (scope.error) return scope.error;
  const id = uuid.safeParse((await context.params).id);
  const body = bomBody.safeParse(await request.json().catch(() => null));
  if (!id.success || !body.success) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  try {
    return NextResponse.json(await saveBom(scope.actor, scope.locationId, body.data, id.data));
  } catch (error) {
    return productionFailure(error);
  }
});

export const DELETE = withTenantScope(async (_request: Request, context: Context) => {
  const scope = await productionScope(await requirePermissions(PERMISSIONS.inventoryAdjust));
  if (scope.error) return scope.error;
  const id = uuid.safeParse((await context.params).id);
  if (!id.success) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  try {
    return NextResponse.json(await deactivateBom(scope.actor, scope.locationId, id.data));
  } catch (error) {
    return productionFailure(error);
  }
});
