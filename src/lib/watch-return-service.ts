/**
 * Issue #795 Phase 3 — the dedicated, manager-approved customer return /
 * exchange workflow for serialized (watch) units.
 *
 * Retail invoice void (retail-invoice-void-service.ts) deliberately refuses
 * watch lines: `sold` is a terminal serial state and no generic flow may
 * quietly put a sold unit back on the shelf. This service is the deliberate
 * exception that audit asked for — an explicit lifecycle on the exact
 * physical unit:
 *
 *   requested → received_for_inspection → dispositioned     (or → cancelled)
 *
 * Request identifies the exact original invoice line + serial + customer and
 * freezes the claim; receiving records that the physical unit is actually in
 * hand (inspection notes); disposition — approved by a manager with
 * orders.void + payments.refund — explicitly chooses what becomes of the
 * unit AND posts the money side in the same transaction:
 *
 * - `returned_sellable` / `exchange`: revenue+VAT AND COGS are mirrored
 *   (exact debit/credit swap of the original sale's own entries), the unit
 *   goes back to `in_stock` with its cost basis intact, and its sale
 *   timestamp/warranty window is cleared — the warranty belonged to the
 *   reversed sale; the historical window stays immutable in the invoice
 *   snapshot. An exchange's replacement unit sells on a NEW invoice through
 *   the normal engine — this workflow only unwinds the returned one.
 * - `returned_service_required`: same financial reversal, but the unit
 *   lands in `in_repair` — it needs a repair ticket before it can sell.
 * - `supplier_claim`: same reversal (the unit's value returns to
 *   inventory), then the unit immediately leaves for the supplier through
 *   createItemSupplierReturn in the SAME transaction — Debit AP / Credit
 *   inventory, terminal `supplier_returned`, with the claim's return
 *   document naming the exact serial.
 * - `returned_damaged` / `write_off`: revenue+VAT are refunded, but COGS is
 *   deliberately NOT reversed — the unit is worthless, so its cost stays on
 *   the books as the loss the shop actually ate. The unit becomes terminal
 *   `written_off` (row kept — provenance, never resellable).
 *
 * Commission the line accrued is reversed with the table's own signed
 * convention; loyalty points the invoice earned are reversed proportionally
 * to this line's share of the invoice total. The refund's payment footprint
 * is a negative `payments` row («negative = refund» — the table's own
 * documented convention). The financial reversal always mirrors the
 * ORIGINAL tender accounts exactly (that is what makes it provably balanced);
 * `refund_method` records the operational channel the money went back
 * through.
 *
 * The original order, its lines and snapshots are never mutated — the sale
 * stays immutable history; the return is a new, fully-audited fact.
 */
import type { PoolClient } from "pg";
import { businessToday } from "./business-day-service";
import { query } from "./db";
import { reverseLiveEntry } from "./retail-invoice-void-service";
import { createItemSupplierReturn, RetailStockError } from "./retail-stock-service";
import type { RetailInvoiceLineSnapshotStored } from "./retail-invoice/types";

export class SerialReturnError extends Error {
  status: number;
  constructor(message: string, status = 409) {
    super(message);
    this.status = status;
  }
}

export const SERIAL_RETURN_DISPOSITIONS = [
  "returned_sellable",
  "returned_service_required",
  "returned_damaged",
  "supplier_claim",
  "write_off",
  "exchange",
] as const;
export type SerialReturnDisposition = (typeof SERIAL_RETURN_DISPOSITIONS)[number];

export const SERIAL_RETURN_REFUND_METHODS = ["cash", "card", "card_to_card", "online", "credit"] as const;
export type SerialReturnRefundMethod = (typeof SERIAL_RETURN_REFUND_METHODS)[number];

export interface SerialReturnSummary {
  id: string;
  orderId: string;
  orderItemId: string;
  serialId: string;
  serialNumber: string;
  itemName: string;
  customerId: string | null;
  status: string;
  disposition: string | null;
  reason: string;
  inspectionNotes: string | null;
  refundMethod: string | null;
  refundAmount: string | null;
  createdAt: string;
  dispositionedAt: string | null;
}

interface ReturnRow extends Record<string, unknown> {
  id: string;
  order_id: string;
  order_item_id: string;
  serial_id: string;
  customer_id: string | null;
  status: string;
  disposition: string | null;
  reason: string;
  inspection_notes: string | null;
  refund_method: string | null;
  refund_amount_rial: string | null;
}

/** The watch snapshot of the sold line this return unwinds. */
type WatchSnapshot = Extract<RetailInvoiceLineSnapshotStored, { kind: "watch" }>;

async function loadLine(
  client: PoolClient,
  orderItemId: string,
): Promise<{ itemId: string | null; snapshot: WatchSnapshot }> {
  const { rows } = await client.query<{ item_id: string | null; retail_snapshot: RetailInvoiceLineSnapshotStored | null }>(
    `SELECT item_id, retail_snapshot FROM order_items WHERE id = $1 AND status <> 'voided'`,
    [orderItemId],
  );
  const line = rows[0];
  if (!line?.retail_snapshot || line.retail_snapshot.kind !== "watch") {
    throw new SerialReturnError("ردیف فاکتور سریالی یافت نشد.", 404);
  }
  return { itemId: line.item_id, snapshot: line.retail_snapshot };
}

/**
 * Opens a return claim for the exact unit of an exact completed invoice.
 * Nothing financial or physical moves yet — the unit is still the
 * customer's until it is received and dispositioned.
 */
export async function requestSerialReturn(
  client: PoolClient,
  input: {
    businessId: string;
    locationId: string;
    /**
     * The invoice being unwound. Omitted = the LATEST completed retail
     * invoice that sold this serial (what the counter actually knows is
     * «this watch came back», not an order id).
     */
    orderId?: string | null;
    serialId: string;
    reason: string;
    createdBy: string | null;
  },
): Promise<{ id: string; orderId: string }> {
  if (!input.reason.trim()) throw new SerialReturnError("دلیل مرجوعی الزامی است.", 400);

  let orderId = input.orderId ?? null;
  if (!orderId) {
    const { rows } = await client.query<{ order_id: string }>(
      `SELECT oi.order_id
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
        WHERE o.location_id = $1 AND o.type = 'retail' AND o.status = 'completed'
          AND oi.status <> 'voided'
          AND oi.retail_snapshot ->> 'kind' = 'watch'
          AND oi.retail_snapshot ->> 'serialId' = $2
        ORDER BY o.closed_at DESC NULLS LAST
        LIMIT 1`,
      [input.locationId, input.serialId],
    );
    if (!rows[0]) throw new SerialReturnError("فاکتور فروش این دستگاه یافت نشد.", 404);
    orderId = rows[0].order_id;
  }

  const { rows: orderRows } = await client.query<{ id: string; customer_id: string | null; status: string; type: string }>(
    `SELECT id, customer_id, status::text AS status, type::text AS type
       FROM orders WHERE id = $1 AND location_id = $2 FOR UPDATE`,
    [orderId, input.locationId],
  );
  const order = orderRows[0];
  if (!order) throw new SerialReturnError("فاکتور یافت نشد.", 404);
  if (order.type !== "retail" || order.status !== "completed") {
    throw new SerialReturnError("مرجوعی فقط برای فاکتور خرده‌فروشی تکمیل‌شده ممکن است.");
  }

  // The exact line that sold THIS serial on THIS invoice.
  const { rows: lineRows } = await client.query<{ id: string; retail_snapshot: RetailInvoiceLineSnapshotStored | null }>(
    `SELECT id, retail_snapshot FROM order_items WHERE order_id = $1 AND status <> 'voided'`,
    [orderId],
  );
  const line = lineRows.find(
    (l) => l.retail_snapshot?.kind === "watch" && l.retail_snapshot.serialId === input.serialId,
  );
  if (!line) throw new SerialReturnError("این دستگاه روی این فاکتور فروخته نشده است.", 404);
  const snapshot = line.retail_snapshot as WatchSnapshot;
  if (!snapshot.ledgerEntryIds?.length) {
    throw new SerialReturnError("این فروش مربوط به پیش از پشتیبانی مرجوعی خودکار است و باید دستی اصلاح شود.");
  }

  const { rows: serialRows } = await client.query<{ status: string }>(
    `SELECT status FROM item_serials WHERE id = $1 FOR UPDATE`,
    [input.serialId],
  );
  if (!serialRows[0]) throw new SerialReturnError("سریال یافت نشد.", 404);
  if (serialRows[0].status !== "sold") {
    throw new SerialReturnError("این دستگاه در وضعیت فروخته‌شده نیست.");
  }

  try {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO serial_returns
         (business_id, location_id, order_id, order_item_id, serial_id, customer_id, reason, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [
        input.businessId,
        input.locationId,
        orderId,
        line.id,
        input.serialId,
        order.customer_id,
        input.reason.trim(),
        input.createdBy,
      ],
    );
    return { id: rows[0].id, orderId };
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      throw new SerialReturnError("برای این ردیف فروش قبلاً مرجوعی ثبت شده است.");
    }
    throw err;
  }
}

/** The physical unit is actually back in hand — record it, with what inspection saw. */
export async function receiveSerialReturn(
  client: PoolClient,
  input: { businessId: string; returnId: string; inspectionNotes?: string | null; actorId: string | null },
): Promise<void> {
  const { rows } = await client.query<ReturnRow>(
    `SELECT * FROM serial_returns WHERE id = $1 AND business_id = $2 FOR UPDATE`,
    [input.returnId, input.businessId],
  );
  const ret = rows[0];
  if (!ret) throw new SerialReturnError("مرجوعی یافت نشد.", 404);
  if (ret.status !== "requested") {
    throw new SerialReturnError("فقط مرجوعی در وضعیت «درخواست‌شده» قابل دریافت است.");
  }
  await client.query(
    `UPDATE serial_returns
        SET status = 'received_for_inspection', inspection_notes = $2, received_by = $3, received_at = now()
      WHERE id = $1`,
    [input.returnId, input.inspectionNotes?.trim() || null, input.actorId],
  );
}

/** A claim that never completed — the unit stays the customer's, sale untouched. */
export async function cancelSerialReturn(
  client: PoolClient,
  input: { businessId: string; returnId: string; actorId: string | null },
): Promise<void> {
  const { rows } = await client.query<ReturnRow>(
    `SELECT * FROM serial_returns WHERE id = $1 AND business_id = $2 FOR UPDATE`,
    [input.returnId, input.businessId],
  );
  const ret = rows[0];
  if (!ret) throw new SerialReturnError("مرجوعی یافت نشد.", 404);
  if (ret.status === "dispositioned" || ret.status === "cancelled") {
    throw new SerialReturnError("این مرجوعی قبلاً بسته شده است.");
  }
  await client.query(
    `UPDATE serial_returns SET status = 'cancelled', cancelled_at = now() WHERE id = $1`,
    [input.returnId],
  );
}

/**
 * The manager-approved, atomic completion of the return: the explicit
 * disposition of the physical unit plus the full financial reversal, all in
 * the caller's transaction. See the module doc comment for exactly what
 * each disposition does and why.
 */
export async function dispositionSerialReturn(
  client: PoolClient,
  input: {
    businessId: string;
    locationId: string;
    returnId: string;
    disposition: SerialReturnDisposition;
    refundMethod: SerialReturnRefundMethod;
    inspectionNotes?: string | null;
    approvedBy: string | null;
  },
): Promise<{ refundAmount: string; reversedEntryIds: string[]; serialStatus: string }> {
  const { rows } = await client.query<ReturnRow>(
    `SELECT * FROM serial_returns WHERE id = $1 AND business_id = $2 FOR UPDATE`,
    [input.returnId, input.businessId],
  );
  const ret = rows[0];
  if (!ret) throw new SerialReturnError("مرجوعی یافت نشد.", 404);
  if (ret.status !== "received_for_inspection") {
    throw new SerialReturnError("فقط مرجوعی دریافت‌شده و بازرسی‌شده قابل تعیین‌تکلیف است.");
  }

  const { itemId, snapshot } = await loadLine(client, ret.order_item_id);
  if (!itemId) throw new SerialReturnError("کالای این ردیف حذف شده است؛ تعیین‌تکلیف خودکار ممکن نیست.");

  const { rows: serialRows } = await client.query<{ id: string; status: string }>(
    `SELECT id, status FROM item_serials WHERE id = $1 FOR UPDATE`,
    [ret.serial_id],
  );
  if (!serialRows[0]) throw new SerialReturnError("سریال یافت نشد.", 404);
  if (serialRows[0].status !== "sold") {
    throw new SerialReturnError("این دستگاه در وضعیت فروخته‌شده نیست.");
  }

  const entryDate = await businessToday(input.businessId);
  const refundAmount = snapshot.total;
  const reversedEntryIds: string[] = [];

  // ---- financial reversal: mirror the sale's own entries ----
  // The snapshot's ledgerEntryIds are the sale's revenue/VAT entry and its
  // COGS entry; which is which is read off the ledger itself, never guessed
  // from array position.
  const { rows: entryRows } = await client.query<{ id: string; posting_kind: string | null }>(
    `SELECT id, posting_kind FROM journal_entries WHERE id = ANY($1::uuid[]) AND business_id = $2`,
    [snapshot.ledgerEntryIds ?? [], input.businessId],
  );
  const keepCogsAsLoss = input.disposition === "returned_damaged" || input.disposition === "write_off";
  for (const entry of entryRows) {
    const isCogs = (entry.posting_kind ?? "").includes("cogs");
    // A worthless unit's cost stays expensed — the loss the shop ate; only
    // the customer-facing revenue/VAT side is refunded.
    if (isCogs && keepCogsAsLoss) continue;
    const reversedId = await reverseLiveEntry(client, {
      businessId: input.businessId,
      locationId: input.locationId,
      entryId: entry.id,
      amendmentId: input.returnId,
      memo: "مرجوعی دستگاه سریالی",
      entryDate,
      createdBy: input.approvedBy,
    });
    if (reversedId) reversedEntryIds.push(reversedId);
  }

  // ---- commission reversal (the table's own «negative = reversed» convention) ----
  const { rows: accrualRows } = await client.query<{
    id: string;
    employee_id: string;
    rule_id: string | null;
    amount: string;
    entry_id: string | null;
  }>(
    `SELECT id, employee_id, rule_id, amount::text, entry_id FROM commission_accruals
      WHERE business_id = $1 AND source_type = 'order_item' AND source_id = $2 AND amount <> 0`,
    [input.businessId, ret.order_item_id],
  );
  for (const accrual of accrualRows) {
    let reversedEntryId: string | null = null;
    if (accrual.entry_id) {
      reversedEntryId = await reverseLiveEntry(client, {
        businessId: input.businessId,
        locationId: input.locationId,
        entryId: accrual.entry_id,
        amendmentId: input.returnId,
        memo: "برگشت پورسانت مرجوعی سریالی",
        entryDate,
        createdBy: input.approvedBy,
      });
      if (reversedEntryId) reversedEntryIds.push(reversedEntryId);
    }
    await client.query(
      `INSERT INTO commission_accruals (business_id, employee_id, rule_id, source_type, source_id, amount, basis_amount, entry_id)
       VALUES ($1,$2,$3,'serial_return',$4,$5,0,$6)`,
      [input.businessId, accrual.employee_id, accrual.rule_id, input.returnId, -Number(accrual.amount), reversedEntryId],
    );
  }

  // ---- loyalty reversal, proportional to this line's share of the invoice ----
  if (ret.customer_id) {
    const { rows: orderRows } = await client.query<{ total: string }>(
      `SELECT total::text AS total FROM orders WHERE id = $1`,
      [ret.order_id],
    );
    const orderTotal = BigInt(orderRows[0]?.total ?? "0");
    const { rows: pointRows } = await client.query<{ points: string }>(
      `SELECT COALESCE(SUM(points), 0)::text AS points FROM customer_points
        WHERE business_id = $1 AND source_type = 'retail_invoice' AND source_id = $2`,
      [input.businessId, ret.order_id],
    );
    const earnedPoints = BigInt(pointRows[0]?.points ?? "0");
    if (earnedPoints > 0n && orderTotal > 0n) {
      const reversal = (earnedPoints * BigInt(refundAmount)) / orderTotal;
      if (reversal > 0n) {
        await client.query(
          `INSERT INTO customer_points (business_id, customer_id, points, source_type, source_id)
           VALUES ($1,$2,$3,'serial_return',$4)`,
          [input.businessId, ret.customer_id, -Number(reversal), input.returnId],
        );
      }
    }
  }

  // ---- refund payment footprint («negative = refund») ----
  await client.query(
    `INSERT INTO payments (location_id, order_id, method, amount, reference, received_by)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [
      input.locationId,
      ret.order_id,
      input.refundMethod,
      -Number(refundAmount),
      `serial-return:${ret.id}`,
      input.approvedBy,
    ],
  );

  // ---- the unit's explicit next state ----
  let serialStatus: string;
  switch (input.disposition) {
    case "returned_sellable":
    case "exchange":
      serialStatus = "in_stock";
      break;
    case "returned_service_required":
      serialStatus = "in_repair";
      break;
    case "supplier_claim":
      // Lands in stock for one instant, then leaves for the supplier below.
      serialStatus = "in_stock";
      break;
    case "returned_damaged":
    case "write_off":
      serialStatus = "written_off";
      break;
  }
  // The deliberate, manager-approved exception to «sold is terminal» — the
  // sale's financial footprint was just mirrored above in the same
  // transaction, so shelf and books move together. sold_at is cleared: the
  // reversed sale's warranty window is dead (its history stays immutable in
  // the invoice snapshot and this return row).
  await client.query(`UPDATE item_serials SET status = $2, sold_at = NULL WHERE id = $1`, [
    ret.serial_id,
    serialStatus,
  ]);
  // The reversed sale's warranty window stops running — a later warranty
  // repair intake must not see a live window on a unit that came back. The
  // historical window stays immutable in the invoice snapshot
  // (warrantyStartDate/warrantyEndDate); a future resale opens a fresh one.
  await client.query(`DELETE FROM serial_warranties WHERE serial_id = $1`, [ret.serial_id]);

  if (input.disposition === "supplier_claim") {
    try {
      await createItemSupplierReturn(client, {
        businessId: input.businessId,
        locationId: input.locationId,
        settlementMethod: "accounts_payable",
        reason: `ادعای خرابی مرجوعی سریالی: ${ret.reason}`,
        idempotencyKey: `serial-return:${ret.id}`,
        createdBy: input.approvedBy,
        lines: [{ itemId, quantity: "1", serialId: ret.serial_id }],
      });
    } catch (err) {
      if (err instanceof RetailStockError) throw new SerialReturnError(err.message);
      throw err;
    }
    serialStatus = "supplier_returned";
  }

  const notes = [ret.inspection_notes, input.inspectionNotes?.trim()].filter(Boolean).join("\n") || null;
  await client.query(
    `UPDATE serial_returns
        SET status = 'dispositioned', disposition = $2, refund_method = $3, refund_amount_rial = $4,
            inspection_notes = $5, reversed_entry_ids = $6, approved_by = $7, dispositioned_at = now()
      WHERE id = $1`,
    [
      input.returnId,
      input.disposition,
      input.refundMethod,
      refundAmount,
      notes,
      reversedEntryIds,
      input.approvedBy,
    ],
  );

  await client.query(
    `INSERT INTO audit_log (business_id, location_id, user_id, action, entity, entity_id, payload)
     VALUES ($1,$2,$3,'watch.return_dispositioned','serial_return',$4,$5)`,
    [
      input.businessId,
      input.locationId,
      input.approvedBy,
      input.returnId,
      JSON.stringify({
        orderId: ret.order_id,
        serialId: ret.serial_id,
        disposition: input.disposition,
        refundMethod: input.refundMethod,
        refundAmount,
        reversedEntryIds,
      }),
    ],
  );

  return { refundAmount, reversedEntryIds, serialStatus };
}

export async function listSerialReturns(
  businessId: string,
  locationId: string,
  client?: PoolClient,
): Promise<SerialReturnSummary[]> {
  const run = <T extends Record<string, unknown>>(text: string, params: unknown[]) =>
    client ? client.query<T>(text, params as never) : query<T>(text, params);
  const { rows } = await run<
    ReturnRow & { serial_number: string; item_name: string; created_at: string; dispositioned_at: string | null }
  >(
    `SELECT r.*, s.serial_number, i.name AS item_name,
            r.created_at::text AS created_at, r.dispositioned_at::text AS dispositioned_at
       FROM serial_returns r
       JOIN item_serials s ON s.id = r.serial_id
       JOIN items i ON i.id = s.item_id
      WHERE r.business_id = $1 AND r.location_id = $2
      ORDER BY r.created_at DESC`,
    [businessId, locationId],
  );
  return rows.map((r) => ({
    id: r.id,
    orderId: r.order_id,
    orderItemId: r.order_item_id,
    serialId: r.serial_id,
    serialNumber: r.serial_number,
    itemName: r.item_name,
    customerId: r.customer_id,
    status: r.status,
    disposition: r.disposition,
    reason: r.reason,
    inspectionNotes: r.inspection_notes,
    refundMethod: r.refund_method,
    refundAmount: r.refund_amount_rial,
    createdAt: r.created_at,
    dispositionedAt: r.dispositioned_at,
  }));
}
