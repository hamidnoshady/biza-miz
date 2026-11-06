import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { reverseAgencyVendorSettlement } from "@/lib/agency-reimbursable-cost-service";
import { handleAgencyError } from "../../../guard";
import { costActor, costErrorResponse, readCostBody } from "../../../reimbursable-cost-guard";

export const POST = withTenantScope(async (
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) => {
  const { session, error } = await requirePermission(PERMISSIONS.financePayablesManage);
  if (error) return error;
  const body = await readCostBody(request);
  if (!body || typeof body.reversedOn !== "string") {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  try {
    const { id } = await context.params;
    const reversal = await reverseAgencyVendorSettlement(session.businessId, costActor(session), id, {
      reversedOn: body.reversedOn,
    });
    return NextResponse.json({ reversal });
  } catch (err) {
    return costErrorResponse(err) ?? handleAgencyError(err);
  }
});
