/**
 * Phase 26 Wave 8 — producers for Holoo's push outbox.
 *
 * The push tick can only drain what the application enqueues. These helpers are
 * called from the existing write paths at the point a document becomes real:
 * order checkout / retail invoice commit, AR receipt, AP payment, and purchase
 * receipt. They do not write to Holoo directly; they create ordinary
 * `integration_outbox_events` rows that the existing retry/backoff/dead-letter
 * machinery drains.
 */
import type { PoolClient } from "pg";
import type { HolooDocument } from "./direct-sql";
import type { HolooOutboxKind } from "./push-service";

interface PushConnection {
  id: string;
}

async function holooPushConnections(client: PoolClient, businessId: string, locationId: string | null): Promise<PushConnection[]> {
  const { rows } = await client.query<PushConnection>(
    `SELECT c.id
       FROM integration_connections c
       JOIN holoo_connection_settings h ON h.connection_id = c.id AND h.business_id = c.business_id
      WHERE c.business_id = $1
        AND c.provider = 'holoo'
        AND c.status = 'active'
        AND h.write_mode <> 'none'
        AND h.companion_activated_at IS NOT NULL
        AND (c.location_id IS NULL OR c.location_id = $2)`,
    [businessId, locationId],
  );
  return rows;
}

async function remoteIdForLocal(
  client: PoolClient,
  businessId: string,
  connectionId: string,
  entityType: string,
  localId: string | null,
): Promise<string | null> {
  if (!localId) return null;
  const { rows } = await client.query<{ remote_id: string }>(
    `SELECT remote_id FROM integration_mappings
      WHERE business_id = $1 AND connection_id = $2 AND entity_type = $3 AND local_id = $4
      ORDER BY updated_at DESC LIMIT 1`,
    [businessId, connectionId, entityType, localId],
  );
  return rows[0]?.remote_id ?? null;
}

function isoDate(value: string | Date | null): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

async function upsertOutbox(
  client: PoolClient,
  businessId: string,
  connectionId: string,
  kind: HolooOutboxKind,
  remoteId: string,
  localId: string,
  document: HolooDocument,
): Promise<void> {
  await client.query(
    `INSERT INTO integration_outbox_events
       (business_id, connection_id, entity_type, remote_id, local_id, payload)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (connection_id, entity_type, remote_id)
     DO UPDATE SET payload = EXCLUDED.payload, status = 'pending', attempts = 0,
                   next_attempt_at = now(), last_error = NULL, updated_at = now()`,
    [businessId, connectionId, kind, remoteId, localId, JSON.stringify(document)],
  );
}

export async function enqueueHolooSaleForOrder(
  client: PoolClient,
  businessId: string,
  orderId: string,
): Promise<number> {
  const { rows: orders } = await client.query<{
    id: string;
    location_id: string;
    order_number: string;
    closed_at: string | Date | null;
    total: string;
    tax: string;
    customer_id: string | null;
    note: string | null;
  }>(
    `SELECT o.id, o.location_id, o.order_number::text, o.closed_at, o.total::text, o.tax::text, o.customer_id, o.note
       FROM orders o JOIN locations l ON l.id = o.location_id
      WHERE o.id = $1 AND l.business_id = $2 AND o.status = 'completed'`,
    [orderId, businessId],
  );
  const order = orders[0];
  if (!order) return 0;

  const connections = await holooPushConnections(client, businessId, order.location_id);
  let queued = 0;
  for (const connection of connections) {
    const personRemoteId = await remoteIdForLocal(client, businessId, connection.id, "holoo_customer", order.customer_id);
    const { rows: lines } = await client.query<{
      id: string;
      local_item_id: string | null;
      name_snapshot: string;
      quantity: string;
      unit_price: string;
      remote_goods_id: string | null;
    }>(
      `SELECT oi.id,
              COALESCE(oi.menu_item_id, oi.item_id) AS local_item_id,
              oi.name_snapshot,
              oi.quantity::text,
              oi.unit_price::text,
              m.remote_id AS remote_goods_id
         FROM order_items oi
         LEFT JOIN integration_mappings m
           ON m.business_id = $2 AND m.connection_id = $3 AND m.entity_type = 'holoo_goods'
          AND m.local_id = COALESCE(oi.menu_item_id, oi.item_id)
        WHERE oi.order_id = $1
        ORDER BY oi.created_at, oi.id`,
      [orderId, businessId, connection.id],
    );
    const document: HolooDocument = {
      sourceId: `order:${order.id}`,
      kind: "sale",
      values: [order.order_number, isoDate(order.closed_at), personRemoteId, order.total],
      payload: {
        documentNumber: order.order_number,
        occurredAt: isoDate(order.closed_at),
        totalRial: order.total,
        taxRial: order.tax,
        personRemoteId,
        memo: order.note,
        lines: lines.map((line) => ({
          sourceLineId: line.id,
          goodsRemoteId: line.remote_goods_id,
          name: line.name_snapshot,
          quantity: line.quantity,
          unitPriceRial: line.unit_price,
        })),
      },
    };
    await upsertOutbox(client, businessId, connection.id, "holoo_sale", document.sourceId, order.id, document);
    queued += 1;
  }
  return queued;
}

export async function enqueueHolooReceiptForArReceipt(
  client: PoolClient,
  businessId: string,
  receiptId: string,
): Promise<number> {
  const { rows } = await client.query<{
    id: string;
    location_id: string | null;
    customer_id: string;
    receipt_date: string;
    method: string;
    amount: string;
    memo: string | null;
  }>(
    `SELECT id, location_id, customer_id, receipt_date::text, method::text, amount::text, memo
       FROM ar_receipts WHERE id = $1 AND business_id = $2`,
    [receiptId, businessId],
  );
  const receipt = rows[0];
  if (!receipt) return 0;
  const connections = await holooPushConnections(client, businessId, receipt.location_id);
  let queued = 0;
  for (const connection of connections) {
    const personRemoteId = await remoteIdForLocal(client, businessId, connection.id, "holoo_customer", receipt.customer_id);
    const document: HolooDocument = {
      sourceId: `ar_receipt:${receipt.id}`,
      kind: "receipt",
      values: [receipt.receipt_date, personRemoteId, receipt.amount, "receipt"],
      payload: { occurredAt: receipt.receipt_date, totalRial: receipt.amount, personRemoteId, method: receipt.method, direction: "receipt", memo: receipt.memo },
    };
    await upsertOutbox(client, businessId, connection.id, "holoo_receipt", document.sourceId, receipt.id, document);
    queued += 1;
  }
  return queued;
}

export async function enqueueHolooReceiptForApPayment(
  client: PoolClient,
  businessId: string,
  paymentId: string,
): Promise<number> {
  const { rows } = await client.query<{
    id: string;
    location_id: string | null;
    supplier_id: string;
    payment_date: string;
    method: string;
    amount: string;
    memo: string | null;
  }>(
    `SELECT id, location_id, supplier_id, payment_date::text, method::text, amount::text, memo
       FROM ap_payments WHERE id = $1 AND business_id = $2`,
    [paymentId, businessId],
  );
  const payment = rows[0];
  if (!payment) return 0;
  const connections = await holooPushConnections(client, businessId, payment.location_id);
  let queued = 0;
  for (const connection of connections) {
    const personRemoteId = await remoteIdForLocal(client, businessId, connection.id, "holoo_customer", payment.supplier_id);
    const document: HolooDocument = {
      sourceId: `ap_payment:${payment.id}`,
      kind: "receipt",
      values: [payment.payment_date, personRemoteId, payment.amount, "payment"],
      payload: { occurredAt: payment.payment_date, totalRial: payment.amount, personRemoteId, method: payment.method, direction: "payment", memo: payment.memo },
    };
    await upsertOutbox(client, businessId, connection.id, "holoo_receipt", document.sourceId, payment.id, document);
    queued += 1;
  }
  return queued;
}

export async function enqueueHolooPurchase(
  client: PoolClient,
  businessId: string,
  purchaseId: string,
  source: "purchase" | "item_purchase",
): Promise<number> {  const table = source === "purchase" ? "purchases" : "item_purchases";
  const dateExpr = source === "purchase" ? "COALESCE(p.received_at::date, p.purchase_date)::text" : "p.received_at::date::text";
  const { rows } = await client.query<{
    id: string;
    location_id: string;
    supplier_id: string | null;
    occurred_at: string;
    total: string;
    note: string | null;
  }>(
    `SELECT p.id, p.location_id, p.supplier_id, ${dateExpr} AS occurred_at, p.total::text, p.note
       FROM ${table} p JOIN locations l ON l.id = p.location_id
      WHERE p.id = $1 AND l.business_id = $2`,
    [purchaseId, businessId],
  );
  const purchase = rows[0];
  if (!purchase) return 0;
  const connections = await holooPushConnections(client, businessId, purchase.location_id);
  let queued = 0;
  for (const connection of connections) {
    const personRemoteId = await remoteIdForLocal(client, businessId, connection.id, "holoo_customer", purchase.supplier_id);
    const document: HolooDocument = {
      sourceId: `${source}:${purchase.id}`,
      kind: "purchase",
      values: [purchase.occurred_at, personRemoteId, purchase.total],
      payload: { occurredAt: purchase.occurred_at, totalRial: purchase.total, personRemoteId, memo: purchase.note, source },
    };
    await upsertOutbox(client, businessId, connection.id, "holoo_purchase", document.sourceId, purchase.id, document);
    queued += 1;
  }
  return queued;
}

/**
 * Issue #829 — Holoo behavior for AR/AP reversals, defined so a reversal never
 * creates silent divergence.
 *
 * A reversal is enqueued as its own outbox document (distinct `remote_id` with
 * a `:reversal` suffix) that names the voucher it undoes. It never overwrites
 * the original receipt/payment document: Holoo keeps both, the same way the
 * local ledger keeps both journal entries. The payload carries `reverses` +
 * `reversalEntryId` so the companion can post a compensating document rather
 * than deleting the original.
 */
export async function enqueueHolooReversalForArReceipt(
  client: PoolClient,
  businessId: string,
  receiptId: string,
  reversalEntryId: string,
): Promise<number> {
  const { rows } = await client.query<{
    id: string;
    location_id: string | null;
    customer_id: string;
    amount: string;
    memo: string | null;
    reversal_date: string | null;
  }>(
    `SELECT r.id, r.location_id, r.customer_id, r.amount::text, r.memo,
            je.entry_date::text AS reversal_date
       FROM ar_receipts r
       LEFT JOIN journal_entries je ON je.id = r.reversal_entry_id
      WHERE r.id = $1 AND r.business_id = $2`,
    [receiptId, businessId],
  );
  const receipt = rows[0];
  if (!receipt) return 0;
  const connections = await holooPushConnections(client, businessId, receipt.location_id);
  let queued = 0;
  for (const connection of connections) {
    const personRemoteId = await remoteIdForLocal(client, businessId, connection.id, "holoo_customer", receipt.customer_id);
    const document: HolooDocument = {
      sourceId: `ar_receipt:${receipt.id}:reversal`,
      kind: "receipt",
      values: [receipt.reversal_date, personRemoteId, receipt.amount, "receipt_reversal"],
      payload: {
        occurredAt: receipt.reversal_date,
        totalRial: receipt.amount,
        personRemoteId,
        direction: "receipt_reversal",
        reverses: receipt.id,
        reversalEntryId,
        memo: receipt.memo,
      },
    };
    await upsertOutbox(client, businessId, connection.id, "holoo_receipt", document.sourceId, receipt.id, document);
    queued += 1;
  }
  return queued;
}

export async function enqueueHolooReversalForApPayment(
  client: PoolClient,
  businessId: string,
  paymentId: string,
  reversalEntryId: string,
): Promise<number> {
  const { rows } = await client.query<{
    id: string;
    location_id: string | null;
    supplier_id: string;
    amount: string;
    memo: string | null;
    reversal_date: string | null;
  }>(
    `SELECT p.id, p.location_id, p.supplier_id, p.amount::text, p.memo,
            je.entry_date::text AS reversal_date
       FROM ap_payments p
       LEFT JOIN journal_entries je ON je.id = p.reversal_entry_id
      WHERE p.id = $1 AND p.business_id = $2`,
    [paymentId, businessId],
  );
  const payment = rows[0];
  if (!payment) return 0;
  const connections = await holooPushConnections(client, businessId, payment.location_id);
  let queued = 0;
  for (const connection of connections) {
    const personRemoteId = await remoteIdForLocal(client, businessId, connection.id, "holoo_customer", payment.supplier_id);
    const document: HolooDocument = {
      sourceId: `ap_payment:${payment.id}:reversal`,
      kind: "receipt",
      values: [payment.reversal_date, personRemoteId, payment.amount, "payment_reversal"],
      payload: {
        occurredAt: payment.reversal_date,
        totalRial: payment.amount,
        personRemoteId,
        direction: "payment_reversal",
        reverses: payment.id,
        reversalEntryId,
        memo: payment.memo,
      },
    };
    await upsertOutbox(client, businessId, connection.id, "holoo_receipt", document.sourceId, payment.id, document);
    queued += 1;
  }
  return queued;
}
