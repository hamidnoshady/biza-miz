/**
 * Phase 21 Wave 6 — accessory sale posting rules, registered against Wave
 * 1's domain-event/posting engine.
 *
 * The thinnest industry module of the four, exactly as the phase plan
 * expected: an accessory is ordinary finished goods, so the two rules are
 * the plain revenue/COGS pair with no industry-specific split (no
 * VAT-exempt metal value the way gold has, no service line the way watch
 * has).
 *
 *   - `accessory.sale_revenue`: Debit Cash/Bank-Clearing/Accounts-
 *     Receivable by payment method for the total; Credit
 *     `accessorySalesRevenue` for the net (post-discount) line and
 *     `vatPayable` for VAT.
 *   - `accessory.sale_cogs`: Debit `accessoryCogs` / Credit
 *     `accessoryInventory` for quantity × the variant's running average
 *     unit cost, as it stood when the sale ran.
 */
import { WELL_KNOWN_CODES } from "./coa-template";
import { rialBigInt, type RialText } from "./inventory-exact";
import { accountIdsByCode } from "./ledger-service";
import { registerPostingRule, type PostingResult } from "./posting-engine";
import type { SettlementMethod } from "./ledger";
import { groupTendersByCode, type RetailTender } from "./retail-tenders";

const PAYMENT_ACCOUNT_CODE: Record<SettlementMethod, string> = {
  cash: WELL_KNOWN_CODES.cash,
  bank: WELL_KNOWN_CODES.bankClearing,
  credit: WELL_KNOWN_CODES.accountsReceivable,
};

const ZERO = "0" as RialText;

interface AccessorySaleRevenuePayload {
  itemId: string;
  quantity: string;
  net: RialText;
  vat: RialText;
  total: RialText;
  tenders: RetailTender[];
}

registerPostingRule("accessory.sale_revenue", async (event, client): Promise<PostingResult | null> => {
  const payload = event.payload as unknown as AccessorySaleRevenuePayload;
  const debits = groupTendersByCode(payload.tenders, (m) => PAYMENT_ACCOUNT_CODE[m]);

  const accounts = await accountIdsByCode(client, event.businessId, [
    ...debits.map((d) => d.code),
    WELL_KNOWN_CODES.accessorySalesRevenue,
    WELL_KNOWN_CODES.vatPayable,
  ]);

  return {
    lines: [
      ...debits.map((d) => ({ accountId: accounts.get(d.code)!, debit: d.amount, credit: ZERO })),
      { accountId: accounts.get(WELL_KNOWN_CODES.accessorySalesRevenue)!, debit: ZERO, credit: payload.net },
      { accountId: accounts.get(WELL_KNOWN_CODES.vatPayable)!, debit: ZERO, credit: payload.vat },
    ],
    memo: "فروش بدلیجات",
    postingKind: "accessory_sale_revenue",
  };
});

interface AccessorySaleCogsPayload {
  itemId: string;
  quantity: string;
  cost: RialText;
}

registerPostingRule("accessory.sale_cogs", async (event, client): Promise<PostingResult | null> => {
  const payload = event.payload as unknown as AccessorySaleCogsPayload;
  if (rialBigInt(payload.cost) === 0n) return null;

  const accounts = await accountIdsByCode(client, event.businessId, [
    WELL_KNOWN_CODES.accessoryCogs,
    WELL_KNOWN_CODES.accessoryInventory,
  ]);

  return {
    lines: [
      { accountId: accounts.get(WELL_KNOWN_CODES.accessoryCogs)!, debit: payload.cost, credit: ZERO },
      { accountId: accounts.get(WELL_KNOWN_CODES.accessoryInventory)!, debit: ZERO, credit: payload.cost },
    ],
    memo: "بهای تمام‌شده بدلیجات فروخته‌شده",
    postingKind: "accessory_sale_cogs",
  };
});
