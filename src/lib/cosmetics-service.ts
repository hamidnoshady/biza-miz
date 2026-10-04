/**
 * Phase 27 Wave 1 & 2 — cosmetics & toiletries (آرایشی و بهداشتی): variant
 * stock, pricing, sales, batches, expiry and FEFO (DB-touching).
 *
 * Cosmetics reuses Phase 21's retail item model exactly as accessories does
 * (`items` variant_parent/variant_child + `item_stock`), so the receipt,
 * price and stock primitives are the *same* `item_stock` operations
 * accessories-service already implements — re-exported here rather than
 * copied, because there is still exactly one stock engine. What is
 * cosmetics' own is the sale (its own `cosmetic.*` events and accounts) and,
 * since Wave 2, the batch/expiry layer: a `tracking='batch'` item's batches
 * are authoritative and `item_stock.quantity` is their rollup.
 *
 * DB-touching, so per repo convention (see cosmetics.ts and fefo.ts for the
 * pure rules this leans on) it has no direct unit test; covered instead by
 * the integration suite.
 */
import { randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import type { PoolClient } from "pg";
import { getPool, query } from "./db";
import { getStock, receiveStock, setUnitPrice, type ItemStock } from "./accessories-service";
import { cosmeticCogs, computeCosmeticSalePrice, type CosmeticSalePriceBreakdown } from "./cosmetics";
import { isBatchExpired, sellableQuantity } from "./fefo";
import {
  allocateBatchLots,
  allocationBatchNumbers,
  allocationCostValue,
  allocationExpiryDate,
  consumeBatchAllocations,
  loadBatchLotsForUpdate,
  recomputeItemStockRollup,
  averageCostAcrossBatches,
  type BatchAllocation,
} from "./retail-batch-inventory";
import { quantityText, rialText, roundRial, type RialText } from "./inventory-exact";
import { getItem, type Item } from "./items-service";
import { buildVariantMatrix, type MatrixAxis } from "./variant-matrix";
import { emitDomainEvent } from "./posting-engine";
import type { SettlementMethod } from "./ledger";
import { resolveLineTenders, type RetailTenderQueueEntry } from "./retail-tenders";
// Side-effect import: registers the cosmetic.* posting rules with the engine.
import "./cosmetics-posting-rules";

export { getStock, receiveStock, setUnitPrice, type ItemStock };
// The 0078 rollup now lives in the canonical engine (retail-batch-inventory.ts)
// so every stock-changing channel shares one implementation. Re-exported under
// its historical name for the modules that already import it from here.
export { recomputeItemStockRollup as rollItemStockToBatches } from "./retail-batch-inventory";

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

export interface ItemBatch {
  id: string;
  itemId: string;
  batchNumber: string;
  /** ISO date (YYYY-MM-DD) or null. */
  expiryDate: string | null;
  /** Manufacturer date from the label, when known. */
  manufactureDate: string | null;
  quantity: string;
  unitCost: number | null;
  receivedDate: string;
  supplierReference: string | null;
}

interface BatchRow extends Record<string, unknown> {
  id: string;
  item_id: string;
  batch_number: string;
  expiry_date: string | null;
  manufacture_date: string | null;
  quantity: string;
  unit_cost: string | null;
  received_date: string;
  supplier_reference: string | null;
}

const BATCH_COLUMNS =
  "id, item_id, batch_number, expiry_date::text AS expiry_date, manufacture_date::text AS manufacture_date, quantity, unit_cost, received_date::text AS received_date, supplier_reference";

function mapBatch(row: BatchRow): ItemBatch {
  return {
    id: row.id,
    itemId: row.item_id,
    batchNumber: row.batch_number,
    expiryDate: row.expiry_date,
    manufactureDate: row.manufacture_date,
    quantity: row.quantity,
    unitCost: row.unit_cost == null ? null : Number(row.unit_cost),
    receivedDate: row.received_date,
    supplierReference: row.supplier_reference,
  };
}

export async function listBatches(itemId: string, client?: PoolClient): Promise<ItemBatch[]> {
  const run = <T extends Record<string, unknown>>(text: string, params: unknown[]) =>
    client ? client.query<T>(text, params as never) : query<T>(text, params);
  const { rows } = await run<BatchRow>(
    `SELECT ${BATCH_COLUMNS} FROM item_batches WHERE item_id = $1 ORDER BY expiry_date NULLS LAST, batch_number`,
    [itemId],
  );
  return rows.map(mapBatch);
}

/** Today, ISO — injectable so callers can pin it in tests and reports. */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Receives a batch of a `tracking='batch'` item: creates the batch row — or
 * merges into the existing lot with the same manufacturer/supplier number,
 * re-averaging its unit cost exactly as the warehouse receipt path does — and
 * rolls `item_stock` forward so its quantity stays the sum of its batches and
 * its unit cost the weighted average across them. Runs in the caller's
 * transaction so the batch and its rollup commit together.
 *
 * The lot number is the real manufacturer/supplier number whenever the caller
 * has it (purchase receipts pass it through); an internal reference is only
 * ever generated when there is genuinely none.
 */
export async function receiveBatch(
  client: PoolClient,
  input: {
    itemId: string;
    batchNumber: string;
    expiryDate?: string | null;
    /** Manufacturer date, when the label carries one. */
    manufactureDate?: string | null;
    quantity: string;
    unitCost: number;
    supplierReference?: string | null;
  },
): Promise<ItemBatch> {
  const item = await getItem(input.itemId);
  if (!item) throw new Error("کالا یافت نشد.");
  if (item.kind === "variant_parent") {
    throw new Error("موجودی روی خودِ خانوادهٔ کالا ثبت نمی‌شود؛ روی هر تنوع جداگانه ثبت کنید.");
  }
  if (item.tracking !== "batch") {
    throw new Error("این کالا بچ‌محور نیست؛ از ورود عادی کالا استفاده کنید.");
  }
  const batchNumber = input.batchNumber?.trim();
  if (!batchNumber) throw new Error("شماره بچ نمی‌تواند خالی باشد.");
  const quantity = quantityText(input.quantity);
  if (new Decimal(quantity).lte(0)) throw new Error("تعداد ورودی باید بزرگ‌تر از صفر باشد.");
  if (!Number.isInteger(input.unitCost) || input.unitCost < 0) {
    throw new Error("بهای تمام‌شده هر واحد باید یک عدد صحیح غیرمنفی (ریال) باشد.");
  }

  // Same lot arriving again (a repeat purchase of one manufacturer lot, or a
  // supplementary delivery) merges into the existing batch row rather than
  // violating UNIQUE (item_id, batch_number): quantity adds up, unit cost
  // becomes the weighted average of what the lot actually cost, and an expiry
  // already recorded is never overwritten by a blank one. This is the same
  // rule `nextLotUnitCost`/`preservedExpiry` apply to warehouse receipts.
  const { rows: existingRows } = await client.query<BatchRow>(
    `SELECT ${BATCH_COLUMNS} FROM item_batches
      WHERE item_id = $1 AND batch_number = $2 FOR UPDATE`,
    [input.itemId, batchNumber],
  );
  if (existingRows[0]) {
    const existing = mapBatch(existingRows[0]);
    const previousQty = new Decimal(existing.quantity);
    const incomingQty = new Decimal(quantity);
    const previousCost = existing.unitCost == null ? null : new Decimal(existing.unitCost);
    const incomingCost = new Decimal(input.unitCost);
    const mergedCost = previousCost == null
      ? incomingCost
      : previousQty.plus(incomingQty).isZero()
        ? incomingCost
        : previousQty.times(previousCost).plus(incomingQty.times(incomingCost)).div(previousQty.plus(incomingQty));
    const { rows } = await client.query<BatchRow>(
      `UPDATE item_batches
          SET quantity = quantity + $3,
              unit_cost = $4,
              expiry_date = COALESCE(expiry_date, $5::date),
              manufacture_date = COALESCE(manufacture_date, $6::date),
              supplier_reference = COALESCE(supplier_reference, $7)
        WHERE id = $1 AND item_id = $2
        RETURNING ${BATCH_COLUMNS}`,
      [
        existing.id,
        input.itemId,
        quantity,
        roundRial(mergedCost),
        input.expiryDate ?? null,
        input.manufactureDate ?? null,
        input.supplierReference?.trim() || null,
      ],
    );
    await recomputeItemStockRollup(client, input.itemId);
    return mapBatch(rows[0]);
  }

  const { rows } = await client.query<BatchRow>(
    `INSERT INTO item_batches
       (item_id, batch_number, expiry_date, manufacture_date, quantity, unit_cost, received_date, supplier_reference)
     VALUES ($1, $2, $3::date, $4::date, $5, $6, CURRENT_DATE, $7)
     RETURNING ${BATCH_COLUMNS}`,
    [
      input.itemId,
      batchNumber,
      input.expiryDate ?? null,
      input.manufactureDate ?? null,
      quantity,
      input.unitCost,
      input.supplierReference?.trim() || null,
    ],
  );
  const batch = mapBatch(rows[0]);

  await recomputeItemStockRollup(client, input.itemId);

  return batch;
}

export interface SellCosmeticInput {
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

export interface SellCosmeticResult {
  breakdown: CosmeticSalePriceBreakdown;
  revenueEntryId: string | null;
  cogsEntryId: string | null;
  /** The COGS this sale posted, Rial — the actual FEFO batch cost when batch-tracked. */
  cost: RialText;
  /** Batch number(s) consumed, when the item is batch-tracked. */
  batchNumbers?: string[];
  /** The earliest expiry date among the consumed batches, when batch-tracked. */
  expiryDate?: string | null;
  /**
   * The exact per-batch allocation this sale consumed (which `item_batches`
   * rows, how much of each, at which cost). The caller persists it against the
   * order line it writes — see `recordOrderItemBatchAllocations` — so the sale
   * can later be returned, refunded or voided exactly.
   */
  batchAllocations?: BatchAllocation[];
}

/**
 * Sells units of one variant in the caller's own transaction: posts revenue
 * and COGS as `cosmetic.*` events and decrements the quantity on hand —
 * atomically, so stock can never drift from what the ledger was told. For a
 * `tracking='batch'` item the batches are consumed first-expired-first-out
 * (fefo.ts) and the COGS is the actual cost of the consumed batches; expired
 * stock is refused, never merely hidden.
 */
export async function sellCosmeticUnits(
  client: PoolClient,
  input: SellCosmeticInput,
): Promise<SellCosmeticResult> {
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

  const breakdown = computeCosmeticSalePrice({
    unitPrice,
    quantity: input.quantity,
    discount: input.discount ?? 0,
    vatPercent: input.vatPercent,
  });

  if (Number(stock.quantity) < Number(input.quantity)) {
    throw new Error("موجودی کافی نیست.");
  }

  let cost: RialText;
  let batchNumbers: string[] | undefined;
  let expiryDate: string | null | undefined;
  let batchAllocations: BatchAllocation[] | undefined;

  if (item.tracking === "batch") {
    // The canonical path (retail-batch-inventory.ts): FEFO across the sellable
    // batches, expired stock refused (never silently sold), exact per-batch
    // COGS, the allocated rows relieved and the `item_stock` rollup recomputed
    // — this function never decrements `item_stock.quantity` for a batch item.
    batchAllocations = allocateBatchLots(
      await loadBatchLotsForUpdate(client, input.itemId),
      input.quantity,
      todayIso(),
    );
    cost = allocationCostValue(batchAllocations);
    batchNumbers = allocationBatchNumbers(batchAllocations);
    expiryDate = allocationExpiryDate(batchAllocations);
    await consumeBatchAllocations(client, input.itemId, batchAllocations);
  } else {
    cost = cosmeticCogs(input.quantity, stock.unitCost);
  }

  // See the identical comment in accessories-service.ts's sellAccessoryUnits:
  // `uq_journal_business_source_posting` is unique on (business_id,
  // source_type, source_id, posting_kind), so keying the posting identity on
  // `input.itemId` — as this used to — only let a cosmetic item ever be sold
  // once, ever; every later sale of the same item threw a raw unique
  // violation. `domain_events.source_id` keeps carrying `input.itemId`
  // (reports group/join on it); `postingSourceId` is the separate identity
  // the ledger posting itself uses, fresh per sale.
  const postingSourceId = randomUUID();
  const lineTenders = resolveLineTenders(input, breakdown.total);

  const { entryId: revenueEntryId } = await emitDomainEvent(client, {
    businessId: input.businessId,
    locationId: input.locationId,
    eventType: "cosmetic.sale_revenue",
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
      batchNumbers: batchNumbers ?? [],
    },
    sourceType: "cosmetic_sale",
    sourceId: input.itemId,
    postingSourceId,
    createdBy: input.createdBy ?? null,
  });

  const { entryId: cogsEntryId } = await emitDomainEvent(client, {
    businessId: input.businessId,
    locationId: input.locationId,
    eventType: "cosmetic.sale_cogs",
    payload: { itemId: input.itemId, quantity: input.quantity, cost },
    sourceType: "cosmetic_sale",
    sourceId: input.itemId,
    postingSourceId,
    createdBy: input.createdBy ?? null,
  });

  if (item.tracking === "batch") {
    // The batches were relieved (and the rollup recomputed) by the engine
    // above; writing `quantity - n` here as well would double-count the sale
    // and desynchronise `item_stock` from `item_batches`.
    await client.query(`UPDATE item_stock SET last_sold_at = now(), updated_at = now() WHERE item_id = $1`, [
      input.itemId,
    ]);
  } else {
    await client.query(
      `UPDATE item_stock SET quantity = quantity - $2, last_sold_at = now(), updated_at = now() WHERE item_id = $1`,
      [input.itemId, input.quantity],
    );
  }

  return { breakdown, revenueEntryId, cogsEntryId, cost, batchNumbers, expiryDate, batchAllocations };
}

/**
 * Writes off an item's expired batches: removes the batch quantity, rolls
 * `item_stock` down, and posts the cost to «کالای منقضی و تستر» (5160)
 * through a domain event — never a hand-written ledger call.
 */
export async function writeOffExpiredBatches(
  client: PoolClient,
  input: {
    businessId: string;
    locationId: string;
    itemId: string;
    createdBy?: string | null;
  },
): Promise<{ writtenOffQuantity: string; cost: RialText; entryId: string | null }> {
  const item = await getItem(input.itemId);
  if (!item) throw new Error("کالا یافت نشد.");
  if (item.tracking !== "batch") throw new Error("این کالا بچ‌محور نیست.");

  const batches = await listBatches(input.itemId, client);
  const today = todayIso();
  const expired = batches.filter((b) => isBatchExpired(b.expiryDate, today) && new Decimal(b.quantity).gt(0));
  if (expired.length === 0) return { writtenOffQuantity: "0", cost: rialText("0"), entryId: null };

  const cost = rialText(
    expired
      .reduce((sum, b) => sum + BigInt(roundRial(new Decimal(b.quantity).times(b.unitCost ?? 0))), 0n)
      .toString(),
  );
  const writtenOffQuantity = expired
    .reduce((sum, b) => sum.plus(new Decimal(b.quantity)), new Decimal(0))
    .toFixed();

  // Same defect, same fix as sellCosmeticUnits above: `cosmetic_write_off`'s
  // posting_kind is fixed (`cosmetic_expiry_write_off`), so keying the
  // posting identity on `input.itemId` let a given item's expired stock be
  // written off only once, ever — a second write-off batch for the same item
  // on a later day would throw `uq_journal_business_source_posting`.
  // `domain_events.source_id` keeps carrying `input.itemId`; `postingSourceId`
  // is the separate identity the ledger posting itself uses, fresh per call.
  const { entryId } = await emitDomainEvent(client, {
    businessId: input.businessId,
    locationId: input.locationId,
    eventType: "cosmetic.expiry_write_off",
    payload: {
      itemId: input.itemId,
      quantity: writtenOffQuantity,
      cost,
      batches: expired.map((b) => ({ batchNumber: b.batchNumber, quantity: b.quantity })),
    },
    sourceType: "cosmetic_write_off",
    sourceId: input.itemId,
    postingSourceId: randomUUID(),
    createdBy: input.createdBy ?? null,
  });


  for (const b of expired) {
    await client.query(`DELETE FROM item_batches WHERE id = $1`, [b.id]);
  }
  // The rollup is the engine's, so a write-off can never leave the shared
  // `item_stock` cache disagreeing with the authoritative batch rows.
  await recomputeItemStockRollup(client, input.itemId);

  return { writtenOffQuantity, cost, entryId };
}

export interface CosmeticVariantSummary {
  id: string;
  parentItemId: string | null;
  parentName: string | null;
  name: string;
  sku: string | null;
  kind: string;
  tracking: string;
  isActive: boolean;
  quantity: string;
  sellableQuantity: string;
  unitCost: number | null;
  unitPrice: number | null;
  attributes: { name: string; value: string }[];
  batches: { id: string; batchNumber: string; expiryDate: string | null; quantity: string }[];
  brandId: string | null;
  brandName: string | null;
  ircCode: string | null;
  healthPermit: string | null;
  authenticityRegistration: string | null;
  tags: string[];
  /** Phase 42 — the products workspace's list columns, the same three every
   * other trade-goods board returns. Without them the shared «لیست محصولات»
   * read `isSellable` as undefined and flagged every cosmetics variant
   * «غیر قابل فروش» while the barcode and unit columns fell back silently. */
  barcode: string | null;
  unit: string | null;
  isSellable: boolean;
}

/** The cosmetics board: every family and variant at this branch, with attributes, stock, pricing and (for batch-tracked items) their batches. */
export async function listCosmeticBoard(locationId: string): Promise<CosmeticVariantSummary[]> {
  const { rows } = await query<{
    id: string;
    parent_item_id: string | null;
    parent_name: string | null;
    name: string;
    sku: string | null;
    kind: string;
    tracking: string;
    is_active: boolean;
    quantity: string | null;
    unit_cost: string | null;
    unit_price: string | null;
    attributes: { name: string; value: string }[] | null;
    batches: { id: string; batch_number: string; expiry_date: string | null; quantity: string }[] | null;
    brand_id: string | null;
    brand_name: string | null;
    irc_code: string | null;
    health_permit: string | null;
    authenticity_registration: string | null;
    tags: string[] | null;
    barcode: string | null;
    unit: string | null;
    is_sellable: boolean;
  }>(
    `SELECT i.id, i.parent_item_id, p.name AS parent_name, i.name, i.sku, i.kind, i.tracking, i.is_active,
            s.quantity, s.unit_cost, s.unit_price,
            i.brand_id, b.name AS brand_name, i.irc_code, i.health_permit,
            i.authenticity_registration, i.tags, i.barcode, i.unit, i.is_sellable,
            COALESCE(
              (SELECT json_agg(json_build_object('name', a.name, 'value', a.value) ORDER BY a.name)
                 FROM item_variant_attributes a WHERE a.item_id = i.id),
              '[]'::json
            ) AS attributes,
            COALESCE(
              (SELECT json_agg(json_build_object(
                        'id', b.id, 'batch_number', b.batch_number,
                        'expiry_date', b.expiry_date::text, 'quantity', b.quantity)
                      ORDER BY b.expiry_date NULLS LAST, b.batch_number)
                 FROM item_batches b WHERE b.item_id = i.id),
              '[]'::json
            ) AS batches
       FROM items i
       LEFT JOIN items p ON p.id = i.parent_item_id
       LEFT JOIN item_stock s ON s.item_id = i.id
       LEFT JOIN item_brands b ON b.id = i.brand_id
      -- Standalone ('simple') items included — same WooCommerce sync fix as
      -- accessories-service's board: a simple product the integration
      -- imported must appear on the management screen it belongs to.
      WHERE i.location_id = $1 AND i.tracking IN ('none', 'batch')
      ORDER BY COALESCE(p.name, i.name), i.kind DESC, i.name`,
    [locationId],
  );

  return rows.map((r) => {
    const batches = r.batches ?? [];
    return {
      id: r.id,
      parentItemId: r.parent_item_id,
      parentName: r.parent_name,
      name: r.name,
      sku: r.sku,
      kind: r.kind,
      tracking: r.tracking,
      isActive: r.is_active,
      quantity: r.quantity ?? "0",
      sellableQuantity:
        r.tracking === "batch"
          ? sellableQuantity(
              batches.map((b) => ({ id: b.id, expiryDate: b.expiry_date, quantity: b.quantity })),
              todayIso(),
            )
          : (r.quantity ?? "0"),
      unitCost: r.unit_cost == null ? null : Number(r.unit_cost),
      unitPrice: r.unit_price == null ? null : Number(r.unit_price),
      attributes: r.attributes ?? [],
      batches: batches.map((b) => ({
        id: b.id,
        batchNumber: b.batch_number,
        expiryDate: b.expiry_date,
        quantity: b.quantity,
      })),
      brandId: r.brand_id,
      brandName: r.brand_name,
      ircCode: r.irc_code,
      healthPermit: r.health_permit,
      authenticityRegistration: r.authenticity_registration,
      tags: r.tags ?? [],
      barcode: r.barcode,
      unit: r.unit,
      isSellable: r.is_sellable,
    };
  });
}

export interface NearExpiryBatchRow {
  itemId: string;
  itemName: string;
  parentName: string | null;
  batchNumber: string;
  expiryDate: string | null;
  quantity: string;
  bucket: "expired" | "under30" | "under90";
}

/** The near-expiry report: every batch within 90 days (or already expired), oldest first — the list the trade's home page surfaces. */
export async function nearExpiryBatches(locationId: string): Promise<NearExpiryBatchRow[]> {
  const { rows } = await query<{
    item_id: string;
    item_name: string;
    parent_name: string | null;
    batch_number: string;
    expiry_date: string | null;
    quantity: string;
  }>(
    `SELECT i.id AS item_id, i.name AS item_name, p.name AS parent_name,
            b.batch_number, b.expiry_date::text AS expiry_date, b.quantity
       FROM item_batches b
       JOIN items i ON i.id = b.item_id
       LEFT JOIN items p ON p.id = i.parent_item_id
      WHERE i.location_id = $1
        AND b.quantity > 0
        AND b.expiry_date IS NOT NULL
        AND b.expiry_date < CURRENT_DATE + 90
      ORDER BY b.expiry_date NULLS LAST, b.batch_number`,
    [locationId],
  );
  const today = todayIso();
  return rows
    .map((r) => {
      const daysLeft = r.expiry_date
        ? Math.floor((Date.parse(`${r.expiry_date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000)
        : 0;
      const bucket: NearExpiryBatchRow["bucket"] =
        daysLeft < 0 ? "expired" : daysLeft <= 30 ? "under30" : "under90";
      return {
        itemId: r.item_id,
        itemName: r.item_name,
        parentName: r.parent_name,
        batchNumber: r.batch_number,
        expiryDate: r.expiry_date,
        quantity: r.quantity,
        bucket,
      };
    })
    .sort((a, b) => {
      const order = { expired: 0, under30: 1, under90: 2 } as const;
      return order[a.bucket] - order[b.bucket];
    });
}

/**
 * Opens a sellable unit as a تستر (tester/sample). The unit leaves stock and
 * its cost moves to «کالای منقضی و تستر» (5160) — a marketing expense, not
 * COGS — through a domain event. The small, specific thing a cosmetics
 * counter does every week that no generic POS models.
 */
export async function openTester(
  client: PoolClient,
  input: { businessId: string; locationId: string; itemId: string; createdBy?: string | null },
): Promise<{ cost: RialText; entryId: string | null }> {
  const item = await getItem(input.itemId);
  if (!item) throw new Error("کالا یافت نشد.");
  if (item.kind === "variant_parent") {
    throw new Error("خانوادهٔ کالا تستر نمی‌شود؛ یکی از تنوع‌ها را انتخاب کنید.");
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
  if (Number(stock.quantity) < 1) throw new Error("موجودی کافی نیست.");

  let cost: RialText;
  let testerFromBatches = false;
  if (item.tracking === "batch") {
    // Opening a tester consumes a real sellable unit, so it goes through the
    // same canonical engine a sale does: FEFO across the sellable lots, the
    // allocated lot relieved, the item_stock rollup recomputed. Expired stock
    // is refused — a tester made from an expired lot is still expired.
    const allocations = allocateBatchLots(
      await loadBatchLotsForUpdate(client, input.itemId),
      "1",
      todayIso(),
    );
    cost = allocationCostValue(allocations);
    await consumeBatchAllocations(client, input.itemId, allocations);
    testerFromBatches = true;
  } else {
    cost = rialText(String(stock.unitCost));
  }

  // Same defect, same fix as sellCosmeticUnits above: `cosmetic_tester`'s
  // posting_kind is fixed, so keying the posting identity on `input.itemId`
  // let a given item have its tester opened only once, ever — the second
  // tester bottle of the same item would throw
  // `uq_journal_business_source_posting`. `domain_events.source_id` keeps
  // carrying `input.itemId`; `postingSourceId` is the separate identity the
  // ledger posting itself uses, fresh per call.
  const { entryId } = await emitDomainEvent(client, {
    businessId: input.businessId,
    locationId: input.locationId,
    eventType: "cosmetic.tester_consumed",
    payload: { itemId: input.itemId, quantity: "1", cost },
    sourceType: "cosmetic_tester",
    sourceId: input.itemId,
    postingSourceId: randomUUID(),
    createdBy: input.createdBy ?? null,
  });

  if (!testerFromBatches) {
    await client.query(
      `UPDATE item_stock SET quantity = quantity - 1, updated_at = now() WHERE item_id = $1`,
      [input.itemId],
    );
  } else {
    // The batch consumption already rolled `item_stock` down; decrementing it
    // again here would double-count the tester.
    await client.query(`UPDATE item_stock SET updated_at = now() WHERE item_id = $1`, [input.itemId]);
  }

  return { cost, entryId };
}

/**
 * Bulk-creates a `variant_parent` and its N×M `variant_child` rows over two
 * axes (شید × حجم, رنگ × سایز) in one transaction — the matrix editor's
 * server half. A failure on any cell leaves none of them created.
 */
export async function createVariantMatrix(input: {
  locationId: string;
  parentName: string;
  parentSku?: string | null;
  axisA: MatrixAxis;
  axisB: MatrixAxis;
}): Promise<{ parentItemId: string; childCount: number }> {
  const cells = buildVariantMatrix(input.parentName, input.axisA, input.axisB);
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows: parentRows } = await client.query<{ id: string }>(
      `INSERT INTO items (location_id, name, sku, kind) VALUES ($1, $2, $3, 'variant_parent') RETURNING id`,
      [input.locationId, input.parentName.trim(), input.parentSku?.trim() || null],
    );
    const parentItemId = parentRows[0].id;
    for (const cell of cells) {
      const { rows: childRows } = await client.query<{ id: string }>(
        `INSERT INTO items (location_id, parent_item_id, name, kind) VALUES ($1, $2, $3, 'variant_child') RETURNING id`,
        [input.locationId, parentItemId, cell.name],
      );
      for (const attribute of cell.attributes) {
        await client.query(
          `INSERT INTO item_variant_attributes (item_id, name, value) VALUES ($1, $2, $3)`,
          [childRows[0].id, attribute.name.trim(), attribute.value.trim()],
        );
      }
    }
    await client.query("COMMIT");
    return { parentItemId, childCount: cells.length };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
