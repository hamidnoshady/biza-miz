/**
 * Which accounts a payroll payment may leave — issue #835 §14.
 *
 * The bank path of a payroll payment used to credit the generic
 * «کارت‌خوان (در راه)» account (1120). That account is card money still on its
 * way from the processor — `account-classification.ts` calls it
 * `payment_clearing` and keeps it out of cash on purpose — so a wage paid by
 * bank transfer made the books say the money left an account that does not hold
 * the business's money yet, and the real bank account (1110) never moved.
 *
 * Payroll does not get an account list of its own. It asks the platform's one
 * classification of the chart (`classifyAccounts`): a payment may leave any
 * active, *postable* (leaf) asset account whose role is cash, bank or petty
 * cash — صندوق, every bank account the business has opened under بانک, and
 * تنخواه. Custom sub-accounts qualify the same way they do everywhere else
 * (a `11101` under `1110` is a bank account). This is the same notion of "a
 * place money can be paid from" the cash-flow statement uses, so the two cannot
 * disagree.
 *
 * Pure: callers pass the business's active chart; no I/O here.
 */
import { classifyAccounts, isUsableLiquidity, type ClassifiableAccount } from "./account-classification";
import type { PayrollPaymentAccount } from "./payroll-types";

export interface ChartAccountRow extends ClassifiableAccount {
  name: string;
}

/**
 * The accounts a payment may leave, in chart (code) order.
 * `chart` must be the business's *active* accounts — an archived account is
 * neither offered nor accepted.
 */
export function usablePaymentAccounts(chart: readonly ChartAccountRow[]): PayrollPaymentAccount[] {
  const roles = classifyAccounts([...chart]);
  const parents = new Set<string>();
  for (const account of chart) if (account.parentId) parents.add(account.parentId);

  return chart
    .filter((account) => account.type === "asset" && !parents.has(account.id))
    .flatMap((account) => {
      const role = roles.get(account.id);
      if (!isUsableLiquidity(role)) return [];
      return [{ id: account.id, code: account.code, name: account.name, role: role as PayrollPaymentAccount["role"] }];
    })
    // Chart order: codes are hierarchical text, so `11101` belongs right after
    // `1110`, not after `1130` — the order of `ORDER BY code` everywhere else.
    .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
}
