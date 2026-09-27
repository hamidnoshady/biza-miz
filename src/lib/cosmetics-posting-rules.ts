/**
 * Phase 27 Wave 1 — cosmetics sale posting rules, registered against the
 * domain-event/posting engine.
 *
 * The cosmetics twin of `accessories-posting-rules.ts`: an item of cosmetics
 * is ordinary finished goods, so the two rules are the plain revenue/COGS
 * pair — debit Cash/Bank-Clearing/AR by payment method, credit
 * `cosmeticSalesRevenue` and `vatPayable`; debit `cosmeticCogs`, credit
 * `cosmeticInventory`. Only the accounts differ, which is the whole reason the
 * sale service emits its own event types.
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

interface CosmeticSaleRevenuePayload {
  itemId: string;
  quantity: string;
  net: RialText;
  vat: RialText;
  total: RialText;
  tenders: RetailTender[];
}

registerPostingRule("cosmetic.sale_revenue", async (event, client): Promise<PostingResult | null> => {
  const payload = event.payload as unknown as CosmeticSaleRevenuePayload;
  const debits = groupTendersByCode(payload.tenders, (m) => PAYMENT_ACCOUNT_CODE[m]);

  const accounts = await accountIdsByCode(client, event.businessId, [
    ...debits.map((d) => d.code),
    WELL_KNOWN_CODES.cosmeticSalesRevenue,
    WELL_KNOWN_CODES.vatPayable,
  ]);

  return {
    lines: [
      ...debits.map((d) => ({ accountId: accounts.get(d.code)!, debit: d.amount, credit: ZERO })),
      { accountId: accounts.get(WELL_KNOWN_CODES.cosmeticSalesRevenue)!, debit: ZERO, credit: payload.net },
      { accountId: accounts.get(WELL_KNOWN_CODES.vatPayable)!, debit: ZERO, credit: payload.vat },
    ],
    memo: "فروش لوازم آرایشی و بهداشتی",
    postingKind: "cosmetic_sale_revenue",
  };
});

interface CosmeticSaleCogsPayload {
  itemId: string;
  quantity: string;
  cost: RialText;
}

registerPostingRule("cosmetic.sale_cogs", async (event, client): Promise<PostingResult | null> => {
  const payload = event.payload as unknown as CosmeticSaleCogsPayload;
  if (rialBigInt(payload.cost) === 0n) return null;

  const accounts = await accountIdsByCode(client, event.businessId, [
    WELL_KNOWN_CODES.cosmeticCogs,
    WELL_KNOWN_CODES.cosmeticInventory,
  ]);

  return {
    lines: [
      { accountId: accounts.get(WELL_KNOWN_CODES.cosmeticCogs)!, debit: payload.cost, credit: ZERO },
      { accountId: accounts.get(WELL_KNOWN_CODES.cosmeticInventory)!, debit: ZERO, credit: payload.cost },
    ],
    memo: "بهای تمام‌شده کالای آرایشی و بهداشتی فروخته‌شده",
    postingKind: "cosmetic_sale_cogs",
  };
});

interface CosmeticExpiryWriteOffPayload {
  itemId: string;
  quantity: string;
  cost: RialText;
}

// Wave 2 — writing off expired stock: the cost leaves inventory and lands in
// «کالای منقضی و تستر» (5160), not in COGS — a shrinkage expense, not a cost
// of a sale.
interface CosmeticTesterPayload {
  itemId: string;
  quantity: string;
  cost: RialText;
}

// Wave 3 — opening a sellable unit as a tester/sample: its cost leaves
// inventory and lands in the same «کالای منقضی و تستر» account (5160), a
// marketing expense rather than COGS.
registerPostingRule("cosmetic.tester_consumed", async (event, client): Promise<PostingResult | null> => {
  const payload = event.payload as unknown as CosmeticTesterPayload;
  if (rialBigInt(payload.cost) === 0n) return null;

  const accounts = await accountIdsByCode(client, event.businessId, [
    WELL_KNOWN_CODES.cosmeticExpiredAndTester,
    WELL_KNOWN_CODES.cosmeticInventory,
  ]);

  return {
    lines: [
      { accountId: accounts.get(WELL_KNOWN_CODES.cosmeticExpiredAndTester)!, debit: payload.cost, credit: ZERO },
      { accountId: accounts.get(WELL_KNOWN_CODES.cosmeticInventory)!, debit: ZERO, credit: payload.cost },
    ],
    memo: "تستر / نمونه",
    postingKind: "cosmetic_tester",
  };
});

registerPostingRule("cosmetic.expiry_write_off", async (event, client): Promise<PostingResult | null> => {
  const payload = event.payload as unknown as CosmeticExpiryWriteOffPayload;
  if (rialBigInt(payload.cost) === 0n) return null;

  const accounts = await accountIdsByCode(client, event.businessId, [
    WELL_KNOWN_CODES.cosmeticExpiredAndTester,
    WELL_KNOWN_CODES.cosmeticInventory,
  ]);

  return {
    lines: [
      { accountId: accounts.get(WELL_KNOWN_CODES.cosmeticExpiredAndTester)!, debit: payload.cost, credit: ZERO },
      { accountId: accounts.get(WELL_KNOWN_CODES.cosmeticInventory)!, debit: ZERO, credit: payload.cost },
    ],
    memo: "کالای منقضی",
    postingKind: "cosmetic_expiry_write_off",
  };
});
