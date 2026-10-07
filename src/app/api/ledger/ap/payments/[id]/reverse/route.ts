import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { ApError, MissingLedgerAccountError, reversePayment } from "@/lib/ap-service";
import { fiscalPeriodLockErrorCode } from "@/lib/fiscal-periods";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * Reverses a payment voucher: posts the exact mirror of its journal entry
 * (dated today, never backdated) and marks the source row reversed. Same gate
 * as recording the payment — finance.payables_manage.
 */
export const POST = withTenantScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.financePayablesManage);
  if (error) return error;

  const { id } = await ctx.params;
  let body: { memo?: string } = {};
  try {
    body = await request.json();
  } catch {
    // no body is fine; memo is optional
  }

  try {
    const result = await reversePayment({
      businessId: session.businessId,
      paymentId: id,
      actorId: session.sub,
      memo: body.memo,
    });
    return NextResponse.json(result, { status: 201 });
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
