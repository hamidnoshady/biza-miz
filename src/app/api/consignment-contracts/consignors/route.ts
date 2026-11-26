import { NextResponse } from "next/server";
import { requirePermissions, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { createConsignorRecord, listConsignors } from "@/lib/fashion-consignment-service";
import { consignmentFailure, consignmentScope, consignorBody } from "@/lib/fashion-consignment-http";

/** GH #1567 6D — the goods owners (تأمین‌کنندگان امانی) a fashion shop holds stock for. */
export const GET = withTenantScope(async () => {
  const scope = await consignmentScope(await requirePermissions(PERMISSIONS.inventoryView));
  if (scope.error) return scope.error;
  try {
    return NextResponse.json({ consignors: await listConsignors(scope.actor) });
  } catch (error) {
    return consignmentFailure(error);
  }
});

export const POST = withTenantScope(async (request: Request) => {
  const scope = await consignmentScope(await requirePermissions(PERMISSIONS.inventoryAdjust));
  if (scope.error) return scope.error;
  const body = consignorBody.safeParse(await request.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  try {
    return NextResponse.json({ consignor: await createConsignorRecord(scope.actor, scope.locationId, body.data) }, { status: 201 });
  } catch (error) {
    return consignmentFailure(error);
  }
});
