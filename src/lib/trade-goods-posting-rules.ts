/**
 * Phase 38 — trade-goods sale posting rules, registered against the
 * domain-event/posting engine.
 *
 * Wholesale, tools & fittings and haberdashery are all ordinary finished
 * goods, so each gets the same two rules accessories/cosmetics get — the
 * plain revenue/COGS pair — differing only in the accounts they post to. The
 * trade is encoded in the event type (`wholesale.sale_revenue`,
 * `tools_fittings.sale_revenue`, `haberdashery.sale_revenue`, …) exactly like
 * `accessory.*`/`cosmetic.*`, so a sale is always routed to its own chart of
 * accounts and reports can never mix two trades.
 *
 *   - {trade}.sale_revenue: Debit Cash/Bank-Clearing/AR by payment method for
 *     the total; Credit {trade}SalesRevenue for the net (post-discount) line
 *     and `vatPayable` for VAT.
 *   - {trade}.sale_cogs: Debit {trade}Cogs / Credit {trade}Inventory for
 *     quantity × the variant's running average unit cost.
 */
import { WELL_KNOWN_CODES } from "./coa-template";
import { rialBigInt, type RialText } from "./inventory-exact";
import { accountIdsByCode } from "./ledger-service";
import { registerPostingRule, type PostingResult } from "./posting-engine";
import type { SettlementMethod } from "./ledger";
import { TRADE_GOODS_ACCOUNTS, TRADE_GOODS_INDUSTRIES, type TradeGoodsIndustry } from "./trade-goods";
import { groupTendersByCode, type RetailTender } from "./retail-tenders";

const PAYMENT_ACCOUNT_CODE: Record<SettlementMethod, string> = {
  cash: WELL_KNOWN_CODES.cash,
  bank: WELL_KNOWN_CODES.bankClearing,
  credit: WELL_KNOWN_CODES.accountsReceivable,
};

const ZERO = "0" as RialText;

interface TradeGoodsSaleRevenuePayload {
  itemId: string;
  quantity: string;
  net: RialText;
  vat: RialText;
  total: RialText;
  tenders: RetailTender[];
}

interface TradeGoodsSaleCogsPayload {
  itemId: string;
  quantity: string;
  cost: RialText;
}

for (const trade of TRADE_GOODS_INDUSTRIES) {
  const accounts = TRADE_GOODS_ACCOUNTS[trade];

  registerPostingRule(`${trade}.sale_revenue`, async (event, client): Promise<PostingResult | null> => {
    const payload = event.payload as unknown as TradeGoodsSaleRevenuePayload;
    const debits = groupTendersByCode(payload.tenders, (m) => PAYMENT_ACCOUNT_CODE[m]);

    const ids = await accountIdsByCode(client, event.businessId, [
      ...debits.map((d) => d.code),
      accounts.sales,
      WELL_KNOWN_CODES.vatPayable,
    ]);

    return {
      lines: [
        ...debits.map((d) => ({ accountId: ids.get(d.code)!, debit: d.amount, credit: ZERO })),
        { accountId: ids.get(accounts.sales)!, debit: ZERO, credit: payload.net },
        { accountId: ids.get(WELL_KNOWN_CODES.vatPayable)!, debit: ZERO, credit: payload.vat },
      ],
      memo: saleMemo(trade),
      postingKind: `${trade}_sale_revenue`,
    };
  });

  registerPostingRule(`${trade}.sale_cogs`, async (event, client): Promise<PostingResult | null> => {
    const payload = event.payload as unknown as TradeGoodsSaleCogsPayload;
    if (rialBigInt(payload.cost) === 0n) return null;

    const ids = await accountIdsByCode(client, event.businessId, [accounts.cogs, accounts.inventory]);

    return {
      lines: [
        { accountId: ids.get(accounts.cogs)!, debit: payload.cost, credit: ZERO },
        { accountId: ids.get(accounts.inventory)!, debit: ZERO, credit: payload.cost },
      ],
      memo: cogsMemo(trade),
      postingKind: `${trade}_sale_cogs`,
    };
  });
}

function saleMemo(trade: TradeGoodsIndustry): string {
  switch (trade) {
    case "wholesale":
      return "فروش عمده";
    case "tools_fittings":
      return "فروش ابزار و یراق‌آلات";
    case "haberdashery":
      return "فروش لوازم خرازی";
  }
}

function cogsMemo(trade: TradeGoodsIndustry): string {
  switch (trade) {
    case "wholesale":
      return "بهای تمام‌شده کالای عمده فروخته‌شده";
    case "tools_fittings":
      return "بهای تمام‌شده ابزار و یراق فروخته‌شده";
    case "haberdashery":
      return "بهای تمام‌شده لوازم خرازی فروخته‌شده";
  }
}
