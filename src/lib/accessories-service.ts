/**
 * Phase 21 Wave 6 — accessories (بدلیجات): variant stock, pricing, and
 * sales (DB-touching).
 *
 * Wave 1 already built the variant model this leans on entirely
 * (`items` with kind variant_parent/variant_child plus
 * `item_variant_attributes`, and `createVariantChild` to create one
 * atomically) — which is exactly why this wave is the thin one. What is
 * added here is the fungible half a variant needs and the other two
 * industries don't: quantity on hand, a running average cost, a shelf
 * price (`item_stock`, migration 0068), and a sale that relieves them.
 *
 * DB-touching, so per repo convention (see accessories.ts for the pure
 * rules this leans on) it has no direct unit test; covered instead by
 * integration/accessories.integration.test.ts.
 */
import { randomUUID } from "node:crypto";
import { query, type PoolClient } from "./db";
import {
  accessoryCogs,
  computeAccessorySalePrice,
  nextAverageUnitCost,
  validateStockReceipt,
  type AccessorySalePriceBreakdown,
} from "./accessories";
import { getItem } from "./items-service";
import { emitDomainEvent } from "./posting-engine";
import type { RialText } from "./inventory-exact";
import type { SettlementMethod } from "./ledger";
import { resolveLineTenders, type RetailTenderQueueEntry } from "./retail-tenders";
// Side-effect import: registers the accessory.* posting rules with the engine.
import "./accessories-posting-rules";

export interface ItemStock {
  itemId: string;
  quantity: string;
  unitCost: number | null;
  unitPrice: number | null;
}

interface StockRow extends Record<string, unknown> {
  item_id: string;
  quantity: string;
  unit_cost: string | null;
  unit_price: string | null;
}

function mapStock(row: StockRow): ItemStock {
  return {
    itemId: row.item_id,
    quantity: row.quantity,
    unitCost: row.unit_cost == null ? null : Number(row.unit_cost),
    unitPrice: row.unit_price == null ? null : Number(row.unit_price),
  };
}

export async function getStock(itemId: string, client?: PoolClient): Promise<ItemStock | null> {
  const run = <T extends Record<string, unknown>>(text: string, params: unknown[]) =>
    client ? client.query<T>(text, params as never) : query<T>(text, params);

  const { rows } = await run<StockRow>(`SELECT * FROM item_stock WHERE item_id = $1`, [itemId]);
  return rows[0] ? mapStock(rows[0]) : null;
}

/** Only a sellable variant carries stock: a variant_parent is a product family, not a thing on a shelf. */
async function assertSellableVariant(itemId: string, client?: PoolClient): Promise<void> {
  const item = await getItem(itemId, client);
  if (!item) throw new Error("کالا یافت نشد.");
  if (item.kind === "variant_parent") {
    throw new Error("موجودی روی خودِ خانوادهٔ کالا ثبت نمی‌شود؛ روی هر تنوع جداگانه ثبت کنید.");
  }
  if (item.tracking !== "none") {
    throw new Error("این روش فقط برای کالای بدون ردیابی وزنی/سریالی است.");
  }
}

/** Sets the shelf price of one variant (Rial per unit, pre-VAT), creating its stock row if this is the first thing recorded about it. */
export async function setUnitPrice(
  itemId: string,
  unitPrice: number,
  client?: PoolClient,
): Promise<ItemStock> {
  if (!Number.isInteger(unitPrice) || unitPrice <= 0) {
    throw new Error("قیمت فروش هر واحد باید یک عدد صحیح مثبت (ریال) باشد.");
  }
  await assertSellableVariant(itemId, client);

  const statement = `INSERT INTO item_stock (item_id, unit_price) VALUES ($1, $2)
     ON CONFLICT (item_id) DO UPDATE SET unit_price = EXCLUDED.unit_price, updated_at = now()
     RETURNING *`;
  const { rows } = client
    ? await client.query<StockRow>(statement, [itemId, unitPrice])
    : await query<StockRow>(statement, [itemId, unitPrice]);
  return mapStock(rows[0]);
}

/**
 * Records an opening purchase cost before any quantity exists. This is not a
 * receipt and therefore must never overwrite the weighted-average cost of
 * existing stock. The add-product form uses it when a purchase price is known
 * but opening quantity is left empty or zero.
 */
export async function setInitialUnitCost(
  itemId: string,
  unitCost: number,
  client?: PoolClient,
): Promise<ItemStock> {
  if (!Number.isInteger(unitCost) || unitCost < 0) {
    throw new Error("قیمت خرید هر واحد باید یک عدد صحیح غیرمنفی (ریال) باشد.");
  }
  await assertSellableVariant(itemId, client);

  const statement = `INSERT INTO item_stock (item_id, unit_cost) VALUES ($1, $2)
     ON CONFLICT (item_id) DO UPDATE
       SET unit_cost = EXCLUDED.unit_cost, updated_at = now()
       WHERE item_stock.quantity = 0
     RETURNING *`;
  const { rows } = client
    ? await client.query<StockRow>(statement, [itemId, unitCost])
    : await query<StockRow>(statement, [itemId, unitCost]);
  if (!rows[0]) {
    throw new Error("قیمت خرید اولیه پس از ثبت موجودی قابل جایگزینی نیست.");
  }
  return mapStock(rows[0]);
}

/**
 * Receives units into stock, rolling the running weighted-average cost
 * forward (accessories.ts's `nextAverageUnitCost`). Read-then-write inside
 * one statement's `ON CONFLICT DO UPDATE` isn't enough here — the new
 * average depends on the row's current values — so the read is taken
 * `FOR UPDATE` in the caller's transaction when one is supplied.
 */
export async function receiveStock(
  itemId: string,
  input: { quantity: string; unitCost: number },
  client?: PoolClient,
): Promise<ItemStock> {
  const errors = validateStockReceipt(input);
  if (errors.length > 0) throw new Error(errors.join("؛ "));
  await assertSellableVariant(itemId, client);

  const run = <T extends Record<string, unknown>>(text: string, params: unknown[]) =>
    client ? client.query<T>(text, params as never) : query<T>(text, params);

  const { rows: existingRows } = await run<StockRow>(
    client ? `SELECT * FROM item_stock WHERE item_id = $1 FOR UPDATE` : `SELECT * FROM item_stock WHERE item_id = $1`,
    [itemId],
  );
  const existing = existingRows[0] ? mapStock(existingRows[0]) : null;

  const newCost = nextAverageUnitCost(
    existing?.quantity ?? "0",
    existing?.unitCost ?? null,
    input.quantity,
    input.unitCost,
  );

  const { rows } = await run<StockRow>(
    `INSERT INTO item_stock (item_id, quantity, unit_cost) VALUES ($1, $2, $3)
     ON CONFLICT (item_id) DO UPDATE
       SET quantity = item_stock.quantity + EXCLUDED.quantity,
           unit_cost = EXCLUDED.unit_cost,
           updated_at = now()
     RETURNING *`,
    [itemId, input.quantity, newCost],
  );
  return mapStock(rows[0]);
}

export interface SellAccessoryInput {
  businessId: string;
  locationId: string;
  itemId: string;
  quantity: string;
  /** Overrides the shelf price for this sale; omit to use `item_stock.unit_price`. */
  unitPrice?: number;
  discount?: number;
  vatPercent: number;
  /** The whole line paid one way — every pre-split caller (the accessories quick-sell panel). */
  paymentMethod?: SettlementMethod;
  /** A retail invoice's shared tender queue (retail-tenders.ts) — mutually exclusive with `paymentMethod`. */
  tenders?: RetailTenderQueueEntry[];
  createdBy?: string | null;
}

export interface SellAccessoryResult {
  breakdown: AccessorySalePriceBreakdown;
  revenueEntryId: string | null;
  cogsEntryId: string | null;
  /** The COGS this sale posted, Rial — the same number the commission margin basis uses. */
  cost: RialText;
}

/**
 * Sells units of one variant in the caller's own transaction: posts
 * revenue and COGS (two events, the same split every sale in this phase
 * uses) and decrements the quantity on hand — atomically, so stock can
 * never drift from what the ledger was told.
 */
export async function sellAccessoryUnits(
  client: PoolClient,
  input: SellAccessoryInput,
): Promise<SellAccessoryResult> {
  const item = await getItem(input.itemId);
  if (!item) throw new Error("کالا یافت نشد.");
  if (item.kind === "variant_parent") {
    throw new Error("خانوادهٔ کالا فروختنی نیست؛ یکی از تنوع‌ها را انتخاب کنید.");
  }

  const { rows: stockRows } = await client.query<StockRow>(
    `SELECT * FROM item_stock WHERE item_id = $1 FOR UPDATE`,
    [input.itemId],
  );
  const stock = stockRows[0] ? mapStock(stockRows[0]) : null;
  if (!stock) throw new Error("موجودی این کالا ثبت نشده است.");
  if (stock.unitCost == null) {
    throw new Error("بهای تمام‌شده این کالا ثبت نشده است؛ ابتدا ورود کالا را ثبت کنید.");
  }

  const unitPrice = input.unitPrice ?? stock.unitPrice;
  if (unitPrice == null) throw new Error("قیمت فروش این کالا تعیین نشده است.");

  const breakdown = computeAccessorySalePrice({
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

  const cost = accessoryCogs(input.quantity, stock.unitCost);

  // `journal_entries` enforces at most one posting per
  // (business_id, source_type, source_id, posting_kind) via
  // `uq_journal_business_source_posting` — the ledger's own idempotency key.
  // Keying that off `input.itemId`, as this used to, meant only the *first*
  // sale of any accessory could ever post: every later sale of the same
  // item — the ordinary case for stock a shop expects to sell many times —
  // threw a raw `duplicate key value violates unique constraint
  // "uq_journal_business_source_posting"`. `domain_events.source_id` still
  // carries `input.itemId` below (variantSalesAnalysis/itemAuditTrail group
  // and join on it); `postingSourceId` is a separate, fresh identity that
  // only the ledger posting itself uses, so each sale posts independently.
  const postingSourceId = randomUUID();
  const lineTenders = resolveLineTenders(input, breakdown.total);

  const { entryId: revenueEntryId } = await emitDomainEvent(client, {
    businessId: input.businessId,
    locationId: input.locationId,
    eventType: "accessory.sale_revenue",
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
    sourceType: "accessory_sale",
    sourceId: input.itemId,
    postingSourceId,
    createdBy: input.createdBy ?? null,
  });

  const { entryId: cogsEntryId } = await emitDomainEvent(client, {
    businessId: input.businessId,
    locationId: input.locationId,
    eventType: "accessory.sale_cogs",
    payload: { itemId: input.itemId, quantity: input.quantity, cost },
    sourceType: "accessory_sale",
    sourceId: input.itemId,
    postingSourceId,
    createdBy: input.createdBy ?? null,
  });

  await client.query(
    `UPDATE item_stock SET quantity = quantity - $2, last_sold_at = now(), updated_at = now() WHERE item_id = $1`,
    [input.itemId, input.quantity],
  );

  return { breakdown, revenueEntryId, cogsEntryId, cost };
}

export interface VariantSummary {
  id: string;
  parentItemId: string | null;
  parentName: string | null;
  name: string;
  sku: string | null;
  kind: string;
  isActive: boolean;
  quantity: string;
  unitCost: number | null;
  unitPrice: number | null;
  attributes: { name: string; value: string }[];
  /** Phase 42 — the products workspace's list columns (barcode, units, sellability). */
  barcode: string | null;
  unit: string | null;
  subUnit: string | null;
  conversionFactor: number | null;
  isSellable: boolean;
}

/** The accessories board: every family and variant at this branch, with its attributes, stock and pricing, in one round trip. */
export async function listVariantBoard(locationId: string): Promise<VariantSummary[]> {
  const { rows } = await query<{
    id: string;
    parent_item_id: string | null;
    parent_name: string | null;
    name: string;
    sku: string | null;
    kind: string;
    is_active: boolean;
    quantity: string | null;
    unit_cost: string | null;
    unit_price: string | null;
    attributes: { name: string; value: string }[] | null;
    barcode: string | null;
    unit: string | null;
    sub_unit: string | null;
    conversion_factor: string | null;
    is_sellable: boolean;
  }>(
    `SELECT i.id, i.parent_item_id, p.name AS parent_name, i.name, i.sku, i.kind, i.is_active,
            i.barcode, i.unit, i.sub_unit, i.conversion_factor, i.is_sellable,
            s.quantity, s.unit_cost, s.unit_price,
            COALESCE(
              (SELECT json_agg(json_build_object('name', a.name, 'value', a.value) ORDER BY a.name)
                 FROM item_variant_attributes a WHERE a.item_id = i.id),
              '[]'::json
            ) AS attributes
       FROM items i
       LEFT JOIN items p ON p.id = i.parent_item_id
       LEFT JOIN item_stock s ON s.item_id = i.id
      WHERE i.location_id = $1 AND i.tracking = 'none'
      ORDER BY COALESCE(p.name, i.name), i.kind DESC, i.name`,
    [locationId],
  );

  return rows.map((r) => ({
    id: r.id,
    parentItemId: r.parent_item_id,
    parentName: r.parent_name,
    name: r.name,
    sku: r.sku,
    kind: r.kind,
    isActive: r.is_active,
    quantity: r.quantity ?? "0",
    unitCost: r.unit_cost == null ? null : Number(r.unit_cost),
    unitPrice: r.unit_price == null ? null : Number(r.unit_price),
    attributes: r.attributes ?? [],
    barcode: r.barcode,
    unit: r.unit,
    subUnit: r.sub_unit,
    conversionFactor: r.conversion_factor == null ? null : Number(r.conversion_factor),
    isSellable: r.is_sellable,
  }));
}
