import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { ArError, MissingLedgerAccountError, reverseReceipt } from "@/lib/ar-service";
import { fiscalPeriodLockErrorCode } from "@/lib/fiscal-periods";
import { optionalBodyText } from "@/lib/payables-input";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * Reverses a receipt voucher: posts the exact mirror of its journal entry
 * (dated today, never backdated) and marks the source row reversed. ledger.
 * approve is deliberately required, like the A/P payment reversal: this is an
 * append-only accounting correction, not ordinary receipt entry.
 */
export const POST = withTenantScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerApprove);
  if (error) return error;

  const { id } = await ctx.params;
  let body: { memo?: string } = {};
  try {
    body = await request.json();
  } catch {
    // no body is fine; memo is optional
  }

  const memo = optionalBodyText(body.memo);
  if (memo === undefined) {
    return NextResponse.json({ error: "invalid_memo" }, { status: 400 });
  }

  try {
    const result = await reverseReceipt({
      businessId: session.businessId,
      receiptId: id,
      actorId: session.sub,
      memo,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof ArError) return NextResponse.json({ error: err.message }, { status: err.status });
    if (err instanceof MissingLedgerAccountError) {
      return NextResponse.json({ error: "ledger_account_missing", code: err.code }, { status: 409 });
    }
    const lockCode = fiscalPeriodLockErrorCode(err);
    if (lockCode) return NextResponse.json({ error: lockCode }, { status: 409 });
    throw err;
  }
});
