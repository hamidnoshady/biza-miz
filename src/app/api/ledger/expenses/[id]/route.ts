import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getExpense, getExpenseJournalLines } from "@/lib/expense-service";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * One expense, in full — the auditable detail view the register never had
 * (issue #832 §8): who recorded it and when, the branch, both accounts with
 * their codes, the linked party, the receipt evidence, the entry it posted with
 * its lines, and the reversal state on both sides.
 *
 * `ledger.view`, the same door as the list: this is the read an auditor and a
 * bookkeeper need, and everything that answers it is already visible in the
 * register. The write actions on the same record live under
 * `finance.expenses_manage` in `./reverse`.
 *
 * The id is scoped by the tenant in the query itself, so another business's
 * expense is a 404 rather than a 403 that confirms it exists.
 */
export const GET = withTenantScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;

  const { id } = await ctx.params;
  const expense = await getExpense(session.businessId, id);
  if (!expense) return NextResponse.json({ error: "expense_not_found" }, { status: 404 });

  const lines = expense.journalEntryId
    ? await getExpenseJournalLines(session.businessId, expense.journalEntryId)
    : [];
  return NextResponse.json({ expense, journalLines: lines });
});
