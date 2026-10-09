/**
 * What the opening-balance and voucher routes share (issue #867): one mapping
 * from a deliberate refusal to the `{ error, ... }` shape the screen translates.
 * Body reading is the same strict reader the payroll routes use.
 */
import { NextResponse } from "next/server";
import { fiscalPeriodLockErrorCode } from "./fiscal-periods";
import { FiscalPeriodError } from "./fiscal-periods-service";
import { MissingLedgerAccountError } from "./ledger-service";
import { OpeningBalanceError } from "./opening-balance-service";
import { VoucherError } from "./voucher-service";

export { readJsonObject, badRequest, type JsonObject } from "./payroll-http";

/**
 * The response for a refusal these routes raise on purpose, or `null` for an
 * unexpected failure, which the caller rethrows (an unexpected failure is not a 4xx).
 */
export function accountingErrorResponse(err: unknown): NextResponse | null {
  if (err instanceof OpeningBalanceError || err instanceof VoucherError) {
    return NextResponse.json({ error: err.message, ...(err.details ?? {}) }, { status: err.status });
  }
  if (err instanceof FiscalPeriodError) {
    return NextResponse.json({ error: err.message, ...(err.details ?? {}) }, { status: err.status });
  }
  if (err instanceof MissingLedgerAccountError) {
    return NextResponse.json({ error: "ledger_account_missing", code: err.code }, { status: 409 });
  }
  const lockCode = fiscalPeriodLockErrorCode(err);
  if (lockCode) return NextResponse.json({ error: lockCode }, { status: 409 });
  // The voucher guard's own refusals: a change to an issued identity without
  // the privileged path, or a retime across a Jalali year. Both are 409s.
  if (err instanceof Error && /^(voucher_identity_locked|voucher_year_change_forbidden|voucher_year_mismatch|voucher_date_out_of_range|journal_voucher_audit_is_append_only)$/.test(err.message)) {
    return NextResponse.json({ error: err.message }, { status: 409 });
  }
  // A unique violation on a number or reference that a concurrent request just
  // took is a conflict the caller can retry, not a server fault.
  if (typeof err === "object" && err !== null && (err as { code?: unknown }).code === "23505") {
    return NextResponse.json({ error: "duplicate_entry" }, { status: 409 });
  }
  return null;
}
