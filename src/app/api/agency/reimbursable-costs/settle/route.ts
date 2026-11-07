import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { resolveActiveLocation } from "@/lib/setup-state";
import { PERMISSIONS } from "@/lib/permissions";
import { settleAgencyVendorCosts } from "@/lib/agency-reimbursable-cost-service";
import { isVendorSettlementMethod } from "@/lib/agency-reimbursable-cost";
import { handleAgencyError } from "../../guard";
import { costActor, costErrorResponse, readCostBody } from "../../reimbursable-cost-guard";

/** Paying a liability is payable-management work, not expense-recording authority. */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.financePayablesManage);
  if (error) return error;
  const body = await readCostBody(request);
  if (!body || !Array.isArray(body.costIds) || !isVendorSettlementMethod(body.method) ||
      typeof body.paidOn !== "string" ||
      (body.locationId !== undefined && typeof body.locationId !== "string") ||
      (body.note !== undefined && typeof body.note !== "string")) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "location_required" }, { status: 409 });
  if (body.locationId && body.locationId !== location.id) {
    return NextResponse.json({ error: "location_required" }, { status: 409 });
  }
  try {
    const settlement = await settleAgencyVendorCosts(session.businessId, costActor(session), {
      costIds: body.costIds, method: body.method, paidOn: body.paidOn,
      locationId: location.id, note: body.note as string | undefined,
    });
    return NextResponse.json({ settlement }, { status: 201 });
  } catch (err) {
    return costErrorResponse(err) ?? handleAgencyError(err);
  }
});
