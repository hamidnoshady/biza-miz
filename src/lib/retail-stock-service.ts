/**
 * Phase 27 Wave 8 — purchasing, supplier returns and transfers on the
 * `items` model (DB-touching), plus reorder points and the low/dead-stock
 * reports.
 *
 * Mirrors F&B's purchase-receipt/supplier-return/transfer semantics, not its
 * tables: the two stock worlds stay separate (Phase 21's decision). Stock
 * effects go through the existing per-item receive paths — `receiveStock`
 * (none), `receiveBatch` (batch) — so there is still exactly one stock
 * engine, and the ledger side rides the `retail.*` domain events in
 * retail-stock-posting-rules.ts.
 *
 * Scope boundaries, deliberately: `weight` items (gold) and `serial` items
 * (watches) keep their existing intake paths (setWeightAttributes / addSerial)
 * and are refused here with a clear message, because those models are
 * one-row-per-unit, not a fungible quantity on `item_stock`. Transfers move
 * fungible `none`-tracking stock AND `batch`-tracking stock between two branch
 * items: a batch transfer relieves the lots at the source (a named lot when
 * the line names one, FEFO otherwise), records exactly which lots left, and
 * puts those same lots — number, expiry and cost — on the destination shelf.
 * Cosmetics uses this shared workflow; there is no separate transfer module.
 */
import { queryReportPage } from "./report-page-query";
import Decimal from "decimal.js";
import type { PoolClient } from "pg";
import { getStock, receiveStock, type ItemStock } from "./accessories-service";
import { receiveBatch } from "./cosmetics-service";
import {
  recomputeItemStockRollup,
  receiveBatchesForTransfer,
  relieveBatchesForTransfer,
  restoreBatchesForTransferCancel,
} from "./retail-batch-inventory";
import { getItem } from "./items-service";
import { query } from "./db";
import { roundRial, rialText, type RialText } from "./inventory-exact";
import { emitDomainEvent } from "./posting-engine";
import { classifyStockLevel, deadStockCutoff, validateItemQuantity, validateItemUnitCost } from "./retail-stock";
// Side-effect import: registers the retail.* stock posting rules.
import "./retail-stock-posting-rules";

export class RetailStockError extends Error {}

type PurchaseLine = {
  itemId: string;
  quantity: string;
  unitCost: number;
  /** Batch-tracked only — the real manufacturer/supplier lot number. */
  batchNumber?: string | null;
  /** Batch-tracked only — the expiry date this receipt carries. */
  expiryDate?: string | null;
  /** Batch-tracked only — the manufacture date, when the label carries one. */
  manufactureDate?: string | null;
  /** Batch-tracked only — the supplier's own reference for this delivery. */
  supplierReference?: string | null;
};

export interface ReceivePurchaseResult {
  id: string;
  total: RialText;
}

/**
 * Receives one purchase into stock, atomically: writes the purchase document,
 * receives each line through its own stock path, and posts the AP entry.
 */
export async function receiveItemPurchase(
  client: PoolClient,
  input: {
    businessId: string;
    locationId: string;
    supplierId?: string | null;
    note?: string | null;
    createdBy?: string | null;
    lines: PurchaseLine[];
  },
): Promise<ReceivePurchaseResult> {
  if (input.lines.length === 0) throw new RetailStockError("خرید بدون قلم کالا قابل ثبت نیست.");

  const { rows: header } = await client.query<{ id: string }>(
    `INSERT INTO item_purchases (business_id, location_id, supplier_id, note, created_by)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [input.businessId, input.locationId, input.supplierId ?? null, input.note?.trim() || null, input.createdBy ?? null],
  );
  const purchaseId = header[0].id;

  let total = 0n;
  for (let i = 0; i < input.lines.length; i++) {
    const line = input.lines[i];
    const qtyError = validateItemQuantity(line.quantity);
    if (qtyError) throw new RetailStockError(qtyError);
    const costError = validateItemUnitCost(line.unitCost);
    if (costError) throw new RetailStockError(costError);

    const item = await getItem(line.itemId);
    if (!item || item.locationId !== input.locationId) throw new RetailStockError("کالا یافت نشد.");
    if (item.kind === "variant_parent") {
      throw new RetailStockError("موجودی روی خودِ خانوادهٔ کالا ثبت نمی‌شود؛ روی هر تنوع جداگانه ثبت کنید.");
    }

    // The real manufacturer/supplier lot number is what a batch-tracked
    // receipt must carry — the shop prints it on the label and it is the unit
    // of recall. An internal `P-…` reference is generated only when the
    // delivery genuinely has no lot number, and it is flagged as generated
    // (`internal_batch_number`) so a report can tell the two apart. It is
    // never a replacement for a real number, which is what this used to be.
    const realLotNumber = line.batchNumber?.trim() || null;
    let batchNumberForReceipt: string | null = realLotNumber;
    if (item.tracking === "batch") {
      const generated = `P-${purchaseId.slice(0, 8)}-${i + 1}`;
      batchNumberForReceipt = realLotNumber ?? generated;
      await receiveBatch(client, {
        itemId: line.itemId,
        batchNumber: batchNumberForReceipt,
        expiryDate: line.expiryDate ?? null,
        manufactureDate: line.manufactureDate ?? null,
        quantity: line.quantity,
        unitCost: line.unitCost,
        supplierReference: line.supplierReference?.trim() || purchaseId,
      });
    } else if (item.tracking === "none") {
      await receiveStock(line.itemId, { quantity: line.quantity, unitCost: line.unitCost }, client);
    } else {
      throw new RetailStockError(
        item.tracking === "serial"
          ? "ورود کالای سریالی از مسیر «سریال دستگاه» ثبت می‌شود."
          : "ورود کالای وزنی از مسیر وزن/عیار ثبت می‌شود.",
      );
    }

    await client.query(
      `INSERT INTO item_purchase_items
         (purchase_id, item_id, quantity, unit_cost, batch_number, manufacture_date, expiry_date,
          supplier_reference, internal_batch_number)
       VALUES ($1, $2, $3, $4, $5, $6::date, $7::date, $8, $9)`,
      [
        purchaseId,
        line.itemId,
        line.quantity,
        line.unitCost,
        batchNumberForReceipt,
        line.manufactureDate ?? null,
        line.expiryDate ?? null,
        line.supplierReference?.trim() || null,
        item.tracking === "batch" && realLotNumber == null,
      ],
    );
    total += BigInt(roundRial(new Decimal(line.quantity).times(line.unitCost)));
  }

  await client.query(`UPDATE item_purchases SET total = $2 WHERE id = $1`, [purchaseId, total.toString()]);

  await emitDomainEvent(client, {
    businessId: input.businessId,
    locationId: input.locationId,
    eventType: "retail.purchase_received",
    payload: { purchaseId, amount: rialText(total.toString()) },
    sourceType: "item_purchase",
    sourceId: purchaseId,
    createdBy: input.createdBy ?? null,
  });

  return { id: purchaseId, total: rialText(total.toString()) };
}

type ReturnLine = {
  itemId: string;
  quantity: string;
  /** Batch-tracked only — the specific batch being sent back. */
  batchId?: string | null;
};

export interface SupplierReturnResult {
  id: string;
  value: RialText;
  duplicate: boolean;
}

/** Sends purchased stock back to the supplier, atomically, with the settlement posting. */
export async function createItemSupplierReturn(
  client: PoolClient,
  input: {
    businessId: string;
    locationId: string;
    purchaseId?: string | null;
    settlementMethod: "accounts_payable" | "cash" | "bank" | "supplier_receivable";
    reason: string;
    idempotencyKey: string;
    createdBy?: string | null;
    lines: ReturnLine[];
  },
): Promise<SupplierReturnResult> {
  if (!input.reason.trim() || !input.idempotencyKey || input.lines.length === 0) {
    throw new RetailStockError("برگشت نامعتبر است.");
  }

  const { rows: prior } = await client.query<{ id: string; total_value_rial: string }>(
    `SELECT id, total_value_rial::text FROM item_supplier_returns WHERE business_id = $1 AND idempotency_key = $2`,
    [input.businessId, input.idempotencyKey],
  );
  if (prior[0]) return { id: prior[0].id, value: rialText(prior[0].total_value_rial), duplicate: true };

  const { rows: header } = await client.query<{ id: string }>(
    `INSERT INTO item_supplier_returns
       (business_id, location_id, purchase_id, settlement_method, reason, created_by, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [
      input.businessId,
      input.locationId,
      input.purchaseId ?? null,
      input.settlementMethod,
      input.reason.trim(),
      input.createdBy ?? null,
      input.idempotencyKey,
    ],
  );
  const returnId = header[0].id;

  let total = 0n;
  for (const line of input.lines) {
    const qtyError = validateItemQuantity(line.quantity);
    if (qtyError) throw new RetailStockError(qtyError);

    const item = await getItem(line.itemId);
    if (!item || item.locationId !== input.locationId) throw new RetailStockError("کالا یافت نشد.");
    if (item.tracking === "weight" || item.tracking === "serial") {
      throw new RetailStockError("برگشت کالای وزنی/سریالی از مسیر همان کالا ثبت می‌شود.");
    }

    let value: RialText;
    if (item.tracking === "batch") {
      if (!line.batchId) throw new RetailStockError("برای برگشت کالای بچ‌محور، بچ را مشخص کنید.");
      const { rows: batchRows } = await client.query<{ id: string; quantity: string; unit_cost: string | null }>(
        `SELECT id, quantity::text, unit_cost::text FROM item_batches WHERE id = $1 AND item_id = $2 FOR UPDATE`,
        [line.batchId, line.itemId],
      );
      const batch = batchRows[0];
      if (!batch) throw new RetailStockError("بچ یافت نشد.");
      if (new Decimal(batch.quantity).lt(new Decimal(line.quantity))) {
        throw new RetailStockError("موجودی بچ کافی نیست.");
      }
      const unitCost = Number(batch.unit_cost ?? 0);
      value = roundRial(new Decimal(line.quantity).times(unitCost));
      await client.query(`UPDATE item_batches SET quantity = quantity - $2 WHERE id = $1`, [batch.id, line.quantity]);
      // The rollup is recomputed in the SAME transaction: a supplier return
      // that relieved a lot but left `item_stock` at its old quantity would
      // desynchronise the shared cache from the authoritative batches
      // (migration 0078), and every later sale would over-sell.
      await recomputeItemStockRollup(client, line.itemId);
    } else {
      const stock = await getStock(line.itemId, client);
      if (!stock || stock.unitCost == null) throw new RetailStockError("بهای تمام‌شده کالا ثبت نشده است.");
      if (new Decimal(stock.quantity).lt(new Decimal(line.quantity))) {
        throw new RetailStockError("موجودی کافی نیست.");
      }
      value = roundRial(new Decimal(line.quantity).times(stock.unitCost));
      await client.query(
        `UPDATE item_stock SET quantity = quantity - $2, updated_at = now() WHERE item_id = $1`,
        [line.itemId, line.quantity],
      );
    }

    await client.query(
      `INSERT INTO item_supplier_return_items (return_id, item_id, batch_id, quantity, value_rial)
       VALUES ($1, $2, $3, $4, $5)`,
      [returnId, line.itemId, line.batchId ?? null, line.quantity, value],
    );
    total += BigInt(value);
  }

  await client.query(`UPDATE item_supplier_returns SET total_value_rial = $2 WHERE id = $1`, [returnId, total.toString()]);

  await emitDomainEvent(client, {
    businessId: input.businessId,
    locationId: input.locationId,
    eventType: "retail.supplier_return",
    payload: { returnId, amount: rialText(total.toString()), settlementMethod: input.settlementMethod },
    sourceType: "item_supplier_return",
    sourceId: returnId,
    createdBy: input.createdBy ?? null,
  });

  return { id: returnId, value: rialText(total.toString()), duplicate: false };
}

type TransferLine = {
  sourceItemId: string;
  destinationItemId: string;
  quantity: string;
  /** Batch-tracked only: move this exact lot instead of taking FEFO. */
  batchId?: string | null;
};

export async function createItemTransfer(
  client: PoolClient,
  input: {
    businessId: string;
    sourceLocationId: string;
    destinationLocationId: string;
    note?: string | null;
    idempotencyKey: string;
    createdBy?: string | null;
    lines: TransferLine[];
  },
): Promise<{ id: string; duplicate: boolean }> {
  if (input.sourceLocationId === input.destinationLocationId || !input.idempotencyKey || input.lines.length === 0) {
    throw new RetailStockError("انتقال نامعتبر است.");
  }
  const { rows: locations } = await client.query<{ id: string }>(
    `SELECT id FROM locations WHERE business_id = $1 AND id = ANY($2::uuid[])`,
    [input.businessId, [input.sourceLocationId, input.destinationLocationId]],
  );
  if (locations.length !== 2) throw new RetailStockError("شعبهٔ انتقال یافت نشد.");

  const { rows: existing } = await client.query<{ id: string }>(
    `SELECT id FROM item_stock_transfers WHERE business_id = $1 AND idempotency_key = $2`,
    [input.businessId, input.idempotencyKey],
  );
  if (existing[0]) return { id: existing[0].id, duplicate: true };

  const { rows: header } = await client.query<{ id: string }>(
    `INSERT INTO item_stock_transfers
       (business_id, source_location_id, destination_location_id, note, created_by, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [
      input.businessId,
      input.sourceLocationId,
      input.destinationLocationId,
      input.note?.trim() || null,
      input.createdBy ?? null,
      input.idempotencyKey,
    ],
  );

  for (const line of input.lines) {
    const qtyError = validateItemQuantity(line.quantity);
    if (qtyError) throw new RetailStockError(qtyError);
    const source = await getItem(line.sourceItemId);
    const destination = await getItem(line.destinationItemId);
    if (!source || source.locationId !== input.sourceLocationId || !destination || destination.locationId !== input.destinationLocationId) {
      throw new RetailStockError("کالای مبدأ یا مقصد یافت نشد.");
    }
    // Serial/weight units are one-row-per-unit and keep their own intake
    // paths; batch and fungible stock both transfer through this workflow.
    if (
      source.tracking === "serial" ||
      source.tracking === "weight" ||
      destination.tracking === "serial" ||
      destination.tracking === "weight"
    ) {
      throw new RetailStockError("انتقال کالای سریالی/وزنی از مسیر خودِ کالا ثبت می‌شود.");
    }
    if (source.tracking !== destination.tracking) {
      throw new RetailStockError("روش ردیابی کالای مبدأ و مقصد باید یکسان باشد.");
    }
    await client.query(
      `INSERT INTO item_stock_transfer_items (transfer_id, source_item_id, destination_item_id, quantity, batch_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [header[0].id, line.sourceItemId, line.destinationItemId, line.quantity, line.batchId ?? null],
    );
  }
  return { id: header[0].id, duplicate: false };
}

export async function shipItemTransfer(
  client: PoolClient,
  input: { businessId: string; transferId: string; actorId: string },
): Promise<{ value: RialText }> {
  const { rows: transfers } = await client.query<{ source_location_id: string; status: string }>(
    `SELECT source_location_id, status::text FROM item_stock_transfers WHERE id = $1 AND business_id = $2 FOR UPDATE`,
    [input.transferId, input.businessId],
  );
  const transfer = transfers[0];
  if (!transfer) throw new RetailStockError("انتقال یافت نشد.");
  if (transfer.status !== "draft") {
    throw new RetailStockError(transfer.status === "shipped" ? "انتقال قبلاً ارسال شده است." : "وضعیت انتقال نامعتبر است.");
  }

  const { rows: lines } = await client.query<{
    id: string;
    source_item_id: string;
    quantity: string;
    batch_id: string | null;
  }>(
    `SELECT id, source_item_id, quantity::text, batch_id
       FROM item_stock_transfer_items WHERE transfer_id = $1 ORDER BY source_item_id`,
    [input.transferId],
  );

  let total = 0n;
  for (const line of lines) {
    const item = await getItem(line.source_item_id);
    let value: RialText;

    if (item?.tracking === "batch") {
      // The lots leave through the canonical engine and the exact rows that
      // left are recorded, so receive puts the same lots on the destination
      // shelf and a cancel restores the same lots at the source.
      const relieved = await relieveBatchesForTransfer(client, {
        sourceItemId: line.source_item_id,
        transferLineId: line.id,
        quantity: line.quantity,
        batchId: line.batch_id,
      });
      value = relieved.value;
    } else {
      const stock = await getStock(line.source_item_id, client);
      if (!stock || stock.unitCost == null) throw new RetailStockError("بهای تمام‌شده کالای مبدأ ثبت نشده است.");
      if (new Decimal(stock.quantity).lt(new Decimal(line.quantity))) {
        throw new RetailStockError("موجودی مبدأ کافی نیست.");
      }

      value = roundRial(new Decimal(line.quantity).times(stock.unitCost));
      await client.query(`UPDATE item_stock SET quantity = quantity - $2, updated_at = now() WHERE item_id = $1`, [
        line.source_item_id,
        line.quantity,
      ]);
    }

    await client.query(`UPDATE item_stock_transfer_items SET value_rial = $2 WHERE id = $1`, [line.id, value]);
    total += BigInt(value);
  }

  await emitDomainEvent(client, {
    businessId: input.businessId,
    locationId: transfer.source_location_id,
    eventType: "retail.transfer_ship",
    payload: { transferId: input.transferId, amount: rialText(total.toString()) },
    sourceType: "item_stock_transfer",
    sourceId: input.transferId,
    createdBy: input.actorId || null,
  });

  await client.query(`UPDATE item_stock_transfers SET status = 'shipped', shipped_at = now() WHERE id = $1`, [input.transferId]);
  return { value: rialText(total.toString()) };
}

export async function receiveItemTransfer(
  client: PoolClient,
  input: { businessId: string; transferId: string; actorId: string },
): Promise<{ value: RialText }> {
  const { rows: transfers } = await client.query<{ destination_location_id: string; status: string }>(
    `SELECT destination_location_id, status::text FROM item_stock_transfers WHERE id = $1 AND business_id = $2 FOR UPDATE`,
    [input.transferId, input.businessId],
  );
  const transfer = transfers[0];
  if (!transfer) throw new RetailStockError("انتقال یافت نشد.");
  if (transfer.status !== "shipped") {
    throw new RetailStockError(transfer.status === "received" ? "انتقال قبلاً دریافت شده است." : "وضعیت انتقال نامعتبر است.");
  }

  const { rows: lines } = await client.query<{
    id: string;
    destination_item_id: string;
    quantity: string;
    value_rial: string | null;
  }>(
    `SELECT id, destination_item_id, quantity::text, value_rial::text
       FROM item_stock_transfer_items WHERE transfer_id = $1 ORDER BY destination_item_id`,
    [input.transferId],
  );

  let total = 0n;
  for (const line of lines) {
    const item = await getItem(line.destination_item_id);
    const value = line.value_rial ?? "0";

    if (item?.tracking === "batch") {
      const received = await receiveBatchesForTransfer(client, {
        destinationItemId: line.destination_item_id,
        transferLineId: line.id,
      });
      total += BigInt(received.value);
      continue;
    }

    // `value_rial` is the whole line's value, NOT a unit cost. Passing it
    // straight to receiveStock valued every destination unit at the line
    // total — a 3-unit line at 100,000 each became 300,000 per unit on the
    // destination shelf. The unit cost is the value divided by the quantity.
    const unitCost = Number(roundRial(new Decimal(value).div(new Decimal(line.quantity))));
    await receiveStock(line.destination_item_id, { quantity: line.quantity, unitCost }, client);
    total += BigInt(value);
  }

  await emitDomainEvent(client, {
    businessId: input.businessId,
    locationId: transfer.destination_location_id,
    eventType: "retail.transfer_receive",
    payload: { transferId: input.transferId, amount: rialText(total.toString()) },
    sourceType: "item_stock_transfer",
    sourceId: input.transferId,
    createdBy: input.actorId || null,
  });

  await client.query(`UPDATE item_stock_transfers SET status = 'received', received_at = now() WHERE id = $1`, [input.transferId]);
  return { value: rialText(total.toString()) };
}

export async function cancelItemTransfer(
  client: PoolClient,
  input: { businessId: string; transferId: string; actorId: string },
): Promise<{ value: RialText }> {
  const { rows: transfers } = await client.query<{ source_location_id: string; status: string }>(
    `SELECT source_location_id, status::text FROM item_stock_transfers WHERE id = $1 AND business_id = $2 FOR UPDATE`,
    [input.transferId, input.businessId],
  );
  const transfer = transfers[0];
  if (!transfer) throw new RetailStockError("انتقال یافت نشد.");
  if (transfer.status === "received") throw new RetailStockError("انتقال دریافت‌شده قابل لغو نیست.");
  if (transfer.status === "cancelled") throw new RetailStockError("انتقال قبلاً لغو شده است.");

  if (transfer.status === "draft") {
    await client.query(`UPDATE item_stock_transfers SET status = 'cancelled', cancelled_at = now() WHERE id = $1`, [input.transferId]);
    return { value: rialText("0") };
  }

  // Shipped: restore the source's stock at the value that left it — and for
  // batch stock, into the exact lots that left.
  const { rows: lines } = await client.query<{
    id: string;
    source_item_id: string;
    quantity: string;
    value_rial: string | null;
  }>(
    `SELECT id, source_item_id, quantity::text, value_rial::text
       FROM item_stock_transfer_items WHERE transfer_id = $1`,
    [input.transferId],
  );
  let total = 0n;
  for (const line of lines) {
    const item = await getItem(line.source_item_id);
    const value = line.value_rial ?? "0";

    if (item?.tracking === "batch") {
      const restored = await restoreBatchesForTransferCancel(client, {
        sourceItemId: line.source_item_id,
        transferLineId: line.id,
      });
      total += BigInt(restored.value);
      continue;
    }

    // Same total-value-vs-unit-cost defect as the receive path above.
    const unitCost = Number(roundRial(new Decimal(value).div(new Decimal(line.quantity))));
    await receiveStock(line.source_item_id, { quantity: line.quantity, unitCost }, client);
    total += BigInt(value);
  }
  await client.query(`UPDATE item_stock_transfers SET status = 'cancelled', cancelled_at = now() WHERE id = $1`, [input.transferId]);
  return { value: rialText(total.toString()) };
}

// ------------------------------------------------------------------- reports

export interface LowStockRow {
  itemId: string;
  itemName: string;
  sku: string | null;
  quantity: string;
  reorderPoint: string;
  level: "out" | "low";
}

/** Variants at or under their reorder point — the «کمبود موجودی» list per branch. */
async function readLowStockReport(locationId: string, page?: number) {
  const result = await queryReportPage<{ item_id: string; name: string; sku: string | null; quantity: string; reorder_point: string }>(
    `SELECT i.id AS item_id, i.name, i.sku, s.quantity::text, s.reorder_point::text
       FROM item_stock s JOIN items i ON i.id = s.item_id
      WHERE i.location_id = $1 AND i.kind <> 'variant_parent' AND s.reorder_point > 0
        AND s.quantity <= s.reorder_point`,
    [locationId], { page, orderBy: "name, item_id" },
  );
  return { ...result, rows: result.rows.map((r): LowStockRow => ({
    itemId: r.item_id, itemName: r.name, sku: r.sku, quantity: r.quantity, reorderPoint: r.reorder_point,
    level: classifyStockLevel(r.quantity, r.reorder_point) as "low" | "out",
  })) };
}
export async function lowStockReport(locationId: string): Promise<LowStockRow[]> {
  return (await readLowStockReport(locationId)).rows;
}
export const lowStockReportPage = (locationId: string, page: number) => readLowStockReport(locationId, page);

export interface DeadStockRow {
  itemId: string;
  itemName: string;
  sku: string | null;
  quantity: string;
  lastSoldAt: string | null;
  unitCost: number | null;
  /** Quantity × unit cost, Rial — the capital tied up in dead stock. */
  valueRial: number;
}

/** Variants that have not sold in `days` days (never sold included) — the dead-stock list per branch. */
async function readDeadStockReport(locationId: string, days: number, todayIso: string, page?: number) {
  const result = await queryReportPage<{
    item_id: string; name: string; sku: string | null; quantity: string;
    last_sold_at: string | null; unit_cost: string | null; value_rial: string;
  }, { totalValueRial: number }>(
    `SELECT i.id AS item_id, i.name, i.sku, s.quantity::text,
            s.last_sold_at::text, s.unit_cost::text,
            floor(s.quantity::double precision * coalesce(s.unit_cost,0)::double precision + 0.5)::text AS value_rial
       FROM item_stock s JOIN items i ON i.id = s.item_id
      WHERE i.location_id = $1 AND i.kind <> 'variant_parent' AND s.quantity > 0
        AND $2::timestamptz IS NOT NULL AND (s.last_sold_at IS NULL OR s.last_sold_at <= $2::timestamptz)`,
    [locationId, deadStockCutoff(todayIso, days)],
    { page, orderBy: "name, item_id", summary: `jsonb_build_object('totalValueRial', coalesce(sum(value_rial::numeric),0))` },
  );
  return { ...result, rows: result.rows.map((r): DeadStockRow => ({
    itemId: r.item_id, itemName: r.name, sku: r.sku, quantity: r.quantity,
    lastSoldAt: r.last_sold_at, unitCost: r.unit_cost == null ? null : Number(r.unit_cost), valueRial: Number(r.value_rial),
  })) };
}
export async function deadStockReport(locationId: string, days: number, todayIso: string): Promise<DeadStockRow[]> {
  return (await readDeadStockReport(locationId, days, todayIso)).rows;
}
export const deadStockReportPage = (locationId: string, days: number, todayIso: string, page: number) =>
  readDeadStockReport(locationId, days, todayIso, page);

/** Sets a variant's reorder point (0 = not tracked). */
export async function setReorderPoint(itemId: string, reorderPoint: number): Promise<ItemStock> {
  if (!Number.isFinite(reorderPoint) || reorderPoint < 0) {
    throw new RetailStockError("نقطهٔ سفارش مجدد باید عددی غیرمنفی باشد.");
  }
  await getItem(itemId); // throws Persian "کالا یافت نشد." on a bad id
  const { rows } = await query<{
    item_id: string;
    quantity: string;
    unit_cost: string | null;
    unit_price: string | null;
  }>(
    `INSERT INTO item_stock (item_id, reorder_point) VALUES ($1, $2)
     ON CONFLICT (item_id) DO UPDATE SET reorder_point = EXCLUDED.reorder_point, updated_at = now()
     RETURNING item_id, quantity::text, unit_cost::text, unit_price::text`,
    [itemId, reorderPoint],
  );
  const r = rows[0];
  return {
    itemId: r.item_id,
    quantity: r.quantity,
    unitCost: r.unit_cost == null ? null : Number(r.unit_cost),
    unitPrice: r.unit_price == null ? null : Number(r.unit_price),
  };
}
