/**
 * Which account a payroll payout leaves — the database half of issue #835 §14.
 *
 * A run's payment and a salary advance are the same act — money leaves the
 * business to a member — so they ask the same question and get the same answer
 * from here: an account the business's own chart classifies as cash, bank or
 * petty cash (`payroll-payment-accounts.ts` is the pure rule), never the
 * card-clearing account (1120) the old «بانک» choice credited.
 */
import type { PoolClient } from "pg";
import { WELL_KNOWN_CODES } from "./coa-template";
import { accountIdsByCode } from "./ledger-service";
import { PayrollError } from "./payroll-errors";
import { clientRunner, poolRunner, type Runner } from "./payroll-db";
import { usablePaymentAccounts, type ChartAccountRow } from "./payroll-payment-accounts";
import type { PayrollPaymentAccount } from "./payroll-types";

async function loadChart(run: Runner, businessId: string): Promise<ChartAccountRow[]> {
  const { rows } = await run<{ id: string; code: string; name: string; parent_id: string | null; type: ChartAccountRow["type"] }>(
    `SELECT id, code, name, parent_id, type::text AS type FROM accounts WHERE business_id = $1 AND is_active`,
    [businessId],
  );
  return rows.map((r) => ({ id: r.id, code: r.code, name: r.name, parentId: r.parent_id, type: r.type }));
}

/** The accounts a payroll payout may leave (cash, banks, petty cash) — one chart, one classification. */
export async function listPaymentAccounts(businessId: string): Promise<PayrollPaymentAccount[]> {
  return usablePaymentAccounts(await loadChart(poolRunner, businessId));
}

export interface PayoutChoice {
  method: "cash" | "bank";
  paymentAccountId: string | null;
}

/**
 * Which account a payout credits. An explicit `paymentAccountId` must be one of
 * `listPaymentAccounts` (so it cannot be a receivable, another business's
 * account, an archived one or a heading) and wins over the method; otherwise
 * the method names the well-known account — cash → صندوق (1100), bank → بانک
 * (1110), the business's own bank account, never the card-clearing account.
 *
 * Returns the account's id and which kind it is (`bank`, or `cash` for cash and
 * petty cash alike), so a record of the payout can say so without a second lookup.
 */
export async function resolvePayoutAccount(
  client: PoolClient,
  businessId: string,
  choice: PayoutChoice,
): Promise<{ accountId: string; method: "cash" | "bank" }> {
  if (choice.paymentAccountId) {
    const allowed = usablePaymentAccounts(await loadChart(clientRunner(client), businessId));
    const chosen = allowed.find((account) => account.id === choice.paymentAccountId);
    if (!chosen) throw new PayrollError("invalid_payment_account");
    return { accountId: chosen.id, method: chosen.role === "bank" ? "bank" : "cash" };
  }
  const code = choice.method === "cash" ? WELL_KNOWN_CODES.cash : WELL_KNOWN_CODES.bank;
  const accounts = await accountIdsByCode(client, businessId, [code]);
  return { accountId: accounts.get(code)!, method: choice.method };
}
