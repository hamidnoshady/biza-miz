import { NextResponse } from "next/server";
import { requirePermissions, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { deactivateSizePack, getSizePack, saveSizePack } from "@/lib/fashion-size-pack-service";
import { packBody, sizePackFailure, sizePackScope, uuid } from "@/lib/fashion-size-pack-http";

type Context = { params: Promise<{ id: string }> };

/** GH #1567 6C — one size pack. Editing bumps its version; sold packs keep their snapshot. */
export const GET = withTenantScope(async (_request: Request, context: Context) => {
  const scope = await sizePackScope(await requirePermissions(PERMISSIONS.inventoryView));
  if (scope.error) return scope.error;
  const id = uuid.safeParse((await context.params).id);
  if (!id.success) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  try {
    return NextResponse.json({ pack: await getSizePack(scope.actor, scope.locationId, id.data) });
  } catch (error) {
    return sizePackFailure(error);
  }
});

export const PUT = withTenantScope(async (request: Request, context: Context) => {
  const scope = await sizePackScope(await requirePermissions(PERMISSIONS.inventoryAdjust));
  if (scope.error) return scope.error;
  const id = uuid.safeParse((await context.params).id);
  const body = packBody.safeParse(await request.json().catch(() => null));
  if (!id.success || !body.success) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  try {
    return NextResponse.json({ pack: await saveSizePack(scope.actor, scope.locationId, body.data, id.data) });
  } catch (error) {
    return sizePackFailure(error);
  }
});

export const DELETE = withTenantScope(async (_request: Request, context: Context) => {
  const scope = await sizePackScope(await requirePermissions(PERMISSIONS.inventoryAdjust));
  if (scope.error) return scope.error;
  const id = uuid.safeParse((await context.params).id);
  if (!id.success) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  try {
    return NextResponse.json({ pack: await deactivateSizePack(scope.actor, scope.locationId, id.data) });
  } catch (error) {
    return sizePackFailure(error);
  }
});
