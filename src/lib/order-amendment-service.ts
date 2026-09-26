/**
 * Closed-order amendments — the DB-touching half (not unit-tested directly,
 * per repo convention; the pure request/plan logic lives in
 * order-amendments.ts and is what order-amendments.test.ts covers, and the
 * end-to-end behaviour is covered by
 * integration/closed-order-amendment.integration.test.ts).
 *
 * A completed order is a posted source document: it carries revenue split by
 * channel, VAT, a tip liability, a platform commission, an A/R balance when it
 * was sold on credit, an exact inventory consumption and the COGS entry that
 * consumption produced. Editing or removing it therefore cannot be a matter of
 * changing `orders.total` — every one of those has to move with it, or the
 * books say one thing and the orders screen another.
 *
 * So it is modelled the way a posted stock count already is
 * (stock-count-service.ts): **reverse, then replay**.
 *
 *   1. Everything the checkout posted is undone at its *own* recorded values —
 *      the journal entries are mirrored line for line (postExactMirrorEntry),
 *      the consumption is put back at the cost it left at
 *      (reverseConsumedInventory), and the payments are cancelled.
 *   2. For a removal, that is the end: the order goes to `voided`, which drops
 *      it out of every order-derived report (they all filter on
 *      `status = 'completed'`), while the ledger nets to zero for it.
 *   3. For an edit, the corrected order is posted again in its place — a fresh
 *      consumption, a fresh revenue + COGS pair, a fresh settlement — under the
 *      amendment's own source identity, so nothing collides with the entries it
 *      replaced and the audit trail keeps both.
 *
 * Two deliberate decisions:
 *
 * - **Reversal and replay are dated on the original order's own posting date**,
 *   not on the day the correction was made. "No accounting shows the effect of
 *   that order" is only true if the sale disappears from the day it belongs to;
 *   dating the reversal today would leave yesterday's sales report untouched and
 *   drop an unexplained credit into today's. The fiscal-period lock (migration
 *   0024) still decides whether that date may be posted into at all, so a locked
 *   month refuses the amendment (`fiscal_period_locked`) instead of quietly
 *   rewriting a closed period.
 * - **An order that already has a customer return is refused**
 *   (`order_has_returns`). The return valued its restocking against this order's
 *   recorded COGS; unwinding the sale underneath it would leave that valuation
 *   referring to a consumption that no longer exists. The return is reversed
 *   first, or the correction is made as a manual journal.
 */
import type { PoolClient } from "pg";
import { getCostingMethod, deductForOrder } from "./inventory-service";
import { rialText, type RialText } from "./inventory-exact";
import { reverseConsumedInventory } from "./inventory-reversal";
import {
  postExactCogsEntry,
  postExactMirrorEntry,
  postExactOrderPaymentEntry,
} from "./ledger-service";
import { getOnlinePlatformsConfig } from "./online-platforms-service";
import { commissionAmountFor } from "./online-platforms-calculation";
import { captureInventorySnapshot, insertOrderItemModifiers } from "./order-mutations";
import { resolveCartItems } from "./order-cart";
import {
  planOrderLines,
  planPaymentRows,
  resolveSettlementMethod,
  type AmendmentPaymentMethod,
  type PaymentRow,
  type ValidatedAmendment,
} from "./order-amendments";
import { recomputeOrderTotals } from "./order-totals";
import type { DiscountInput } from "./orders";
import type { OrderChannel } from "./ledger";

export class OrderAmendmentError extends Error {
  status: number;
  constructor(code: string, status = 409) {
    super(code);
    this.status = status;
  }
}

interface OrderRow {
  id: string;
  status: string;
  type: OrderChannel;
  total: string;
  tax: string;
  tip_amount: string | null;
  discount_type: "percent" | "amount" | null;
  discount_value: string | null;
  note: string | null;
  closed_at: string | null;
}

export interface AmendmentResult {
  id: string;
  kind: "edit" | "void";
  entryDate: string;
  previousTotal: number;
  newTotal: number;
  /** whole-Rial value put back into stock by the reversal */
  restoredCost: string;
  /** whole-Rial COGS the replayed consumption posted ('0' for a removal) */
  replayedCost: string;
  reversedEntryIds: string[];
}

/**
 * The order, its lines and their modifiers as they stand right now — the
 * amendment's before/after record. Exported for
 * `retail-invoice-void-service.ts`, which writes its own `order_amendments`
 * row for the identical `before_snapshot` purpose (retail voids never touch
 * this file's own `amendClosedOrder`, which is F&B-only) — this query has no
 * F&B-only assumption in it (a retail line simply has an empty modifiers
 * array), so it is shared rather than duplicated.
 */
export async function snapshotOrder(client: PoolClient, orderId: string): Promise<unknown> {
  const { rows } = await client.query<{ snapshot: unknown }>(
    `SELECT jsonb_build_object(
              'order', to_jsonb(o) - 'id',
              'items', COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                         'id', oi.id, 'name', oi.name_snapshot, 'unitPrice', oi.unit_price,
                         'quantity', oi.quantity, 'status', oi.status, 'note', oi.note,
                         'modifiers', COALESCE((
                           SELECT jsonb_agg(jsonb_build_object('name', m.name_snapshot, 'priceDelta', m.price_delta, 'quantity', m.quantity)
                                            ORDER BY m.id)
                             FROM order_item_modifiers m WHERE m.order_item_id = oi.id), '[]'::jsonb))
                       ORDER BY oi.created_at)
                  FROM order_items oi WHERE oi.order_id = o.id), '[]'::jsonb)
            ) AS snapshot
       FROM orders o WHERE o.id = $1`,
    [orderId],
  );
  return rows[0]?.snapshot ?? {};
}

/**
 * The consumption event currently standing for this order: the original sale's,
 * or the one the most recent amendment replayed in its place. Amending twice
 * has to undo the *live* consumption, not the one already reversed.
 */
async function liveConsumptionEvent(
  client: PoolClient,
  businessId: string,
  orderId: string,
): Promise<{ id: string } | null> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT e.id
       FROM inventory_events e
      WHERE e.business_id = $1
        AND e.event_type = 'sale_consumption'
        AND e.posting_status <> 'reversed'
        AND ((e.source_type = 'order' AND e.source_id = $2)
             OR (e.source_type = 'order_amendment'
                 AND e.source_id IN (SELECT id FROM order_amendments WHERE order_id = $2)))
      ORDER BY e.created_at DESC, e.id DESC
      LIMIT 1`,
    [businessId, orderId],
  );
  return rows[0] ?? null;
}

/**
 * Exported for customer-return-service.ts, which values a restock against the
 * COGS this order actually recorded — after an amendment that is the replayed
 * consumption's movements, not the original's (both carry
 * `source_type = 'order'`, so the event is the only thing that separates them).
 */
export async function liveSaleInventoryEventId(
  client: PoolClient,
  businessId: string,
  orderId: string,
): Promise<string | null> {
  const event = await liveConsumptionEvent(client, businessId, orderId);
  return event?.id ?? null;
}

/** Every journal entry standing for this order that has not already been reversed. */
async function livePostings(
  client: PoolClient,
  businessId: string,
  orderId: string,
): Promise<{ id: string; posting_kind: string | null; entry_date: string }[]> {
  const { rows } = await client.query<{ id: string; posting_kind: string | null; entry_date: string }>(
    `SELECT je.id, je.posting_kind, je.entry_date::text AS entry_date
       FROM journal_entries je
      WHERE je.business_id = $1
        AND je.reversed_at IS NULL
        AND je.reverses_entry_id IS NULL
        AND ((je.source_type = 'order' AND je.source_id = $2)
             OR (je.source_type = 'order_amendment'
                 AND je.source_id IN (SELECT id FROM order_amendments WHERE order_id = $2)))
      ORDER BY je.entry_date, je.posted_at, je.id`,
    [businessId, orderId],
  );
  return rows;
}

async function paymentsOnOrder(client: PoolClient, orderId: string): Promise<PaymentRow[]> {
  const { rows } = await client.query<{ method: AmendmentPaymentMethod; amount: string }>(
    "SELECT method::text AS method, sum(amount)::text AS amount FROM payments WHERE order_id=$1 GROUP BY method",
    [orderId],
  );
  return rows.map((row) => ({ method: row.method, amount: Number(row.amount) }));
}

/** SnapFood keeps a contract-specific slice of the bill; the ledger only ever sees the Rial amount. */
async function platformCommissionFor(
  businessId: string,
  method: string,
  amount: RialText,
): Promise<RialText> {
  if (method !== "snappfood") return rialText("0");
  const { snappfood } = await getOnlinePlatformsConfig(businessId);
  if (!snappfood) return rialText("0");
  return commissionAmountFor(amount, snappfood.commissionPercent);
}

export async function amendClosedOrder(
  client: PoolClient,
  params: {
    businessId: string;
    locationId: string;
    orderId: string;
    actorId: string | null;
    input: ValidatedAmendment;
  },
): Promise<AmendmentResult> {
  const { rows: orderRows } = await client.query<OrderRow>(
    `SELECT id, status, type, total::text, tax::text, tip_amount::text, discount_type,
            discount_value::text, note, closed_at::text
       FROM orders WHERE id = $1 AND location_id = $2 FOR UPDATE`,
    [params.orderId, params.locationId],
  );
  const order = orderRows[0];
  if (!order) throw new OrderAmendmentError("order_not_found", 404);
  if (order.status !== "completed") throw new OrderAmendmentError("order_not_completed", 409);

  const { rows: returns } = await client.query(
    "SELECT 1 FROM customer_returns WHERE order_id = $1 LIMIT 1",
    [params.orderId],
  );
  if (returns.length > 0) throw new OrderAmendmentError("order_has_returns", 409);

  const beforeSnapshot = await snapshotOrder(client, params.orderId);
  const previousTotal = Number(order.total);
  const previousTip = Number(order.tip_amount ?? 0);
  const paid = await paymentsOnOrder(client, params.orderId);
  const postings = await livePostings(client, params.businessId, params.orderId);
  // The date the sale is on the books for. Everything this amendment posts —
  // reversal and replay alike — lands there, so the day's own reports change.
  const entryDate = postings[0]?.entry_date ?? (order.closed_at ?? "").slice(0, 10);
  if (!entryDate) throw new OrderAmendmentError("order_not_completed", 409);

  const { rows: amendmentRows } = await client.query<{ id: string }>(
    `INSERT INTO order_amendments
       (business_id, location_id, order_id, kind, reason, before_snapshot, after_snapshot,
        previous_total, new_total, previous_tip, new_tip, entry_date, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,'{}'::jsonb,$7,$7,$8,$8,$9,$10)
     RETURNING id`,
    [
      params.businessId,
      params.locationId,
      params.orderId,
      params.input.kind,
      params.input.reason,
      JSON.stringify(beforeSnapshot),
      previousTotal,
      previousTip,
      entryDate,
      params.actorId,
    ],
  );
  const amendmentId = amendmentRows[0].id;

  // ---------------------------------------------------------------- reverse
  const liveEvent = await liveConsumptionEvent(client, params.businessId, params.orderId);
  let restoredCost = 0n;
  let reversalEventId: string | null = null;
  if (liveEvent) {
    const { rows: reversalRows } = await client.query<{ id: string }>(
      `INSERT INTO inventory_events
         (business_id, location_id, event_type, source_type, source_id, created_by,
          costing_version, idempotency_key, reversal_of)
       VALUES ($1,$2,'sale_reversal','order_amendment',$3,$4,2,$5,$6) RETURNING id`,
      [
        params.businessId,
        params.locationId,
        amendmentId,
        params.actorId,
        `order-amendment-reversal:${amendmentId}`,
        liveEvent.id,
      ],
    );
    reversalEventId = reversalRows[0].id;
    const restored = await reverseConsumedInventory(client, {
      locationId: params.locationId,
      consumptionEventId: liveEvent.id,
      movementType: "sale",
      sourceType: "order_amendment",
      sourceId: amendmentId,
      reversalEventId,
      // Put the stock back where it left the FIFO queue rather than behind
      // everything bought since, so a replay re-consumes the same layers.
      receivedAt: order.closed_at ?? new Date().toISOString(),
      createdBy: params.actorId,
      method: await getCostingMethod(params.businessId, client),
    });
    restoredCost = restored.restoredValue;
    await client.query("UPDATE inventory_events SET posting_status='reversed' WHERE id=$1", [liveEvent.id]);
    await client.query("UPDATE inventory_events SET posting_status='posted' WHERE id=$1", [reversalEventId]);
  }

  for (const posting of postings) {
    await postExactMirrorEntry(client, {
      businessId: params.businessId,
      locationId: params.locationId,
      originalEntryId: posting.id,
      sourceType: "order_amendment",
      sourceId: amendmentId,
      postingKind: `${posting.posting_kind ?? "entry"}_reversal`,
      memo: "برگشت سند سفارش بسته‌شده",
      entryDate,
      inventoryEventId: reversalEventId,
      createdBy: params.actorId,
    });
  }

  // Everything settled so far stops being the order's live settlement: the
  // rows are stamped with this amendment (which is what
  // `uq_payments_one_positive_per_order` now keys off) and cancelled by
  // matching negative rows, so every reader that simply sums `payments` — the
  // shift's cash reconciliation, the daily till report — sees the correction
  // without knowing anything about amendments.
  const settlementMethod = resolveSettlementMethod(paid, params.input.paymentMethod);
  await client.query(
    "UPDATE payments SET superseded_by_amendment_id=$2 WHERE order_id=$1 AND superseded_by_amendment_id IS NULL",
    [params.orderId, amendmentId],
  );
  for (const row of planPaymentRows(paid, 0, settlementMethod)) {
    await client.query(
      `INSERT INTO payments (location_id, order_id, method, amount, reference, received_by, superseded_by_amendment_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        params.locationId,
        params.orderId,
        row.method,
        row.amount,
        `order-amendment:${amendmentId}`,
        params.actorId,
        amendmentId,
      ],
    );
  }

  // ----------------------------------------------------------------- replay
  let newTotal = 0;
  let newTip = 0;
  let replayEventId: string | null = null;
  let replayedCost = rialText("0");

  if (params.input.kind === "void") {
    await client.query(
      `UPDATE orders SET status='voided', voided_reason=$2, amended_at=now(), amended_by=$3 WHERE id=$1`,
      [params.orderId, params.input.reason, params.actorId],
    );
  } else {
    // Migration 0014 freezes a settled order's lines at the database. An
    // amendment is the one write allowed to move them, and it says so for the
    // rest of this transaction rather than the guard being weakened for
    // everyone — see 0075's note on `app.order_amendment`.
    await client.query("SET LOCAL app.order_amendment = 'on'");
    const { rows: currentLines } = await client.query<{ id: string; quantity: number }>(
      "SELECT id, quantity FROM order_items WHERE order_id=$1 AND status<>'voided' ORDER BY created_at",
      [params.orderId],
    );
    const plan = planOrderLines(currentLines, params.input.lines);
    if (!plan.ok) throw new OrderAmendmentError(plan.error, plan.error === "item_not_found" ? 404 : 400);

    for (const itemId of plan.value.voids) {
      await client.query(
        "UPDATE order_items SET status='voided', void_reason=$2 WHERE id=$1",
        [itemId, params.input.reason],
      );
    }
    for (const update of plan.value.updates) {
      if (update.note === undefined) {
        await client.query("UPDATE order_items SET quantity=$2 WHERE id=$1", [
          update.orderItemId,
          update.quantity,
        ]);
      } else {
        await client.query("UPDATE order_items SET quantity=$2, note=$3 WHERE id=$1", [
          update.orderItemId,
          update.quantity,
          update.note?.trim() || null,
        ]);
      }
    }
    if (plan.value.additions.length > 0) {
      const resolved = await resolveCartItems(
        params.locationId,
        plan.value.additions.map((addition) => ({
          menuItemId: addition.menuItemId,
          quantity: addition.quantity,
          modifierIds: addition.modifierIds,
          note: addition.note ?? undefined,
        })),
        client,
      );
      if (!resolved.ok) throw new OrderAmendmentError(resolved.error, resolved.status);
      for (const item of resolved.preparedItems) {
        const { rows: itemRows } = await client.query<{ id: string }>(
          `INSERT INTO order_items (location_id, order_id, menu_item_id, name_snapshot, unit_price, quantity, note, status, sent_to_kitchen_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'served',now()) RETURNING id`,
          [
            params.locationId,
            params.orderId,
            item.menuItemId,
            item.name,
            item.unitPrice,
            item.quantity,
            item.note,
          ],
        );
        const orderItemId = itemRows[0].id;
        await insertOrderItemModifiers(client, orderItemId, item.modifiers);
        try {
          await captureInventorySnapshot(
            client,
            orderItemId,
            item.menuItemId,
            item.modifiers,
          );
        } catch (snapshotError) {
          if (
            snapshotError instanceof Error &&
            snapshotError.message === "negative_ingredient_requirement"
          ) {
            throw new OrderAmendmentError("negative_ingredient_requirement", 400);
          }
          throw snapshotError;
        }
      }
    }

    await client.query("SET LOCAL app.order_amendment = 'off'");

    const discount: DiscountInput = params.input.discount.type
      ? { type: params.input.discount.type, value: params.input.discount.value }
      : { type: null };
    const totals = await recomputeOrderTotals(client, params.orderId, discount);
    newTotal = totals.total;
    newTip = params.input.tipAmount ?? previousTip;
    await client.query(
      `UPDATE orders SET note = COALESCE($2, note), tip_amount = $3, amended_at = now(), amended_by = $4
        WHERE id = $1`,
      [params.orderId, params.input.note?.trim() ?? null, newTip, params.actorId],
    );

    const { rows: replayRows } = await client.query<{ id: string }>(
      `INSERT INTO inventory_events
         (business_id, location_id, event_type, source_type, source_id, created_by,
          costing_version, idempotency_key)
       VALUES ($1,$2,'sale_consumption','order_amendment',$3,$4,2,$5) RETURNING id`,
      [
        params.businessId,
        params.locationId,
        amendmentId,
        params.actorId,
        `order-amendment-replay:${amendmentId}`,
      ],
    );
    replayEventId = replayRows[0].id;
    const consumed = await deductForOrder(
      client,
      params.businessId,
      params.locationId,
      params.orderId,
      params.actorId,
      replayEventId,
      // The corrected sale happened on the day the order was sold, so its
      // consumption is dated there too — the stock ledger and the back-dated
      // COGS entry have to agree about which day the goods moved.
      order.closed_at,
    );
    replayedCost = consumed.totalCost;

    const amount = rialText(String(newTotal));
    await postExactOrderPaymentEntry(client, {
      businessId: params.businessId,
      locationId: params.locationId,
      orderId: params.orderId,
      sourceType: "order_amendment",
      sourceId: amendmentId,
      entryDate,
      createdBy: params.actorId,
      method: settlementMethod,
      amount,
      tax: rialText(String(totals.tax)),
      inventoryEventId: replayEventId,
      orderChannel: order.type,
      tip: rialText(String(newTip)),
      platformCommission: await platformCommissionFor(params.businessId, settlementMethod, amount),
    });
    await postExactCogsEntry(client, {
      businessId: params.businessId,
      locationId: params.locationId,
      orderId: params.orderId,
      sourceType: "order_amendment",
      sourceId: amendmentId,
      entryDate,
      createdBy: params.actorId,
      totalCost: replayedCost,
      inventoryEventId: replayEventId,
    });
    await client.query("UPDATE inventory_events SET posting_status='posted' WHERE id=$1", [replayEventId]);

    for (const row of planPaymentRows([], newTotal, settlementMethod)) {
      await client.query(
        `INSERT INTO payments (location_id, order_id, method, amount, reference, received_by)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          params.locationId,
          params.orderId,
          row.method,
          row.amount,
          `order-amendment:${amendmentId}`,
          params.actorId,
        ],
      );
    }
  }

  // Phase 9's central rollup re-pushes only the last couple of days
  // (RESEND_OVERLAP_DAYS), so a correction to an older day would never reach a
  // central server on its own. Winding the push high-water mark back to the
  // amended day puts it in the next push window; the ingest side is an
  // idempotent per-day upsert, so the day simply converges.
  await client.query(
    `UPDATE settings
        SET value = jsonb_set(value, '{lastSuccessDay}', to_jsonb($2::text)), updated_at = now()
      WHERE business_id = $1 AND location_id IS NULL AND key = 'rollup.sync_state'
        AND value->>'lastSuccessDay' IS NOT NULL
        AND value->>'lastSuccessDay' > $2`,
    [params.businessId, entryDate],
  );

  const afterSnapshot = await snapshotOrder(client, params.orderId);
  await client.query(
    `UPDATE order_amendments
        SET after_snapshot=$2, new_total=$3, new_tip=$4, reversal_event_id=$5, replay_event_id=$6
      WHERE id=$1`,
    [amendmentId, JSON.stringify(afterSnapshot), newTotal, newTip, reversalEventId, replayEventId],
  );
  await client.query(
    `INSERT INTO audit_log (business_id, location_id, user_id, action, entity, entity_id, payload)
     VALUES ($1,$2,$3,$4,'order',$5,$6)`,
    [
      params.businessId,
      params.locationId,
      params.actorId,
      params.input.kind === "void" ? "order.voided_after_close" : "order.amended",
      params.orderId,
      JSON.stringify({
        amendmentId,
        reason: params.input.reason,
        entryDate,
        previousTotal,
        newTotal,
        restoredCost: restoredCost.toString(),
        replayedCost,
      }),
    ],
  );

  return {
    id: amendmentId,
    kind: params.input.kind,
    entryDate,
    previousTotal,
    newTotal,
    restoredCost: restoredCost.toString(),
    replayedCost,
    reversedEntryIds: postings.map((posting) => posting.id),
  };
}

export interface OrderAmendmentSummary {
  id: string;
  kind: "edit" | "void";
  reason: string;
  previousTotal: number;
  newTotal: number;
  entryDate: string;
  createdAt: string;
  createdByName: string | null;
}

/** An order's correction history, oldest first — what the order detail screen shows under the bill. */
export async function listOrderAmendments(
  client: PoolClient,
  orderId: string,
): Promise<OrderAmendmentSummary[]> {
  const { rows } = await client.query<{
    id: string;
    kind: "edit" | "void";
    reason: string;
    previous_total: string;
    new_total: string;
    entry_date: string;
    created_at: Date;
    created_by_name: string | null;
  }>(
    `SELECT a.id, a.kind::text AS kind, a.reason, a.previous_total::text, a.new_total::text,
            a.entry_date::text AS entry_date, a.created_at, u.full_name AS created_by_name
       FROM order_amendments a
       LEFT JOIN users u ON u.id = a.created_by
      WHERE a.order_id = $1
      ORDER BY a.created_at, a.id`,
    [orderId],
  );
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    reason: row.reason,
    previousTotal: Number(row.previous_total),
    newTotal: Number(row.new_total),
    entryDate: row.entry_date,
    createdAt: row.created_at.toISOString(),
    createdByName: row.created_by_name,
  }));
}
