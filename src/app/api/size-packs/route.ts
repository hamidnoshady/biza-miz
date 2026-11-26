import { NextResponse } from "next/server";
import { requirePermissions, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { listSizePacks, saveSizePack } from "@/lib/fashion-size-pack-service";
import { packBody, sizePackFailure, sizePackScope } from "@/lib/fashion-size-pack-http";

/** GH #1567 6C — the branch's size packs, with availability derived from the variants. */
export const GET = withTenantScope(async (request: Request) => {
  const scope = await sizePackScope(await requirePermissions(PERMISSIONS.inventoryView));
  if (scope.error) return scope.error;
  const activeOnly = new URL(request.url).searchParams.get("active") === "1";
  try {
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
