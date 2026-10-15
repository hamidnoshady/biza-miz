import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { commissionErrorResponse, csvResponse, exportStamp } from "@/lib/commission-settlement-http";
import { parseEmployeeParam, parseStatementQuery } from "@/lib/commission-settlement-input";
import { getCommissionStatement } from "@/lib/commission-settlement-service";

import { statementToCsv } from "@/lib/commission-settlement-csv";
import { resolveBusinessMoneyUnit } from "@/lib/ai-money-unit";

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
    const options = parseStatementQuery(request.nextUrl.searchParams);
    const statement = await getCommissionStatement(session.businessId, employeeId, options);
    if (options.format === "csv") {
      const unit = await resolveBusinessMoneyUnit(session.businessId);
      return csvResponse(statementToCsv(statement, unit), `صورت‌حساب-پورسانت-${exportStamp()}.csv`);
    }
    return NextResponse.json(statement);
  } catch (err) {
    const response = commissionErrorResponse(err);
    if (response) return response;
    throw err;
  }
});
