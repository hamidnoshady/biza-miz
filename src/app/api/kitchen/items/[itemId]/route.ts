import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { query } from "@/lib/db";
import { resolveActiveLocation } from "@/lib/setup-state";
import { isKitchenOrderReady, type OrderItemStatus } from "@/lib/order-item-status";
import { transitionKitchenItem } from "@/lib/kitchen-item-transition";
import { broadcast } from "@/lib/realtime";
import { recordCoworkerEvent } from "@/lib/ai-coworker-events";
import { notifyOrderReady } from "@/lib/kavenegar/lookup-triggers";

/**
 * Kitchen "bump" (sent→preparing→ready) and waiter/cashier "served"
 * (ready→served) transitions, kept separate from the cashier-only
 * quantity/void endpoint at /api/orders/[id]/items/[itemId].
 */
export const PATCH = withTenantScope(async (request: NextRequest, context: { params: Promise<{ itemId: string }> }) => {
  const { itemId } = await context.params;
  const { session: sessionForKitchen } = await requirePermission(PERMISSIONS.kitchenView);
  const { session: sessionForServing, error: servingError } = await requirePermission(PERMISSIONS.ordersView);
  const session = sessionForKitchen ?? sessionForServing;
  if (!session) return servingError ?? NextResponse.json({ error: "forbidden" }, { status: 403 });

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  let body: { status?: OrderItemStatus };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const to = body.status;
  if (to !== "preparing" && to !== "ready" && to !== "served") {
    return NextResponse.json({ error: "invalid_status" }, { status: 400 });
  }

  const mutation = await transitionKitchenItem({
    businessId: session.businessId,
    locationId: location.id,
    itemId,
    to,
    mayBumpKitchen: Boolean(sessionForKitchen),
    mayServe: Boolean(sessionForServing),
    actorUserId: session.sub,
    syncActor: { userId: session.sub, role: session.role },
  });

  if (mutation.kind === "missing") {
    return NextResponse.json({ error: "item_not_found" }, { status: 404 });
  }
  if (mutation.kind === "conflict" || mutation.kind === "duplicate") {
    return NextResponse.json(
      { error: "stale_status", currentStatus: mutation.currentStatus },
      { status: 409 },
    );
  }
  const orderId = mutation.orderId;

  broadcast(location.id, { type: "order.item_status", orderId, itemId, status: to });
  if (to === "ready") {
    // A multi-line ticket is ready only when its final unserved line is ready.
    // The event has a stable order key, so a retry/second terminal line remains
    // one customer event and therefore one coworker run/campaign.
    const { rows: readyOrders } = await query<{
      customer_id: string;
      item_statuses: OrderItemStatus[];
    }>(
      `SELECT o.customer_id, array_agg(oi.status::text) AS item_statuses
         FROM orders o JOIN order_items oi ON oi.order_id = o.id
        WHERE o.id = $1 AND o.customer_id IS NOT NULL
          AND o.status IN ('open', 'held', 'completed')
        GROUP BY o.id`,
      [orderId],
    );
    if (readyOrders[0] && isKitchenOrderReady(readyOrders[0].item_statuses)) {
      try {
        await recordCoworkerEvent({
          businessId: session.businessId, locationId: location.id, kind: "order_ready",
          payload: { customerId: readyOrders[0].customer_id, orderId },
          dedupeKey: `order-ready:${orderId}`,
        });
      } catch (error) {
        // Fulfillment has committed. A downstream automation outage must not
        // turn a successful bump into an apparent failure that invites a retry.
        console.error("kitchen order-ready event dispatch failed:", error);
      }
      // Issue #902 §5 — the customer's own message, if this business turned
      // that trigger on. Deliberately not awaited: a kitchen bump must not wait
      // on a provider round trip (the same rule the outbox drain states for a
      // till close), and `notifyOrderReady` swallows and logs its own failures.
      // The send log's UNIQUE key is what makes this safe to fire twice.
      void notifyOrderReady({
        businessId: session.businessId,
        locationId: location.id,
        orderId,
      });
    }
  }
  return NextResponse.json({ ok: true });
});
