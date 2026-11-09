import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { financialReportAccess } from "@/lib/financial-report-access";
import { completeReconciliation, ReconciliationError } from "@/lib/reconciliation-service";

interface Ctx {
  params: Promise<{ id: string }>;
}

/** Locks a reconciliation — only once its cleared lines exactly account for the statement balance. */
export const POST = withTenantScope(async (_request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.financeReconciliationManage);
  if (error) return error;

  const { id } = await ctx.params;
  try {
    const reconciliation = await completeReconciliation({
      ...await financialReportAccess(session),
      businessId: session.businessId,
      reconciliationId: id,
      actorId: session.sub,
    });
    return NextResponse.json(reconciliation);
  } catch (err) {
    if (err instanceof ReconciliationError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
});
