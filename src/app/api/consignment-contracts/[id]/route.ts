import { NextResponse } from "next/server";
import { requirePermissions, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import {
  closeContract,
  getContract,
  receiveConsignedGoods,
  returnGoodsToOwner,
  settleWithOwner,
} from "@/lib/fashion-consignment-service";
import { consignmentFailure, consignmentScope, contractActionBody, uuid } from "@/lib/fashion-consignment-http";

type Context = { params: Promise<{ id: string }> };

/** GH #1567 6D — one contract with its lines and movement history. */
export const GET = withTenantScope(async (_request: Request, context: Context) => {
  const scope = await consignmentScope(await requirePermissions(PERMISSIONS.inventoryView));
  if (scope.error) return scope.error;
  const id = uuid.safeParse((await context.params).id);
  if (!id.success) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  try {
    return NextResponse.json(await getContract(scope.actor, scope.locationId, id.data));
  } catch (error) {
    return consignmentFailure(error);
  }
});

/**
 * Receive from / hand back to the owner (quantity only), settle with the owner
 * (Dr 2110 / Cr cash or bank — so it also needs ledger.post), or close.
 */
export const POST = withTenantScope(async (request: Request, context: Context) => {
  const raw = await request.json().catch(() => null);
  const body = contractActionBody.safeParse(raw);
  const settling = body.success && body.data.action === "settle";
  const guard = settling
    ? await requirePermissions(PERMISSIONS.inventoryAdjust, PERMISSIONS.ledgerPost)
    : await requirePermissions(PERMISSIONS.inventoryAdjust);
  const scope = await consignmentScope(guard);
  if (scope.error) return scope.error;
  const id = uuid.safeParse((await context.params).id);
  if (!id.success || !body.success) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  try {
    const input = body.data;
    switch (input.action) {
      case "receive":
        return NextResponse.json({ contract: await receiveConsignedGoods(scope.actor, scope.locationId, id.data, input) });
      case "return_to_owner":
        return NextResponse.json({ contract: await returnGoodsToOwner(scope.actor, scope.locationId, id.data, input) });
      case "settle":
        return NextResponse.json({ contract: await settleWithOwner(scope.actor, scope.locationId, id.data, input) });
      case "close":
        return NextResponse.json({ contract: await closeContract(scope.actor, scope.locationId, id.data, input) });
    }
  } catch (error) {
    return consignmentFailure(error);
  }
});
