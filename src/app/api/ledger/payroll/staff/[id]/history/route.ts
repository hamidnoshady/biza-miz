import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { listPayTermChanges } from "@/lib/payroll-service";
import { parsePayTermHistoryQuery } from "@/lib/payroll-history-query";
import { payrollErrorResponse } from "@/lib/payroll-http";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * One member's pay-term history — which term (wage, an allowance, the fixed
 * deduction), its previous amount, its new amount, who changed it, when, and
 * why — newest first (`?limit=&cursor=`). The history is compensation data: it
 * needs `payroll.view`, so a role without that capability (the manager preset,
 * for one) cannot read it any more than it can read the wages. Amounts are
 * integer Rial as text.
 */
export const GET = withTenantScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.payrollView);
  if (error) return error;

  const { id } = await ctx.params;
  try {
    const { limit, cursor } = parsePayTermHistoryQuery(request.nextUrl.searchParams);
    return NextResponse.json(await listPayTermChanges(session.businessId, id, { limit, cursor }));
  } catch (err) {
    const response = payrollErrorResponse(err);
    if (response) return response;
    throw err;
  }
});
