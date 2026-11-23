/**
 * Order-ticket sales imported from Holoo.
 *
 * A migration brings across trading that already happened: last month's
 * invoices, the year before the install. For a `retail_invoice` tenant those
 * land through `createRetailInvoice`; for an `order_ticket` one (a café, a
 * restaurant) the local shape is an `orders` row, and this is the writer for
 * it.
 *
 * Every timestamp it writes is the instant the sale *happened* rather than
 * `now()`, which is the whole point of importing history:
 *
 *   * `orders.opened_at` / `closed_at`, which is what every day-bucketed
 *     report reads through `app_business_date` (migration 0076), so an
 *     imported sale lands on the trading day it belongs to — including for a
 *     branch whose day starts at 18:00;
 *   * `stock_movements.occurred_at`, via `deductForOrder`'s `occurredAt`, so
 *     the stock ledger agrees with the sales one; and
 *   * `journal_entries.entry_date`, via `postExact*`'s `entryDate`, which is
 *     also what puts the posting under migration 0024's fiscal-period lock for
 *     the month the sale belongs to rather than the current one. A closed month
 *     refuses the import instead of quietly absorbing it.
 *
 * Two things are deliberately *not* moved back:
 *
 *   * the order number, which comes off the branch's ordinary counter. Numbers
 *     are the sequence bills were issued in, not a second date.
 *   * the table. An imported dine-in sale carries its channel as a label but
 *     never a `table_id`: seating is live floor state, and occupying table 4
 *     tonight because of an invoice from last spring would be a lie the floor
 *     screen has no way to correct.
 *
 * No posting rule is re-implemented here: totals, tender validation, stock
 * consumption and both journal entries all go through the same services the
 * live checkout uses.
 */
import type { PoolClient } from "pg";
import { allocateOrderNumber, resolveOrderNumberSource } from "../../order-number-service";
import { businessDateOf } from "../../business-day";
import { deductForOrder } from "../../inventory-service";
import { rialText, type RialText } from "../../inventory-exact";
import { postExactCogsEntry, postExactOrderPaymentEntry } from "../../ledger-service";
import { captureInventorySnapshot, insertOrderItemModifiers } from "../../order-mutations";
import { resolveCartItems } from "../../order-cart";
import { computeOrderTotals } from "../../orders";
import { tendersWithTip, validateTenders, type ResolvedTender } from "../../payment-methods";
import { listPaymentMethods } from "../../payment-methods-service";

export class ImportedSaleError extends Error {
  status: number;
  constructor(code: string, status = 400) {
    super(code);
    this.status = status;
  }
}

export interface ImportedSaleLine {
  menuItemId: string;
  quantity: number;
}

export interface RecordImportedSaleInput {
  businessId: string;
  locationId: string;
  actorId: string | null;
  /** When the sale happened at the branch, as an instant. */
  occurredAt: Date;
  type: "dine_in" | "takeaway" | "delivery";
  note: string | null;
  customerId: string | null;
  lines: ImportedSaleLine[];
  /** Settlement way code as the source system reports it — 'cash' for Holoo. */
  paymentMethodCode: string;
  /** Names the import in the audit row, e.g. `{ system: 'holoo', remoteId: '1042' }`. */
  source: { system: string; remoteId: string };
}

export interface RecordImportedSaleResult {
  orderId: string;
  orderNumber: number;
  /** The trading day the sale was posted on. */
  entryDate: string;
  total: number;
  payments: ResolvedTender[];
}

interface BranchRow extends Record<string, unknown> {
  timezone: string;
  business_day_start_minutes: number | null;
}

/**
 * Records one imported sale. Runs inside the caller's transaction — the import
 * service owns BEGIN/COMMIT — so a failed posting takes the order and its stock
 * movements with it.
 */
export async function recordImportedSale(
  client: PoolClient,
  params: RecordImportedSaleInput,
): Promise<RecordImportedSaleResult> {
  const { businessId, locationId, actorId, occurredAt, customerId, source } = params;
  const occurredAtIso = occurredAt.toISOString();

  const { rows: branchRows } = await client.query<BranchRow>(
    `SELECT timezone, business_day_start_minutes FROM locations WHERE id = $1 AND business_id = $2`,
    [locationId, businessId],
  );
  if (branchRows.length === 0) throw new ImportedSaleError("no_location", 409);
  const entryDate = businessDateOf(occurredAt, branchRows[0].timezone, branchRows[0].business_day_start_minutes);

  if (customerId) {
    const { rowCount } = await client.query(`SELECT 1 FROM parties WHERE id = $1 AND business_id = $2`, [
      customerId,
      businessId,
    ]);
    if (rowCount !== 1) throw new ImportedSaleError("customer_not_found", 404);
  }

  // The settlement way is resolved against the business's own *active* ways
  // (migration 0091) exactly as the checkout route resolves them. Resolved
  // before anything is written, because listPaymentMethods reads (and lazily
  // seeds) through the pool rather than this transaction's connection.
  const available = await listPaymentMethods(businessId);
  const way = available.find((method) => method.code === params.paymentMethodCode);
  if (!way) throw new ImportedSaleError("invalid_payment_method", 400);
  if (way.settlement === "credit" && !customerId) throw new ImportedSaleError("customer_required", 400);

  const resolved = await resolveCartItems(
    locationId,
    params.lines.map((line) => ({ menuItemId: line.menuItemId, quantity: line.quantity, modifierIds: [] })),
    client,
  );
  if (!resolved.ok) throw new ImportedSaleError(resolved.error, resolved.status);
  const totals = computeOrderTotals(resolved.cartLines, { type: null, value: 0 }, 0);

  // The branch's ordinary allocator (migration 0318): imported history shares
  // the one per-location sequence, so it can never shadow a live bill.
  const orderNumber = await allocateOrderNumber(client, {
    locationId,
    source: await resolveOrderNumberSource(client, businessId),
  });

  // Opened, filled, then completed — in that order, because
  // `guard_order_item_mutation` (migration 0014) refuses a line on an order
  // that is not 'open', which is the invariant that makes a settled sale
  // immutable. An imported order has no open stage anyone ever saw, but it
  // still passes through the state the guard requires.
  const { rows: orderRows } = await client.query<{ id: string }>(
    `INSERT INTO orders (location_id, order_number, type, status, customer_id,
            subtotal, discount, discount_type, discount_value, service_charge, tax, total, note,
            opened_by, opened_at)
     VALUES ($1, $2, $3, 'open', $4, $5, $6, NULL, NULL, 0, $7, $8, $9, $10, $11)
     RETURNING id`,
    [
      locationId,
      orderNumber,
      params.type,
      customerId,
      totals.subtotal,
      totals.discount,
      totals.tax,
      totals.total,
      params.note,
      actorId,
      occurredAtIso,
    ],
  );
  const orderId = orderRows[0].id;

  for (const item of resolved.preparedItems) {
    // 'served', not 'sent': the kitchen made this months ago. Leaving it 'sent'
    // would be a lie the KDS could not clear, and would put a finished sale
    // into the kitchen's throughput figures as an outstanding ticket.
    const { rows: itemRows } = await client.query<{ id: string }>(
      `INSERT INTO order_items (location_id, order_id, menu_item_id, name_snapshot, unit_price, quantity, note,
              status, sent_to_kitchen_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'served', $8, $8) RETURNING id`,
      [locationId, orderId, item.menuItemId, item.name, item.unitPrice, item.quantity, item.note, occurredAtIso],
    );
    const orderItemId = itemRows[0].id;
    await insertOrderItemModifiers(client, orderItemId, item.modifiers);
    await captureInventorySnapshot(client, orderItemId, item.menuItemId, item.modifiers);
  }

  let tenders: ResolvedTender[] = [];
  if (totals.total > 0) {
    const validated = validateTenders([{ methodId: way.id, settlement: way.settlement }], {
      due: totals.total,
      hasCustomer: Boolean(customerId),
    });
    if (!validated.ok) throw new ImportedSaleError(validated.error, 400);
    tenders = validated.value;
  }

  const { rows: eventRows } = await client.query<{ id: string }>(
    `INSERT INTO inventory_events
       (business_id,location_id,event_type,source_type,source_id,created_by,idempotency_key,costing_version)
     VALUES($1,$2,'sale_consumption','order',$3,$4,'imported-order:' || $5,2)
     RETURNING id`,
    [businessId, locationId, orderId, actorId, orderId],
  );
  const inventoryEventId = eventRows[0].id;

  // `received_at` is when the money was taken, so it moves with the sale.
  // `settlement_seq` numbers the slices within this one settlement (migration
  // 0092), exactly as the live checkout does.
  for (const [index, tender] of tenders.entries()) {
    await client.query(
      `INSERT INTO payments (location_id, order_id, method, amount, reference, received_by, payment_method_id,
              settlement_seq, received_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        locationId,
        orderId,
        tender.settlement,
        String(tender.amount),
        tender.reference,
        actorId,
        tender.methodId,
        index + 1,
        occurredAtIso,
      ],
    );
  }

  const { rowCount: completed } = await client.query(
    `UPDATE orders SET status = 'completed', closed_by = $2, closed_at = $3, tip_amount = 0
      WHERE id = $1 AND status = 'open'`,
    [orderId, actorId, occurredAtIso],
  );
  if (completed !== 1) throw new ImportedSaleError("order_not_open", 409);

  const { totalCost } = await deductForOrder(
    client,
    businessId,
    locationId,
    orderId,
    actorId,
    inventoryEventId,
    occurredAtIso,
  );

  // An imported sale is never a marketplace order, so there is no platform
  // commission slice to carry.
  const platformCommission = "0" as RialText;

  await postExactOrderPaymentEntry(client, {
    businessId,
    locationId,
    orderId,
    createdBy: actorId,
    tenders: tendersWithTip(tenders, 0).map((tender) => ({
      settlement: tender.settlement,
      amount: rialText(String(tender.amount)),
    })),
    amount: rialText(String(totals.total)),
    tax: rialText(String(totals.tax)),
    inventoryEventId,
    orderChannel: params.type,
    tip: rialText("0"),
    platformCommission,
    entryDate,
  });
  await postExactCogsEntry(client, {
    businessId,
    locationId,
    orderId,
    createdBy: actorId,
    totalCost,
    inventoryEventId,
    entryDate,
  });
  await client.query("UPDATE inventory_events SET posting_status='posted' WHERE id=$1", [inventoryEventId]);

  // Phase 9's central rollup re-pushes only the last couple of days
  // (RESEND_OVERLAP_DAYS), so a sale imported for an older day would never
  // reach a central server on its own. Winding the push high-water mark back to
  // that day puts it in the next push window; the ingest side is an idempotent
  // per-day upsert, so the day simply converges.
  await client.query(
    `UPDATE settings
        SET value = jsonb_set(value, '{lastSuccessDay}', to_jsonb($2::text)), updated_at = now()
      WHERE business_id = $1 AND location_id IS NULL AND key = 'rollup.sync_state'
        AND value->>'lastSuccessDay' IS NOT NULL
        AND value->>'lastSuccessDay' > $2`,
    [businessId, entryDate],
  );

  await client.query(
    `INSERT INTO audit_log (business_id, location_id, user_id, action, entity, entity_id, payload)
     VALUES ($1,$2,$3,'order.imported','order',$4,$5)`,
    [
      businessId,
      locationId,
      actorId,
      orderId,
      JSON.stringify({
        occurredAt: occurredAtIso,
        entryDate,
        orderNumber,
        total: totals.total,
        source: source.system,
        remoteId: source.remoteId,
      }),
    ],
  );

  return { orderId, orderNumber, entryDate, total: totals.total, payments: tenders };
}
