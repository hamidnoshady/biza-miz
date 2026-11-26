import { NextResponse } from "next/server";
import { requirePermissions, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { createContract, listContracts } from "@/lib/fashion-consignment-service";
import { consignmentFailure, consignmentScope, contractBody } from "@/lib/fashion-consignment-http";

/** GH #1567 6D — the branch's consignment (امانی) contracts with on-hand and the owner payable. */
export const GET = withTenantScope(async () => {
  const scope = await consignmentScope(await requirePermissions(PERMISSIONS.inventoryView));
  if (scope.error) return scope.error;
  try {
    return NextResponse.json({ contracts: await listContracts(scope.actor, scope.locationId) });
  } catch (error) {
    return consignmentFailure(error);
  }
});

export const POST = withTenantScope(async (request: Request) => {
  const scope = await consignmentScope(await requirePermissions(PERMISSIONS.inventoryAdjust));
  if (scope.error) return scope.error;
  const body = contractBody.safeParse(await request.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  try {
    return NextResponse.json({ contract: await createContract(scope.actor, scope.locationId, body.data) }, { status: 201 });
  } catch (error) {
    return consignmentFailure(error);
  }
});
