import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveActiveLocation } from "@/lib/setup-state";
import { type OrderItemStatus } from "@/lib/order-item-status";
import { transitionKitchenItem } from "@/lib/kitchen-item-transition";
import { announceKitchenOrderReady } from "@/lib/kitchen-order-ready";
import { broadcast } from "@/lib/realtime";

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
    // Shared with the ticket-wide batch route so both paths use the same
    // dedupe keys and notification policy.
    await announceKitchenOrderReady({
      businessId: session.businessId,
      locationId: location.id,
      orderId,
    });
  }
  return NextResponse.json({ ok: true });
});
