/**
 * Phase 21 Wave 3 — gold sale posting rules, registered against Wave 1's
 * domain-event/posting engine.
 *
 * Two entries per sale, not one — the same split Phase 7 decided for F&B
 * order payments (revenue recognition vs. cost of the goods sold are
 * conceptually distinct events):
 *
 *   - `gold.sale_revenue`: Debit Cash/Bank-Clearing/Accounts-Receivable
 *     (by payment method) for the total price; Credit `goldSalesRevenue`
 *     for the metal value (VAT-exempt), `makingChargeRevenue` for making
 *     charge + profit combined, and `vatPayable` for VAT — mirroring the
 *     gold-pricing engine's own VAT-on-اجرت-و-سود-only rule
 *     (src/lib/gold-pricing.ts).
 *   - `gold.sale_cogs`: Debit `goldCogs` / Credit `goldInventory` for the
 *     sold piece's cost basis (net weight × unit_cost_per_gram, plus the
 *     sum of any item_stones cost add-ons — Wave 4). Stone costs are read
 *     live from item_stones rather than passed through the event payload,
 *     the same "resolve against the current record, not a caller-supplied
 *     snapshot" instinct accountIdsByCode already uses for account ids.
 *
 * `consignment.payout` (Wave 7) settles what those sales credited: Debit
 * `consignmentPayable`, Credit the cash/bank account the money left from —
 * the second half of the "invoice, then collect/pay" shape Phase 16's AR/AP
 * subledgers already use, which Wave 4 deliberately left for its own slice.
 *
 * `gold.consignment_sale_revenue` (Wave 4) is a third, separate rule for a
 * consigned (امانی) piece — same pricing engine, different posting. The
 * shop never owned the piece, so there is no `gold.sale_cogs` counterpart
 * for a consignment sale at all (nothing to relieve from inventory): Debit
 * the payment account for the total, same as an owned-inventory sale;
 * Credit `consignmentPayable` for metal value + making charge (owed to the
 * consignor, not the shop's revenue); Credit `consignmentCommissionRevenue`
 * for profit (the pricing engine's "profit" input becomes the shop's
 * commission here, per the product owner's confirmed decision — same
 * formula, different meaning); Credit `vatPayable` for VAT, unchanged.
 */
import Decimal from "decimal.js";
import type { PoolClient } from "pg";
import { WELL_KNOWN_CODES } from "./coa-template";
import { rialBigInt, rialText, roundRial, type RialText } from "./inventory-exact";
import { accountIdsByCode } from "./ledger-service";
import { registerPostingRule, type PostingResult } from "./posting-engine";
import type { SettlementMethod } from "./ledger";
import { groupTendersByCode, type RetailTender } from "./retail-tenders";

interface GoldSaleRevenuePayload {
  itemId: string;
  metalValue: RialText;
  makingChargePlusProfit: RialText;
  vat: RialText;
  total: RialText;
  tenders: RetailTender[];
}

const PAYMENT_ACCOUNT_CODE: Record<SettlementMethod, string> = {
  cash: WELL_KNOWN_CODES.cash,
  bank: WELL_KNOWN_CODES.bankClearing,
  credit: WELL_KNOWN_CODES.accountsReceivable,
};

registerPostingRule("gold.sale_revenue", async (event, client): Promise<PostingResult | null> => {
  const payload = event.payload as unknown as GoldSaleRevenuePayload;
  const debits = groupTendersByCode(payload.tenders, (m) => PAYMENT_ACCOUNT_CODE[m]);

  const accounts = await accountIdsByCode(client, event.businessId, [
    ...debits.map((d) => d.code),
    WELL_KNOWN_CODES.goldSalesRevenue,
    WELL_KNOWN_CODES.makingChargeRevenue,
    WELL_KNOWN_CODES.vatPayable,
  ]);
  const zero = "0" as RialText;

  const lines = [
    ...debits.map((d) => ({ accountId: accounts.get(d.code)!, debit: d.amount, credit: zero })),
    { accountId: accounts.get(WELL_KNOWN_CODES.goldSalesRevenue)!, debit: zero, credit: payload.metalValue },
    {
      accountId: accounts.get(WELL_KNOWN_CODES.makingChargeRevenue)!,
      debit: zero,
      credit: payload.makingChargePlusProfit,
    },
    { accountId: accounts.get(WELL_KNOWN_CODES.vatPayable)!, debit: zero, credit: payload.vat },
  ];

  return {
    lines,
    memo: "فروش طلا",
    postingKind: "gold_sale_revenue",
  };
});

interface GoldConsignmentSaleRevenuePayload {
  itemId: string;
  metalValue: RialText;
  makingCharge: RialText;
  profit: RialText;
  vat: RialText;
  total: RialText;
  tenders: RetailTender[];
}

registerPostingRule(
  "gold.consignment_sale_revenue",
  async (event, client): Promise<PostingResult | null> => {
    const payload = event.payload as unknown as GoldConsignmentSaleRevenuePayload;
    const debits = groupTendersByCode(payload.tenders, (m) => PAYMENT_ACCOUNT_CODE[m]);

    const accounts = await accountIdsByCode(client, event.businessId, [
      ...debits.map((d) => d.code),
      WELL_KNOWN_CODES.consignmentPayable,
      WELL_KNOWN_CODES.consignmentCommissionRevenue,
      WELL_KNOWN_CODES.vatPayable,
    ]);
    const zero = "0" as RialText;
    const consignorPortion = rialText(
      (rialBigInt(payload.metalValue) + rialBigInt(payload.makingCharge)).toString(),
    );

    const lines = [
      ...debits.map((d) => ({ accountId: accounts.get(d.code)!, debit: d.amount, credit: zero })),
      {
        accountId: accounts.get(WELL_KNOWN_CODES.consignmentPayable)!,
        debit: zero,
        credit: consignorPortion,
      },
      {
        accountId: accounts.get(WELL_KNOWN_CODES.consignmentCommissionRevenue)!,
        debit: zero,
        credit: payload.profit,
      },
      { accountId: accounts.get(WELL_KNOWN_CODES.vatPayable)!, debit: zero, credit: payload.vat },
    ];

    return {
      lines,
      memo: "فروش امانی طلا",
      postingKind: "gold_consignment_sale_revenue",
    };
  },
);

interface GoldSaleCogsPayload {
  itemId: string;
  netWeight: string;
  unitCostPerGram: string;
}

/**
 * A sold gold piece's cost basis: metal cost (net weight × unit cost per
 * gram) plus the sum of its stone cost add-ons — the single source of truth
 * for the COGS posting *and* the commission margin basis, so the two can
 * never disagree.
 */
export async function goldSoldCost(
  client: PoolClient,
  input: { itemId: string; netWeight: string; unitCostPerGram: string },
): Promise<RialText> {
  const metalCost = new Decimal(input.netWeight).times(input.unitCostPerGram);

  const { rows: stoneRows } = await client.query<{ total: string | null }>(
    `SELECT SUM(cost)::text AS total FROM item_stones WHERE item_id = $1`,
    [input.itemId],
  );
  const stoneCost = new Decimal(stoneRows[0]?.total ?? 0);

  return roundRial(metalCost.plus(stoneCost));
}

registerPostingRule("gold.sale_cogs", async (event, client): Promise<PostingResult | null> => {
  const payload = event.payload as unknown as GoldSaleCogsPayload;
  const cost = await goldSoldCost(client, {
    itemId: payload.itemId,
    netWeight: payload.netWeight,
    unitCostPerGram: payload.unitCostPerGram,
  });
  if (rialBigInt(cost) === 0n) return null;

  const accounts = await accountIdsByCode(client, event.businessId, [
    WELL_KNOWN_CODES.goldCogs,
    WELL_KNOWN_CODES.goldInventory,
  ]);
  const zero = "0" as RialText;

  return {
    lines: [
      { accountId: accounts.get(WELL_KNOWN_CODES.goldCogs)!, debit: cost, credit: zero },
      { accountId: accounts.get(WELL_KNOWN_CODES.goldInventory)!, debit: zero, credit: cost },
    ],
    memo: "بهای تمام‌شده طلای فروخته‌شده",
    postingKind: "gold_sale_cogs",
  };
});

interface ConsignmentPayoutPayload {
  consignorId: string;
  amount: RialText;
  paymentMethod: SettlementMethod;
}

/**
 * Paying a consignor what their sold goods credited (Wave 7). Only cash and
 * bank make sense here — `credit` would mean the shop paid its consignor by
 * taking on a receivable from them, which is not a thing — so the rule maps
 * a payout through the two settlement accounts and the service layer
 * rejects `credit` before it ever gets here.
 */
registerPostingRule("consignment.payout", async (event, client): Promise<PostingResult | null> => {
  const payload = event.payload as unknown as ConsignmentPayoutPayload;
  if (rialBigInt(payload.amount) === 0n) return null;

  const paymentCode = PAYMENT_ACCOUNT_CODE[payload.paymentMethod];
  const accounts = await accountIdsByCode(client, event.businessId, [
    WELL_KNOWN_CODES.consignmentPayable,
    paymentCode,
  ]);
  const zero = "0" as RialText;

  return {
    lines: [
      { accountId: accounts.get(WELL_KNOWN_CODES.consignmentPayable)!, debit: payload.amount, credit: zero },
      { accountId: accounts.get(paymentCode)!, debit: zero, credit: payload.amount },
    ],
    memo: "تسویه با امانت‌گذار",
    postingKind: "consignment_payout",
  };
});
