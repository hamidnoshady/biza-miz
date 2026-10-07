/**
 * Settlement-account resolution for AR receipts / AP payments — Issue #829.
 *
 * A voucher posts against an explicit cash/bank asset account
 * (`settlement_account_id`); `method` stays as classification/display metadata.
 * When the caller does not name an account, the method resolves to its
 * well-known account (cash → 1100 صندوق, bank → 1110 بانک, clearing → 1120
 * کارت‌خوان در راه).
 *
 * DB-touching helper shared by `ar-service.ts` and `ap-service.ts` so the two
 * cannot drift on what "an eligible settlement account" means.
 */
import type { PoolClient } from "pg";
import { WELL_KNOWN_CODES } from "./coa-template";
import { accountIdsByCode } from "./ledger-service";
import { settlementCodeForMethod, type SettlementMethod } from "./voucher-shared";
import { isUuid } from "./uuid";

export class SettlementAccountError extends Error {
  status: number;
  constructor(code: string, status = 400) {
    super(code);
    this.status = status;
  }
}

/**
 * Resolves the settlement account a voucher posts against.
 *
 * - When `settlementAccountId` is given it must be this business's own active
 *   asset account under the 11xx cash/bank family (1100 صندوق, 1110 بانک,
 *   1120 کارت‌خوان, 1130 تنخواه, or a custom bank account the business added
 *   under 11xx). Anything else is `invalid_settlement_account` — a receipt
 *   cannot be "received into" inventory or receivables.
 * - Otherwise the method's well-known account is resolved (missing → the
 *   shared `MissingLedgerAccountError`, so the voucher rolls back cleanly).
 */
export async function resolveSettlementAccount(
  client: PoolClient,
  businessId: string,
  method: SettlementMethod,
  settlementAccountId: string | null | undefined,
): Promise<{ id: string; code: string }> {
  if (settlementAccountId != null && settlementAccountId !== "") {
    if (!isUuid(settlementAccountId)) throw new SettlementAccountError("invalid_settlement_account");
    const { rows } = await client.query<{ id: string; code: string }>(
      `SELECT id, code FROM accounts
        WHERE id = $1 AND business_id = $2 AND is_active AND type = 'asset'`,
      [settlementAccountId, businessId],
    );
    const account = rows[0];
    if (!account) throw new SettlementAccountError("invalid_settlement_account");
    // Cash/bank family only: 11xx. A settlement into 12xx/13xx (receivables,
    // inventory, cheques on hand) is a caller bug, not a receipt.
    if (!account.code.startsWith("11")) throw new SettlementAccountError("invalid_settlement_account");
    return account;
  }

  const code = settlementCodeForMethod(method);
  // `accountIdsByCode` throws `MissingLedgerAccountError` naming the code when
  // the business customized its chart out from under the posting.
  const accounts = await accountIdsByCode(client, businessId, [code]);
  return { id: accounts.get(code)!, code };
}

/** The well-known codes a settlement account is expected to be one of (for tests/docs). */
export const SETTLEMENT_WELL_KNOWN_CODES = {
  cash: WELL_KNOWN_CODES.cash,
  bank: WELL_KNOWN_CODES.bank,
  bankClearing: WELL_KNOWN_CODES.bankClearing,
} as const;
