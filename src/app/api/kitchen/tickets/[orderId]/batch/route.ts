import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveActiveLocation } from "@/lib/setup-state";
import {
  transitionKitchenTicketBatch,
  type KitchenBatchTargetStatus,
} from "@/lib/kitchen-item-transition";
import { announceKitchenOrderReady } from "@/lib/kitchen-order-ready";
import { broadcast } from "@/lib/realtime";

const UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const MAX_SELECTED_ITEMS = 100;

/**
 * Ticket-wide kitchen fulfillment: `Start all` (sent → preparing) and
 * `Mark all ready` (preparing → ready).
 *
 * It is intentionally separate from the single-line PATCH and from serving:
 * only `kitchen.view` may request it, the service re-checks every line, and
 * served/voided/pending lines can never be advanced. A partial batch answers
 * 200 with per-line results — never a blanket success.
 */
export const POST = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ orderId: string }> }) => {
    const { orderId } = await context.params;
    if (!UUID_PATTERN.test(orderId)) {
      return NextResponse.json({ error: "ticket_not_found" }, { status: 404 });
    }

    const { session, error } = await requirePermission(PERMISSIONS.kitchenView);
    if (error) return error;

    const location = await resolveActiveLocation(session);
    if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

    let body: { status?: unknown; itemIds?: unknown } | null;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }

    const status = body?.status;
    if (status !== "preparing" && status !== "ready") {
      return NextResponse.json({ error: "invalid_status" }, { status: 400 });
    }
    const to: KitchenBatchTargetStatus = status;

    const rawItemIds = body?.itemIds;
    let itemIds: string[] | undefined;
    if (rawItemIds !== undefined) {
      if (
        !Array.isArray(rawItemIds) ||
        rawItemIds.length === 0 ||
        rawItemIds.length > MAX_SELECTED_ITEMS ||
        !rawItemIds.every((id) => typeof id === "string" && UUID_PATTERN.test(id))
      ) {
        return NextResponse.json({ error: "invalid_items" }, { status: 400 });
      }
      itemIds = [...new Set(rawItemIds)];
    }

    const result = await transitionKitchenTicketBatch({
      businessId: session.businessId,
      locationId: location.id,
      orderId,
      to,
      itemIds,
      mayBumpKitchen: true,
      actorUserId: session.sub,
      syncActor: { userId: session.sub, role: session.role },
    });

    if (result.kind === "forbidden") {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    if (result.kind === "missing_order") {
      return NextResponse.json({ error: "ticket_not_found" }, { status: 404 });
    }

    // Commit already happened; these are post-commit fan-outs only.
    for (const itemId of result.appliedItemIds) {
      broadcast(location.id, { type: "order.item_status", orderId, itemId, status: to });
    }
    if (to === "ready" && result.appliedItemIds.length > 0) {
      await announceKitchenOrderReady({
        businessId: session.businessId,
        locationId: location.id,
        orderId,
      });
    }

    return NextResponse.json({
      ok: true,
      orderId: result.orderId,
      requestedStatus: result.requestedStatus,
      items: result.items,
      summary: result.summary,
    });
  },
);
