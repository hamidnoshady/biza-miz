/**
 * Phase 21 Wave 5 — watch sale and repair posting rules, registered against
 * Wave 1's domain-event/posting engine.
 *
 * Four rules, following the same "revenue and cost are two entries, not
 * one" split Phase 7 chose for F&B order payments and Wave 3 reused for
 * gold:
 *
 *   - `watch.sale_revenue`: Debit Cash/Bank-Clearing/Accounts-Receivable by
 *     payment method for the total; Credit `watchSalesRevenue` for the
 *     net (post-discount) price and `vatPayable` for VAT. Unlike gold,
 *     nothing here is VAT-exempt — a watch is finished goods, not metal.
 *   - `watch.sale_cogs`: Debit `watchCogs` / Credit `watchInventory` for the
 *     unit's own recorded cost (item_serials.unit_cost). One physical unit,
 *     one purchase, one cost — no lot/average question to answer.
 *   - `watch.repair_revenue`: Debit the payment account for the total;
 *     Credit `repairServiceRevenue` for labor + parts billed, `vatPayable`
 *     for VAT. A warranty repair bills nothing, so this rule returns `null`
 *     for a zero total — the engine records the event and posts no entry,
 *     exactly the case it was designed to allow.
 *   - `watch.repair_cogs`: Debit `repairPartsExpense` / Credit
 *     `watchInventory` for what the consumed parts cost the shop. This
 *     posts even on a warranty repair, which is the entire point of keeping
 *     a part's cost and its charge as two separate columns: the shop ate
 *     the cost, and the books have to show it.
 *
 * Parts cost is read live from `repair_ticket_parts` at posting time rather
 * than passed through the event payload — the same "resolve against the
 * current record, not a caller-supplied snapshot" instinct
 * `gold.sale_cogs` already applies to `item_stones`.
 */
import Decimal from "decimal.js";
import { WELL_KNOWN_CODES } from "./coa-template";
import { rialBigInt, roundRial, type RialText } from "./inventory-exact";
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

interface WatchSaleRevenuePayload {
  serialId: string;
  itemId: string;
  net: RialText;
  vat: RialText;
  total: RialText;
  tenders: RetailTender[];
}

registerPostingRule("watch.sale_revenue", async (event, client): Promise<PostingResult | null> => {
  const payload = event.payload as unknown as WatchSaleRevenuePayload;
  const debits = groupTendersByCode(payload.tenders, (m) => PAYMENT_ACCOUNT_CODE[m]);

  const accounts = await accountIdsByCode(client, event.businessId, [
    ...debits.map((d) => d.code),
    WELL_KNOWN_CODES.watchSalesRevenue,
    WELL_KNOWN_CODES.vatPayable,
  ]);

  return {
    lines: [
      ...debits.map((d) => ({ accountId: accounts.get(d.code)!, debit: d.amount, credit: ZERO })),
      { accountId: accounts.get(WELL_KNOWN_CODES.watchSalesRevenue)!, debit: ZERO, credit: payload.net },
      { accountId: accounts.get(WELL_KNOWN_CODES.vatPayable)!, debit: ZERO, credit: payload.vat },
    ],
    memo: "فروش ساعت",
    postingKind: "watch_sale_revenue",
  };
});

interface WatchSaleCogsPayload {
  serialId: string;
  unitCost: RialText;
}

registerPostingRule("watch.sale_cogs", async (event, client): Promise<PostingResult | null> => {
  const payload = event.payload as unknown as WatchSaleCogsPayload;
  if (rialBigInt(payload.unitCost) === 0n) return null;

  const accounts = await accountIdsByCode(client, event.businessId, [
    WELL_KNOWN_CODES.watchCogs,
    WELL_KNOWN_CODES.watchInventory,
  ]);

  return {
    lines: [
      { accountId: accounts.get(WELL_KNOWN_CODES.watchCogs)!, debit: payload.unitCost, credit: ZERO },
      { accountId: accounts.get(WELL_KNOWN_CODES.watchInventory)!, debit: ZERO, credit: payload.unitCost },
    ],
    memo: "بهای تمام‌شده ساعت فروخته‌شده",
    postingKind: "watch_sale_cogs",
  };
});

interface RepairRevenuePayload {
  ticketId: string;
  net: RialText;
  vat: RialText;
  total: RialText;
  paymentMethod: SettlementMethod;
}

registerPostingRule("watch.repair_revenue", async (event, client): Promise<PostingResult | null> => {
  const payload = event.payload as unknown as RepairRevenuePayload;
  // A warranty repair bills nothing. Recorded as an event (the repair
  // happened), posted as nothing (no revenue, no receivable) — the engine's
  // documented "not every domain event has a ledger effect" path.
  if (rialBigInt(payload.total) === 0n) return null;

  const paymentCode = PAYMENT_ACCOUNT_CODE[payload.paymentMethod];
  const accounts = await accountIdsByCode(client, event.businessId, [
    paymentCode,
    WELL_KNOWN_CODES.repairServiceRevenue,
    WELL_KNOWN_CODES.vatPayable,
  ]);

  return {
    lines: [
      { accountId: accounts.get(paymentCode)!, debit: payload.total, credit: ZERO },
      { accountId: accounts.get(WELL_KNOWN_CODES.repairServiceRevenue)!, debit: ZERO, credit: payload.net },
      { accountId: accounts.get(WELL_KNOWN_CODES.vatPayable)!, debit: ZERO, credit: payload.vat },
    ],
    memo: "درآمد تعمیرات",
    postingKind: "watch_repair_revenue",
  };
});

interface RepairCogsPayload {
  ticketId: string;
}

registerPostingRule("watch.repair_cogs", async (event, client): Promise<PostingResult | null> => {
  const payload = event.payload as unknown as RepairCogsPayload;

  const { rows } = await client.query<{ total: string | null }>(
    `SELECT SUM(quantity * unit_cost)::text AS total FROM repair_ticket_parts WHERE ticket_id = $1`,
    [payload.ticketId],
  );
  const cost = roundRial(new Decimal(rows[0]?.total ?? 0));
  if (rialBigInt(cost) === 0n) return null;

  const accounts = await accountIdsByCode(client, event.businessId, [
    WELL_KNOWN_CODES.repairPartsExpense,
    WELL_KNOWN_CODES.watchInventory,
  ]);

  return {
    lines: [
      { accountId: accounts.get(WELL_KNOWN_CODES.repairPartsExpense)!, debit: cost, credit: ZERO },
      { accountId: accounts.get(WELL_KNOWN_CODES.watchInventory)!, debit: ZERO, credit: cost },
    ],
    memo: "بهای قطعات مصرفی تعمیرات",
    postingKind: "watch_repair_cogs",
  };
});
