/**
 * Phase 38 — wholesale / tools & fittings / haberdashery trade-goods service.
 *
 * Three industries, one shared DB-touching module. All three sell countable
 * finished goods from the same `items`/`item_stock` model accessories uses, so
 * catalogue management (families + variants, stock, average cost, shelf price)
 * is already solved by `accessories-service.ts` and is reused unchanged. The
 * only thing this file owns is the *sale*: it emits the trade's own
 * `{trade}.sale_revenue`/`{trade}.sale_cogs` events, so posting lands in that
 * trade's chart of accounts and the trade's reports read back the same events.
 *
 * DB-touching, so per repo convention it has no direct unit test; covered by
 * integration/trade-goods.integration.test.ts.
 */
import { randomUUID } from "node:crypto";
import { query, type PoolClient } from "./db";
import { getItem } from "./items-service";
import {
  getStock,
  listVariantBoard,
  receiveStock,
  setUnitPrice,
  type ItemStock,
  type VariantSummary,
} from "./accessories-service";
import { emitDomainEvent } from "./posting-engine";
import type { RialText } from "./inventory-exact";
import type { SettlementMethod } from "./ledger";
import { resolveLineTenders, type RetailTenderQueueEntry } from "./retail-tenders";
import {
  computeTradeGoodsSalePrice,
  nextTradeGoodsAverageUnitCost,
  tradeGoodsCogs,
  validateTradeGoodsReceipt,
  isTradeGoodsIndustry,
  type TradeGoodsIndustry,
} from "./trade-goods";
// Side-effect import: registers the {trade}.sale_* posting rules with the engine.
import "./trade-goods-posting-rules";

export type { ItemStock, VariantSummary };

/** Stock and pricing are trade-agnostic on the item model; re-exported for the shared routes. */
export { getStock, listVariantBoard, receiveStock, setUnitPrice };

export interface SellTradeGoodsInput {
  /** The trade-goods industry — the one that brands the event and the accounts. */
  trade: TradeGoodsIndustry;
  businessId: string;
  locationId: string;
  itemId: string;
  quantity: string;
  /** Overrides the shelf price for this sale; omit to use `item_stock.unit_price`. */
  unitPrice?: number;
  discount?: number;
  vatPercent: number;
  /** The whole line paid one way — every pre-split caller. */
  paymentMethod?: SettlementMethod;
  /** A retail invoice's shared tender queue (retail-tenders.ts) — mutually exclusive with `paymentMethod`. */
  tenders?: RetailTenderQueueEntry[];
  createdBy?: string | null;
}

export interface SellTradeGoodsResult {
  breakdown: {
    gross: RialText;
    discount: RialText;
    net: RialText;
    vat: RialText;
    total: RialText;
  };
  revenueEntryId: string | null;
  cogsEntryId: string | null;
  /** The COGS this sale posted, Rial — the same number the commission margin basis uses. */
  cost: RialText;
}

/**
 * Sells units of one variant in the caller's own transaction: posts the
 * trade's revenue and COGS (two events, the same split every sale in this
 * phase uses) and decrements the quantity on hand — atomically, so stock can
 * never drift from what the ledger was told.
 */
export async function sellTradeGoodsUnits(
  client: PoolClient,
  input: SellTradeGoodsInput,
): Promise<SellTradeGoodsResult> {
  if (!isTradeGoodsIndustry(input.trade)) {
    throw new Error("این نوع کسب‌وکار از کالای شمارشی با رویداد اختصاصی پشتیبانی نمی‌کند.");
  }

  const item = await getItem(input.itemId);
  if (!item) throw new Error("کالا یافت نشد.");
  if (item.kind === "variant_parent") {
    throw new Error("خانوادهٔ کالا فروختنی نیست؛ یکی از تنوع‌ها را انتخاب کنید.");
  }

  const { rows: stockRows } = await client.query<{
    item_id: string;
    quantity: string;
    unit_cost: string | null;
    unit_price: string | null;
  }>(`SELECT * FROM item_stock WHERE item_id = $1 FOR UPDATE`, [input.itemId]);
  const stock: ItemStock | null = stockRows[0]
    ? {
        itemId: stockRows[0].item_id,
        quantity: stockRows[0].quantity,
        unitCost: stockRows[0].unit_cost == null ? null : Number(stockRows[0].unit_cost),
        unitPrice: stockRows[0].unit_price == null ? null : Number(stockRows[0].unit_price),
      }
    : null;
  if (!stock) throw new Error("موجودی این کالا ثبت نشده است.");
  if (stock.unitCost == null) {
    throw new Error("بهای تمام‌شده این کالا ثبت نشده است؛ ابتدا ورود کالا را ثبت کنید.");
  }

  const unitPrice = input.unitPrice ?? stock.unitPrice;
  if (unitPrice == null) throw new Error("قیمت فروش این کالا تعیین نشده است.");

  const breakdown = computeTradeGoodsSalePrice({
    unitPrice,
    quantity: input.quantity,
    discount: input.discount ?? 0,
    vatPercent: input.vatPercent,
  });

  // The CHECK (quantity >= 0) on item_stock is the real guard against
  // overselling; this is the readable error in front of it.
  if (Number(stock.quantity) < Number(input.quantity)) {
    throw new Error("موجودی کافی نیست.");
  }

  const cost = tradeGoodsCogs(input.quantity, stock.unitCost);

  // See the identical comment in accessories-service.ts's sellAccessoryUnits:
  // `uq_journal_business_source_posting` is unique on (business_id,
  // source_type, source_id, posting_kind), so keying the posting identity on
  // `input.itemId` — as this used to — only let a trade-goods item ever be
  // sold once, ever; every later sale of the same item threw a raw unique
  // violation. `domain_events.source_id` keeps carrying `input.itemId`
  // (reports group/join on it); `postingSourceId` is the separate identity
  // the ledger posting itself uses, fresh per sale.
  const postingSourceId = randomUUID();
  const lineTenders = resolveLineTenders(input, breakdown.total);

  const { entryId: revenueEntryId } = await emitDomainEvent(client, {
    businessId: input.businessId,
    locationId: input.locationId,
    eventType: `${input.trade}.sale_revenue`,
    payload: {
      itemId: input.itemId,
      quantity: input.quantity,
      unitPrice,
      gross: breakdown.gross,
      discount: breakdown.discount,
      net: breakdown.net,
      vat: breakdown.vat,
      total: breakdown.total,
      tenders: lineTenders,
    },
    sourceType: `${input.trade}_sale`,
    sourceId: input.itemId,
    postingSourceId,
    createdBy: input.createdBy ?? null,
  });

  const { entryId: cogsEntryId } = await emitDomainEvent(client, {
    businessId: input.businessId,
    locationId: input.locationId,
    eventType: `${input.trade}.sale_cogs`,
    payload: { itemId: input.itemId, quantity: input.quantity, cost },
    sourceType: `${input.trade}_sale`,
    sourceId: input.itemId,
    postingSourceId,
    createdBy: input.createdBy ?? null,
  });

  await client.query(
    `UPDATE item_stock SET quantity = quantity - $2, last_sold_at = now(), updated_at = now() WHERE item_id = $1`,
    [input.itemId, input.quantity],
  );

  return {
    breakdown: {
      gross: breakdown.gross,
      discount: breakdown.discount,
      net: breakdown.net,
      vat: breakdown.vat,
      total: breakdown.total,
    },
    revenueEntryId,
    cogsEntryId,
    cost,
  };
}

/**
 * Receives units into a trade-goods variant. This is the shared stock path the
 * trade routes use; it leans on the exact-arithmetic receipt from accessories.
 * Kept here so the trade's own routes do not import a differently-aimed module
 * name for what is the same operation.
 */
export async function receiveTradeGoodsStock(
  itemId: string,
  input: { quantity: string; unitCost: number },
  client?: PoolClient,
): Promise<ItemStock> {
  const errors = validateTradeGoodsReceipt(input);
  if (errors.length > 0) throw new Error(errors.join("؛ "));
  const item = await getItem(itemId);
  if (!item) throw new Error("کالا یافت نشد.");
  if (item.kind === "variant_parent") {
    throw new Error("موجودی روی خودِ خانوادهٔ کالا ثبت نمی‌شود؛ روی هر تنوع جداگانه ثبت کنید.");
  }

  const run = <T extends Record<string, unknown>>(text: string, params: unknown[]) =>
    client ? client.query<T>(text, params as never) : query<T>(text, params);

  const { rows: existingRows } = await run<{
    item_id: string;
    quantity: string;
    unit_cost: string | null;
    unit_price: string | null;
  }>(
    client ? `SELECT * FROM item_stock WHERE item_id = $1 FOR UPDATE` : `SELECT * FROM item_stock WHERE item_id = $1`,
    [itemId],
  );
  const existing: ItemStock | null = existingRows[0]
    ? {
        itemId: existingRows[0].item_id,
        quantity: existingRows[0].quantity,
        unitCost: existingRows[0].unit_cost == null ? null : Number(existingRows[0].unit_cost),
        unitPrice: existingRows[0].unit_price == null ? null : Number(existingRows[0].unit_price),
      }
    : null;

  const newCost = nextTradeGoodsAverageUnitCost(
    existing?.quantity ?? "0",
    existing?.unitCost ?? null,
    input.quantity,
    input.unitCost,
  );

  const { rows } = await run<{
    item_id: string;
    quantity: string;
    unit_cost: string | null;
    unit_price: string | null;
  }>(
    `INSERT INTO item_stock (item_id, quantity, unit_cost) VALUES ($1, $2, $3)
     ON CONFLICT (item_id) DO UPDATE
       SET quantity = item_stock.quantity + EXCLUDED.quantity,
           unit_cost = EXCLUDED.unit_cost,
           updated_at = now()
     RETURNING *`,
    [itemId, input.quantity, newCost],
  );
  return {
    itemId: rows[0].item_id,
    quantity: rows[0].quantity,
    unitCost: rows[0].unit_cost == null ? null : Number(rows[0].unit_cost),
    unitPrice: rows[0].unit_price == null ? null : Number(rows[0].unit_price),
  };
}

export async function setTradeGoodsUnitPrice(itemId: string, unitPrice: number): Promise<ItemStock> {
  return setUnitPrice(itemId, unitPrice);
}
