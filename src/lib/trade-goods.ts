/**
 * Phase 38 — the shared "trade goods" model behind wholesale, tools & fittings
 * and haberdashery.
 *
 * All three sell countable finished goods from the same `items`/`item_stock`
 * model that accessories and cosmetics use: a product family
 * (`kind = variant_parent`) with one or more sellable variants
 * (`kind = variant_child`), each carrying a quantity on hand, a running
 * weighted-average unit cost and a shelf price. The trade difference is exactly
 * one of *accounts*, not of shape — so this module reuses the pure stock/price
 * arithmetic already proven for accessories and supplies the trade's own
 * account codes and sale-event prefix.
 *
 * Pure and framework-free (no `db`, no `next`), exactly like its neighbours in
 * `src/lib`, so client components can import the sale-price helper directly and
 * the server service is the only DB-touching half.
 */
import Decimal from "decimal.js";
import type { Industry } from "./industries";
import { WELL_KNOWN_CODES } from "./coa-template";
import {
  computeAccessorySalePrice,
  nextAverageUnitCost,
  validateStockReceipt,
  type AccessorySalePriceBreakdown,
  type AccessorySalePriceInput,
  type StockReceiptInput,
} from "./accessories";
import { roundRial, type RialText } from "./inventory-exact";

/**
 * The trade-goods industries, kept in one place so services, routes and tests
 * agree. Phase 38 opened this set with wholesale / tools & fittings /
 * haberdashery; issue #1567 adds `fashion_apparel` for the same reason — a
 * garment, shoe or bag is a countable finished good sold as a variant child
 * (style × size × colour) over `items`/`item_stock`, with the same receipts,
 * weighted-average cost and sale events, differing only in the accounts.
 */
export const TRADE_GOODS_INDUSTRIES = ["wholesale", "tools_fittings", "haberdashery", "fashion_apparel"] as const;
export type TradeGoodsIndustry = (typeof TRADE_GOODS_INDUSTRIES)[number];

export function isTradeGoodsIndustry(value: Industry | string | null): value is TradeGoodsIndustry {
  return value !== null && (TRADE_GOODS_INDUSTRIES as readonly string[]).includes(value);
}

export interface TradeGoodsAccounts {
  /** `item_stock` cost basis and the retail stock module's inventory account. */
  inventory: string;
  sales: string;
  cogs: string;
}

/** The trade's own posting accounts and its domain-event prefix. */
export const TRADE_GOODS_ACCOUNTS: Record<TradeGoodsIndustry, TradeGoodsAccounts> = {
  wholesale: {
    inventory: WELL_KNOWN_CODES.wholesaleInventory,
    sales: WELL_KNOWN_CODES.wholesaleSalesRevenue,
    cogs: WELL_KNOWN_CODES.wholesaleCogs,
  },
  tools_fittings: {
    inventory: WELL_KNOWN_CODES.toolsInventory,
    sales: WELL_KNOWN_CODES.toolsSalesRevenue,
    cogs: WELL_KNOWN_CODES.toolsCogs,
  },
  haberdashery: {
    inventory: WELL_KNOWN_CODES.haberdasheryInventory,
    sales: WELL_KNOWN_CODES.haberdasherySalesRevenue,
    cogs: WELL_KNOWN_CODES.haberdasheryCogs,
  },
  // Issue #1567 — the fashion trade's own finished-goods triple (1374/4584/5184).
  fashion_apparel: {
    inventory: WELL_KNOWN_CODES.fashionInventory,
    sales: WELL_KNOWN_CODES.fashionSalesRevenue,
    cogs: WELL_KNOWN_CODES.fashionCogs,
  },
};

/** The `*.sale_revenue` / `*.sale_cogs` domain-event prefix for a trade. */
export function tradeGoodsEventPrefix(trade: TradeGoodsIndustry): string {
  return trade;
}

/** The trade's own accounts, resolved for a business id that is guaranteed to be a trade-goods industry. */
export function tradeGoodsAccountsFor(trade: TradeGoodsIndustry): TradeGoodsAccounts {
  return TRADE_GOODS_ACCOUNTS[trade];
}

/** Receipt validation — the same rules accessories use, because the stock model is the same. */
export function validateTradeGoodsReceipt(input: StockReceiptInput): string[] {
  return validateStockReceipt(input);
}

/** The running weighted-average unit cost after a receipt — see `nextAverageUnitCost`. */
export function nextTradeGoodsAverageUnitCost(
  existingQty: string,
  existingUnitCost: number | null,
  incomingQty: string,
  incomingUnitCost: number,
): RialText {
  return nextAverageUnitCost(existingQty, existingUnitCost, incomingQty, incomingUnitCost);
}

/** A one-line sale price breakdown for a trade-goods line. */
export function computeTradeGoodsSalePrice(input: AccessorySalePriceInput): AccessorySalePriceBreakdown {
  return computeAccessorySalePrice(input);
}

/** The cost of goods sold for `quantity` units carried at `unitCost`. */
export function tradeGoodsCogs(quantity: string, unitCost: number): RialText {
  return roundRial(new Decimal(quantity).times(unitCost));
}
