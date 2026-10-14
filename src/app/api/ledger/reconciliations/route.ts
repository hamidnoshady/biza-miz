import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { todayIsoDate } from "@/lib/jalali";
import { parseCreateReconciliationRequest } from "@/lib/bank-reconciliation";
import {
  createReconciliation,
  ReconciliationError,
  listReconciliations,
  RECONCILABLE_ACCOUNTS,
  type ReconcilableAccount,
} from "@/lib/reconciliation-service";

/**
 * The reconcilable set lives in `bank-reconciliation.ts` (and is re-exported by
 * the service) so the route cannot fall behind it — the local copy here was
 * still two entries long after بانک became a posted-to account.
 */
const ACCOUNT_CODES: readonly ReconcilableAccount[] = RECONCILABLE_ACCOUNTS;

/** A reconciliation history, or the current one, for ?accountCode=cash|bank|bankClearing. */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;

  const accountCode = request.nextUrl.searchParams.get("accountCode") as ReconcilableAccount | null;
  if (!accountCode || !ACCOUNT_CODES.includes(accountCode)) {
    return NextResponse.json({ error: "invalid_account" }, { status: 400 });
  }

  // `ledger_account_missing` is a real, reachable state — a chart of accounts
  // that never got ۱۱۱۰, or an account renamed out from under the code — and
  // the service raises it as a 409. Without this catch it escaped as a 500 and
  // the screen said «خطای غیرمنتظره» instead of naming the missing account.
  try {
    return NextResponse.json({ reconciliations: await listReconciliations(session.businessId, accountCode) });
  } catch (err) {
    if (err instanceof ReconciliationError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
});

/**
 * Starts a new reconciliation for an account. Only one may be in progress per
 * account at a time.
 *
 * The body is parsed by `parseCreateReconciliationRequest`, which is where the
 * wire contract lives: `body.statementDate?.trim()` used to answer a numeric
 * `statementDate` with a 500, and `Number(body.statementBalance)` turned
 * `null` into a statement balance of 0 — a legal value no later check would
 * question. Both are 400s now, with the reason named.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.financeReconciliationManage);
  if (error) return error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  // Tehran's day, not UTC's: between midnight and 03:30 local the two disagree,
  // and a statement dated *today* is the most likely date there is.
  const parsed = parseCreateReconciliationRequest(body, { todayIso: todayIsoDate() });
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  try {
    const reconciliation = await createReconciliation({
      businessId: session.businessId,
      accountCode: parsed.value.accountCode,
      statementDate: parsed.value.statementDate,
      statementBalance: parsed.value.statementBalance,
      createdBy: session.sub,
    });
    return NextResponse.json({ reconciliation }, { status: 201 });
  } catch (err) {
    if (err instanceof ReconciliationError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
});
