import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveActiveLocation } from "@/lib/setup-state";
import { ApError, MissingLedgerAccountError, reverseApPayment } from "@/lib/ap-service";
import { fiscalPeriodLockErrorCode } from "@/lib/fiscal-periods";
import { isValidIsoDate } from "@/lib/iso-date";
import { optionalBodyText } from "@/lib/payables-input";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * Reverses a posted supplier payment. ledger.approve is deliberately required:
 * this is an append-only accounting correction, not ordinary payment entry.
 */
export const POST = withTenantScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerApprove);
  if (error) return error;

  const { id } = await ctx.params;
  let body: { reversalDate?: string; memo?: string } = {};
  try {
    body = await request.json();
  } catch {
    // An empty body means reverse on the business-local date with the default memo.
  }

  const reversalDate = optionalBodyText(body.reversalDate);
  if (reversalDate === undefined) {
    return NextResponse.json({ error: "invalid_date" }, { status: 400 });
  }
  if (reversalDate && !isValidIsoDate(reversalDate)) {
    return NextResponse.json({ error: "invalid_date" }, { status: 400 });
  }
  const memo = optionalBodyText(body.memo);
  if (memo === undefined) {
    return NextResponse.json({ error: "invalid_memo" }, { status: 400 });
  }
  const location = await resolveActiveLocation(session);

  try {
    const reversal = await reverseApPayment({
      businessId: session.businessId,
      locationId: location?.id ?? null,
      paymentId: id,
      actorId: session.sub,
      reversalDate,
      memo,
    });
    return NextResponse.json({ reversal }, { status: 201 });
  } catch (err) {
    if (err instanceof ApError) return NextResponse.json({ error: err.message }, { status: err.status });
    if (err instanceof MissingLedgerAccountError) {
      return NextResponse.json({ error: "ledger_account_missing", code: err.code }, { status: 409 });
    }
    const lockCode = fiscalPeriodLockErrorCode(err);
    if (lockCode) return NextResponse.json({ error: lockCode }, { status: 409 });
    throw err;
  }
});
