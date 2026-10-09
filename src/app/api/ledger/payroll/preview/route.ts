import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getPayrollLiability, previewCommission } from "@/lib/payroll-service";
import { listPaymentAccounts } from "@/lib/payroll-accounts";
import { badRequest, payrollErrorResponse } from "@/lib/payroll-http";

/**
 * What the payroll screen needs from the database to act on, in one read —
 * gated on `payroll.view`:
 *
 *   - `commission` — exactly the commission an accrual for `?periodKey=`
 *     (`YYYY-MM`, optional) dated `?accrualDate=` (default as the accrual
 *     defaults it) would settle, per person. Built by the same code that claims
 *     it, so the screen cannot show a number the ledger will not;
 *     `?includeCommission=false` previews a wage-only run. (The wage side — gross
 *     to net — is the pure calculator the screen runs over the saved terms.)
 *   - `liability` — the salaries-payable (۲۳۰۰) tie-out: the ledger balance next
 *     to the runs awaiting payment and the commission no run has settled, with
 *     whatever is left unexplained.
 *   - `paymentAccounts` — the cash, bank and petty-cash accounts a payment or an
 *     advance may leave.
 *
 * All amounts are integer Rial as text.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.payrollView);
  if (error) return error;

  const params = request.nextUrl.searchParams;
  const includeCommissionParam = params.get("includeCommission");
  if (includeCommissionParam !== null && includeCommissionParam !== "true" && includeCommissionParam !== "false") {
    return badRequest();
  }

  try {
    const [commission, liability, paymentAccounts] = await Promise.all([
      previewCommission(session.businessId, {
        periodKey: params.get("periodKey"),
        accrualDate: params.get("accrualDate"),
        includeCommission: includeCommissionParam !== "false",
      }),
      getPayrollLiability(session.businessId),
      listPaymentAccounts(session.businessId),
    ]);
    return NextResponse.json({ commission, liability, paymentAccounts });
  } catch (err) {
    const response = payrollErrorResponse(err);
    if (response) return response;
    throw err;
  }
});
