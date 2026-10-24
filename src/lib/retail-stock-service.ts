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
import { RetailReturnError } from "./retail-return-errors";
import { MAX_RETURN_LINES, returnRequestFingerprint } from "./retail-return-validation";
import {
  depleteBatchStock,
  recomputeItemStockRollup,
  RetailBatchError,
  receiveBatchesForTransfer,
  relieveBatchesForTransfer,
  restoreBatchesForTransferCancel,
} from "./retail-batch-inventory";
import { getItem } from "./items-service";
import { query } from "./db";
import { postExactMirrorEntry } from "./ledger-service";
import {
  MAX_RIAL,
  positiveQuantityText,
  proportionalDepletionValue,
  quantityText,
  roundRial,
  rialText,
  type RialText,
} from "./inventory-exact";
import { emitDomainEvent } from "./posting-engine";
import { classifyStockLevel, deadStockCutoff, stockNeedsAttentionSql, validateItemQuantity, validateItemUnitCost } from "./retail-stock";
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
            // Issue #918 — the purchase a serialized unit was received under
            // is its provenance: a purchase-linked supplier return proves the
            // unit came from the purchase it names through this column.
            `INSERT INTO item_serials (item_id, serial_number, unit_cost, warranty_months, purchase_id)
             VALUES ($1, $2, $3, $4, $5) RETURNING id`,
            [line.itemId, serialNumber, line.unitCost, warrantyMonths, purchaseId],
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

export type ReturnLine = {
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
  /**
   * Issue #918 — the exact receipt line a purchase-linked return line
   * relieves. Required when the linked purchase received the same SKU on
   * several lines at different costs; otherwise the service resolves the
   * single matching line itself.
   */
  purchaseItemId?: string | null;
};

export interface SupplierReturnResult {
  id: string;
  /** Inventory carrying value relieved (the `total_value_rial` legacy meaning, kept). */
  value: RialText;
  /** Supplier credit — what the settlement account is debited. */
  supplierCredit: RialText;
  /** Signed Rial: carrying − credit. Positive is a loss, negative a gain. */
  variance: string;
  /** The per-business sequential voucher number printed on the document. */
  returnNumber: number;
  duplicate: boolean;
}

/** The next per-business return voucher number (the ar_ap_voucher_counters pattern). */
async function nextItemSupplierReturnNumber(client: PoolClient, businessId: string): Promise<number> {
  const { rows } = await client.query<{ last_number: string }>(
    `INSERT INTO item_supplier_return_counters (business_id, last_number)
     VALUES ($1, 1)
     ON CONFLICT (business_id) DO UPDATE
       SET last_number = item_supplier_return_counters.last_number + 1
     RETURNING last_number::text AS last_number`,
    [businessId],
  );
  return Number(rows[0].last_number);
}

interface PurchaseLineRow {
  id: string;
  item_id: string;
  quantity: string;
  unit_cost: string;
  batch_number: string | null;
  serial_id: string | null;
}

interface ResolvedReturnLine {
  itemId: string;
  quantity: string;
  quantityDecimal: Decimal;
  batchId: string | null;
  serialId: string | null;
  purchaseItemId: string | null;
  /** Inventory carrying value relieved by this line. */
  carrying: RialText;
  /** Supplier credit (invoice value) for this line. */
  credit: RialText;
}

/**
 * Sends purchased stock back to the supplier, atomically, with the settlement
 * posting.
 *
 * Issue #918 hardening, in the order the checks run:
 *
 * 1. **Retry safety** — the caller's idempotency key is bound to a canonical
 *    payload hash. Same key + same payload replays the original voucher; same
 *    key + changed payload is a 409. The header insert is
 *    `ON CONFLICT DO NOTHING` with a winner re-read, so two requests racing
 *    on one key still yield one voucher, one stock effect, one journal.
 * 2. **Attribution** — a purchase-linked return resolves its supplier through
 *    the purchase; an unlinked return settled against AP or a supplier
 *    receivable must name its supplier explicitly. An AP debit against no
 *    supplier is refused, as is a supplier that disagrees with the purchase.
 * 3. **Provenance + ceilings** — every line is validated against the warehouse,
 *    the purchase, the lot/serial it names, and the unconsumed receipt
 *    quantity, with the purchase row locked so concurrent returns serialize.
 * 4. **Valuation** — inventory is relieved at carrying value (batch/lot cost,
 *    serial cost basis, or the running average), the supplier is credited at
 *    the linked invoice cost, and the variance posts explicitly. A null cost
 *    is refused, never zeroed; no `Number(bigint)` conversion touches money.
 * 5. **Concurrency** — non-batch stock rows are locked `FOR UPDATE` in sorted
 *    order before any cost/availability read, and every decrement is guarded
 *    (`quantity >= requested`, one row asserted), so a concurrent sale,
 *    transfer or return cannot silently over-relieve.
 */
export async function createItemSupplierReturn(
  client: PoolClient,
  input: {
    businessId: string;
    locationId: string;
    purchaseId?: string | null;
    /** Explicit supplier for a return without a historical purchase. */
    supplierId?: string | null;
    settlementMethod: "accounts_payable" | "cash" | "bank" | "supplier_receivable";
    reason: string;
    idempotencyKey: string;
    createdBy?: string | null;
    lines: ReturnLine[];
  },
): Promise<SupplierReturnResult> {
  // Fail-closed for non-route callers (the route's parser is stricter): the
  // voucher editor always sends a settlement, a reason, a stable key and
  // canonical lines, but nothing here trusts that.
  const reason = input.reason?.trim() ?? "";
  const idempotencyKey = input.idempotencyKey?.trim() ?? "";
  const purchaseId = input.purchaseId ?? null;
  const explicitSupplierId = input.supplierId ?? null;
  if (!reason) throw new RetailReturnError("reason_required");
  if (!idempotencyKey) throw new RetailReturnError("idempotency_key_required");
  if (!Array.isArray(input.lines) || input.lines.length === 0) throw new RetailReturnError("lines_required");
  if (input.lines.length > MAX_RETURN_LINES) throw new RetailReturnError("too_many_lines");
  if (
    input.settlementMethod !== "accounts_payable" &&
    input.settlementMethod !== "cash" &&
    input.settlementMethod !== "bank" &&
    input.settlementMethod !== "supplier_receivable"
  ) {
    throw new RetailReturnError("settlement_invalid");
  }

  // Canonical quantities first: every later comparison, aggregation and hash
  // runs on one spelling ("1.50" and "1.5" are the same request).
  const lines = input.lines.map((line): ParsedLineShape => {
    if (!line || typeof line !== "object") throw new RetailReturnError("invalid_line");
    if (typeof line.itemId !== "string" || !line.itemId) throw new RetailReturnError("invalid_line");
    let quantity: string;
    try {
      quantity = positiveQuantityText(quantityText(String(line.quantity ?? "").trim()));
    } catch (err) {
      const code = err instanceof Error ? err.message : "";
      if (code === "quantity_precision_exceeded") throw new RetailReturnError("quantity_precision_exceeded");
      throw new RetailReturnError("quantity_invalid");
    }
    const batchId = line.batchId ?? null;
    const serialId = line.serialId ?? null;
    const serialNumber = line.serialNumber?.trim() || null;
    if (batchId && (serialId || serialNumber)) throw new RetailReturnError("invalid_line");
    if (serialId && serialNumber) throw new RetailReturnError("invalid_line");
    return {
      itemId: line.itemId,
      quantity,
      batchId,
      serialId,
      serialNumber,
      purchaseItemId: line.purchaseItemId ?? null,
    };
  });

  const fingerprint = returnRequestFingerprint({
    businessId: input.businessId,
    locationId: input.locationId,
    purchaseId,
    supplierId: explicitSupplierId,
    settlementMethod: input.settlementMethod,
    reason,
    lines,
  });

  const { rows: prior } = await client.query<{
    id: string;
    total_value_rial: string;
    supplier_credit_rial: string;
    variance_rial: string;
    return_number: string;
    request_fingerprint: string | null;
  }>(
    `SELECT id, total_value_rial::text, supplier_credit_rial::text, variance_rial::text,
            return_number::text, request_fingerprint
       FROM item_supplier_returns WHERE business_id = $1 AND idempotency_key = $2`,
    [input.businessId, idempotencyKey],
  );
  if (prior[0]) {
    // Legacy rows predate fingerprints and replay unconditionally; anything
    // newer replays only on an identical payload.
    if (prior[0].request_fingerprint !== null && prior[0].request_fingerprint !== fingerprint) {
      throw new RetailReturnError("idempotency_conflict", 409);
    }
    return {
      id: prior[0].id,
      value: rialText(prior[0].total_value_rial),
      supplierCredit: rialText(prior[0].supplier_credit_rial),
      variance: prior[0].variance_rial,
      returnNumber: Number(prior[0].return_number),
      duplicate: true,
    };
  }

  // The warehouse must be this tenant's own branch. The route resolves it
  // from the session; this is the fail-closed backstop for internal callers.
  const { rows: locationRows } = await client.query<{ id: string }>(
    `SELECT id FROM locations WHERE id = $1 AND business_id = $2`,
    [input.locationId, input.businessId],
  );
  if (!locationRows[0]) throw new RetailReturnError("return_invalid");

  // The linked purchase, locked: the lock serializes concurrent returns
  // against the same receipt, which is what makes the ceiling checks below
  // true rather than advisory. A foreign-tenant id answers "not found" —
  // existence across tenants is never confirmed.
  let purchase: { id: string; supplier_id: string | null } | null = null;
  let purchaseLines: PurchaseLineRow[] = [];
  const priorQtyByPurchaseItem = new Map<string, Decimal>();
  const priorQtyByItem = new Map<string, Decimal>();
  if (purchaseId) {
    const { rows: purchaseRows } = await client.query<{
      id: string;
      business_id: string;
      location_id: string;
      supplier_id: string | null;
      status: string;
    }>(
      `SELECT id, business_id, location_id, supplier_id, status::text
         FROM item_purchases WHERE id = $1 FOR UPDATE`,
      [purchaseId],
    );
    const found = purchaseRows[0];
    if (!found || found.business_id !== input.businessId) throw new RetailReturnError("purchase_not_found", 404);
    if (found.location_id !== input.locationId) throw new RetailReturnError("purchase_location_mismatch", 409);
    if (found.status !== "received") throw new RetailReturnError("purchase_cancelled", 409);
    purchase = { id: found.id, supplier_id: found.supplier_id };

    const { rows: lineRows } = await client.query<PurchaseLineRow>(
      `SELECT id, item_id, quantity::text AS quantity, unit_cost::text AS unit_cost,
              batch_number, serial_id::text AS serial_id
         FROM item_purchase_items WHERE purchase_id = $1`,
      [purchaseId],
    );
    purchaseLines = lineRows;

    // What earlier returns already consumed — grouped by exact receipt line,
    // with legacy (unlinked-line) rows attributed at the (purchase, item)
    // level so they still count against the ceiling.
    const { rows: consumed } = await client.query<{
      purchase_item_id: string | null;
      item_id: string;
      qty: string;
    }>(
      `SELECT li.purchase_item_id, li.item_id, COALESCE(SUM(li.quantity), 0)::text AS qty
         FROM item_supplier_return_items li
         JOIN item_supplier_returns r ON r.id = li.return_id
        WHERE r.purchase_id = $1 AND r.status = 'posted'
        GROUP BY li.purchase_item_id, li.item_id`,
      [purchaseId],
    );
    for (const row of consumed) {
      const qty = new Decimal(row.qty);
      priorQtyByItem.set(row.item_id, (priorQtyByItem.get(row.item_id) ?? new Decimal(0)).plus(qty));
      if (row.purchase_item_id) {
        priorQtyByPurchaseItem.set(
          row.purchase_item_id,
          (priorQtyByPurchaseItem.get(row.purchase_item_id) ?? new Decimal(0)).plus(qty),
        );
      }
    }
  }

  // Supplier attribution: linked returns inherit the purchase's supplier, and
  // an explicit supplier that disagrees with it is a mismatch, not an
  // override. Unlinked AP/supplier-receivable returns must name theirs —
  // there is no default uncategorized reduction of AP.
  if (explicitSupplierId) {
    const { rows: supplierRows } = await client.query<{ id: string; location_id: string }>(
      `SELECT s.id, s.location_id FROM suppliers s JOIN locations l ON l.id = s.location_id
        WHERE s.id = $1 AND l.business_id = $2 AND s.is_active`,
      [explicitSupplierId, input.businessId],
    );
    const supplier = supplierRows[0];
    if (!supplier) throw new RetailReturnError("supplier_not_found", 404);
    if (supplier.location_id !== input.locationId) throw new RetailReturnError("supplier_location_mismatch", 409);
  }
  const linkedSupplierId = purchase?.supplier_id ?? null;
  if (explicitSupplierId && linkedSupplierId && explicitSupplierId !== linkedSupplierId) {
    throw new RetailReturnError("supplier_mismatch", 409);
  }
  const resolvedSupplierId = explicitSupplierId ?? linkedSupplierId;
  if (
    (input.settlementMethod === "accounts_payable" || input.settlementMethod === "supplier_receivable") &&
    !resolvedSupplierId
  ) {
    throw new RetailReturnError("supplier_required_for_payable", 409);
  }

  // Items, read inside the transaction: same-warehouse sellable variants
  // only. Weight-tracked (gold) pieces keep their own intake path and are
  // refused here with the reason on screen.
  const items = new Map<string, { tracking: string }>();
  for (const line of lines) {
    if (items.has(line.itemId)) continue;
    const item = await getItem(line.itemId, client);
    if (!item || item.locationId !== input.locationId) throw new RetailReturnError("item_not_found", 404);
    if (item.kind === "variant_parent") throw new RetailReturnError("variant_parent_unsupported");
    if (item.tracking === "weight") throw new RetailReturnError("weight_unsupported");
    items.set(line.itemId, { tracking: item.tracking });
  }

  // Lock the fungible stock rows BEFORE any cost or availability read, in
  // sorted order so two multi-line returns cannot deadlock each other. The
  // old code read via getStock (no lock) and trusted the value through the
  // update — a concurrent sale could slip between the two.
  const noneItemIds = [...new Set(
    lines.filter((l) => items.get(l.itemId)!.tracking === "none").map((l) => l.itemId),
  )].sort();
  const stockByItem = new Map<string, { quantity: string; unit_cost: string | null }>();
  if (noneItemIds.length > 0) {
    const { rows: stockRows } = await client.query<{ item_id: string; quantity: string; unit_cost: string | null }>(
      `SELECT item_id, quantity::text AS quantity, unit_cost::text AS unit_cost
         FROM item_stock WHERE item_id = ANY($1::uuid[]) FOR UPDATE`,
      [noneItemIds],
    );
    for (const row of stockRows) stockByItem.set(row.item_id, row);
  }

  const batchIds = [...new Set(lines.map((l) => l.batchId).filter((id): id is string => !!id))].sort();
  const batchById = new Map<string, {
    item_id: string;
    batch_number: string;
    quantity: string;
    unit_cost: string | null;
    total_value_rial: string | null;
  }>();
  if (batchIds.length > 0) {
    const { rows: batchRows } = await client.query<{
      id: string;
      item_id: string;
      batch_number: string;
      quantity: string;
      unit_cost: string | null;
      total_value_rial: string | null;
    }>(
      `SELECT id, item_id, batch_number, quantity::text AS quantity, unit_cost::text AS unit_cost,
              total_value_rial::text AS total_value_rial
         FROM item_batches WHERE id = ANY($1::uuid[]) FOR UPDATE`,
      [batchIds],
    );
    for (const row of batchRows) batchById.set(row.id, row);
  }

  // Re-check the key after the locks: a concurrent same-key request may have
  // committed while this transaction waited on its rows — replay it instead
  // of validating (and failing) against post-winner stock.
  const { rows: raced } = await client.query<{
    id: string;
    total_value_rial: string;
    supplier_credit_rial: string;
    variance_rial: string;
    return_number: string;
    request_fingerprint: string | null;
  }>(
    `SELECT id, total_value_rial::text, supplier_credit_rial::text, variance_rial::text,
            return_number::text, request_fingerprint
       FROM item_supplier_returns WHERE business_id = $1 AND idempotency_key = $2`,
    [input.businessId, idempotencyKey],
  );
  if (raced[0]) {
    if (raced[0].request_fingerprint !== null && raced[0].request_fingerprint !== fingerprint) {
      throw new RetailReturnError("idempotency_conflict", 409);
    }
    return {
      id: raced[0].id,
      value: rialText(raced[0].total_value_rial),
      supplierCredit: rialText(raced[0].supplier_credit_rial),
      variance: raced[0].variance_rial,
      returnNumber: Number(raced[0].return_number),
      duplicate: true,
    };
  }

  // Resolve the receipt line a linked line relieves: an explicit
  // purchaseItemId must belong to this purchase and this item; otherwise the
  // single matching line is used, and several lines at one cost collapse to
  // it — several lines at different costs need the caller to choose.
  const resolvePurchaseLine = (itemId: string, purchaseItemId: string | null, batchNumber: string | null): PurchaseLineRow => {
    const candidates = purchaseLines.filter(
      (l) => l.item_id === itemId && (batchNumber === null || l.batch_number === batchNumber),
    );
    if (purchaseItemId) {
      const exact = candidates.find((l) => l.id === purchaseItemId);
      if (!exact) {
        if (!purchaseLines.some((l) => l.id === purchaseItemId)) throw new RetailReturnError("purchase_item_not_found", 404);
        throw new RetailReturnError(batchNumber === null ? "item_not_in_purchase" : "batch_provenance_mismatch", 409);
      }
      return exact;
    }
    if (candidates.length === 0) {
      throw new RetailReturnError(batchNumber === null ? "item_not_in_purchase" : "batch_provenance_mismatch", 409);
    }
    const costs = new Set(candidates.map((l) => l.unit_cost));
    if (candidates.length > 1 && costs.size > 1) throw new RetailReturnError("ambiguous_purchase_line", 409);
    return candidates[0];
  };

  const consumedByPurchaseItem = new Map<string, Decimal>();
  const consumedByItem = new Map<string, Decimal>();
  const consumeCeiling = (purchaseLine: PurchaseLineRow, qty: Decimal): void => {
    const linePrior = priorQtyByPurchaseItem.get(purchaseLine.id) ?? new Decimal(0);
    const lineUsed = (consumedByPurchaseItem.get(purchaseLine.id) ?? new Decimal(0)).plus(qty);
    if (linePrior.plus(lineUsed).gt(new Decimal(purchaseLine.quantity))) {
      throw new RetailReturnError("ceiling_exceeded", 409);
    }
    consumedByPurchaseItem.set(purchaseLine.id, lineUsed);
    // The item-level backstop: legacy rows with no purchase_item_id still
    // count, so prior + current can never exceed what the purchase received.
    const itemReceived = purchaseLines
      .filter((l) => l.item_id === purchaseLine.item_id)
      .reduce((sum, l) => sum.plus(new Decimal(l.quantity)), new Decimal(0));
    const itemPrior = priorQtyByItem.get(purchaseLine.item_id) ?? new Decimal(0);
    const itemUsed = (consumedByItem.get(purchaseLine.item_id) ?? new Decimal(0)).plus(qty);
    if (itemPrior.plus(itemUsed).gt(itemReceived)) throw new RetailReturnError("ceiling_exceeded", 409);
    consumedByItem.set(purchaseLine.item_id, itemUsed);
  };

  const assertBoundedRial = (value: RialText): RialText => {
    if (BigInt(value) > MAX_RIAL) throw new RetailReturnError("quantity_out_of_range");
    return value;
  };

  // Serial lines lock one row at a time (mixed id/number keys), in sorted
  // order for the same deadlock-freedom as the set locks above.
  const serialLines = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => items.get(line.itemId)!.tracking === "serial")
    .sort((a, b) => {
      const ka = `${a.line.itemId}${a.line.serialId ?? ""}${a.line.serialNumber ?? ""}`;
      const kb = `${b.line.itemId}${b.line.serialId ?? ""}${b.line.serialNumber ?? ""}`;
      return ka < kb ? -1 : ka > kb ? 1 : a.index - b.index;
    });
  const serialByLineIndex = new Map<number, { id: string; status: string; unit_cost: string | null; purchase_id: string | null }>();
  for (const { line, index } of serialLines) {
    if (!line.serialId && !line.serialNumber) throw new RetailReturnError("serial_required");
    const { rows: serialRows } = await client.query<{
      id: string;
      status: string;
      unit_cost: string | null;
      purchase_id: string | null;
    }>(
      line.serialId
        ? `SELECT id, status, unit_cost::text, purchase_id::text FROM item_serials WHERE id = $2 AND item_id = $1 FOR UPDATE`
        : `SELECT id, status, unit_cost::text, purchase_id::text FROM item_serials WHERE item_id = $1 AND serial_number = $2 FOR UPDATE`,
      [line.itemId, line.serialId ?? line.serialNumber],
    );
    const serial = serialRows[0];
    if (!serial) throw new RetailReturnError("serial_not_found", 404);
    serialByLineIndex.set(index, serial);
  }

  // Per-line valuation. Inventory is relieved at carrying value; the supplier
  // is credited at the linked invoice cost; unlinked returns credit what they
  // relieve (variance zero) — the explicit unlinked policy, visible on the
  // voucher preview rather than silently assumed.
  const resolved: ResolvedReturnLine[] = [];
  const noneRequested = new Map<string, Decimal>();
  const batchRequested = new Map<string, Decimal>();
  const batchValueRequested = new Map<string, bigint>();
  lines.forEach((line, index) => {
    const tracking = items.get(line.itemId)!.tracking;
    const qty = new Decimal(line.quantity);
    let carrying: RialText;
    let credit: RialText;
    let purchaseItemId: string | null = null;
    let batchId: string | null = null;
    let serialId: string | null = null;

    if (tracking === "serial") {
      if (!qty.eq(1)) throw new RetailReturnError("serial_quantity_must_be_one");
      const serial = serialByLineIndex.get(index)!;
      if (serial.status === "sold") throw new RetailReturnError("serial_already_sold", 409);
      if (serial.status === "supplier_returned") throw new RetailReturnError("serial_already_returned", 409);
      const transitionError = validateSerialStatusTransition(serial.status as SerialStatus, "supplier_returned");
      if (transitionError) throw new RetailReturnError("serial_not_in_stock", 409);
      if (serial.unit_cost == null) throw new RetailReturnError("cost_missing", 409);
      carrying = assertBoundedRial(rialText(BigInt(serial.unit_cost).toString()));
      serialId = serial.id;
      if (purchase) {
        // A linked return proves the unit came from the purchase it names.
        // Legacy multi-unit lines never recorded per-unit provenance
        // (purchase_id NULL), so they fall back to an item-level check.
        if (serial.purchase_id !== null && serial.purchase_id !== purchase.id) {
          throw new RetailReturnError("serial_provenance_mismatch", 409);
        }
        const itemCandidates = purchaseLines.filter((l) => l.item_id === line.itemId);
        if (itemCandidates.length === 0) throw new RetailReturnError("serial_provenance_mismatch", 409);
        let purchaseLine: PurchaseLineRow;
        if (line.purchaseItemId) {
          purchaseLine = resolvePurchaseLine(line.itemId, line.purchaseItemId, null);
        } else {
          const exact = itemCandidates.find((l) => l.serial_id === serial.id);
          purchaseLine = exact ?? resolvePurchaseLine(line.itemId, null, null);
        }
        purchaseItemId = purchaseLine.id;
        credit = assertBoundedRial(rialText(BigInt(purchaseLine.unit_cost).toString()));
        consumeCeiling(purchaseLine, qty);
      } else {
        credit = carrying;
      }
    } else if (tracking === "batch") {
      if (!line.batchId) throw new RetailReturnError("batch_required");
      const batch = batchById.get(line.batchId);
      if (!batch) throw new RetailReturnError("batch_not_found", 404);
      if (batch.item_id !== line.itemId) throw new RetailReturnError("batch_item_mismatch", 409);
      // A null lot cost is refused, never zeroed: the old
      // `Number(batch.unit_cost ?? 0)` silently created zero-valued removals.
      if (batch.unit_cost == null) throw new RetailReturnError("cost_missing", 409);
      batchId = line.batchId;
      const previouslyRequested = batchRequested.get(batchId) ?? new Decimal(0);
      const requested = previouslyRequested.plus(qty);
      if (requested.gt(new Decimal(batch.quantity))) throw new RetailReturnError("batch_depleted", 409);
      const remainingQuantity = new Decimal(batch.quantity).minus(previouslyRequested);
      const fullBatchValue = batch.total_value_rial == null
        ? roundRial(new Decimal(batch.quantity).times(new Decimal(batch.unit_cost)))
        : rialText(batch.total_value_rial);
      const remainingValue = BigInt(fullBatchValue) - (batchValueRequested.get(batchId) ?? 0n);
      carrying = assertBoundedRial(
        proportionalDepletionValue(
          quantityText(remainingQuantity.toFixed()),
          rialText(remainingValue.toString()),
          quantityText(qty.toFixed()),
        ),
      );
      batchRequested.set(batchId, requested);
      batchValueRequested.set(batchId, (batchValueRequested.get(batchId) ?? 0n) + BigInt(carrying));
      if (purchase) {
        const purchaseLine = resolvePurchaseLine(line.itemId, line.purchaseItemId, batch.batch_number);
        purchaseItemId = purchaseLine.id;
        credit = assertBoundedRial(roundRial(qty.times(new Decimal(purchaseLine.unit_cost))));
        consumeCeiling(purchaseLine, qty);
      } else {
        credit = carrying;
      }
    } else {
      const stock = stockByItem.get(line.itemId);
      if (!stock || stock.unit_cost == null) throw new RetailReturnError("cost_missing", 409);
      const requested = (noneRequested.get(line.itemId) ?? new Decimal(0)).plus(qty);
      if (requested.gt(new Decimal(stock.quantity))) throw new RetailReturnError("stock_insufficient", 409);
      noneRequested.set(line.itemId, requested);
      carrying = assertBoundedRial(roundRial(qty.times(new Decimal(stock.unit_cost))));
      if (purchase) {
        const purchaseLine = resolvePurchaseLine(line.itemId, line.purchaseItemId, null);
        purchaseItemId = purchaseLine.id;
        credit = assertBoundedRial(roundRial(qty.times(new Decimal(purchaseLine.unit_cost))));
        consumeCeiling(purchaseLine, qty);
      } else {
        credit = carrying;
      }
    }

    resolved.push({ itemId: line.itemId, quantity: line.quantity, quantityDecimal: qty, batchId, serialId, purchaseItemId, carrying, credit });
  });

  let carryingTotal = 0n;
  let creditTotal = 0n;
  for (const line of resolved) {
    carryingTotal += BigInt(line.carrying);
    creditTotal += BigInt(line.credit);
  }
  if (carryingTotal > MAX_RIAL || creditTotal > MAX_RIAL) throw new RetailReturnError("quantity_out_of_range");
  const varianceTotal = carryingTotal - creditTotal;

  // The header insert races deterministically: a concurrent request on the
  // same key blocks on the unique index, then lands here with no row — the
  // re-read below sees the single winner and applies the same fingerprint
  // guard, so the race yields one voucher, not two and not a 500.
  const returnNumber = await nextItemSupplierReturnNumber(client, input.businessId);
  const { rows: header } = await client.query<{ id: string }>(
    `INSERT INTO item_supplier_returns
       (business_id, location_id, purchase_id, supplier_id, settlement_method,
        total_value_rial, supplier_credit_rial, variance_rial, return_number,
        reason, created_by, idempotency_key, request_fingerprint)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (business_id, idempotency_key) DO NOTHING RETURNING id`,
    [
      input.businessId,
      input.locationId,
      purchaseId,
      explicitSupplierId,
      input.settlementMethod,
      carryingTotal.toString(),
      creditTotal.toString(),
      varianceTotal.toString(),
      returnNumber,
      reason,
      input.createdBy ?? null,
      idempotencyKey,
      fingerprint,
    ],
  );
  if (!header[0]) {
    const { rows: winner } = await client.query<{
      id: string;
      total_value_rial: string;
      supplier_credit_rial: string;
      variance_rial: string;
      return_number: string;
      request_fingerprint: string | null;
    }>(
      `SELECT id, total_value_rial::text, supplier_credit_rial::text, variance_rial::text,
              return_number::text, request_fingerprint
         FROM item_supplier_returns WHERE business_id = $1 AND idempotency_key = $2`,
      [input.businessId, idempotencyKey],
    );
    // No row means the winner rolled back — the key is free again, so the
    // caller retries into a clean insert; anything else is a hard conflict.
    if (!winner[0] || (winner[0].request_fingerprint !== null && winner[0].request_fingerprint !== fingerprint)) {
      throw new RetailReturnError("idempotency_conflict", 409);
    }
    return {
      id: winner[0].id,
      value: rialText(winner[0].total_value_rial),
      supplierCredit: rialText(winner[0].supplier_credit_rial),
      variance: winner[0].variance_rial,
      returnNumber: Number(winner[0].return_number),
      duplicate: true,
    };
  }
  const returnId = header[0].id;

  for (const line of resolved) {
    await client.query(
      `INSERT INTO item_supplier_return_items
         (return_id, item_id, batch_id, serial_id, purchase_item_id, quantity, value_rial, supplier_credit_rial)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [returnId, line.itemId, line.batchId, line.serialId, line.purchaseItemId, line.quantity, line.carrying, line.credit],
    );
  }

  // Guarded decrements: the locked reads above already proved sufficiency,
  // but the predicate is what keeps a concurrent sale/transfer/return from
  // over-relieving between that read and this write. One row, or it raced.
  for (const [itemId, qty] of [...noneRequested].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const updated = await client.query(
      `UPDATE item_stock SET quantity = quantity - $2::numeric, updated_at = now()
        WHERE item_id = $1 AND quantity >= $2::numeric`,
      [itemId, qty.toFixed()],
    );
    if (updated.rowCount !== 1) throw new RetailReturnError("stock_insufficient", 409);
  }
  const batchItemsTouched = new Set<string>();
  for (const line of resolved) {
    if (!line.batchId) continue;
    let depletedValue: RialText;
    try {
      depletedValue = await depleteBatchStock(client, {
        itemId: line.itemId,
        batchId: line.batchId,
        quantity: line.quantity,
      });
    } catch (error) {
      if (error instanceof RetailBatchError) throw new RetailReturnError("batch_depleted", 409);
      throw error;
    }
    if (BigInt(depletedValue) !== BigInt(line.carrying)) {
      throw new RetailReturnError("batch_value_mismatch", 409);
    }
    batchItemsTouched.add(line.itemId);
  }
  for (const line of resolved) {
    if (line.serialId) {
      const updated = await client.query(
        `UPDATE item_serials SET status = 'supplier_returned' WHERE id = $1 AND status = 'in_stock'`,
        [line.serialId],
      );
      if (updated.rowCount !== 1) throw new RetailReturnError("serial_not_in_stock", 409);
    }
  }
  // The rollup is recomputed in the SAME transaction: a supplier return
  // that relieved a lot but left `item_stock` at its old quantity would
  // desynchronise the shared cache from the authoritative batches
  // (migration 0078), and every later sale would over-sell.
  for (const itemId of [...batchItemsTouched].sort()) {
    await recomputeItemStockRollup(client, itemId);
  }

  await emitDomainEvent(client, {
    businessId: input.businessId,
    locationId: input.locationId,
    eventType: "retail.supplier_return",
    payload: {
      returnId,
      amount: rialText(carryingTotal.toString()),
      supplierCredit: rialText(creditTotal.toString()),
      variance: varianceTotal.toString(),
      settlementMethod: input.settlementMethod,
    },
    sourceType: "item_supplier_return",
    sourceId: returnId,
    createdBy: input.createdBy ?? null,
  });

  return {
    id: returnId,
    value: rialText(carryingTotal.toString()),
    supplierCredit: rialText(creditTotal.toString()),
    variance: varianceTotal.toString(),
    returnNumber,
    duplicate: false,
  };
}

export interface ReverseSupplierReturnResult {
  id: string;
  reversalEntryId: string | null;
  duplicate: boolean;
}

/**
 * Audited compensating reversal of a posted supplier-return voucher. The source
 * voucher and journal remain immutable; stock is restored to its original lot
 * or serial (or to the fungible item at the historical carrying value), the
 * exact original journal is mirrored, and the source status becomes reversed.
 * Caller owns the transaction so an accounting/stock failure rolls back every
 * effect together.
 */
export async function reverseItemSupplierReturn(
  client: PoolClient,
  input: {
    businessId: string;
    returnId: string;
    reason: string;
    idempotencyKey: string;
    actorId: string | null;
  },
): Promise<ReverseSupplierReturnResult> {
  const reason = input.reason.trim();
  const idempotencyKey = input.idempotencyKey.trim();
  if (!reason) throw new RetailReturnError("reversal_reason_required");
  if (reason.length > 500) throw new RetailReturnError("reason_too_long");
  if (!idempotencyKey || idempotencyKey.length > 200) throw new RetailReturnError("idempotency_key_required");

  const { rows: documents } = await client.query<{
    id: string;
    location_id: string;
    status: string;
    reversal_idempotency_key: string | null;
    reversal_entry_id: string | null;
  }>(
    `SELECT id, location_id, status, reversal_idempotency_key, reversal_entry_id
       FROM item_supplier_returns WHERE business_id = $1 AND id = $2 FOR UPDATE`,
    [input.businessId, input.returnId],
  );
  const document = documents[0];
  if (!document) throw new RetailReturnError("return_not_found", 404);
  if (document.status === "reversed") {
    if (document.reversal_idempotency_key === idempotencyKey) {
      return { id: document.id, reversalEntryId: document.reversal_entry_id, duplicate: true };
    }
    throw new RetailReturnError("return_already_reversed", 409);
  }
  if (document.status !== "posted") throw new RetailReturnError("return_not_reversible", 409);

  const { rows: lines } = await client.query<{
    id: string;
    item_id: string;
    tracking: string;
    quantity: string;
    value_rial: string;
    batch_id: string | null;
    serial_id: string | null;
  }>(
    `SELECT li.id, li.item_id, i.tracking::text AS tracking,
            li.quantity::text AS quantity, li.value_rial::text AS value_rial,
            li.batch_id, li.serial_id
       FROM item_supplier_return_items li
       JOIN items i ON i.id = li.item_id
      WHERE li.return_id = $1
      ORDER BY li.item_id, li.id
      FOR UPDATE OF li`,
    [document.id],
  );
  if (lines.length === 0) throw new RetailReturnError("return_not_reversible", 409);

  const fungible = new Map<string, { quantity: Decimal; value: bigint }>();
  const batchQuantity = new Map<string, { itemId: string; quantity: Decimal; value: bigint }>();
  const serialIds = new Map<string, string>();
  const batchItems = new Set<string>();
  for (const line of lines) {
    const qty = new Decimal(line.quantity);
    if (line.tracking === "batch") {
      if (!line.batch_id) throw new RetailReturnError("return_reversal_provenance_missing", 409);
      const prior = batchQuantity.get(line.batch_id) ?? { itemId: line.item_id, quantity: new Decimal(0), value: 0n };
      if (prior.itemId !== line.item_id) throw new RetailReturnError("return_reversal_provenance_missing", 409);
      prior.quantity = prior.quantity.plus(qty);
      prior.value += BigInt(line.value_rial);
      batchQuantity.set(line.batch_id, prior);
      batchItems.add(line.item_id);
    } else if (line.tracking === "serial") {
      if (!line.serial_id || !qty.eq(1)) throw new RetailReturnError("return_reversal_provenance_missing", 409);
      serialIds.set(line.serial_id, line.item_id);
    } else if (line.tracking === "none") {
      const prior = fungible.get(line.item_id) ?? { quantity: new Decimal(0), value: 0n };
      prior.quantity = prior.quantity.plus(qty);
      prior.value += BigInt(line.value_rial);
      fungible.set(line.item_id, prior);
    } else {
      throw new RetailReturnError("weight_unsupported", 409);
    }
  }

  // Lock aggregate stock in a deterministic order. Re-enter the original
  // carrying value rather than today's moving average so stock value and the
  // exact mirrored inventory journal stay reconciled after intervening buys.
  const fungibleIds = [...fungible.keys()].sort();
  const stockByItem = new Map<string, { quantity: string; unit_cost: string | null }>();
  if (fungibleIds.length) {
    const { rows } = await client.query<{ item_id: string; quantity: string; unit_cost: string | null }>(
      `SELECT item_id, quantity::text AS quantity, unit_cost::text AS unit_cost
         FROM item_stock WHERE item_id = ANY($1::uuid[]) ORDER BY item_id FOR UPDATE`,
      [fungibleIds],
    );
    for (const row of rows) stockByItem.set(row.item_id, row);
  }
  for (const itemId of fungibleIds) {
    const current = stockByItem.get(itemId);
    const restored = fungible.get(itemId)!;
    const currentQuantity = new Decimal(current?.quantity ?? "0");
    if (currentQuantity.gt(0) && current?.unit_cost == null) {
      throw new RetailReturnError("cost_missing", 409);
    }
    const nextQuantity = currentQuantity.plus(restored.quantity);
    const nextUnitCost = currentQuantity.isZero()
      ? roundRial(new Decimal(restored.value.toString()).div(restored.quantity))
      : roundRial(
          currentQuantity
            .times(current!.unit_cost!)
            .plus(new Decimal(restored.value.toString()))
            .div(nextQuantity),
        );
    await client.query(
      `INSERT INTO item_stock (item_id, quantity, unit_cost)
       VALUES ($1, $2::numeric, $3::bigint)
       ON CONFLICT (item_id) DO UPDATE
         SET quantity = item_stock.quantity + EXCLUDED.quantity,
             unit_cost = ROUND((item_stock.quantity * COALESCE(item_stock.unit_cost, 0)
                                + $4::numeric) / (item_stock.quantity + EXCLUDED.quantity)),
             updated_at = now()`,
      [itemId, restored.quantity.toFixed(), nextUnitCost, restored.value.toString()],
    );
  }

  for (const [batchId, restored] of [...batchQuantity.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const result = await client.query(
      `UPDATE item_batches
          SET quantity = quantity + $2::numeric,
              total_value_rial = CASE WHEN total_value_rial IS NULL THEN NULL
                                      ELSE total_value_rial + $4::bigint END
        WHERE id = $1 AND item_id = $3`,
      [batchId, restored.quantity.toFixed(), restored.itemId, restored.value.toString()],
    );
    if (result.rowCount !== 1) throw new RetailReturnError("return_reversal_provenance_missing", 409);
  }
  for (const [serialId, itemId] of [...serialIds.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const result = await client.query(
      `UPDATE item_serials SET status = 'in_stock'
        WHERE id = $1 AND item_id = $2 AND status = 'supplier_returned'`,
      [serialId, itemId],
    );
    if (result.rowCount !== 1) throw new RetailReturnError("return_reversal_stock_changed", 409);
  }
  for (const itemId of [...batchItems].sort()) await recomputeItemStockRollup(client, itemId);

  const { rows: originalEntries } = await client.query<{ id: string }>(
    `SELECT id FROM journal_entries
      WHERE business_id = $1 AND source_type = 'item_supplier_return' AND source_id = $2
      ORDER BY posted_at, id LIMIT 1 FOR UPDATE`,
    [input.businessId, document.id],
  );
  let reversalEntryId: string | null = null;
  if (originalEntries[0]) {
    reversalEntryId = await postExactMirrorEntry(client, {
      businessId: input.businessId,
      locationId: document.location_id,
      originalEntryId: originalEntries[0].id,
      sourceType: "item_supplier_return",
      sourceId: document.id,
      postingKind: "item_supplier_return_reversal",
      memo: `برگشت حوالهٔ تأمین‌کننده: ${reason}`,
      createdBy: input.actorId,
      idempotencyKey: `item_supplier_return_reversal:${idempotencyKey}`,
    });
  }

  await client.query(
    `UPDATE item_supplier_returns
        SET status = 'reversed', reversal_entry_id = $3,
            reversal_idempotency_key = $4, reversal_reason = $5,
            reversed_by = $6, reversed_at = now()
      WHERE business_id = $1 AND id = $2 AND status = 'posted'`,
    [input.businessId, document.id, reversalEntryId, idempotencyKey, reason, input.actorId],
  );
  await client.query(
    `INSERT INTO audit_log (business_id, location_id, user_id, action, entity, entity_id, payload)
     VALUES ($1, $2, $3, 'inventory.item_supplier_return.reversed', 'item_supplier_return', $4, $5::jsonb)`,
    [input.businessId, document.location_id, input.actorId, document.id, JSON.stringify({ reversalEntryId, reason, idempotencyKey })],
  );
  return { id: document.id, reversalEntryId, duplicate: false };
}

/** The service-side shape of one return line, after quantity canonicalization. */
type ParsedLineShape = {
  itemId: string;
  quantity: string;
  batchId: string | null;
  serialId: string | null;
  serialNumber: string | null;
  purchaseItemId: string | null;
};

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

/** Variants out of stock or at/under a positive reorder point — the «کمبود موجودی» list per branch. */
async function readLowStockReport(locationId: string, page?: number) {
  const result = await queryReportPage<{ item_id: string; name: string; sku: string | null; quantity: string; reorder_point: string }>(
    `SELECT i.id AS item_id, i.name, i.sku, s.quantity::text, s.reorder_point::text
       FROM item_stock s JOIN items i ON i.id = s.item_id
      WHERE i.location_id = $1 AND i.kind <> 'variant_parent' AND i.is_active
        AND ${stockNeedsAttentionSql("s.quantity", "s.reorder_point")}`,
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
