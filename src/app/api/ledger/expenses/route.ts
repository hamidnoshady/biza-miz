import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveActiveLocation } from "@/lib/setup-state";
import { ExpenseError, listExpenses, recordExpense } from "@/lib/expense-service";
import { parseExpenseListQuery } from "@/lib/expense-input";
import { fiscalPeriodLockErrorCode } from "@/lib/fiscal-periods";

/**
 * The expense list, filterable by date range, category, payment account and a
 * free-text search over the memo/vendor/account names — the same shape the
 * journal («دفتر روزنامه») already had. It also returns the *true* total and
 * count over the whole matching set plus `hasMore`, because the screen shows a
 * «جمع هزینه‌ها» that must not quietly become the sum of one page.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;

  const filters = parseExpenseListQuery(request.nextUrl.searchParams);
  const { expenses, hasMore, totalAmount, totalCount } = await listExpenses(session.businessId, filters);
  return NextResponse.json({ expenses, hasMore, totalAmount, totalCount });
});

/** Records a paid operating expense and posts it immediately (Debit the chosen expense account / Credit the payment account). */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.financeExpensesManage);
  if (error) return error;

  let body: {
    accountId?: string;
    paymentAccountId?: string;
    amount?: number;
    expenseDate?: string;
    vendor?: string;
    memo?: string;
    receiptAssetId?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const location = await resolveActiveLocation(session);

  try {
    const expense = await recordExpense({
      businessId: session.businessId,
      locationId: location?.id ?? null,
      accountId: String(body.accountId ?? ""),
      paymentAccountId: String(body.paymentAccountId ?? ""),
      amount: Math.trunc(Number(body.amount)),
      expenseDate: body.expenseDate,
      vendor: body.vendor,
      memo: String(body.memo ?? ""),
      createdBy: session.sub,
      receiptAssetId: typeof body.receiptAssetId === "string" ? body.receiptAssetId : null,
    });
    return NextResponse.json({ expense }, { status: 201 });
  } catch (err) {
    if (err instanceof ExpenseError) return NextResponse.json({ error: err.message }, { status: err.status });
    const lockCode = fiscalPeriodLockErrorCode(err);
    if (lockCode) return NextResponse.json({ error: lockCode }, { status: 409 });
    throw err;
  }
});
