import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getPayslip } from "@/lib/payroll-engine-runs";

interface Ctx {
  params: Promise<{ id: string }>;
}

/** One payslip: earnings, deductions, employer contributions, bases, tax, net and payment status. `payroll.view`. */
export const GET = withTenantScope(async (_request: Request, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.payrollView);
  if (error) return error;
  const { id } = await ctx.params;
  const payslip = await getPayslip(session.businessId, id);
  if (!payslip) return NextResponse.json({ error: "payslip_not_found" }, { status: 404 });
  return NextResponse.json({ payslip });
});
