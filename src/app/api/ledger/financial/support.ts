/**
 * What the «حساب‌های مالی» and «انتقال وجه» routes share (issue #862).
 *
 * Both domains post to the ledger, so both need the same three things the
 * cheque endpoints already solved: a body reader that refuses a broken payload
 * rather than acting on defaults, an idempotency key that can arrive as a header
 * or a body field, and one translation from the four error shapes a posting
 * route can raise into an HTTP status.
 *
 * The two helpers are imported from the cheques endpoints rather than copied: a
 * second implementation of "no body is `{}`, broken JSON is `bad_request`" is
 * how two money-moving doors end up disagreeing about what a truncated request
 * means. The error translation is here because the two domains raise *different*
 * error classes over the same shared codes.
 */
import { NextResponse } from "next/server";
import { FinancialAccountError } from "@/lib/financial-accounts-service";
import { FinancialTransferError } from "@/lib/financial-transfers-service";
import { MissingLedgerAccountError } from "@/lib/ledger-service";
import { fiscalPeriodLockErrorCode } from "@/lib/fiscal-periods";

export { MalformedBodyError, readJsonObjectBody } from "../cheques/body";
export { idempotencyKeyOf } from "../cheques/idempotency";

/**
 * The failure shapes a financial-accounts or transfers route can raise.
 *
 * Order matters: the two domain classes carry their own status and message
 * first, then the ledger's missing-account error (a chart the business has not
 * seeded yet), then the database's own unique violation — the structural
 * backstop for a race the service's pre-check could not see — and finally a
 * locked fiscal period, which is `fiscal-periods.ts`'s own code and not this
 * domain's.
 */
export function financialErrorResponse(err: unknown): NextResponse {
  if (err instanceof FinancialAccountError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  if (err instanceof FinancialTransferError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  if (err instanceof MissingLedgerAccountError) {
    return NextResponse.json({ error: "ledger_account_missing", code: err.code }, { status: 409 });
  }
  const lockCode = fiscalPeriodLockErrorCode(err);
  if (lockCode) return NextResponse.json({ error: lockCode }, { status: 409 });
  const code = (err as { code?: string } | null)?.code;
  if (code === "23505") {
    // The unique index that fired is not named here on purpose: the service
    // already translates the ones it can predict, so anything reaching this
    // line is a genuine duplicate of a document number or key, which is exactly
    // the same class of mistake as a duplicate cheque serial.
    return NextResponse.json({ error: "duplicate_record" }, { status: 409 });
  }
  throw err;
}

/** A `?limit=` value, clamped, with the route's own idea of "not a number". */
export function limitFromSearch(value: string | null, fallback: number, max: number): number | null {
  if (value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1) return null;
  return Math.min(parsed, max);
}
