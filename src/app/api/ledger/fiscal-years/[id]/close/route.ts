import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { closeFiscalYear, MissingLedgerAccountError } from "@/lib/closing-service";
import { FiscalPeriodError } from "@/lib/fiscal-periods-service";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * Closes a fiscal year: every period must already be `soft_closed`. Posts one
 * closing entry rolling revenue/expense into Retained Earnings, then locks
 * every period. `ledger.close_period` — owner and accountant, same gate as
 * soft-closing/locking a period.
 */
export const POST = withTenantScope(async (_request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerClosePeriod);
  if (error) return error;

  const { id } = await ctx.params;
  try {
    const result = await closeFiscalYear(session.businessId, id, session.sub);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof FiscalPeriodError) {
      return NextResponse.json({ error: err.message, ...err.details }, { status: err.status });
    }
    if (err instanceof MissingLedgerAccountError) {
      return NextResponse.json({ error: "ledger_account_missing", code: err.code }, { status: 409 });
    }
    throw err;
  }
});
