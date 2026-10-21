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
import { createHash } from "node:crypto";
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
import { rialBigInt, roundRial, rialText, type RialText } from "./inventory-exact";
import { resolvePaymentDueDate, type SupplierInvoiceInput } from "./payables-input";
import { emitDomainEvent } from "./posting-engine";
import { classifyStockLevel, deadStockCutoff, stockNeedsAttentionSql, validateItemQuantity, validateItemUnitCost } from "./retail-stock";
import { validateWarrantyMonths } from "./watch";
import { validateSerialStatusTransition, type SerialStatus } from "./items";
// Side-effect import: registers the retail.* stock posting rules.
import "./retail-stock-posting-rules";

export class RetailStockError extends Error {}

/**
 * Issue #915 — the same idempotency key arrived again with a DIFFERENT
 * payload. The caller must surface a deterministic conflict (409), never
 * silently return another request's receipt.
 */
export class RetailIdempotencyConflictError extends RetailStockError {
  constructor() {
    super("این شناسهٔ درخواست قبلاً برای درخواست دیگری استفاده شده است.");
  }
}

/**
 * Issue #915 — two requests raced on the same idempotency key and this one
 * lost the unique-index insert. The transaction is aborted; the caller must
 * roll back, re-read the committed winner and answer from it.
 */
export class RetailIdempotencyRaceError extends RetailStockError {
  constructor(readonly idempotencyKey: string) {
    super("درخواست هم‌زمان با همین شناسه ثبت شد.");
  }
}

/**
 * Canonical hash of a purchase/return request body, bound to the exact
 * fields the operation consumes — so a retried request with the same
 * idempotency key but a different payload is detectable as a conflict.
 */
export function retailRequestHash(payload: unknown): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([, v]) => v !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, v]) => [k, canonical(v)]),
      );
    }
    return value ?? null;
  };
  return createHash("sha256").update(JSON.stringify(canonical(payload))).digest("hex");
}

/** How a retail purchase was settled — mirrors the F&B receive's choice (ledger.ts `SettlementMethod`). */
export const RETAIL_PURCHASE_SETTLEMENT_METHODS = ["credit", "cash", "bank"] as const;
export type RetailPurchaseSettlementMethod = (typeof RETAIL_PURCHASE_SETTLEMENT_METHODS)[number];

type PurchaseLine = {
  itemId: string;
  quantity: string;
  /**
   * Whole Rial — decimal text for exact bigint values (the wire format, safe
   * past 2^53), or a safe integer from older internal callers (issue #915).
   */
  unitCost: number | string;
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
  /** True when an idempotent retry matched an already-committed receipt. */
  duplicate: boolean;
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
    /**
     * Issue #915 — a stable, client-generated key, reused verbatim across
     * retries. The first writer wins (unique per business); an identical
     * retry returns the original receipt; the same key with a different
     * `requestHash` is a deterministic conflict. Optional because internal
     * callers (Holoo import keys on its own remote-id mapping) carry their
     * own dedup identity.
     */
    idempotencyKey?: string | null;
    requestHash?: string | null;
    /**
     * Issue #915 — how the goods were paid: credit (AP, the default and the
     * historical behaviour), cash (صندوق) or bank (bankClearing). Decides the
     * credit side of the receipt's posting.
     */
    settlementMethod?: RetailPurchaseSettlementMethod | null;
    /** Issue #915 — the supplier's invoice block (number, date, VAT, terms/due date). */
    invoice?: SupplierInvoiceInput | null;
    lines: PurchaseLine[];
  },
): Promise<ReceivePurchaseResult> {
  if (input.lines.length === 0) throw new RetailStockError("خرید بدون قلم کالا قابل ثبت نیست.");
  const settlementMethod: RetailPurchaseSettlementMethod =
    input.settlementMethod && RETAIL_PURCHASE_SETTLEMENT_METHODS.includes(input.settlementMethod)
      ? input.settlementMethod
      : "credit";

  const idempotencyKey = input.idempotencyKey?.trim() || null;
  if (idempotencyKey) {
    const { rows: prior } = await client.query<{ id: string; total: string; request_hash: string | null }>(
      `SELECT id, total::text, request_hash FROM item_purchases WHERE business_id = $1 AND idempotency_key = $2`,
      [input.businessId, idempotencyKey],
    );
    if (prior[0]) {
      if (prior[0].request_hash && input.requestHash && prior[0].request_hash !== input.requestHash) {
        throw new RetailIdempotencyConflictError();
      }
      return { id: prior[0].id, total: rialText(prior[0].total), duplicate: true };
    }
  }

  // The supplier must be this branch's own, active supplier — an FK alone
  // accepts any suppliers row in the database, including another branch's
  // or a deactivated one (issue #915).
  if (input.supplierId) {
    const { rows: supplier } = await client.query<{ id: string }>(
      `SELECT id FROM suppliers WHERE id = $1 AND location_id = $2 AND is_active`,
      [input.supplierId, input.locationId],
    );
    if (!supplier[0]) throw new RetailStockError("تأمین‌کننده یافت نشد یا در این شعبه فعال نیست.");
  }

  // The invoice block is a decision the caller already validated
  // (parseSupplierInvoice); the due date derives from an explicit date, or
  // terms over the invoice date, falling back to the receipt's own date —
  // the same resolution the F&B purchase uses.
  const invoice = input.invoice ?? null;
  const receivedIso = new Date().toISOString().slice(0, 10);
  const paymentDueDate = invoice
    ? resolvePaymentDueDate({
        dueDate: invoice.dueDate,
        paymentTermsDays: invoice.paymentTermsDays,
        invoiceDate: invoice.invoiceDate,
        purchaseDate: receivedIso,
      })
    : null;

  let header: { id: string }[];
  try {
    ({ rows: header } = await client.query<{ id: string }>(
      `INSERT INTO item_purchases
         (business_id, location_id, supplier_id, note, created_by, idempotency_key, request_hash,
          settlement_method, supplier_invoice_number, supplier_invoice_date, vat_amount,
          payment_terms_days, payment_due_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::date, $11, $12, $13::date) RETURNING id`,
      [
        input.businessId,
        input.locationId,
        input.supplierId ?? null,
        input.note?.trim() || null,
        input.createdBy ?? null,
        idempotencyKey,
        input.requestHash ?? null,
        settlementMethod,
        invoice?.invoiceNumber ?? null,
        invoice?.invoiceDate ?? null,
        invoice?.vatAmount ?? 0,
        invoice?.paymentTermsDays ?? null,
        paymentDueDate,
      ],
    ));
  } catch (err) {
    // A concurrent request with the same key won the unique index. The
    // transaction is now aborted — the caller rolls back and answers from
    // the committed winner.
    if ((err as { code?: string }).code === "23505" && idempotencyKey) {
      throw new RetailIdempotencyRaceError(idempotencyKey);
    }
    throw err;
  }
  const purchaseId = header[0].id;

  let total = 0n;
  for (let i = 0; i < input.lines.length; i++) {
    const line = input.lines[i];
    const qtyError = validateItemQuantity(line.quantity);
    if (qtyError) throw new RetailStockError(qtyError);
    const costError = validateItemUnitCost(line.unitCost);
    if (costError) throw new RetailStockError(costError);
    // One canonical Rial text per line — every arithmetic step and DB write
    // below uses it, so a cost past 2^53 never passes through a float.
    const unitCostRial = rialText(String(line.unitCost));

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
        unitCost: unitCostRial,
        supplierReference: line.supplierReference?.trim() || purchaseId,
      });
    } else if (item.tracking === "none") {
      await receiveStock(line.itemId, { quantity: line.quantity, unitCost: unitCostRial }, client);
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
      if (rialBigInt(unitCostRial) <= 0n) {
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
            [line.itemId, serialNumber, unitCostRial, warrantyMonths],
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
        unitCostRial,
        batchNumberForReceipt,
        line.manufactureDate ?? null,
        line.expiryDate ?? null,
        line.supplierReference?.trim() || null,
        item.tracking === "batch" && realLotNumber == null,
        receivedSerialId,
      ],
    );
    total += BigInt(roundRial(new Decimal(line.quantity).times(unitCostRial)));
  }

  await client.query(`UPDATE item_purchases SET total = $2 WHERE id = $1`, [purchaseId, total.toString()]);

  await emitDomainEvent(client, {
    businessId: input.businessId,
    locationId: input.locationId,
    eventType: "retail.purchase_received",
    payload: {
      purchaseId,
      amount: rialText(total.toString()),
      // Issue #915 — the credit side of the posting follows the settlement,
      // and the invoice's VAT debits 1220 on top of the goods. Absent fields
      // mean what every historical event meant: credit AP, no VAT.
      settlementMethod,
      vatAmount: rialText(String(invoice?.vatAmount ?? 0)),
    },
    sourceType: "item_purchase",
    sourceId: purchaseId,
    createdBy: input.createdBy ?? null,
  });

  return { id: purchaseId, total: rialText(total.toString()), duplicate: false };
}

/**
 * Reads a committed purchase by its idempotency key — the recovery path a
 * route takes after losing an idempotency race (the winner committed in a
 * different transaction).
 */
export async function readItemPurchaseByIdempotencyKey(
  businessId: string,
  idempotencyKey: string,
): Promise<{ id: string; total: RialText; requestHash: string | null } | null> {
  const { rows } = await query<{ id: string; total: string; request_hash: string | null }>(
    `SELECT id, total::text, request_hash FROM item_purchases WHERE business_id = $1 AND idempotency_key = $2`,
    [businessId, idempotencyKey],
  );
  if (!rows[0]) return null;
  return { id: rows[0].id, total: rialText(rows[0].total), requestHash: rows[0].request_hash };
}

/** The supplier-return counterpart of `readItemPurchaseByIdempotencyKey`. */
export async function readItemSupplierReturnByIdempotencyKey(
  businessId: string,
  idempotencyKey: string,
): Promise<{ id: string; value: RialText; requestHash: string | null } | null> {
  const { rows } = await query<{ id: string; total_value_rial: string; request_hash: string | null }>(
    `SELECT id, total_value_rial::text, request_hash FROM item_supplier_returns WHERE business_id = $1 AND idempotency_key = $2`,
    [businessId, idempotencyKey],
  );
  if (!rows[0]) return null;
  return { id: rows[0].id, value: rialText(rows[0].total_value_rial), requestHash: rows[0].request_hash };
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
    /**
     * Optional on purpose: an UNLINKED supplier return (no purchaseId) is a
     * supported workflow — goods whose receipt predates this system, or a
     * negotiated give-back — valued at the item's current recorded cost
     * basis and settled by `settlementMethod`. When a purchaseId IS given,
     * the return is bound to that purchase: the purchase must belong to this
     * tenant/branch, every returned line must have been acquired under it,
     * and cumulative returns can never exceed what it received (issue #915).
     */
    purchaseId?: string | null;
    settlementMethod: "accounts_payable" | "cash" | "bank" | "supplier_receivable";
    reason: string;
    idempotencyKey: string;
    requestHash?: string | null;
    createdBy?: string | null;
    lines: ReturnLine[];
  },
): Promise<SupplierReturnResult> {
  if (!input.reason.trim() || !input.idempotencyKey || input.lines.length === 0) {
    throw new RetailStockError("برگشت نامعتبر است.");
  }

  const { rows: prior } = await client.query<{ id: string; total_value_rial: string; request_hash: string | null }>(
    `SELECT id, total_value_rial::text, request_hash FROM item_supplier_returns WHERE business_id = $1 AND idempotency_key = $2`,
    [input.businessId, input.idempotencyKey],
  );
  if (prior[0]) {
    if (prior[0].request_hash && input.requestHash && prior[0].request_hash !== input.requestHash) {
      throw new RetailIdempotencyConflictError();
    }
    return { id: prior[0].id, value: rialText(prior[0].total_value_rial), duplicate: true };
  }

  // A linked return's purchase must be this tenant AND branch's own received
  // purchase. The row lock serialises concurrent returns against the same
  // purchase so the cumulative ceiling below cannot be raced past.
  if (input.purchaseId) {
    const { rows: purchases } = await client.query<{ id: string }>(
      `SELECT id FROM item_purchases
        WHERE id = $1 AND business_id = $2 AND location_id = $3 AND status = 'received'
        FOR UPDATE`,
      [input.purchaseId, input.businessId, input.locationId],
    );
    if (!purchases[0]) throw new RetailStockError("خرید مرتبط با این برگشت یافت نشد.");
  }

  let header: { id: string }[];
  try {
    ({ rows: header } = await client.query<{ id: string }>(
      `INSERT INTO item_supplier_returns
         (business_id, location_id, purchase_id, settlement_method, reason, created_by, idempotency_key, request_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [
        input.businessId,
        input.locationId,
        input.purchaseId ?? null,
        input.settlementMethod,
        input.reason.trim(),
        input.createdBy ?? null,
        input.idempotencyKey,
        input.requestHash ?? null,
      ],
    ));
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      throw new RetailIdempotencyRaceError(input.idempotencyKey);
    }
    throw err;
  }
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

    // Linked return — exact provenance (issue #915): the line's item must
    // have been acquired under the named purchase, and cumulative returns
    // against that purchase can never exceed what it received. Lines of this
    // same return inserted in earlier iterations are already counted (the
    // header above carries purchase_id), and the purchase row lock taken
    // before the header insert serialises concurrent requests.
    if (input.purchaseId) {
      const { rows: acquired } = await client.query<{ quantity: string }>(
        `SELECT COALESCE(sum(quantity), 0)::text AS quantity
           FROM item_purchase_items WHERE purchase_id = $1 AND item_id = $2`,
        [input.purchaseId, line.itemId],
      );
      if (new Decimal(acquired[0].quantity).lte(0)) {
        throw new RetailStockError("این کالا در خرید انتخاب‌شده دریافت نشده است.");
      }
      const { rows: returned } = await client.query<{ quantity: string }>(
        `SELECT COALESCE(sum(l.quantity), 0)::text AS quantity
           FROM item_supplier_return_items l
           JOIN item_supplier_returns r ON r.id = l.return_id
          WHERE r.purchase_id = $1 AND l.item_id = $2`,
        [input.purchaseId, line.itemId],
      );
      if (new Decimal(returned[0].quantity).plus(new Decimal(line.quantity)).gt(new Decimal(acquired[0].quantity))) {
        throw new RetailStockError("مقدار برگشتی از مقدار دریافت‌شده در این خرید بیشتر است.");
      }
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
      // Linked return: when every purchase line for this item names its
      // exact unit (single-unit lines record serial_id), the returned unit
      // must be one of them. Multi-unit lines keep provenance through the
      // serial rows themselves (migration 0084 stores one pointer per line),
      // so those fall back to the item membership/ceiling checks above.
      if (input.purchaseId) {
        const { rows: purchaseSerials } = await client.query<{ serial_id: string | null }>(
          `SELECT serial_id FROM item_purchase_items WHERE purchase_id = $1 AND item_id = $2`,
          [input.purchaseId, line.itemId],
        );
        const named = purchaseSerials.filter((r) => r.serial_id != null);
        if (named.length === purchaseSerials.length && !named.some((r) => r.serial_id === serial.id)) {
          throw new RetailStockError("این دستگاه در خرید انتخاب‌شده دریافت نشده است.");
        }
      }
      value = rialText(serial.unit_cost);
      returnedSerialId = serial.id;
      await client.query(`UPDATE item_serials SET status = 'supplier_returned' WHERE id = $1`, [serial.id]);
    } else if (item.tracking === "batch") {
      if (!line.batchId) throw new RetailStockError("برای برگشت کالای بچ‌محور، بچ را مشخص کنید.");
      const { rows: batchRows } = await client.query<{
        id: string;
        batch_number: string;
        quantity: string;
        unit_cost: string | null;
      }>(
        `SELECT id, batch_number, quantity::text, unit_cost::text FROM item_batches WHERE id = $1 AND item_id = $2 FOR UPDATE`,
        [line.batchId, line.itemId],
      );
      const batch = batchRows[0];
      if (!batch) throw new RetailStockError("بچ یافت نشد.");
      // Linked return: the lot sent back must be a lot this purchase
      // actually received. Lines recorded before migration 0198 carry no
      // batch_number — only enforce when the purchase named its lots.
      if (input.purchaseId) {
        const { rows: lotMatch } = await client.query(
          `SELECT 1 FROM item_purchase_items WHERE purchase_id = $1 AND item_id = $2 AND batch_number = $3`,
          [input.purchaseId, line.itemId, batch.batch_number],
        );
        if (!lotMatch[0]) {
          const { rows: anyLot } = await client.query(
            `SELECT 1 FROM item_purchase_items WHERE purchase_id = $1 AND item_id = $2 AND batch_number IS NOT NULL`,
            [input.purchaseId, line.itemId],
          );
          if (anyLot[0]) throw new RetailStockError("بچ انتخاب‌شده در این خرید دریافت نشده است.");
        }
      }
      if (new Decimal(batch.quantity).lt(new Decimal(line.quantity))) {
        throw new RetailStockError("موجودی بچ کافی نیست.");
      }
      const unitCost = Number(batch.unit_cost ?? 0);
      value = roundRial(new Decimal(line.quantity).times(unitCost));
      // Issue #922 regression: the lot's exact carrying value must leave with
      // the quantity, or the rollup's SUM(total_value_rial) inflates the
      // weighted average after every supplier return.
      await client.query(
        `UPDATE item_batches
            SET quantity = quantity - $2,
                total_value_rial = CASE
                  WHEN total_value_rial IS NULL THEN NULL
                  WHEN quantity <= $2::numeric THEN 0
                  ELSE GREATEST(total_value_rial - $3::bigint, 0)
                END
          WHERE id = $1`,
        [batch.id, line.quantity, value],
      );
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
