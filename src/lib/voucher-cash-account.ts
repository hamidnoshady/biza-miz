/**
 * Audit F11 — the cash/bank side of a receipt or payment voucher.
 *
 * A voucher used to name only a method, and the method alone picked the
 * account (1100 for «نقدی», the 1120 clearing account for «بانکی»), so a
 * business with two bank accounts could not say which one the money went
 * through. This resolves the account an `ar_receipts`/`ap_payments` row
 * debits or credits: the account the user chose, checked to belong to this
 * business, to be active, and to be an account of the voucher's method
 * (`voucherMethodForRole`); or, when none was chosen, the method's default
 * account (cash → 1100 صندوق, bank → 1110 بانک, clearing → 1120
 * کارت‌خوان (در راه) — issue #829 gave «بانکی» its own bank default and
 * moved the clearing account to the new `clearing` method).
 *
 * DB-touching, so per repo convention it has no direct unit test; the pure
 * rule is `voucherMethodForRole` in payables-input.ts and the behaviour is
 * covered by integration/f11-payables.integration.test.ts.
 */
import type { PoolClient } from "pg";
import { classifyAccounts, type ClassifiableAccount } from "./account-classification";
import { accountIdsByCode } from "./ledger-service";
import {
  PayablesInputError,
  voucherDefaultAccountCode,
  voucherMethodForRole,
  type VoucherMethod,
} from "./payables-input";
import { isUuid } from "./uuid";

export async function resolveVoucherCashAccount(
  client: PoolClient,
  businessId: string,
  method: VoucherMethod,
  cashAccountId: string | null | undefined,
): Promise<{ accountId: string; chosen: boolean }> {
  const chosen = cashAccountId?.trim() || null;
  if (!chosen) {
    // `accountIdsByCode` throws `MissingLedgerAccountError` naming the code
    // when the business customized its chart out from under the posting, so
    // the voucher rolls back cleanly instead of posting to a guessed account.
    const code = voucherDefaultAccountCode(method);
    const accounts = await accountIdsByCode(client, businessId, [code]);
    return { accountId: accounts.get(code)!, chosen: false };
  }
  if (!isUuid(chosen)) throw new PayablesInputError("invalid_cash_account");

  // The whole chart, because a custom sub-account inherits its parent's role.
  const { rows } = await client.query<{ id: string; code: string; parent_id: string | null; type: ClassifiableAccount["type"]; is_active: boolean }>(
    `SELECT id, code, parent_id, type, is_active FROM accounts WHERE business_id = $1`,
    [businessId],
  );
  const target = rows.find((r) => r.id === chosen);
  if (!target || !target.is_active) throw new PayablesInputError("invalid_cash_account");
  const roles = classifyAccounts(rows.map((r) => ({ id: r.id, code: r.code, parentId: r.parent_id, type: r.type })));
  const accountMethod = voucherMethodForRole(roles.get(chosen));
  if (!accountMethod) throw new PayablesInputError("invalid_cash_account");
  if (accountMethod !== method) throw new PayablesInputError("cash_account_method_mismatch");
  return { accountId: chosen, chosen: true };
}
