import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveActiveLocation } from "@/lib/setup-state";
import { ExpenseError, listExpenses, MissingLedgerAccountError, recordExpense } from "@/lib/expense-service";
import { encodeExpenseCursor, parseExpenseAmount, parseExpenseListQuery } from "@/lib/expense-input";
import { fiscalPeriodLockErrorCode } from "@/lib/fiscal-periods";

/**
 * The expense register: filterable by date range, category, payment account,
 * branch, register state and a free-text search over the memo/vendor/reference
 * and the account names — the same vocabulary «دفتر روزنامه» uses, so the two
 * books are searched the same way.
 *
 * It also returns the *true* totals and count over the whole matching set plus
 * `hasMore`/`nextCursor`, because the screen shows a «جمع هزینه‌ها» that must not
 * quietly become the sum of one page (issue #832 §9), and because a register is
 * browsed: the cursor is the last row's position in the register's own total
 * order, so a page cannot shift under somebody reading it.
 *
 * Reading is `ledger.view` — the door every read-only accountant, auditor and
 * viewer holds. Writing is `finance.expenses_manage`, which is why the screen
 * asks for the capability separately and hides its form when the answer is no
 * (§3) rather than handing a 403 to somebody who came to read.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;

  const filters = parseExpenseListQuery(request.nextUrl.searchParams);
  const {
    expenses,
    hasMore,
    nextCursor,
    totalAmount,
    totalVatAmount,
    totalPaidAmount,
    totalOwedAmount,
    totalCount,
  } = await listExpenses(session.businessId, filters);
  return NextResponse.json({
    expenses,
    hasMore,
    // Encoded, not the raw triple: the client hands this exact string back as
    // `?cursor=`, and `parseExpenseCursor` is what reads it on the other side.
    nextCursor: nextCursor ? encodeExpenseCursor(nextCursor) : null,
    totalAmount,
    totalVatAmount,
    totalPaidAmount,
    totalOwedAmount,
    totalCount,
  });
});

/**
 * Records an operating expense and posts it immediately: Debit the chosen expense
 * account (net of input VAT, plus a debit to the VAT account when the expense
 * carries any) / Credit the payment account for the gross — or, with
 * `settlement: "credit"` («پرداخت بعدی», audit F11), Credit Accounts Payable for
 * `supplierId`, to be settled later through `POST /api/ledger/ap/payments`.
 *
 * Every rule the form applies is re-applied in `recordExpense()` — this route is
 * one of four callers of that service and is deliberately not the only one that
 * enforces anything.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.financeExpensesManage);
  if (error) return error;

  let body: {
    accountId?: string;
    paymentAccountId?: string;
    amount?: number;
    expenseDate?: string;
    vendor?: string;
    partyId?: string;
    locationId?: string;
    memo?: string;
    vatAmount?: number | string;
    receiptAssetId?: string;
    settlement?: string;
    supplierId?: string;
    dueDate?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  /*
   * The branch a *new* expense belongs to defaults to the member's active one, as
   * it always has; an explicit `locationId` is accepted so a manager recording
   * another branch's rent is not silently mis-filing it under their own. Either
   * way `recordExpense` re-validates it against the business, so a foreign id is
   * a refusal rather than a write.
   */
  const requestedLocation = typeof body.locationId === "string" ? body.locationId.trim() : "";
  const location = requestedLocation ? null : await resolveActiveLocation(session);

  try {
    const expense = await recordExpense({
      businessId: session.businessId,
      locationId: requestedLocation || location?.id || null,
      accountId: String(body.accountId ?? ""),
      paymentAccountId: String(body.paymentAccountId ?? ""),
      /*
       * Not `Math.trunc(Number(...))`: the truncation happened *before* the
       * service looked at it, so a fractional amount was posted as a different
       * number instead of being refused. An unparseable amount reaches
       * `recordExpense` as `NaN`, which is the one place the rule
       * («integer, positive, within the safe range») lives — so this route cannot
       * be stricter or laxer than the form, the importer or the assistant (§5).
       */
      amount: parseExpenseAmount(body.amount) ?? Number.NaN,
      expenseDate: body.expenseDate,
      vendor: body.vendor,
      partyId: typeof body.partyId === "string" ? body.partyId : null,
      memo: String(body.memo ?? ""),
      createdBy: session.sub,
      vatAmount: body.vatAmount ?? null,
      receiptAssetId: typeof body.receiptAssetId === "string" ? body.receiptAssetId : null,
      settlement: typeof body.settlement === "string" ? (body.settlement as "paid" | "credit") : null,
      supplierId: typeof body.supplierId === "string" ? body.supplierId : null,
      dueDate: typeof body.dueDate === "string" ? body.dueDate : null,
    });
    return NextResponse.json({ expense }, { status: 201 });
  } catch (err) {
    if (err instanceof ExpenseError) return NextResponse.json({ error: err.message }, { status: err.status });
    if (err instanceof MissingLedgerAccountError) {
      return NextResponse.json({ error: "ledger_account_missing", code: err.code }, { status: 409 });
    }
    const lockCode = fiscalPeriodLockErrorCode(err);
    if (lockCode) return NextResponse.json({ error: lockCode }, { status: 409 });
    throw err;
  }
});


