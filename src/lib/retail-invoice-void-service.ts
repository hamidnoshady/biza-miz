/**
 * Voiding a completed retail invoice — actually reversing it, not just
 * marking it voided.
 *
 * Root cause this fixes (see RETAIL_POS_ENGINEERING_REPORT.md §12): a retail
 * invoice's revenue/COGS never post under `source_type = 'order'` — every
 * line settles through its own industry sell service
 * (gold/watch/accessories/cosmetics/trade-goods), each posting under its own
 * `source_type` (`gold_sale`, `accessory_sale`, ...). `order-amendment-
 * service.ts`'s F&B void/edit engine only ever looks for `source_type IN
 * ('order', 'order_amendment')`, so calling it against a retail invoice
 * flips `orders.status` to `'voided'` while the original ledger entries and
 * inventory consumption sit there completely untouched — the invoice *looks*
 * voided; the books and the shelf never learn about it.
 *
 * This is a **separate, dedicated function**, not a branch inside
 * `amendClosedOrder()`. That function is F&B's own well-tested, production-
 * critical reverse-then-replay engine (recipe consumption, menu-item
 * modifiers, online-platform commission); retail has none of that, and
 * threading retail-only branches into the middle of it would risk the one
 * thing this whole audit is trying to protect. What *is* shared, because it
 * is genuinely generic and already proven: `postExactMirrorEntry` (the exact
 * same debit/credit-swap the F&B engine posts a reversal with),
 * `order_amendments` (the same audit-trail table, so a voided retail invoice
 * shows up in the same "amendment" bookkeeping), and `snapshotOrder` (no
 * F&B-only assumption in it).
 *
 * What this can and cannot void, and why:
 *
 * - **Accessories, cosmetics (non-batch), and trade-goods (wholesale/tools &
 *   fittings/haberdashery) lines: fully reversible**, and this does so —
 *   the revenue/COGS/VAT entries are mirrored (which, for a credit sale,
 *   also correctly credits back the customer's receivable, since that is
 *   just the debit side of the same entry being reversed), the exact
 *   quantity sold is added back to `item_stock`, any commission the line
 *   accrued is reversed (a documented, signed convention:
 *   commission_accruals."negative = reversed"), and any loyalty points the
 *   invoice earned are reversed the same way `redeemPoints` already spends
 *   points — an offsetting negative row, `customer_points`' own signed
 *   convention.
 * - **Gold and watch lines: refused outright, always.** A `tracking:
 *   'weight'`/`'serial'` unit's `status` is a deliberate one-way state
 *   machine — see `validateWeightItemStatusTransition`/
 *   `validateSerialStatusTransition` in items.ts: "a sold item can never be
 *   returned to another status." There is no code path, anywhere, that ever
 *   puts a sold gold piece or watch back into sellable stock. Reversing only
 *   the ledger while the physical unit stays permanently marked sold would
 *   make the books say "never sold" while the shelf says "gone forever" —
 *   a worse, silent mismatch than refusing outright. A shop that genuinely
 *   needs to unwind a gold/watch sale needs a deliberate, separate,
 *   manager-approved workflow (return → inspection → explicit inventory
 *   disposition), which this codebase does not have yet; building it was
 *   explicitly decided against widening this fix to cover, since it would
 *   mean relaxing a rule several other invariants may already assume is
 *   permanent.
 * - **Batch-tracked cosmetics: refused.** A batch sale's exact FEFO
 *   allocation (which specific `item_batches` rows, and how much of each,
 *   were consumed) is not persisted anywhere recoverable after the fact —
 *   only the batch *numbers* are, for the receipt. Restoring `item_stock`'s
 *   quantity alone without restoring the same batch rows would violate the
 *   "item_stock is the authoritative SUM of item_batches" invariant
 *   `rollItemStockToBatches` exists to guarantee (migration 0078).
 * - **A line sold before this fix shipped: refused.** The per-line
 *   `ledgerEntryIds` this reversal needs did not exist before this session;
 *   there is no reliable way to re-derive them after the fact (see
 *   `RetailInvoiceLineSnapshotBase.ledgerEntryIds`'s own doc comment). This
 *   is not retroactive, and is not pretended to be.
 *
 * Every refusal above throws `RetailInvoiceVoidError` with a specific,
 * actionable Persian message *before* anything is written — a blocked void
 * never leaves the invoice half-reversed.
 */
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { postExactMirrorEntry } from "./ledger-service";
import { snapshotOrder } from "./order-amendment-service";
import { planPaymentRows, type AmendmentPaymentMethod, type PaymentRow } from "./order-amendments";
import type { RetailInvoiceLineSnapshotStored } from "./retail-invoice/types";

export class RetailInvoiceVoidError extends Error {
  status: number;
  constructor(message: string, status = 409) {
    super(message);
    this.status = status;
  }
}

export interface VoidRetailInvoiceInput {
  businessId: string;
  locationId: string;
  orderId: string;
  actorId: string | null;
  reason: string;
}

export interface VoidRetailInvoiceResult {
  amendmentId: string;
  /** Every reversal journal entry this void posted (line entries + any commission reversal). */
  reversedEntryIds: string[];
}

interface OrderRow {
  id: string;
  status: string;
  type: string;
  customer_id: string | null;
  closed_at: string | null;
  total: string;
}

interface LineRow {
  id: string;
  item_id: string | null;
  /**
   * `order_items.quantity` itself — deliberately unused for the stock
   * restore below. Retail lines always store `1` there (see
   * retail-invoice-service.ts's own comment on that INSERT); the real sold
   * quantity lives only in `retail_snapshot.quantity`.
   */
  quantity: string;
  retail_snapshot: RetailInvoiceLineSnapshotStored | null;
}

async function reverseLiveEntry(
  client: PoolClient,
  params: {
    businessId: string;
    locationId: string;
    entryId: string;
    amendmentId: string;
    memo: string;
    entryDate?: string;
    createdBy: string | null;
  },
): Promise<string | null> {
  const { rows } = await client.query<{ id: string; posting_kind: string | null }>(
    `SELECT id, posting_kind FROM journal_entries
      WHERE id = $1 AND business_id = $2 AND reversed_at IS NULL AND reverses_entry_id IS NULL`,
    [params.entryId, params.businessId],
  );
  const live = rows[0];
  if (!live) return null; // already reversed, or never posted (e.g. a zero-value line) — nothing to do

  // A fresh, per-reversal identity — not `params.amendmentId` shared across
  // every reversal this void posts. `uq_journal_business_source_posting` is
  // unique on (business_id, source_type, source_id, posting_kind); a
  // multi-line invoice can have several entries of the *same* posting_kind
  // (two accessory lines both post `accessory_sale_revenue`), so reusing one
  // id for all of them here would reintroduce the exact defect §12/§13 of
  // RETAIL_POS_ENGINEERING_REPORT.md fixed in the sell services themselves.
  return postExactMirrorEntry(client, {
    businessId: params.businessId,
    locationId: params.locationId,
    originalEntryId: live.id,
    sourceType: "order_amendment",
    sourceId: randomUUID(),
    postingKind: `${live.posting_kind ?? "entry"}_reversal`,
    memo: params.memo,
    entryDate: params.entryDate ?? null,
    createdBy: params.createdBy,
  });
}

/**
 * Voids a completed retail invoice, atomically, in the caller's transaction.
 * Throws `RetailInvoiceVoidError` (never mutates anything) if the invoice
 * cannot be voided automatically — see this file's own doc comment for
 * exactly which cases those are and why.
 */
export async function voidRetailInvoice(
  client: PoolClient,
  params: VoidRetailInvoiceInput,
): Promise<VoidRetailInvoiceResult> {
  const { rows: orderRows } = await client.query<OrderRow>(
    `SELECT id, status::text AS status, type::text AS type, customer_id, closed_at::text AS closed_at,
            total::text AS total
       FROM orders WHERE id = $1 AND location_id = $2 FOR UPDATE`,
    [params.orderId, params.locationId],
  );
  const order = orderRows[0];
  if (!order) throw new RetailInvoiceVoidError("فاکتور یافت نشد.", 404);
  if (order.type !== "retail") {
    throw new RetailInvoiceVoidError("این عملیات فقط برای فاکتورهای خرده‌فروشی است.", 400);
  }
  if (order.status !== "completed") {
    throw new RetailInvoiceVoidError("این فاکتور تکمیل‌شده نیست یا قبلاً باطل شده است.", 409);
  }

  const { rows: returns } = await client.query(
    "SELECT 1 FROM customer_returns WHERE order_id = $1 LIMIT 1",
    [params.orderId],
  );
  if (returns.length > 0) {
    throw new RetailInvoiceVoidError("این فاکتور مرجوعی ثبت‌شده دارد و به‌صورت خودکار باطل نمی‌شود.", 409);
  }

  const { rows: lineRows } = await client.query<LineRow>(
    `SELECT id, item_id, quantity::text, retail_snapshot
       FROM order_items WHERE order_id = $1 AND status <> 'voided'
      ORDER BY created_at FOR UPDATE`,
    [params.orderId],
  );
  if (lineRows.length === 0) throw new RetailInvoiceVoidError("این فاکتور کالایی ندارد.", 409);

  // ---- validate every line before mutating anything ----
  for (const line of lineRows) {
    const snapshot = line.retail_snapshot;
    if (!snapshot) {
      throw new RetailInvoiceVoidError(
        "این فاکتور مربوط به پیش از پشتیبانی ابطال خودکار است و باید به‌صورت دستی اصلاح شود.",
        409,
      );
    }
    if (snapshot.kind === "gold" || snapshot.kind === "watch") {
      throw new RetailInvoiceVoidError(
        "این فاکتور شامل کالای طلا/سریال‌دار است و به دلیل وضعیت نهایی فروش، ابطال خودکار امکان‌پذیر نیست.",
        409,
      );
    }
    if (snapshot.kind === "cosmetic" && (snapshot.batchNumbers?.length ?? 0) > 0) {
      throw new RetailInvoiceVoidError(
        "این فاکتور شامل کالای آرایشی بچ‌محور (تاریخ‌دار) است؛ ابطال خودکار برای این نوع کالا پشتیبانی نمی‌شود.",
        409,
      );
    }
    if (!line.item_id) {
      throw new RetailInvoiceVoidError(
        "کالای یکی از ردیف‌های این فاکتور حذف شده است؛ ابطال خودکار ممکن نیست.",
        409,
      );
    }
    if (!snapshot.ledgerEntryIds || snapshot.ledgerEntryIds.length === 0) {
      throw new RetailInvoiceVoidError(
        "این فاکتور مربوط به پیش از پشتیبانی ابطال خودکار است و باید به‌صورت دستی اصلاح شود.",
        409,
      );
    }
  }

  // ---- everything validated; now mutate ----
  // Migration 0075's guard_order_item_financial_mutation trigger refuses any
  // status<->'voided' transition on a non-'open' order unless this is set —
  // the same escape hatch order-amendment-service.ts's own void/edit takes,
  // for the exact same reason: this *is* the deliberate, audited way to
  // touch a closed order's lines, not a bypass of the guard.
  await client.query("SET LOCAL app.order_amendment = 'on'");
  const entryDate = order.closed_at?.slice(0, 10) || new Date().toISOString().slice(0, 10);
  const beforeSnapshot = await snapshotOrder(client, params.orderId);

  const { rows: amendmentRows } = await client.query<{ id: string }>(
    `INSERT INTO order_amendments
       (business_id, location_id, order_id, kind, reason, before_snapshot, after_snapshot,
        previous_total, new_total, previous_tip, new_tip, entry_date, created_by)
     VALUES ($1,$2,$3,'void',$4,$5,'{}'::jsonb,$6,0,0,0,$7,$8)
     RETURNING id`,
    [
      params.businessId,
      params.locationId,
      params.orderId,
      params.reason,
      JSON.stringify(beforeSnapshot),
      order.total,
      entryDate,
      params.actorId,
    ],
  );
  const amendmentId = amendmentRows[0].id;
  const reversedEntryIds: string[] = [];

  for (const line of lineRows) {
    const snapshot = line.retail_snapshot!;
    for (const entryId of snapshot.ledgerEntryIds ?? []) {
      const reversedId = await reverseLiveEntry(client, {
        businessId: params.businessId,
        locationId: params.locationId,
        entryId,
        amendmentId,
        memo: "برگشت فاکتور خرده‌فروشی باطل‌شده",
        entryDate,
        createdBy: params.actorId,
      });
      if (reversedId) reversedEntryIds.push(reversedId);
    }

    // Restore the quantity this line consumed. item_stock is the fungible
    // stock model accessories, non-batch cosmetics and trade-goods all
    // share; a sale only ever decrements `quantity`, never `unit_cost`
    // (average cost moves on *receipt*, not sale), so adding the same
    // quantity back is the exact, symmetric inverse. The real sold quantity
    // is `snapshot.quantity` — never `order_items.quantity`, which retail
    // lines always store as `1` (see LineRow's own doc comment).
    await client.query(
      `UPDATE item_stock SET quantity = quantity + $2, updated_at = now() WHERE item_id = $1`,
      [line.item_id, snapshot.quantity],
    );

    await client.query(`UPDATE order_items SET status = 'voided', void_reason = $2 WHERE id = $1`, [
      line.id,
      params.reason,
    ]);
  }

  // Reverse any commission this invoice's lines accrued — the table's own
  // documented convention ("negative = reversed by a later return").
  const orderItemIds = lineRows.map((l) => l.id);
  const { rows: accrualRows } = await client.query<{
    id: string;
    employee_id: string;
    rule_id: string | null;
    amount: string;
    entry_id: string | null;
  }>(
    `SELECT id, employee_id, rule_id, amount::text, entry_id FROM commission_accruals
      WHERE business_id = $1 AND source_type = 'order_item' AND source_id = ANY($2::uuid[]) AND amount <> 0`,
    [params.businessId, orderItemIds],
  );
  for (const accrual of accrualRows) {
    let reversedEntryId: string | null = null;
    if (accrual.entry_id) {
      reversedEntryId = await reverseLiveEntry(client, {
        businessId: params.businessId,
        locationId: params.locationId,
        entryId: accrual.entry_id,
        amendmentId,
        memo: "برگشت پورسانت فاکتور باطل‌شده",
        entryDate,
        createdBy: params.actorId,
      });
      if (reversedEntryId) reversedEntryIds.push(reversedEntryId);
    }
    await client.query(
      `INSERT INTO commission_accruals (business_id, employee_id, rule_id, source_type, source_id, amount, basis_amount, entry_id)
       VALUES ($1,$2,$3,'order_amendment',$4,$5,0,$6)`,
      [params.businessId, accrual.employee_id, accrual.rule_id, amendmentId, -Number(accrual.amount), reversedEntryId],
    );
  }

  // Reverse any loyalty points this invoice earned — customer_points' own
  // signed convention (redeemPoints already spends with a negative row the
  // same way).
  if (order.customer_id) {
    const { rows: pointRows } = await client.query<{ points: string }>(
      `SELECT COALESCE(SUM(points), 0)::text AS points FROM customer_points
        WHERE business_id = $1 AND source_type = 'retail_invoice' AND source_id = $2`,
      [params.businessId, params.orderId],
    );
    const earnedPoints = Number(pointRows[0]?.points ?? 0);
    if (earnedPoints > 0) {
      await client.query(
        `INSERT INTO customer_points (business_id, customer_id, points, source_type, source_id)
         VALUES ($1,$2,$3,'retail_invoice_void',$4)`,
        [params.businessId, order.customer_id, -earnedPoints, amendmentId],
      );
    }
  }

  // Cancel the payment / receivable footprint: supersede the live rows and
  // insert offsetting negatives, exactly the shape `payments` already
  // documents ("negative = refund") and the F&B amendment engine already
  // uses — this table has no F&B-only assumption in it.
  const { rows: paidRows } = await client.query<{ method: AmendmentPaymentMethod; amount: string }>(
    `SELECT method::text AS method, sum(amount)::text AS amount FROM payments
      WHERE order_id = $1 AND superseded_by_amendment_id IS NULL GROUP BY method`,
    [params.orderId],
  );
  const paid: PaymentRow[] = paidRows.map((r) => ({ method: r.method, amount: Number(r.amount) }));
  await client.query(
    "UPDATE payments SET superseded_by_amendment_id = $2 WHERE order_id = $1 AND superseded_by_amendment_id IS NULL",
    [params.orderId, amendmentId],
  );
  for (const row of planPaymentRows(paid, 0, null)) {
    await client.query(
      `INSERT INTO payments (location_id, order_id, method, amount, reference, received_by, superseded_by_amendment_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        params.locationId,
        params.orderId,
        row.method,
        row.amount,
        `retail-invoice-void:${amendmentId}`,
        params.actorId,
        amendmentId,
      ],
    );
  }

  await client.query(
    `UPDATE orders SET status = 'voided', voided_reason = $2, amended_at = now(), amended_by = $3 WHERE id = $1`,
    [params.orderId, params.reason, params.actorId],
  );

  // Same after_snapshot/audit_log parity the F&B engine records for its own
  // void, so a voided retail invoice shows up identically in both places.
  const afterSnapshot = await snapshotOrder(client, params.orderId);
  await client.query(
    `UPDATE order_amendments SET after_snapshot = $2, new_total = 0, new_tip = 0 WHERE id = $1`,
    [amendmentId, JSON.stringify(afterSnapshot)],
  );
  await client.query(
    `INSERT INTO audit_log (business_id, location_id, user_id, action, entity, entity_id, payload)
     VALUES ($1,$2,$3,'order.voided_after_close','order',$4,$5)`,
    [
      params.businessId,
      params.locationId,
      params.actorId,
      params.orderId,
      JSON.stringify({ amendmentId, reason: params.reason, reversedEntryIds }),
    ],
  );

  return { amendmentId, reversedEntryIds };
}
