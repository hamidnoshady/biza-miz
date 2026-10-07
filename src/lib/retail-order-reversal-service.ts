/**
 * Retail + Cosmetics (issue #770) — reversing an imported retail order
 * (WooCommerce / Eshobe CMS) through retail rules, not F&B's.
 *
 * Why this exists as its own function rather than a branch of
 * `retail-invoice-void-service.ts`:
 *
 *   - A POS retail invoice's reversal identity lives in each line's
 *     `retail_snapshot.ledgerEntryIds` (the exact entries that sale posted).
 *     An *imported* retail order has no retail_snapshot at all: its revenue
 *     and COGS were posted by the integration adapter against the order
 *     itself (`source_type = 'cms_store_order' | 'woocommerce_order'`,
 *     `source_id = order id`). Discovering what to reverse is therefore a
 *     different query, and pretending otherwise would mean fabricating
 *     snapshot data.
 *   - CMS reversals used to call `amendClosedOrder`, the F&B closed-order
 *     engine, whose whole shape assumes recipe consumption, menu-item
 *     modifiers and online-platform commission. A retail order has none of
 *     that; running it through F&B's engine reversed the wrong things or
 *     nothing at all.
 *
 * What it *shares* is deliberately shared: `postExactMirrorEntry` (the
 * debit/credit swap every reversal in this codebase posts), `snapshotOrder`
 * and the `order_amendments` audit table (so a reversed retail order appears
 * in the same bookkeeping as any other amendment), `planPaymentRows` (the
 * supersede-and-offset payment shape), and the canonical batch engine
 * (`restoreOrderItemBatchStock`) for putting stock back into the exact lots
 * the sale consumed.
 *
 * Stock restoration rule, the same one the POS void follows:
 *   - a line with persisted batch allocations restores its original lots and
 *     the item_stock rollup is recomputed (never a bare quantity increment);
 *   - a fungible line restores `item_stock.quantity` symmetrically;
 *   - a batch-tracked line with NO allocation (imported before migration
 *     0198) is refused rather than desynchronising the rollup.
 */
import { randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import type { PoolClient } from "pg";
import { postExactMirrorEntry } from "./ledger-service";
import { snapshotOrder } from "./order-amendment-service";
import { planPaymentRows, type AmendmentPaymentMethod, type PaymentRow } from "./order-amendments";
import { restoreOrderItemBatchStock } from "./retail-batch-inventory";
import { planOnlineLineReturn } from "./online-sale-policy";
import { rialText, roundRial, type RialText } from "./inventory-exact";

export class RetailOrderReversalError extends Error {
  status: number;
  constructor(message: string, status = 409) {
    super(message);
    this.status = status;
  }
}

export interface ReverseRetailOrderInput {
  businessId: string;
  locationId: string;
  orderId: string;
  actorId: string | null;
  reason: string;
  /**
   * The `journal_entries.source_type` values this channel posted under — the
   * channel's own identity, e.g. `["cms_store_order"]` or
   * `["woocommerce_order"]`.
   */
  sourceTypes: string[];
  /** Where the stock restorations are recorded, for audit/idempotency. */
  restorationSourceType: string;
  restorationSourceId: string;
  /** Injectable for tests. */
  entryDate?: string;
}

export interface ReverseRetailOrderResult {
  amendmentId: string;
  reversedEntryIds: string[];
  /** Cost value put back into stock by this reversal, Rial. */
  restockedValue: RialText;
}

interface OrderRow {
  id: string;
  status: string;
  type: string;
  customer_id: string | null;
  location_id: string;
  closed_at: string | null;
  total: string;
}

interface OrderLineRow {
  id: string;
  item_id: string | null;
  quantity: string;
}

/**
 * Reverses a completed imported retail order atomically, in the caller's
 * transaction. Idempotent by construction: a second call sees a non-completed
 * order and returns the existing amendment instead of posting anything again.
 */
export async function reverseRetailImportedOrder(
  client: PoolClient,
  input: ReverseRetailOrderInput,
): Promise<ReverseRetailOrderResult> {
  const { rows: orderRows } = await client.query<OrderRow>(
    `SELECT id, status::text AS status, type::text AS type, customer_id, location_id,
            closed_at::text AS closed_at, total::text AS total
       FROM orders WHERE id = $1 AND location_id = $2 FOR UPDATE`,
    [input.orderId, input.locationId],
  );
  const order = orderRows[0];
  if (!order) throw new RetailOrderReversalError("سفارش یافت نشد.", 404);
  if (order.type !== "retail") {
    throw new RetailOrderReversalError("این عملیات فقط برای سفارش‌های خرده‌فروشی است.", 400);
  }
  if (order.status !== "completed") {
    // Already reversed (or never completed) — find the amendment that did it,
    // so a replayed CMS webhook resolves to the same id.
    const { rows: existing } = await client.query<{ id: string }>(
      `SELECT id FROM order_amendments
        WHERE order_id = $1 AND kind = 'void' ORDER BY created_at DESC LIMIT 1`,
      [input.orderId],
    );
    if (existing[0]) {
      return {
        amendmentId: existing[0].id,
        reversedEntryIds: [],
        restockedValue: rialText("0"),
      };
    }
    throw new RetailOrderReversalError("این سفارش تکمیل‌شده نیست و قابل برگشت نیست.", 409);
  }

  const { rows: lineRows } = await client.query<OrderLineRow>(
    `SELECT id, item_id, quantity::text FROM order_items
      WHERE order_id = $1 AND status <> 'voided' ORDER BY created_at FOR UPDATE`,
    [input.orderId],
  );

  // ---- validate the stock side before any mutation ----
  const lineItemIds = lineRows.map((l) => l.item_id).filter((id): id is string => id != null);
  const batchTracked = new Set<string>();
  if (lineItemIds.length > 0) {
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM items WHERE id = ANY($1::uuid[]) AND tracking = 'batch'`,
      [[...new Set(lineItemIds)]],
    );
    for (const row of rows) batchTracked.add(row.id);
  }
  const allocatedLines = new Set<string>();
  if (lineRows.length > 0) {
    const { rows } = await client.query<{ order_item_id: string }>(
      `SELECT DISTINCT order_item_id FROM order_item_batch_allocations
        WHERE order_item_id = ANY($1::uuid[])`,
      [lineRows.map((l) => l.id)],
    );
    for (const row of rows) allocatedLines.add(row.order_item_id);
  }
  for (const line of lineRows) {
    if (line.item_id && batchTracked.has(line.item_id) && !allocatedLines.has(line.id)) {
      throw new RetailOrderReversalError(
        "ردیفی از این سفارش، کالای بچ‌محور بدون تخصیص بچ ثبت‌شده است؛ برگشت خودکار ممکن نیست.",
        409,
      );
    }
  }

  await client.query("SET LOCAL app.order_amendment = 'on'");
  const entryDate = input.entryDate ?? order.closed_at?.slice(0, 10) ?? new Date().toISOString().slice(0, 10);
  const beforeSnapshot = await snapshotOrder(client, input.orderId);

  const { rows: amendmentRows } = await client.query<{ id: string }>(
    `INSERT INTO order_amendments
       (business_id, location_id, order_id, kind, reason, before_snapshot, after_snapshot,
        previous_total, new_total, previous_tip, new_tip, entry_date, created_by)
     VALUES ($1,$2,$3,'void',$4,$5,'{}'::jsonb,$6,0,0,0,$7,$8)
     RETURNING id`,
    [
      input.businessId,
      input.locationId,
      input.orderId,
      input.reason,
      JSON.stringify(beforeSnapshot),
      order.total,
      entryDate,
      input.actorId,
    ],
  );
  const amendmentId = amendmentRows[0].id;

  // ---- reverse the journal entries this channel posted for the order ----
  const reversedEntryIds: string[] = [];
  const { rows: entryRows } = await client.query<{ id: string; posting_kind: string | null }>(
    `SELECT id, posting_kind FROM journal_entries
      WHERE business_id = $1 AND source_id = $2 AND source_type = ANY($3::text[])
        AND reversed_at IS NULL AND reverses_entry_id IS NULL
      ORDER BY posted_at, id`,
    [input.businessId, input.orderId, input.sourceTypes],
  );
  for (const entry of entryRows) {
    const reversedId = await postExactMirrorEntry(client, {
      businessId: input.businessId,
      locationId: input.locationId,
      originalEntryId: entry.id,
      // A fresh identity per reversal: `uq_journal_business_source_posting`
      // is unique on (business_id, source_type, source_id, posting_kind), and
      // an order can legitimately post more than one entry of the same kind.
      sourceType: "order_amendment",
      sourceId: randomUUID(),
      postingKind: `${entry.posting_kind ?? "entry"}_reversal`,
      memo: input.reason,
      entryDate,
      createdBy: input.actorId,
    });
    if (reversedId) reversedEntryIds.push(reversedId);
  }

  // ---- restore stock, lot by lot where the sale recorded allocations ----
  let restockedValue = 0n;
  for (const line of lineRows) {
    if (line.item_id && allocatedLines.has(line.id)) {
      const restored = await restoreOrderItemBatchStock(client, {
        orderItemId: line.id,
        itemId: line.item_id,
        locationId: input.locationId,
        quantity: line.quantity,
        disposition: "restockable",
        sourceType: input.restorationSourceType,
        sourceId: input.restorationSourceId,
      });
      if (restored) restockedValue += BigInt(restored.restockedValue);
    } else if (line.item_id) {
      // An online line recorded what it actually took off the shelf
      // (`online_sale_lines`, migration 0209): put back exactly that, so a
      // reversal of a sale a remote snapshot already reflected — or one the
      // shelf could not cover — does not invent stock.
      const { rows: factRows } = await client.query<{
        quantity: string; short_quantity: string; relieved_quantity: string;
        restored_quantity: string; cogs_rial: string; restored_cogs_rial: string;
      }>(
        `SELECT quantity::text, short_quantity::text, relieved_quantity::text,
                restored_quantity::text, cogs_rial::text, restored_cogs_rial::text
           FROM online_sale_lines WHERE order_item_id = $1 FOR UPDATE`,
        [line.id],
      );
      const fact = factRows[0];
      if (fact) {
        const plan = planOnlineLineReturn({
          quantity: fact.quantity,
          shortQuantity: fact.short_quantity,
          relievedQuantity: fact.relieved_quantity,
          restoredQuantity: fact.restored_quantity,
          cogsRial: fact.cogs_rial,
          restoredCogsRial: fact.restored_cogs_rial,
        }, String(line.quantity));
        if (new Decimal(plan.restock).gt(0)) {
          await client.query(
            `UPDATE item_stock SET quantity = quantity + $2::numeric, updated_at = now() WHERE item_id = $1`,
            [line.item_id, plan.restock],
          );
        }
        await client.query(
          `UPDATE online_sale_lines
              SET returned_quantity = quantity,
                  restored_quantity = restored_quantity + $2::numeric,
                  restored_cogs_rial = restored_cogs_rial + $3::bigint
            WHERE order_item_id = $1`,
          [line.id, plan.restock, plan.cogsReversalRial],
        );
        restockedValue += BigInt(plan.cogsReversalRial);
        await client.query(`UPDATE order_items SET status = 'voided', void_reason = $2 WHERE id = $1`, [
          line.id,
          input.reason,
        ]);
        continue;
      }
      await client.query(
        `UPDATE item_stock SET quantity = quantity + $2, updated_at = now() WHERE item_id = $1`,
        [line.item_id, line.quantity],
      );
      // Fungible stock: the reversal's cost value is the quantity at the
      // current running cost, matching what the import's COGS entry used.
      const { rows: stockRows } = await client.query<{ unit_cost: string | null }>(
        `SELECT unit_cost::text FROM item_stock WHERE item_id = $1`,
        [line.item_id],
      );
      if (stockRows[0]?.unit_cost) {
        restockedValue += BigInt(
          roundRial(new Decimal(line.quantity).times(stockRows[0].unit_cost)),
        );
      }
    }
    await client.query(`UPDATE order_items SET status = 'voided', void_reason = $2 WHERE id = $1`, [
      line.id,
      input.reason,
    ]);
  }

  // ---- supersede the payment footprint (supersede + offsetting negatives) ----
  const { rows: paidRows } = await client.query<{ method: AmendmentPaymentMethod; amount: string }>(
    `SELECT method::text AS method, sum(amount)::text AS amount FROM payments
      WHERE order_id = $1 AND superseded_by_amendment_id IS NULL GROUP BY method`,
    [input.orderId],
  );
  const paid: PaymentRow[] = paidRows.map((r) => ({ method: r.method, amount: Number(r.amount) }));
  await client.query(
    "UPDATE payments SET superseded_by_amendment_id = $2 WHERE order_id = $1 AND superseded_by_amendment_id IS NULL",
    [input.orderId, amendmentId],
  );
  for (const row of planPaymentRows(paid, 0, null)) {
    await client.query(
      `INSERT INTO payments (location_id, order_id, method, amount, reference, received_by, superseded_by_amendment_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        input.locationId,
        input.orderId,
        row.method,
        row.amount,
        `retail-order-reversal:${amendmentId}`,
        input.actorId,
        amendmentId,
      ],
    );
  }

  await client.query(
    `UPDATE orders SET status = 'voided', voided_reason = $2, amended_at = now(), amended_by = $3 WHERE id = $1`,
    [input.orderId, input.reason, input.actorId],
  );

  const afterSnapshot = await snapshotOrder(client, input.orderId);
  await client.query(
    `UPDATE order_amendments SET after_snapshot = $2, new_total = 0, new_tip = 0 WHERE id = $1`,
    [amendmentId, JSON.stringify(afterSnapshot)],
  );
  await client.query(
    `INSERT INTO audit_log (business_id, location_id, user_id, action, entity, entity_id, payload)
     VALUES ($1,$2,$3,'order.voided_after_close','order',$4,$5)`,
    [
      input.businessId,
      input.locationId,
      input.actorId,
      input.orderId,
      JSON.stringify({ amendmentId, reason: input.reason, reversedEntryIds, sourceTypes: input.sourceTypes }),
    ],
  );

  return {
    amendmentId,
    reversedEntryIds,
    restockedValue: rialText(restockedValue.toString()),
  };
}
