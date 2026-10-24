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
 * Scope boundaries, deliberately: `weight` items (gold) keep their existing
 * intake path (setWeightAttributes) and are refused here with a clear
 * message, because that model is one-row-per-unit with a formula-priced
 * cost, not a fungible quantity on `item_stock`. `serial` items (watches)
 * ARE received here since issue #795: a serial purchase line names its
 * exact physical serials and creates their `item_serials` rows in the same
 * transaction as the AP posting, which is what gives a serialized unit's
 * cost basis a real purchase behind it (bare `addSerial` registration
 * records a cost with no accounting). Transfers move
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
import { deadStockCutoff, stockNeedsAttentionSql, validateItemQuantity, validateItemUnitCost } from "./retail-stock";
import { validateWarrantyMonths } from "./watch";
import { validateSerialStatusTransition, type SerialStatus } from "./items";
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
  /**
   * Serial-tracked only (issue #795 item 1) — the exact physical units this
   * line receives. A serial line of quantity N must name exactly N serials;
   * each becomes an `item_serials` row with this line's unit cost as its
   * cost basis and opens the model's warranty default. This is what finally
   * completes the serialized accounting chain: purchase → Debit
   * {industry}Inventory / Credit AP (retail.purchase_received), so the later
   * sale's Credit of that same inventory account has a real debit behind it.
   */
  serials?: { serialNumber: string; warrantyMonths?: number }[] | null;
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
    // Serial-tracked, single-unit lines: the exact physical unit received.
    let receivedSerialId: string | null = null;
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
    } else if (item.tracking === "serial") {
      // Issue #795 item 1 — a serial-tracked line is received as exact
      // physical units, inside this same transaction, so the serial rows,
      // their cost basis, the purchase document and the inventory/AP posting
      // are one atomic fact. Distinct unit costs belong on distinct lines
      // (the same way an invoice works), so every serial on this line
      // carries this line's exact unit cost.
      const qty = Number(line.quantity);
      if (!Number.isInteger(qty) || qty <= 0) {
        throw new RetailStockError("تعداد کالای سریالی باید یک عدد صحیح مثبت باشد.");
      }
      if (!Number.isInteger(line.unitCost) || line.unitCost <= 0) {
        throw new RetailStockError("بهای هر دستگاه سریالی باید یک عدد صحیح مثبت (ریال) باشد.");
      }
      const serials = line.serials ?? [];
      if (serials.length !== qty) {
        throw new RetailStockError(
          "دریافت کالای سریالی باید به ازای هر واحد دقیقاً یک شماره سریال داشته باشد.",
        );
      }
      const seen = new Set<string>();
      for (const s of serials) {
        const serialNumber = s.serialNumber?.trim();
        if (!serialNumber) throw new RetailStockError("شماره سریال نمی‌تواند خالی باشد.");
        if (seen.has(serialNumber)) {
          throw new RetailStockError(`شماره سریال «${serialNumber}» در این ردیف تکراری است.`);
        }
        seen.add(serialNumber);
        const warrantyMonths = s.warrantyMonths ?? 0;
        const warrantyError = validateWarrantyMonths(warrantyMonths);
        if (warrantyError) throw new RetailStockError(warrantyError);
        try {
          const { rows: created } = await client.query<{ id: string }>(
            `INSERT INTO item_serials (item_id, serial_number, unit_cost, warranty_months)
             VALUES ($1, $2, $3, $4) RETURNING id`,
            [line.itemId, serialNumber, line.unitCost, warrantyMonths],
          );
          // `item_purchase_items.serial_id` (migration 0084) is singular, so
          // it can only point at THE unit of a one-unit line; multi-unit
          // lines keep their provenance through the serial rows themselves.
          if (serials.length === 1) receivedSerialId = created[0].id;
        } catch (err) {
          if ((err as { code?: string }).code === "23505") {
            throw new RetailStockError(`شماره سریال «${serialNumber}» قبلاً برای این کالا ثبت شده است.`);
          }
          throw err;
        }
      }
    } else {
      throw new RetailStockError(
        "ورود کالای وزنی از مسیر وزن/عیار ثبت می‌شود.",
      );
    }

    await client.query(
      `INSERT INTO item_purchase_items
         (purchase_id, item_id, quantity, unit_cost, batch_number, manufacture_date, expiry_date,
          supplier_reference, internal_batch_number, serial_id)
       VALUES ($1, $2, $3, $4, $5, $6::date, $7::date, $8, $9, $10)`,
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
        receivedSerialId,
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
  /**
   * Serial-tracked only (issue #795) — the exact physical unit being sent
   * back, by row id or by its serial number (what the operator scans/types).
   * One line returns exactly one unit.
   */
  serialId?: string | null;
  serialNumber?: string | null;
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
    if (item.tracking === "weight") {
      throw new RetailStockError("برگشت کالای وزنی از مسیر همان کالا ثبت می‌شود.");
    }

    let value: RialText;
    let returnedSerialId: string | null = null;
    if (item.tracking === "serial") {
      // Issue #795 — a serialized supplier return names the exact physical
      // unit. The unit must be on this shelf (`in_stock`), it moves to the
      // terminal `supplier_returned` state (never deleted — provenance), and
      // the posting relieves inventory at its own recorded cost basis.
      if (new Decimal(line.quantity).toString() !== "1") {
        throw new RetailStockError("برگشت کالای سریالی هر ردیف دقیقاً یک دستگاه است.");
      }
      const serialNumber = line.serialNumber?.trim();
      if (!line.serialId && !serialNumber) {
        throw new RetailStockError("برای برگشت کالای سریالی، سریال دقیق دستگاه را مشخص کنید.");
      }
      const { rows: serialRows } = await client.query<{
        id: string;
        status: string;
        unit_cost: string | null;
      }>(
        line.serialId
          ? `SELECT id, status, unit_cost::text FROM item_serials WHERE id = $2 AND item_id = $1 FOR UPDATE`
          : `SELECT id, status, unit_cost::text FROM item_serials WHERE item_id = $1 AND serial_number = $2 FOR UPDATE`,
        [line.itemId, line.serialId ?? serialNumber],
      );
      const serial = serialRows[0];
      if (!serial) throw new RetailStockError("سریال یافت نشد.");
      const transitionError = validateSerialStatusTransition(
        serial.status as SerialStatus,
        "supplier_returned",
      );
      if (transitionError) throw new RetailStockError(transitionError);
      if (serial.unit_cost == null) {
        throw new RetailStockError("بهای تمام‌شده این دستگاه ثبت نشده است؛ برگشت بدون مبنای بها ممکن نیست.");
      }
      value = rialText(serial.unit_cost);
      returnedSerialId = serial.id;
      await client.query(`UPDATE item_serials SET status = 'supplier_returned' WHERE id = $1`, [serial.id]);
    } else if (item.tracking === "batch") {
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
      `INSERT INTO item_supplier_return_items (return_id, item_id, batch_id, serial_id, quantity, value_rial)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [returnId, line.itemId, line.batchId ?? null, returnedSerialId, line.quantity, value],
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
// Issue #917 — authoritative, warehouse-scoped predicates shared with
// stock-levels/warehouse overview. All reports use LEFT JOIN so active
// sellable items with no item_stock row appear as quantity 0 / out of stock.

export interface LowStockRow {
  itemId: string;
  itemName: string;
  sku: string | null;
  quantity: string;
  reorderPoint: string;
  level: "out" | "low";
  unit: string | null;
  category: string | null;
  /** null unitCost means missing cost basis (not zero) */
  unitCost: string | null;
  hasMissingCost: boolean;
  /** Text Rial value — exact, not JS Number, for large balances */
  valueRialText: string;
}

export interface LowStockFilters {
  search?: string | null;
  includeInactive?: boolean;
  severity?: "all" | "out" | "low";
  /** Sort key */
  sortBy?: "shortage" | "quantity" | "name" | "value";
  sortDir?: "asc" | "desc";
  category?: string | null;
  tracking?: string | null;
  /** Valuation completeness: all = both, valued = has cost, missing = no cost */
  valuation?: "all" | "valued" | "missing" | null;
}

export interface DeadStockRow {
  itemId: string;
  itemName: string;
  sku: string | null;
  quantity: string;
  lastSoldAt: string | null;
  /** First acquisition / stock age baseline for never-sold classification */
  firstStockedAt: string | null;
  unit: string | null;
  category: string | null;
  unitCost: string | null;
  hasMissingCost: boolean;
  /** Exact Rial text, not Number — lossless for large balances */
  valueRialText: string;
  /** Deprecated numeric for legacy callers; derived from valueRialText */
  valueRial: number;
  /** Days since last sale or since first stocked (for never-sold) */
  ageDays: number | null;
}

export type DeadStockFilters = LowStockFilters;

/**
 * Shared authoritative low-stock query — includes active, sellable items with
 * missing item_stock rows as quantity 0 (out), excludes variant_parent,
 * honours warehouse scope, and treats weight/serial separately.
 */
async function readLowStockReport(
  locationId: string,
  page?: number,
  options: {
    search?: string | null;
    includeInactive?: boolean;
    severity?: "all" | "out" | "low";
    sortBy?: string;
    sortDir?: "asc" | "desc";
    todayIso?: string;
    category?: string | null;
    valuation?: "all" | "valued" | "missing" | null;
    tracking?: string | null;
  } = {},
) {
  const search = options.search?.trim() || null;
  const includeInactive = options.includeInactive ?? false;
  const severity = options.severity ?? "all";
  const sortBy = options.sortBy ?? "name";
  const sortDir = options.sortDir === "desc" ? "DESC" : "ASC";
  const category = options.category?.trim() || null;
  const valuation = options.valuation ?? "all";
  const tracking = options.tracking?.trim() || null;

  let orderBy: string;
  switch (sortBy) {
    case "shortage":
      // Out first, then low by shortage magnitude; tie-breaker name
      orderBy = `level_sort ASC, shortage_ratio ASC, name ${sortDir}, item_id`;
      break;
    case "quantity":
      orderBy = `quantity_numeric ${sortDir}, name ASC, item_id`;
      break;
    case "value":
      orderBy = `value_rial_numeric ${sortDir}, name ASC, item_id`;
      break;
    case "name":
    default:
      orderBy = `name ${sortDir}, item_id ASC`;
      break;
  }

  const clauses: string[] = [
    "i.location_id = $1",
    "i.kind <> 'variant_parent'",
  ];
  const params: unknown[] = [locationId];
  if (!includeInactive) clauses.push("i.is_active");

  if (search) {
    params.push(`%${search}%`);
    clauses.push(`(i.name ILIKE $${params.length} OR COALESCE(i.sku,'') ILIKE $${params.length} OR COALESCE(i.barcode,'') ILIKE $${params.length})`);
  }
  if (category) {
    params.push(category);
    clauses.push(`COALESCE(i.collection, i.season) = $${params.length}`);
  }
  if (valuation === "valued") clauses.push("s.unit_cost IS NOT NULL");
  if (valuation === "missing") clauses.push("s.unit_cost IS NULL");
  if (tracking) {
    params.push(tracking);
    clauses.push(`i.tracking = $${params.length}`);
  }

  // Compute derived columns for sorting and level — shared predicate with stock-levels/warehouse summary
  const innerWhere = clauses.join(" AND ");
  const levelExpr = `CASE WHEN COALESCE(s.quantity,0) <= 0 THEN 'out' WHEN COALESCE(s.reorder_point,0) > 0 AND COALESCE(s.quantity,0) <= s.reorder_point THEN 'low' ELSE 'ok' END`;
  const needsAttention = stockNeedsAttentionSql("COALESCE(s.quantity,0)", "COALESCE(s.reorder_point,0)");

  // Add severity filter if requested
  let severityClause = "";
  if (severity === "out") severityClause = ` AND COALESCE(s.quantity,0) <= 0`;
  if (severity === "low") severityClause = ` AND COALESCE(s.quantity,0) > 0 AND COALESCE(s.reorder_point,0) > 0 AND COALESCE(s.quantity,0) <= s.reorder_point`;

  const source = `
    SELECT
      i.id AS item_id,
      i.name,
      i.sku,
      i.unit,
      COALESCE(i.collection, i.season)::text AS category,
      COALESCE(s.quantity,0)::text AS quantity,
      COALESCE(s.reorder_point,0)::text AS reorder_point,
      s.unit_cost::text AS unit_cost,
      (CASE WHEN s.unit_cost IS NULL THEN true ELSE false END) AS has_missing_cost,
      COALESCE(ROUND(COALESCE(s.quantity,0) * COALESCE(s.unit_cost,0))::text, '0') AS value_rial_text,
      (COALESCE(s.quantity,0) * COALESCE(s.unit_cost,0))::numeric AS value_rial_numeric,
      COALESCE(s.quantity,0)::numeric AS quantity_numeric,
      CASE WHEN COALESCE(s.quantity,0) <= 0 THEN 0
           WHEN COALESCE(s.reorder_point,0) > 0 THEN COALESCE(s.quantity,0)::numeric / NULLIF(s.reorder_point,0)::numeric
           ELSE 999 END AS shortage_ratio,
      ${levelExpr} AS level,
      CASE WHEN COALESCE(s.quantity,0) <= 0 THEN 0 ELSE 1 END AS level_sort
     FROM items i
     LEFT JOIN item_stock s ON s.item_id = i.id
    WHERE ${innerWhere} AND ${needsAttention} ${severityClause}
  `;

  const summaryExpr = `jsonb_build_object(
    'totalValueRialText', coalesce(sum(ROUND(value_rial_numeric)),0)::text,
    'totalValueRial', coalesce(sum(ROUND(value_rial_numeric)),0)::bigint,
    'missingCostCount', coalesce(sum(CASE WHEN has_missing_cost AND quantity_numeric > 0 THEN 1 ELSE 0 END),0),
    'outCount', coalesce(sum(CASE WHEN quantity_numeric <= 0 THEN 1 ELSE 0 END),0),
    'lowCount', coalesce(sum(CASE WHEN quantity_numeric > 0 THEN 1 ELSE 0 END),0)
  )`;

  const result = await queryReportPage<{
    item_id: string; name: string; sku: string | null; unit: string | null; category: string | null;
    quantity: string; reorder_point: string; unit_cost: string | null; has_missing_cost: boolean;
    value_rial_text: string; value_rial_numeric: string; quantity_numeric: string;
    level: string;
  }, { totalValueRialText: string; totalValueRial: number; missingCostCount: number; outCount: number; lowCount: number }>(
    source,
    params,
    { page, orderBy, summary: summaryExpr },
  );
  return {
    ...result,
    rows: result.rows.map((r): LowStockRow => ({
      itemId: r.item_id,
      itemName: r.name,
      sku: r.sku,
      unit: r.unit ?? null,
      category: r.category ?? null,
      quantity: r.quantity,
      reorderPoint: r.reorder_point,
      unitCost: r.unit_cost,
      hasMissingCost: r.has_missing_cost,
      valueRialText: r.value_rial_text,
      level: r.level as "low" | "out",
    })),
  };
}

export async function lowStockReport(locationId: string, opts?: { search?: string | null; includeInactive?: boolean; category?: string | null; valuation?: "all" | "valued" | "missing" | null }): Promise<LowStockRow[]> {
  return (await readLowStockReport(locationId, undefined, opts)).rows;
}
export const lowStockReportPage = (
  locationId: string,
  page: number,
  opts?: { search?: string | null; includeInactive?: boolean; severity?: "all" | "out" | "low"; sortBy?: string; sortDir?: "asc" | "desc"; category?: string | null; valuation?: "all" | "valued" | "missing" | null; tracking?: string | null },
) => readLowStockReport(locationId, page, opts);

/** Recompute last_sold_at from valid non-voided sales for an item.
 *  Business rule (P1): void/return of the last sale does NOT automatically
 *  erase last_sold_at; we rebuild from the most recent non-voided sale event
 *  that is still valid. Domain events for retail sales carry item reference
 *  in payload; fallback is orders with status != voided linked via order_items.
 */
export async function recomputeLastSoldAt(client: PoolClient, itemId: string): Promise<string | null> {
  // Look for latest valid sale from domain_events (retail sale events) and orders
  // Strategy: find most recent order_items with this item_id that is not voided
  // and whose order is completed without void.
  const { rows } = await client.query<{ last_sold_at: string | null }>(
    `SELECT MAX(o.closed_at)::text AS last_sold_at
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
      WHERE oi.item_id = $1
        AND oi.status <> 'voided'
        AND o.status <> 'voided'
        AND oi.quantity::numeric > 0
        AND o.closed_at IS NOT NULL`,
    [itemId],
  );
  const lastSale = rows[0]?.last_sold_at ?? null;
  // Also check domain_events for sale events where item is referenced (some sales may not have order_items)
  // Use GREATEST of both if domain_events carry timestamp
  try {
    const { rows: eventRows } = await client.query<{ ts: string | null }>(
      `SELECT MAX(created_at)::text AS ts FROM domain_events
        WHERE payload->>'itemId' = $1
          AND event_type LIKE '%sale%'
          AND event_type NOT LIKE '%void%'
          AND event_type NOT LIKE '%reversal%'`,
      [itemId],
    );
    const eventTime = eventRows[0]?.ts ?? null;
    if (eventTime && lastSale) {
      return new Date(eventTime) > new Date(lastSale) ? eventTime : lastSale;
    }
    return lastSale ?? eventTime;
  } catch {
    return lastSale;
  }
}

export async function refreshItemLastSoldAt(itemId: string, client?: PoolClient): Promise<void> {
  const lastSoldAt = client ? await recomputeLastSoldAt(client, itemId) : await recomputeLastSoldAtFromPool(itemId);
  if (client) {
    await client.query(`UPDATE item_stock SET last_sold_at = $2::timestamptz, updated_at = now() WHERE item_id = $1`, [itemId, lastSoldAt]);
  } else {
    await query(`UPDATE item_stock SET last_sold_at = $2::timestamptz, updated_at = now() WHERE item_id = $1`, [itemId, lastSoldAt]);
  }
}

async function recomputeLastSoldAtFromPool(itemId: string): Promise<string | null> {
  const { rows } = await query<{ last_sold_at: string | null }>(
    `SELECT MAX(o.closed_at)::text AS last_sold_at
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
      WHERE oi.item_id = $1
        AND oi.status <> 'voided'
        AND o.status <> 'voided'
        AND oi.quantity::numeric > 0
        AND o.closed_at IS NOT NULL`,
    [itemId],
  );
  return rows[0]?.last_sold_at ?? null;
}

async function readDeadStockReport(
  locationId: string,
  days: number,
  todayIso: string,
  page?: number,
  options: {
    search?: string | null;
    includeInactive?: boolean;
    sortBy?: string;
    sortDir?: "asc" | "desc";
    category?: string | null;
    valuation?: "all" | "valued" | "missing" | null;
    tracking?: string | null;
  } = {},
) {
  const search = options.search?.trim() || null;
  const includeInactive = options.includeInactive ?? false;
  const sortBy = options.sortBy ?? "name";
  const sortDir = options.sortDir === "desc" ? "DESC" : "ASC";
  const category = options.category?.trim() || null;
  const valuation = options.valuation ?? "all";
  const tracking = options.tracking?.trim() || null;
  const cutoff = deadStockCutoff(todayIso, days);

  let orderBy: string;
  switch (sortBy) {
    case "age":
      orderBy = `age_days DESC, name ${sortDir}, item_id`;
      break;
    case "value":
      orderBy = `value_rial_numeric ${sortDir}, name ASC, item_id`;
      break;
    case "quantity":
      orderBy = `quantity_numeric ${sortDir}, name ASC, item_id`;
      break;
    case "name":
    default:
      orderBy = `name ${sortDir}, item_id ASC`;
      break;
  }

  const clauses: string[] = [
    "i.location_id = $1",
    "i.kind <> 'variant_parent'",
    "COALESCE(s.quantity,0) > 0",
  ];
  const params: unknown[] = [locationId];
  // cutoff param
  params.push(cutoff);
  const cutoffParam = `$${params.length}`;

  // Dead-stock predicate: quantity > 0 AND cutoff IS NOT NULL AND
  //   ( last_sold_at <= cutoff OR (last_sold_at IS NULL AND stock_age <= cutoff) )
  // stock_age = COALESCE(s.created_at, s.first_stocked_at, i.created_at)
  // Use COALESCE to handle pre-migration rows where created_at may be null
  const stockAgeExpr = `COALESCE(s.created_at, s.first_stocked_at, i.created_at)`;
  const deadPredicate = `${cutoffParam}::timestamptz IS NOT NULL AND (
    s.last_sold_at <= ${cutoffParam}::timestamptz
    OR (s.last_sold_at IS NULL AND ${stockAgeExpr} IS NOT NULL AND ${stockAgeExpr} <= ${cutoffParam}::timestamptz)
  )`;

  if (!includeInactive) clauses.push("i.is_active");

  if (search) {
    params.push(`%${search}%`);
    clauses.push(`(i.name ILIKE $${params.length} OR COALESCE(i.sku,'') ILIKE $${params.length} OR COALESCE(i.barcode,'') ILIKE $${params.length})`);
  }
  if (category) {
    params.push(category);
    clauses.push(`COALESCE(i.collection, i.season) = $${params.length}`);
  }
  if (valuation === "valued") clauses.push("s.unit_cost IS NOT NULL");
  if (valuation === "missing") clauses.push("s.unit_cost IS NULL");
  if (tracking) {
    params.push(tracking);
    clauses.push(`i.tracking = $${params.length}`);
  }

  const whereClause = clauses.join(" AND ");

  const source = `
    SELECT
      i.id AS item_id,
      i.name,
      i.sku,
      i.unit,
      COALESCE(i.collection, i.season)::text AS category,
      COALESCE(s.quantity,0)::text AS quantity,
      COALESCE(s.quantity,0)::numeric AS quantity_numeric,
      s.last_sold_at::text AS last_sold_at,
      ${stockAgeExpr}::text AS first_stocked_at,
      s.unit_cost::text AS unit_cost,
      (CASE WHEN s.unit_cost IS NULL THEN true ELSE false END) AS has_missing_cost,
      COALESCE(ROUND(COALESCE(s.quantity,0) * COALESCE(s.unit_cost,0))::text, '0') AS value_rial_text,
      (COALESCE(s.quantity,0) * COALESCE(s.unit_cost,0))::numeric AS value_rial_numeric,
      EXTRACT(DAY FROM (now() - COALESCE(s.last_sold_at, ${stockAgeExpr})))::int AS age_days
     FROM items i
     LEFT JOIN item_stock s ON s.item_id = i.id
    WHERE ${whereClause} AND ${deadPredicate}
  `;

  const summaryExpr = `jsonb_build_object(
    'totalValueRialText', coalesce(sum(ROUND(value_rial_numeric)),0)::text,
    'totalValueRial', coalesce(sum(ROUND(value_rial_numeric)),0)::bigint,
    'missingCostCount', coalesce(sum(CASE WHEN has_missing_cost AND quantity_numeric > 0 THEN 1 ELSE 0 END),0),
    'valuedCount', coalesce(sum(CASE WHEN NOT has_missing_cost AND quantity_numeric > 0 THEN 1 ELSE 0 END),0),
    'totalInactiveValueRialText', '0'
  )`;

  const result = await queryReportPage<{
    item_id: string; name: string; sku: string | null; unit: string | null; category: string | null;
    quantity: string; last_sold_at: string | null; first_stocked_at: string | null;
    unit_cost: string | null; has_missing_cost: boolean; value_rial_text: string;
    value_rial_numeric: string; quantity_numeric: string; age_days: number | null;
  }, { totalValueRialText: string; totalValueRial: number; missingCostCount: number; valuedCount: number; totalInactiveValueRialText: string }>(
    source,
    params,
    { page, orderBy, summary: summaryExpr },
  );
  return {
    ...result,
    rows: result.rows.map((r): DeadStockRow => ({
      itemId: r.item_id,
      itemName: r.name,
      sku: r.sku,
      unit: r.unit ?? null,
      category: r.category ?? null,
      quantity: r.quantity,
      lastSoldAt: r.last_sold_at,
      firstStockedAt: r.first_stocked_at,
      unitCost: r.unit_cost,
      hasMissingCost: r.has_missing_cost,
      valueRialText: r.value_rial_text,
      valueRial: Number(r.value_rial_text ?? "0"),
      ageDays: r.age_days,
    })),
  };
}
export async function deadStockReport(locationId: string, days: number, todayIso: string, opts?: { search?: string | null; includeInactive?: boolean; category?: string | null; valuation?: "all" | "valued" | "missing" | null }): Promise<DeadStockRow[]> {
  return (await readDeadStockReport(locationId, days, todayIso, undefined, opts)).rows;
}
export const deadStockReportPage = (
  locationId: string,
  days: number,
  todayIso: string,
  page: number,
  opts?: { search?: string | null; includeInactive?: boolean; sortBy?: string; sortDir?: "asc" | "desc"; category?: string | null; valuation?: "all" | "valued" | "missing" | null; tracking?: string | null },
) => readDeadStockReport(locationId, days, todayIso, page, opts);

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
