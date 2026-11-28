/**
 * GH #1567 F3 — reverse an items-model NRV write-down after NRV recovered
 * (IAS 2): at most the write-down still attributable to units on hand, never
 * above the revised NRV. inventory.adjust + ledger.approve, `confirm`, reason.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermissions, withTenantScope } from "@/lib/auth";
import {
  itemWriteDownIndustryError,
  readWriteDownBody,
  withItemWriteDownClient,
} from "@/lib/item-write-down-http";
import { reverseItemWriteDown } from "@/lib/item-nrv-write-down-service";
import { PERMISSIONS } from "@/lib/permissions";

export const POST = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermissions(PERMISSIONS.inventoryAdjust, PERMISSIONS.ledgerApprove);
  if (error) return error;
  const industryError = await itemWriteDownIndustryError(session.businessId);
  if (industryError) return industryError;
  const { id } = await context.params;
  const body = await readWriteDownBody(request);
  if (!body) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  if (body.confirm !== true) return NextResponse.json({ error: "confirmation_required" }, { status: 400 });
  return withItemWriteDownClient(async (client) => {
    const result = await reverseItemWriteDown(client, {
      businessId: session.businessId,
      writeDownId: id,
      revisedNrvUnitValue:
        typeof body.revisedNrvUnitValue === "string" || typeof body.revisedNrvUnitValue === "number" ? body.revisedNrvUnitValue : "",
      reason: typeof body.reason === "string" ? body.reason : "",
      reversedBy: session.sub,
    });
    return NextResponse.json({ ok: true, ...result });
  }, { transaction: true });
});
