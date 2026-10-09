import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { commissionErrorResponse, csvResponse, exportStamp } from "@/lib/commission-settlement-http";
import { parseRunLinesQuery } from "@/lib/commission-settlement-input";
import { runLinesToCsv } from "@/lib/commission-settlement-csv";
import { exportCommissionRunLines, listCommissionRunLines } from "@/lib/commission-settlement-service";
import { resolveBusinessMoneyUnit } from "@/lib/ai-money-unit";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * A run's lines — the source sales behind each member's amount, newest rules
 * and all. `?employeeId=` narrows to one member; `?limit=`, `?offset=`; and
 * `?format=csv` exports the same selection (Shamsi dates, business unit).
 * Gated on `commission.view`.
 */
export const GET = withTenantScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.commissionView);
  if (error) return error;

  const { id } = await ctx.params;
  try {
    const options = parseRunLinesQuery(request.nextUrl.searchParams);
    if (options.format === "csv") {
      const unit = await resolveBusinessMoneyUnit(session.businessId);
      const rows = await exportCommissionRunLines(session.businessId, id, options.employeeId);
      return csvResponse(runLinesToCsv(rows, unit), `ردیف‌های-تسویه-پورسانت-${exportStamp()}.csv`);
    }
    return NextResponse.json(await listCommissionRunLines(session.businessId, id, options));
  } catch (err) {
    const response = commissionErrorResponse(err);
    if (response) return response;
    throw err;
  }
});
