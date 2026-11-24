import { query } from "./db";
import { isKitchenOrderReady, type OrderItemStatus } from "./order-item-status";
import { recordCoworkerEvent } from "./ai-coworker-events";
import { notifyOrderReady } from "./kavenegar/lookup-triggers";

/**
 * The one post-commit "this order is now fully ready" fan-out, shared by the
 * single-line kitchen route and the ticket-wide batch route.
 *
 * It runs AFTER the fulfillment transaction commits: a downstream automation
 * outage must never turn a successful bump into an apparent failure that
 * invites a retry. The coworker event's stable dedupe key and the SMS send log
 * keep a duplicate call (a second terminal line, a retried batch) as one
 * customer-visible event.
 */
export async function announceKitchenOrderReady(input: {
  businessId: string;
  locationId: string;
  orderId: string;
}): Promise<void> {
  const { rows } = await query<{
    customer_id: string;
    item_statuses: OrderItemStatus[];
  }>(
    `SELECT o.customer_id, array_agg(oi.status::text) AS item_statuses
       FROM orders o JOIN order_items oi ON oi.order_id = o.id
      WHERE o.id = $1 AND o.customer_id IS NOT NULL
        AND o.status IN ('open', 'held', 'completed')
      GROUP BY o.id`,
    [input.orderId],
  );
  if (!rows[0] || !isKitchenOrderReady(rows[0].item_statuses)) return;

  try {
    await recordCoworkerEvent({
      businessId: input.businessId,
      locationId: input.locationId,
      kind: "order_ready",
      payload: { customerId: rows[0].customer_id, orderId: input.orderId },
      dedupeKey: `order-ready:${input.orderId}`,
    });
  } catch (error) {
    console.error("kitchen order-ready event dispatch failed:", error);
  }

  // Issue #902 §5 — the customer's own message, if this business enabled it.
  // Deliberately not awaited: a kitchen bump must not wait on a provider round
  // trip, and `notifyOrderReady` swallows and logs its own failures. The send
  // log's UNIQUE key is what makes this safe to fire twice.
  void notifyOrderReady({
    businessId: input.businessId,
    locationId: input.locationId,
    orderId: input.orderId,
  });
}
