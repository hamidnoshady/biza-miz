import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { ExpenseError, reverseExpense } from "@/lib/expense-service";
import { fiscalPeriodLockErrorCode } from "@/lib/fiscal-periods";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * Reverses a posted expense: a new, separately numbered expense row whose
 * journal swaps every debit and credit of the original, dated the day the
 * correction is made. The original is annotated (`reversed_at`/`reversed_by`)
 * and stays in the register, so both facts remain auditable and the pair nets
 * to zero on the accounts it touched — which is the whole point of issue #832 §1:
 * without this route, the only way to fix a wrong expense was a manual
 * correcting journal, and the Expenses register then disagreed with the General
 * Ledger for good.
 *
 * Gated on `finance.expenses_manage`, *not* on `ledger.approve` (which is what
 * the manual-journal reversal asks for): the capability that means "this member
 * may move money out through the expense register" is the one that decides
 * whether they may undo such a move. Two permissions for one business act is how
 * a custom role ends up able to post expenses but not correct them — or, worse
 * for the import path, able to do both through the door nobody was watching.
 *
 * Body: `{ memo?: string, expenseDate?: string }` — both optional. The date may
 * be any non-future day the fiscal periods still accept; a locked period is a
 * 409 from the same trigger every other posting path obeys.
 */
export const POST = withTenantScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.financeExpensesManage);
  if (error) return error;

  const { id } = await ctx.params;
  let body: { memo?: string; expenseDate?: string } = {};
  try {
    body = await request.json();
  } catch {
    // No body is fine: both fields are optional and the defaults are the
    // business's today and a «برگشت هزینه …» memo built from the original.
  }

  try {
    const expense = await reverseExpense({
      businessId: session.businessId,
      expenseId: id,
      actorId: session.sub,
      reversalDate: typeof body.expenseDate === "string" ? body.expenseDate : null,
      memo: typeof body.memo === "string" ? body.memo : null,
    });
    return NextResponse.json({ expense }, { status: 201 });
  } catch (err) {
    if (err instanceof ExpenseError) return NextResponse.json({ error: err.message }, { status: err.status });
    const lockCode = fiscalPeriodLockErrorCode(err);
    if (lockCode) return NextResponse.json({ error: lockCode }, { status: 409 });
    throw err;
  }
});
