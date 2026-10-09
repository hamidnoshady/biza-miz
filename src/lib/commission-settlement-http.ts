/**
 * What the commission settlement routes share (issue #869): turning a refusal
 * into the one response shape the screen translates, building the acting
 * person from a guard, and answering a CSV download.
 *
 * Payroll's refusals (fiscal-period lock, missing ledger account, payout account
 * not usable) reach the same mapper, so a payout that the books refuse answers
 * the same way wherever it is made from.
 */
import { NextResponse } from "next/server";
import type { MembershipContext } from "./authorize";
import { CommissionSettlementError } from "./commission-settlement-errors";
import type { CommissionActor } from "./commission-settlement-service";
import { payrollErrorResponse } from "./payroll-http";

/** The response for a refusal the settlement lifecycle raised on purpose, or for a payroll-side refusal it shares; `null` for anything else (rethrow). */
export function commissionErrorResponse(err: unknown): NextResponse | null {
  if (err instanceof CommissionSettlementError) {
    return NextResponse.json({ error: err.message, ...(err.details ?? {}) }, { status: err.status });
  }
  return payrollErrorResponse(err);
}

/** The person acting, as the service needs them: the user id and the effective permissions (the membership's, never the token's). */
export function actorOf(session: { sub: string }, membership: MembershipContext): CommissionActor {
  return { userId: session.sub, role: membership.role, permissions: membership.permissions };
}

/** A CSV attachment. The body already carries the BOM and CRLF from `toCsv`. */
export function csvResponse(body: string, fileName: string): NextResponse {
  return new NextResponse(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="export.csv"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      "Cache-Control": "no-store",
    },
  });
}

/** Today's date for a file name, in the storage form (YYYY-MM-DD). */
export function exportStamp(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}
