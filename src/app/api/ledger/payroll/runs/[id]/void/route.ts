import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { voidPayrollRun } from "@/lib/payroll-service";
import { payrollErrorResponse } from "@/lib/payroll-http";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * Voids a payroll run: posts the exact mirror of its accrual (and its payment,
 * if paid), dated today rather than backdated — the reversal path every other
 * ledger surface has. Gated on `payroll.manage`, the same capability as
 * accruing and paying, since a void is an equally ledger-altering action.
 *
 * Each mirror carries its original entry's location, never the caller's active
 * branch; the commission the run had settled becomes claimable again.
 */
export const POST = withTenantScope(async (_request: Request, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.payrollManage);
  if (error) return error;

  const { id } = await ctx.params;

  try {
    const run = await voidPayrollRun({
      businessId: session.businessId,
      runId: id,
      actorId: session.sub,
    });
    return NextResponse.json({ run });
  } catch (err) {
    const response = payrollErrorResponse(err);
    if (response) return response;
    throw err;
  }
});
