import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import {
  employeePayrollCard,
  employerCostReport,
  insuranceSummary,
  payrollLiabilityReconciliation,
  payrollPeriodSummaries,
  payrollRegister,
  payrollTaxSummary,
  periodComparison,
} from "@/lib/payroll-engine-runs";
import { resolvePayrollPeriodKey } from "@/lib/payroll-period";
import { badRequest, payrollErrorResponse } from "@/lib/payroll-http";

interface Ctx {
  params: Promise<{ report: string }>;
}

/**
 * Issue #865 payroll reports. `payroll.view`.
 *
 *   register?period=|runId=     payroll register
 *   employee-card?userId=&year= employee payroll card (Jalali year)
 *   insurance?period=           insurance summary
 *   tax?period=                 payroll tax summary
 *   employer-cost?period=       employer cost, with cost allocation
 *   reconciliation              payroll liabilities vs GL
 *   comparison?a=&b=            period comparison
 *   periods                     per-period totals
 */
export const GET = withTenantScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.payrollView);
  if (error) return error;
  const { report } = await ctx.params;
  const q = request.nextUrl.searchParams;
  const period = () => {
    const resolved = resolvePayrollPeriodKey(q.get("period") ?? "");
    return resolved.ok ? resolved.period.key : null;
  };
  try {
    const businessId = session.businessId;
    switch (report) {
      case "register": {
        const runId = q.get("runId") ?? undefined;
        const periodKey = period() ?? undefined;
        if (!runId && !periodKey) return badRequest("invalid_period");
        return NextResponse.json(await payrollRegister(businessId, { runId, periodKey }));
      }
      case "employee-card":
        return NextResponse.json(await employeePayrollCard(businessId, q.get("userId") ?? "", Number(q.get("year"))));
      case "insurance":
      case "tax":
      case "employer-cost": {
        const periodKey = period();
        if (!periodKey) return badRequest("invalid_period");
        const fn = report === "insurance" ? insuranceSummary : report === "tax" ? payrollTaxSummary : employerCostReport;
        return NextResponse.json(await fn(businessId, periodKey));
      }
      case "reconciliation":
        return NextResponse.json(await payrollLiabilityReconciliation(businessId));
      case "comparison":
        return NextResponse.json(await periodComparison(businessId, q.get("a") ?? "", q.get("b") ?? ""));
      case "periods":
        return NextResponse.json({ periods: await payrollPeriodSummaries(businessId) });
      default:
        return NextResponse.json({ error: "unknown_report" }, { status: 404 });
    }
  } catch (err) {
    const response = payrollErrorResponse(err);
    if (response) return response;
    throw err;
  }
});
