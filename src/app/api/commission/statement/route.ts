import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { commissionErrorResponse } from "@/lib/commission-settlement-http";
import { parseEmployeeParam } from "@/lib/commission-settlement-input";
import { getCommissionStatement } from "@/lib/commission-settlement-service";

/**
 * One member's commission statement: what has accrued to them, what was settled through payroll and through
 * settlement runs, what is still unpaid, and the runs and payouts that touched them. `?employeeId=` is required.
 * Gated on `commission.view`.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.commissionView);
  if (error) return error;

  try {
    const employeeId = parseEmployeeParam(request.nextUrl.searchParams);
    return NextResponse.json(await getCommissionStatement(session.businessId, employeeId));
  } catch (err) {
    const response = commissionErrorResponse(err);
    if (response) return response;
    throw err;
  }
});
