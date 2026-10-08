import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getPayrollRun } from "@/lib/payroll-service";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * One run with its per-employee lines — the lazy half of the payroll history.
 * The list carries summaries so that years of history do not load every
 * employee row; the screen fetches this when a run's details are opened.
 * Gated on `payroll.view`.
 */
export const GET = withTenantScope(async (_request: Request, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.payrollView);
  if (error) return error;

  const { id } = await ctx.params;
  const run = await getPayrollRun(session.businessId, id);
  if (!run) return NextResponse.json({ error: "run_not_found" }, { status: 404 });
  return NextResponse.json({ run });
});
