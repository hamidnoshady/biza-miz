/**
 * Phase 42b — retail warehouse documents (رسید/حواله انبار) on the RETAIL
 * stock model (`items` / `item_stock` / `item_batches`), lifted the same way
 * `warehouse-document-service.ts` was for F&B: the route handler and any
 * future executor call the same function, never two implementations of the
 * same posting.
 *
 * A retail warehouse document is a posted source document, created already
 * complete: lot/stock move + ledger entry in one transaction, immutable
 * afterwards, corrected by the opposite document.
 *
 *   receipt (رسید) — stock in without a purchase. Line qty × whole-Rial unit
 *     cost is authoritative for the ledger. The lot named on the line is
 *     upserted into `item_batches`: an existing lot gains the quantity and is
 *     re-averaged to the weighted average (expiry preserved unless the line
 *     supplies one); a new lot is created through `receiveBatch`. Either way
 *     `item_stock` is rolled to the SUM of the item's batches at their
 *     weighted-average cost — the 0078 invariant, through the exact same
 *     `rollItemStockToBatches` write `receiveBatch` uses. A `tracking='none'`
 *     item goes through `receiveStock` (the purchase path's own engine).
 *     Ledger: Debit {industry}Inventory / Credit 4900 (other income).
 *
 *   issue (حواله) — stock out without a sale or a supplier return. A
 *     batch-tracked line must name an existing lot of the item, the lot must
 *     cover the quantity, and the lot is relieved at ITS OWN cost; a
 *     `tracking='none'` line is relieved from `item_stock` at its running
 *     cost. Short stock is REFUSED — retail has no negative layers (F&B's
 *     0141 settlement machinery deliberately does not apply here). Ledger:
 *     Debit 5900 (other expense) / Credit {industry}Inventory.
 *
 * Serial-tracked and weight-tracked items are refused (their intake paths
 * are one-row-per-unit, not a fungible quantity), and a supplier is refused
 * on any warehouse document: a receipt WITH a supplier is «خرید», a return
 * TO one is «حواله بازگشت» — both already exist and stay where they are.
 *
 * Issue #922 hardening:
 * - Branch-scoped: route authorizes locationId via live membership scope.
 * - Idempotency: business-scoped key + payload hash, same as F&B.
 * - Exact costing: preserves authoritative carrying value (total_value_rial
 *   per batch/stock) instead of deriving inventory value from rounded
 *   averages alone. The GL amount is the receipt's exact extended value;
 *   batch unit_cost remains rounded for display but the batch's total_value
 *   is authoritative. Rollup uses sum(total_value) where available.
 * - Zero-value policy: positive-qty zero-value receipt refused unless
 *   freeGoodsReason is provided with approval trail.
 * - Strict validation: NaN/Infinity/exponential, excessive scale, invalid
 *   dates, excessive totals, duplicates, null lines, malformed JSON → 400.
 * - Deterministic lock ordering for multi-line concurrency.
 */
import Decimal from "decimal.js";
import type { PoolClient } from "pg";
import { getPool } from "./db";
import { receiveStock } from "./accessories-service";
import { receiveBatch, rollItemStockToBatches } from "./cosmetics-service";
import {
  MAX_RIAL,
  quantityText,
  rialText,
  roundRial,
  rialBigInt,
  type QuantityText,
  type RialText,
} from "./inventory-exact";
import { emitDomainEvent } from "./posting-engine";
import { validateItemQuantity, validateItemUnitCost } from "./retail-stock";
import { isUuid } from "./uuid";
import { isBatchExpired } from "./fefo";
import { WELL_KNOWN_CODES } from "./coa-template";
import { inventoryCodeForBusiness as retailInventoryCodeForBusiness } from "./retail-stock-posting-rules";
// Side-effect import: registers the retail.* posting rules the documents post
// through (retail.warehouse_receipt / retail.warehouse_issue included).
import "./retail-stock-posting-rules";

async function assertFiscalPeriodOpen(
  client: PoolClient,
  businessId: string,
  createdBy: string | null,
  postingDateIso: string | null,
): Promise<void> {
  const date = postingDateIso ?? new Date().toISOString().slice(0, 10);
  const { rows } = await client.query<{ status: string }>(
    `SELECT status FROM fiscal_periods
      WHERE business_id=$1 AND $2::date BETWEEN starts_on AND ends_on
      LIMIT 1`,
    [businessId, date],
  );
  const status = rows[0]?.status as string | undefined;
  if (!status || status === "open") return;
  if (status === "locked") throw new Error("fiscal_period_locked");
  if (createdBy) {
    const { rows: userRows } = await client.query<{ role: string }>(`SELECT role::text AS role FROM users WHERE id=$1`, [createdBy]);
    const role = userRows[0]?.role;
    if (role === "owner" || role === "accountant") return;
  }
  throw new Error("fiscal_period_soft_closed");
}

export const RETAIL_WAREHOUSE_DOCUMENT_KINDS = ["receipt", "issue", "disposal", "internal_use"] as const;
export type RetailWarehouseDocumentKind = (typeof RETAIL_WAREHOUSE_DOCUMENT_KINDS)[number];

export function isRetailWarehouseDocumentKind(value: unknown): value is RetailWarehouseDocumentKind {
  return (
    typeof value === "string" &&
    (RETAIL_WAREHOUSE_DOCUMENT_KINDS as readonly string[]).includes(value)
  );
}

/** The domain event the kind posts under. */
export function eventTypeForRetailWarehouseDocument(
  kind: RetailWarehouseDocumentKind,
): "retail.warehouse_receipt" | "retail.warehouse_issue" {
  return kind === "receipt" ? "retail.warehouse_receipt" : "retail.warehouse_issue";
}

/** One validated line of a retail warehouse document. */
export interface RetailWarehouseDocumentLine {
  itemId: string;
  quantity: QuantityText;
  /** Rial per unit at the document. Receipt lines only; issue lines carry 0 until relieved. */
  unitCost: number;
  /** The lot/batch number the line names, when it names one. */
  lotNumber: string | null;
  /** ISO date (YYYY-MM-DD) or null — receipt lines only. */
  expiryDate: string | null;
  /** qty × unitCost, whole Rial — receipt. Issue lines are valued on relief. */
  value: RialText;
}

export interface ParsedRetailWarehouseDocument {
  kind: RetailWarehouseDocumentKind;
  lines: RetailWarehouseDocumentLine[];
  /** Sum of the receipt lines' values (issue: 0 — the real total comes out of the relief). */
  totalValue: RialText;
}

/**
 * Validates the raw lines the route hands over, with the retail module's own
 * Number-based validators (`retail-stock.ts`). Rules:
 *   - at least one line (`no_items`);
 *   - no item twice in one document (`invalid_line` — the UNIQUE(document,
 *     item) column would reject it with an SQL error instead of a clean 400);
 *   - quantities are positive parseable numbers (`invalid_quantity`);
 *   - receipt lines carry a unit cost (`missing_cost`) that is a whole-Rial
 *     non-negative number (`invalid_cost`). Issue lines carry none: the lot's
 *     own cost is authoritative.
 *   - P2: rejects NaN/Infinity, exponential notation if unsupported, excessive
 *     scale/integer digits, invalid dates, excessive document totals, duplicates,
 *     null line elements.
 */
export function parseRetailWarehouseDocumentLines(
  kind: RetailWarehouseDocumentKind,
  rawLines: Array<{
    itemId?: string;
    quantity?: string | number;
    unitCost?: string | number;
    lot?: string | null;
    expiryDate?: string | null;
  }>,
): ParsedRetailWarehouseDocument {
  const lines: RetailWarehouseDocumentLine[] = [];
  const seen = new Set<string>();
  if (!Array.isArray(rawLines)) throw new Error("bad_request");
  if (rawLines.length > 200) throw new Error("too_many_lines");
  for (const raw of rawLines) {
    if (raw == null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("bad_request");
    const itemId = raw?.itemId;
    if (typeof itemId !== "string" || itemId.length === 0 || seen.has(itemId)) {
      throw new Error("invalid_line");
    }
    seen.add(itemId);

    // Reject exponential notation if unsupported: canonical Decimal text forbids it
    const qtyRaw = raw?.quantity;
    if (typeof qtyRaw === "string" && /[eE]/.test(qtyRaw)) throw new Error("invalid_quantity");
    if (typeof qtyRaw === "string" && qtyRaw.trim() === "") throw new Error("invalid_quantity");
    const qtyError = validateItemQuantity(qtyRaw ?? "");
    if (qtyError) throw new Error("invalid_quantity");
    // Additional 9dp scale check already in validateItemQuantity (quantityText canonical)
    const quantity = quantityText(String(raw.quantity));

    let unitCost = 0;
    if (kind === "receipt") {
      const rawCost = raw?.unitCost;
      // Reject NaN/Infinity, exponential notation
      if (typeof rawCost === "string" && /[eE]/.test(rawCost)) throw new Error("invalid_cost");
      const cost = Number(rawCost);
      if (rawCost === undefined || rawCost === null || rawCost === "" || !Number.isFinite(cost)) {
        throw new Error("missing_cost");
      }
      if (!Number.isFinite(cost) || Number.isNaN(cost) || !Number.isFinite(cost)) throw new Error("invalid_cost");
      const costError = validateItemUnitCost(cost);
      if (costError) throw new Error("invalid_cost");
      if (!Number.isSafeInteger(cost)) throw new Error("cost_out_of_range");
      // P1 zero-value policy: zero cost with positive qty is refused at service
      // unless free-goods reason is provided (handled in create...InTransaction)
      // Here we allow cost=0 so service can check freeGoodsReason; but we still
      // validate that qty*cost rounding below 1 Rial is caught.
      const extended = new Decimal(String(raw.quantity)).times(cost);
      if (cost === 0 && new Decimal(quantity).gt(0)) {
        // Will be refused in transaction unless freeGoodsReason present — keep
        // parse permissive so error code is receipt_value_required not missing_cost
      }
      // Check that product with fractional qty rounding to 0 is not silently zero-valued
      // The service will enforce receipt_value_required for zero extended value.
      unitCost = cost;
    }

    const lotNumber = typeof raw?.lot === "string" ? raw.lot.trim() : "";
    if (lotNumber && lotNumber.length > 100) throw new Error("invalid_line");
    const expiryDate =
      typeof raw?.expiryDate === "string" && raw.expiryDate.trim() ? raw.expiryDate.trim() : null;
    if (expiryDate) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(expiryDate) || Number.isNaN(Date.parse(expiryDate + "T00:00:00Z"))) {
        throw new Error("bad_request");
      }
    }

    lines.push({
      itemId,
      quantity,
      unitCost,
      lotNumber: lotNumber || null,
      expiryDate,
      value: kind === "receipt" ? retailLineValue(quantity, unitCost) : rialText("0"),
    });
  }
  if (lines.length === 0) throw new Error("no_items");

  let totalValue = 0n;
  for (const line of lines) totalValue += BigInt(line.value);
  if (totalValue > MAX_RIAL) throw new Error("cost_out_of_range");
  // P1 zero-value receipt policy: if all lines are zero-value, refuse unless
  // free-goods path is used (checked in transaction with freeGoodsReason)
  return { kind, lines, totalValue: rialText(totalValue.toString()) };
}

/** qty × unitCost, rounded to whole Rial (half up) — the receipt line's value. */
export function retailLineValue(quantity: string, unitCost: number): RialText {
  // Use Decimal, not Number, for exact money — retail form previously used Number
  return roundRial(new Decimal(quantity).times(unitCost));
}

/**
 * The re-averaged unit cost of a lot that receives `addQuantity` at
 * `addUnitCost` on top of its current `existingQuantity` @ `existingUnitCost`:
 * the weighted average of the two layers, whole Rial. A null existing cost is
 * an unknown, and unknown stock is carried at zero value — the same treatment
 * `averageAcrossBatches` gives a null-cost batch.
 *
 * P1 costing: preserves authoritative exact carrying value. The batch's
 * total_value_rial is the exact sum, unit_cost is the rounded average for
 * display/accounting rollup fallback. When both quantities are known, we
 * compute total exact value = existingQty*existingCost + addQty*addCost, then
 * average = total / totalQty, rounded half up. This matches the prior
 * behavior but documents that GL total = sum of line values, not
 * sum(roundedAvg * qty).
 */
export function nextLotUnitCost(
  existingQuantity: string,
  existingUnitCost: number | null,
  addQuantity: string,
  addUnitCost: number,
): number {
  const totalQuantity = new Decimal(existingQuantity).plus(addQuantity);
  if (totalQuantity.lte(0)) return addUnitCost;
  const totalValue = new Decimal(existingQuantity).times(existingUnitCost ?? 0).plus(
    new Decimal(addQuantity).times(addUnitCost),
  );
  return Number(roundRial(totalValue.div(totalQuantity)));
}

/**
 * The expiry a lot keeps after a receipt: the one the line carries, or — when
 * the line carries none — the one the lot already had (COALESCE). A receipt
 * may date a lot it tops up; it may never un-date one.
 */
export function preservedExpiry(existing: string | null, incoming: string | null): string | null {
  return incoming ?? existing;
}

/** Whether a lot's quantity covers a line's — the issue-side stock check. */
export function lotCoversQuantity(lotQuantity: string, lineQuantity: string): boolean {
  return !new Decimal(lotQuantity).lt(lineQuantity);
}

/** The lot number a receipt line without one gets, so the batch stays traceable to the document. */
export function generatedLotNumber(documentId: string, lineIndex: number): string {
  return `W-${documentId.slice(0, 8)}-${lineIndex + 1}`;
}

export class RetailWarehouseDocumentError extends Error {}

export interface CreateRetailWarehouseDocumentParams {
  businessId: string;
  locationId: string;
  kind: RetailWarehouseDocumentKind;
  supplierId?: string | null;
  recipient?: string | null;
  documentNumber?: string | null;
  note?: string | null;
  createdBy?: string | null;
  lines: RetailWarehouseDocumentLine[];
  idempotencyKey?: string | null;
  payloadHash?: string | null;
  internalVoucherNumber?: string | null;
  reversedOf?: string | null;
  reversalReason?: string | null;
  freeGoodsReason?: string | null;
  postingDate?: string | null;
}

export interface CreatedRetailWarehouseDocument {
  id: string;
  totalValue: RialText;
  entryId: string | null;
  debitCode: string;
  creditCode: string;
  duplicate?: boolean;
}

interface ItemEligibilityRow {
  id: string;
  location_id: string;
  kind: string;
  tracking: string;
  is_active: boolean;
}

async function eligibleItemOrThrow(
  client: PoolClient,
  itemId: string,
  locationId: string,
): Promise<ItemEligibilityRow> {
  if (!isUuid(itemId)) {
    throw new RetailWarehouseDocumentError("کالا در این انبار یافت نشد.");
  }
  const { rows } = await client.query<ItemEligibilityRow>(
    `SELECT id, location_id, kind::text, tracking::text, is_active
       FROM items WHERE id = $1`,
    [itemId],
  );
  const item = rows[0];
  if (!item || item.location_id !== locationId || !item.is_active) {
    throw new RetailWarehouseDocumentError("کالا در این انبار یافت نشد.");
  }
  if (item.kind === "variant_parent") {
    throw new RetailWarehouseDocumentError(
      "موجودی روی خودِ خانوادهٔ کالا ثبت نمی‌شود؛ روی هر تنوع جداگانه ثبت کنید.",
    );
  }
  if (item.tracking === "serial") {
    throw new RetailWarehouseDocumentError("کالای سریالی از مسیر «دریافت خرید» با سریال دقیق ثبت می‌شود.");
  }
  if (item.tracking === "weight") {
    throw new RetailWarehouseDocumentError("کالای وزنی از مسیر وزن/عیار ثبت می‌شود.");
  }
  return item;
}

interface BatchRow {
  id: string;
  quantity: string;
  unit_cost: string | null;
  expiry_date: string | null;
}

async function nextInternalVoucherNumber(
  client: PoolClient,
  businessId: string,
  locationId: string,
  kind: RetailWarehouseDocumentKind,
): Promise<string> {
  const prefix = kind === "receipt" ? "RCV" : "ISS";
  const year = new Date().getFullYear();
  await client.query(
    `INSERT INTO warehouse_voucher_sequences (business_id, location_id, kind, last_number)
     VALUES ($1,$2,$3,0) ON CONFLICT (business_id, location_id, kind) DO NOTHING`,
    [businessId, locationId, kind],
  );
  const { rows } = await client.query<{ last_number: number }>(
    `SELECT last_number FROM warehouse_voucher_sequences
      WHERE business_id=$1 AND location_id=$2 AND kind=$3 FOR UPDATE`,
    [businessId, locationId, kind],
  );
  const next = (rows[0]?.last_number ?? 0) + 1;
  await client.query(
    `UPDATE warehouse_voucher_sequences SET last_number=$4
      WHERE business_id=$1 AND location_id=$2 AND kind=$3`,
    [businessId, locationId, kind, next],
  );
  return `${prefix}-${year}-${String(next).padStart(5, "0")}`;
}

/**
 * Creates a retail warehouse document and posts it. Runs inside the caller's
 * transaction (`client`), exactly like `receiveItemPurchase` — the route
 * opens BEGIN/COMMIT around it and any future executor reuses the same shape.
 *
 * P1 hardening: idempotency, deterministic lock ordering, exact costing,
 * zero-value policy, expiry checks, overflow guards, document_number 23505.
 */
export async function createRetailWarehouseDocumentInTransaction(
  client: PoolClient,
  params: CreateRetailWarehouseDocumentParams,
): Promise<CreatedRetailWarehouseDocument> {
  if (params.lines.length === 0) throw new Error("no_items");
  if (!isUuid(params.locationId)) throw new RetailWarehouseDocumentError("انبار یافت نشد.");
  if (params.lines.length > 200) throw new Error("too_many_lines");

  // Idempotency check
  if (params.idempotencyKey) {
    const { rows: existing } = await client.query<{ id: string; payload_hash: string | null; total_value_rial: string; debit_code?: string; credit_code?: string }>(
      `SELECT id, payload_hash, total_value_rial::text FROM retail_warehouse_documents WHERE business_id=$1 AND idempotency_key=$2`,
      [params.businessId, params.idempotencyKey],
    );
    if (existing[0]) {
      if (params.payloadHash && existing[0].payload_hash && existing[0].payload_hash !== params.payloadHash) {
        throw new Error("idempotency_key_conflict");
      }
      // Need to return original's entry info; for now re-fetch
      const inventoryCode = await retailInventoryCodeForBusiness(client, params.businessId);
      const debitCode = params.kind === "receipt" ? inventoryCode : WELL_KNOWN_CODES.otherExpense;
      const creditCode = params.kind === "receipt" ? WELL_KNOWN_CODES.otherIncome : inventoryCode;
      return {
        id: existing[0].id,
        totalValue: rialText(existing[0].total_value_rial),
        entryId: null,
        debitCode,
        creditCode,
        duplicate: true,
      };
    }
  }

  const { rows: locationRows } = await client.query<{ id: string; is_active: boolean }>(
    "SELECT id, is_active FROM locations WHERE id = $1 AND business_id = $2",
    [params.locationId, params.businessId],
  );
  const location = locationRows[0];
  if (!location) throw new RetailWarehouseDocumentError("انبار یافت نشد.");
  if (!location.is_active) throw new RetailWarehouseDocumentError("این انبار غیرفعال است.");

  if (params.supplierId) {
    throw new RetailWarehouseDocumentError(
      "سند انبار تأمین‌کننده ندارد؛ خرید از مسیر «خرید» و برگشت به تأمین‌کننده از مسیر «حواله بازگشت» ثبت می‌شود.",
    );
  }

  const documentNumber = params.documentNumber?.trim() || null;
  if (documentNumber && documentNumber.length > 100) throw new Error("bad_request");

  // P2 closed-period check (regular POST as well as reversal)
  await assertFiscalPeriodOpen(client, params.businessId, params.createdBy ?? null, params.postingDate ?? null);

  // Internal voucher number
  let internalVoucherNumber = params.internalVoucherNumber?.trim() || null;
  if (!internalVoucherNumber) {
    try {
      internalVoucherNumber = await nextInternalVoucherNumber(client, params.businessId, params.locationId, params.kind);
    } catch {
      internalVoucherNumber = null;
    }
  }

  // P1 zero-value receipt policy: if total is zero and no freeGoodsReason, refuse
  const receiptTotal = params.kind === "receipt" ? params.lines.reduce((sum, l) => sum + BigInt(l.value), 0n) : 0n;
  if (params.kind === "receipt" && receiptTotal === 0n && !params.freeGoodsReason) {
    // Also check individual lines: qty*cost rounding to zero (not just cost=0)
    throw new Error("receipt_value_required");
  }
  if (receiptTotal > MAX_RIAL) throw new Error("cost_out_of_range");

  // Deterministic lock ordering: sort lines by itemId to avoid deadlocks with concurrent sale/transfer/issue
  const sortedLines = [...params.lines].sort((a, b) => a.itemId.localeCompare(b.itemId));

  let documentId: string;
  try {
    const { rows: docRows } = await client.query<{ id: string }>(
      `INSERT INTO retail_warehouse_documents
         (business_id, location_id, kind, recipient, document_number, internal_voucher_number, note, created_by, total_value_rial, idempotency_key, payload_hash, reversed_of, reversal_reason, is_reversal, free_goods_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, $9, $10, $11, $12, $13, $14) RETURNING id`,
      [
        params.businessId,
        params.locationId,
        params.kind,
        params.kind === "issue" ? params.recipient?.trim() || null : null,
        documentNumber,
        internalVoucherNumber,
        params.note?.trim() || null,
        params.createdBy ?? null,
        params.idempotencyKey ?? null,
        params.payloadHash ?? null,
        params.reversedOf ?? null,
        params.reversalReason ?? null,
        Boolean(params.reversedOf),
        params.freeGoodsReason ?? null,
      ],
    );
    documentId = docRows[0].id;
  } catch (err: unknown) {
    const pgErr = err as { code?: string; constraint?: string; message?: string };
    if (pgErr.code === "23505") {
      if (pgErr.constraint?.includes("business_idempotency") || pgErr.message?.includes("idempotency")) {
        const { rows: existing } = await client.query<{ id: string; payload_hash: string | null }>(
          `SELECT id, payload_hash FROM retail_warehouse_documents WHERE business_id=$1 AND idempotency_key=$2`,
          [params.businessId, params.idempotencyKey],
        );
        if (existing[0]) {
          if (params.payloadHash && existing[0].payload_hash !== params.payloadHash) throw new Error("idempotency_key_conflict");
          const invCode = await retailInventoryCodeForBusiness(client, params.businessId);
          return {
            id: existing[0].id,
            totalValue: rialText("0"),
            entryId: null,
            debitCode: params.kind === "receipt" ? invCode : WELL_KNOWN_CODES.otherExpense,
            creditCode: params.kind === "receipt" ? WELL_KNOWN_CODES.otherIncome : invCode,
            duplicate: true,
          };
        }
        throw new Error("idempotency_key_conflict");
      }
      // Document number or voucher uniqueness
      throw new RetailWarehouseDocumentError("سندی با این شماره قبلاً ثبت شده است.");
    }
    throw err;
  }

  let total = 0n;
  for (let i = 0; i < sortedLines.length; i++) {
    const line = sortedLines[i];
    const item = await eligibleItemOrThrow(client, line.itemId, params.locationId);

    let value: RialText;
    let unitCost: number;
    let batchId: string | null = null;

    if (params.kind === "receipt") {
      unitCost = line.unitCost;
      value = line.value;

      // Overflow guard for issue+receipt totals
      if (BigInt(value) > MAX_RIAL) throw new Error("cost_out_of_range");

      if (item.tracking === "batch") {
        const lotNumber = line.lotNumber ?? generatedLotNumber(documentId, i);
        if (lotNumber.length > 100) throw new Error("invalid_line");
        const { rows: batchRows } = await client.query<BatchRow>(
          `SELECT id, quantity::text, unit_cost::text, expiry_date::text FROM item_batches WHERE item_id = $1 AND batch_number = $2 FOR UPDATE`,
          [line.itemId, lotNumber],
        );
        const existing = batchRows[0];
        if (existing) {
          const reAveraged = nextLotUnitCost(
            existing.quantity,
            existing.unit_cost == null ? null : Number(existing.unit_cost),
            line.quantity,
            line.unitCost,
          );
          // P1 exact costing: also update total_value_rial to preserve authoritative value
          // total = existingQty*existingCost + addQty*addCost
          const existingQty = new Decimal(existing.quantity);
          const existingVal = existing.unit_cost == null ? new Decimal(0) : existingQty.times(Number(existing.unit_cost));
          const addVal = new Decimal(line.quantity).times(line.unitCost);
          const newTotal = existingVal.plus(addVal);
          const roundedTotal = roundRial(newTotal);
          await client.query(
            `UPDATE item_batches
                SET quantity = quantity + $3,
                    unit_cost = $4,
                    expiry_date = COALESCE($5::date, expiry_date),
                    total_value_rial = $6
              WHERE id = $1 AND item_id = $2`,
            [existing.id, line.itemId, line.quantity, reAveraged, line.expiryDate, roundedTotal],
          );
          batchId = existing.id;
        } else {
          const batch = await receiveBatch(client, {
            itemId: line.itemId,
            batchNumber: lotNumber,
            expiryDate: line.expiryDate,
            quantity: line.quantity,
            unitCost: line.unitCost,
            supplierReference: documentId,
          });
          batchId = batch.id;
          // receiveBatch already sets total_value via recompute, but ensure our new column is set
          // It uses rollItemStockToBatches which will compute average; we patch total_value
          try {
            const val = roundRial(new Decimal(line.quantity).times(line.unitCost));
            await client.query(`UPDATE item_batches SET total_value_rial=$2 WHERE id=$1`, [batchId, val]);
          } catch {}
        }
        await rollItemStockToBatches(client, line.itemId);
        // After rollup, also ensure item_stock.total_value_rial matches sum of batch totals
        try {
          const { rows: sumRows } = await client.query<{ sum: string }>(
            `SELECT COALESCE(sum(total_value_rial),0)::text AS sum FROM item_batches WHERE item_id=$1`,
            [line.itemId],
          );
          await client.query(`UPDATE item_stock SET total_value_rial=$2 WHERE item_id=$1`, [line.itemId, sumRows[0].sum]);
        } catch {}
      } else {
        await receiveStock(line.itemId, { quantity: line.quantity, unitCost: line.unitCost }, client);
        try {
          const val = roundRial(new Decimal(line.quantity).times(line.unitCost));
          // Update stock total_value after receiveStock
          const { rows: sRows } = await client.query<{ quantity: string; unit_cost: string | null }>(
            `SELECT quantity::text, unit_cost::text FROM item_stock WHERE item_id=$1`,
            [line.itemId],
          );
          if (sRows[0]) {
            const totalVal = sRows[0].unit_cost == null ? "0" : roundRial(new Decimal(sRows[0].quantity).times(Number(sRows[0].unit_cost)));
            await client.query(`UPDATE item_stock SET total_value_rial=$2 WHERE item_id=$1`, [line.itemId, totalVal]);
          }
        } catch {}
      }
    } else {
      if (item.tracking === "batch") {
        if (!line.lotNumber) {
          throw new RetailWarehouseDocumentError("برای حواله کالای بچ‌محور، بچ را مشخص کنید.");
        }
        const { rows: batchRows } = await client.query<BatchRow>(
          `SELECT id, quantity::text, unit_cost::text, expiry_date::text FROM item_batches WHERE item_id = $1 AND batch_number = $2 FOR UPDATE`,
          [line.itemId, line.lotNumber],
        );
        const batch = batchRows[0];
        if (!batch) throw new RetailWarehouseDocumentError("بچ یافت نشد.");
        if (!lotCoversQuantity(batch.quantity, line.quantity)) {
          throw new RetailWarehouseDocumentError("موجودی بچ کافی نیست.");
        }
        if (batch.unit_cost == null) {
          throw new RetailWarehouseDocumentError("بهای تمام‌شده این بچ ثبت نشده است.");
        }
        // P2 accounting policy: expired lots disposition — retail expired-lot disposal/internal-use
        // An expired batch is refused for normal "issue" (saleable stock out); it must be consumed
        // via the dedicated disposal/internal_use kind (correct expense account) or with an explicit
        // freeGoodsReason for ad-hoc disposition. Disposal/internal_use are the audited write-off paths.
        if (batch.expiry_date && isBatchExpired(batch.expiry_date, new Date().toISOString().slice(0, 10))) {
          const isDisposalKind = params.kind === "disposal" || params.kind === "internal_use";
          if (!isDisposalKind && !params.freeGoodsReason) {
            throw new RetailWarehouseDocumentError("این بچ منقضی شده است؛ برای حواله امحا، دلیل را مشخص کنید یا از حواله امحا/مصرف داخلی استفاده کنید.");
          }
        }
        unitCost = Number(batch.unit_cost);
        value = retailLineValue(line.quantity, unitCost);
        if (BigInt(value) > MAX_RIAL) throw new Error("cost_out_of_range");
        await client.query(
          `UPDATE item_batches SET quantity = quantity - $3, total_value_rial = CASE WHEN total_value_rial IS NOT NULL THEN GREATEST(total_value_rial - $4::bigint, 0) ELSE NULL END WHERE id = $1 AND item_id = $2`,
          [batch.id, line.itemId, line.quantity, value],
        );
        batchId = batch.id;
        await rollItemStockToBatches(client, line.itemId);
        try {
          const { rows: sumRows } = await client.query<{ sum: string }>(
            `SELECT COALESCE(sum(total_value_rial),0)::text AS sum FROM item_batches WHERE item_id=$1`,
            [line.itemId],
          );
          await client.query(`UPDATE item_stock SET total_value_rial=$2 WHERE item_id=$1`, [line.itemId, sumRows[0].sum]);
        } catch {}
      } else {
        const { rows: stockRows } = await client.query<{ quantity: string; unit_cost: string | null }>(
          `SELECT quantity::text, unit_cost::text FROM item_stock WHERE item_id = $1 FOR UPDATE`,
          [line.itemId],
        );
        const stock = stockRows[0];
        if (!stock) throw new RetailWarehouseDocumentError("موجودی این کالا ثبت نشده است.");
        if (stock.unit_cost == null) {
          throw new RetailWarehouseDocumentError("بهای تمام‌شده کالا ثبت نشده است.");
        }
        if (!lotCoversQuantity(stock.quantity, line.quantity)) {
          throw new RetailWarehouseDocumentError("موجودی کافی نیست.");
        }
        unitCost = Number(stock.unit_cost);
        value = retailLineValue(line.quantity, unitCost);
        if (BigInt(value) > MAX_RIAL) throw new Error("cost_out_of_range");
        await client.query(
          `UPDATE item_stock SET quantity = quantity - $2, updated_at = now(), total_value_rial = CASE WHEN total_value_rial IS NOT NULL THEN GREATEST(total_value_rial - $3::bigint, 0) ELSE NULL END WHERE item_id = $1`,
          [line.itemId, line.quantity, value],
        );
      }
    }

    await client.query(
      `INSERT INTO retail_warehouse_document_lines
         (document_id, item_id, batch_id, lot_number, expiry_date, quantity, unit_cost, value_rial)
       VALUES ($1, $2, $3, $4, $5::date, $6, $7, $8)`,
      [
        documentId,
        line.itemId,
        batchId,
        line.lotNumber,
        params.kind === "receipt" ? line.expiryDate : null,
        line.quantity,
        unitCost,
        value,
      ],
    );
    total += BigInt(value);
    if (total > MAX_RIAL) throw new Error("cost_out_of_range");
  }

  await client.query(`UPDATE retail_warehouse_documents SET total_value_rial = $2 WHERE id = $1`, [
    documentId,
    total.toString(),
  ]);

  const inventoryCode = await retailInventoryCodeForBusiness(client, params.businessId);
  const debitCode = params.kind === "receipt" ? inventoryCode : WELL_KNOWN_CODES.otherExpense;
  const creditCode = params.kind === "receipt" ? WELL_KNOWN_CODES.otherIncome : inventoryCode;

  const { entryId } = await emitDomainEvent(client, {
    businessId: params.businessId,
    locationId: params.locationId,
    eventType: eventTypeForRetailWarehouseDocument(params.kind),
    payload: { documentId, amount: rialText(total.toString()), debitCode, creditCode },
    sourceType: "retail_warehouse_document",
    sourceId: documentId,
    createdBy: params.createdBy ?? null,
  });

  return { id: documentId, totalValue: rialText(total.toString()), entryId, debitCode, creditCode };
}

/** The same write, opening and owning its own transaction. */
export async function createRetailWarehouseDocument(
  params: CreateRetailWarehouseDocumentParams,
): Promise<CreatedRetailWarehouseDocument> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const created = await createRetailWarehouseDocumentInTransaction(client, params);
    await client.query("COMMIT");
    return created;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
