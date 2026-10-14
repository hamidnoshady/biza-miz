/**
 * Which of a business's own accounts an operating expense may touch, on either
 * side of the entry — the one rule behind «دسته هزینه» and «پرداخت از»
 * (issue #832 §2).
 *
 * The screen used to build its payment picker with `accounts.filter(a => a.type
 * === "asset")` and the service accepted any active asset account, so a rent
 * payment could be credited against inventory, a customer receivable or
 * recoverable VAT. This module is why that cannot be patched in only one place:
 *
 *   - `expense-section.tsx` fills both pickers from it,
 *   - `POST /api/ledger/expenses` and every other write channel go through
 *     `expense-service.ts`, which validates the id against the *same* rule
 *     computed from the tenant's chart on the server,
 *   - `accounting.expenses` import calls `recordExpense()`, so it inherits it,
 *   - the AI/autopilot executor likewise.
 *
 * It is pure and framework-free (the same contract as `account-classification`,
 * which it delegates to) so the client bundle can import it — the browser filter
 * and the server check can never disagree, because they are the same function.
 *
 * Callers pass **active** accounts only; nothing here knows about `is_active`,
 * because archiving an account is the chart's business, not the rule's.
 */
import { classifyAccounts, isExpensePaymentSource } from "./account-classification";

/** The shape the rule needs — a subset of both `AccountRow` and the service's row. */
export interface ExpenseAccountShape {
  id: string;
  code: string;
  parentId: string | null;
  type: "asset" | "liability" | "equity" | "revenue" | "expense";
}

/**
 * The accounts an expense may be paid from, in the order they were given (the
 * chart's own code order, at every call site). Cash and banks first is the
 * chart's own ordering, not a re-sort — the picker shows the ledger's order.
 */
export function expensePaymentSourceAccounts<T extends ExpenseAccountShape>(accounts: readonly T[]): T[] {
  const roles = classifyAccounts(
    accounts.map((account) => ({
      id: account.id,
      code: account.code,
      parentId: account.parentId,
      type: account.type,
    })),
  );
  return accounts.filter((account) => isExpensePaymentSource(roles.get(account.id)));
}

/** The ids an expense may be paid from — what a server-side membership check wants. */
export function expensePaymentSourceIds(accounts: readonly ExpenseAccountShape[]): Set<string> {
  return new Set(expensePaymentSourceAccounts(accounts).map((account) => account.id));
}

/**
 * The accounts an expense may be categorised into: any expense-type account.
 * The chosen account *is* the category (0030's decision — one taxonomy, the
 * chart), so this is deliberately not a fixed 5xxx list; a business's own
 * subaccounts and any industry's chart are all categories here.
 */
export function expenseCategoryAccounts<T extends ExpenseAccountShape>(accounts: readonly T[]): T[] {
  return accounts.filter((account) => account.type === "expense");
}
