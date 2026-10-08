import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveActiveLocation } from "@/lib/setup-state";
import { MissingLedgerAccountError, PayrollError, voidAdvance } from "@/lib/payroll-service";
import { fiscalPeriodLockErrorCode } from "@/lib/fiscal-periods";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * Voids a salary advance recorded by mistake: mirrors its entry, dated today.
 * Refused once a payroll run has recovered any of it.
 */
export const POST = withTenantScope(async (_request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.payrollManage);
  if (error) return error;

  const { id } = await ctx.params;
  const location = await resolveActiveLocation(session);

  try {
    const advance = await voidAdvance({
      businessId: session.businessId,
      locationId: location?.id ?? null,
      advanceId: id,
      actorId: session.sub,
    });
    return NextResponse.json({ advance });
  } catch (err) {
    if (err instanceof PayrollError) return NextResponse.json({ error: err.message }, { status: err.status });
    if (err instanceof MissingLedgerAccountError) {
      return NextResponse.json({ error: "ledger_account_missing", code: err.code }, { status: 409 });
    }
    const lockCode = fiscalPeriodLockErrorCode(err);
    if (lockCode) return NextResponse.json({ error: lockCode }, { status: 409 });
    throw err;
  }
});
