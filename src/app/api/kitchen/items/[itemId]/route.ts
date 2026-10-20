import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { query, withTenantTransaction } from "@/lib/db";
import { resolveActiveLocation } from "@/lib/setup-state";
import { canKitchenBump, canMarkServed, type OrderItemStatus } from "@/lib/order-item-status";
import { broadcast } from "@/lib/realtime";
import { recordCoworkerEvent } from "@/lib/ai-coworker-events";
import { recordOrderStateStandalone } from "@/lib/order-state-sync";

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

  // Serialize against void/pay/other-device mutations by locking the parent
  // order and line in one tenant-scoped transaction. The compare-and-set is
  // repeated at the write boundary so even a stale status cannot be replayed.
  const mutation = await withTenantTransaction(
    session.businessId,
    async () => {
      const { rows } = await query<{ id: string; status: OrderItemStatus; order_id: string }>(
        `SELECT oi.id, oi.status, oi.order_id
           FROM order_items oi JOIN orders o ON o.id = oi.order_id
          WHERE oi.id = $1 AND oi.location_id = $2 AND o.location_id = $2
            AND o.status IN ('open', 'held', 'completed')
          FOR UPDATE OF o, oi`,
        [itemId, location.id],
      );
      const item = rows[0];
      if (!item) return { kind: "missing" as const };

      const canKitchen = Boolean(sessionForKitchen) && canKitchenBump(item.status, to);
      const canServe = Boolean(sessionForServing) && canMarkServed(item.status, to);
      if (!canKitchen && !canServe) {
        return { kind: "conflict" as const, currentStatus: item.status };
      }

      const { rows: changed } = await query<{ id: string }>(
        `UPDATE order_items oi
            SET status = $3, ready_at = CASE WHEN $3 = 'ready' THEN now() ELSE ready_at END
          WHERE oi.id = $1 AND oi.location_id = $2 AND oi.status = $4
            AND EXISTS (
              SELECT 1 FROM orders o
               WHERE o.id = oi.order_id AND o.location_id = $2
                 AND o.status IN ('open', 'held', 'completed')
            )
          RETURNING oi.id`,
        [itemId, location.id, to, item.status],
      );
      if (!changed.length) {
        const { rows: current } = await query<{ status: OrderItemStatus }>(
          `SELECT oi.status FROM order_items oi
            WHERE oi.id = $1 AND oi.location_id = $2`,
          [itemId, location.id],
        );
        return current[0]
          ? { kind: "conflict" as const, currentStatus: current[0].status }
          : { kind: "missing" as const };
      }
      return { kind: "updated" as const, orderId: item.order_id };
    },
    { locationId: location.id, userId: session.sub },
  );

  if (mutation.kind === "missing") {
    return NextResponse.json({ error: "item_not_found" }, { status: 404 });
  }
  if (mutation.kind === "conflict") {
    return NextResponse.json(
      { error: "stale_status", currentStatus: mutation.currentStatus },
      { status: 409 },
    );
  }
  const orderId = mutation.orderId;

  broadcast(location.id, { type: "order.item_status", orderId, itemId, status: to });
  // The paired peer's kitchen screen follows the same ticket.
  await recordOrderStateStandalone({
    locationId: location.id,
    orderId,
    actor: { userId: session.sub, role: session.role },
  });
  if (to === "ready") {
    // A multi-line ticket is ready only when its final unserved line is ready.
    // The event has a stable order key, so a retry/second terminal line remains
    // one customer event and therefore one coworker run/campaign.
    const { rows: readyOrders } = await query<{ customer_id: string }>(
      `SELECT o.customer_id FROM orders o
        WHERE o.id = $1 AND o.customer_id IS NOT NULL
          AND o.status IN ('open', 'held', 'completed')
          AND NOT EXISTS (SELECT 1 FROM order_items oi
                           WHERE oi.order_id = o.id AND oi.status NOT IN ('ready', 'served', 'voided'))`,
      [orderId],
    );
    if (readyOrders[0]) {
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
    }
  }
  return NextResponse.json({ ok: true });
});
