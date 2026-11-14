/**
 * ESH-146 (biza-miz#1304) — `POST /api/orders/[id]/website-approval`.
 *
 * The staff decision on a website café order. Approval state is its own state
 * machine (`pending` → `accepted` | `rejected`), deliberately separate from
 * `orders.status` and from payment: a paid order can still be rejected (and
 * then follows the ordinary refund flow), and a pay-at-counter order is
 * accepted while it is still unpaid.
 *
 * Permissions follow what the act *is*:
 *
 *   - accept (`orders.create`) — the same authority that may ring a sale into
 *     this branch, because accepting releases the order to the kitchen;
 *   - reject (`orders.void`) — cancelling a sale a customer has already placed.
 *
 * The decision is durable: it is recorded on the order, an outbox row is
 * written for the CMS (ESH-148 delivers it) and the audit log names the actor
 * and reason.
 */
import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveActiveLocation } from "@/lib/setup-state";
import { broadcast } from "@/lib/realtime";
import {
  decideCafeOrderApproval,
  type CafeApprovalDecision,
} from "@/lib/cms/cafe-order-approval-service";

const isUuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim());

export const POST = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { id } = await context.params;
    if (!isUuid(id)) return NextResponse.json({ error: "invalid_order_id" }, { status: 400 });

    let body: { decision?: unknown; reason?: unknown };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }

    const decision = body.decision;
    if (decision !== "accepted" && decision !== "rejected") {
      return NextResponse.json({ error: "invalid_decision" }, { status: 400 });
    }

    const permission = decision === "accepted" ? PERMISSIONS.ordersCreate : PERMISSIONS.ordersVoid;
    const guard = await requirePermission(permission);
    if (guard.error) return guard.error;
    const { session } = guard;

    const location = await resolveActiveLocation(session);
    if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

    const result = await decideCafeOrderApproval({
      businessId: session.businessId,
      locationId: location.id,
      orderId: id,
      decision: decision as CafeApprovalDecision,
      actor: { userId: session.sub, role: session.role },
      reason: typeof body.reason === "string" ? body.reason : null,
    });

    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });

    // The queue lives on the orders screen; a decision must leave it without a
    // reload, on every open till in the branch.
    broadcast(location.id, { type: "order.updated", orderId: id });
    return NextResponse.json({
      status: result.state,
      changed: result.changed,
      dispatchedItemIds: result.dispatchedItemIds,
    });
  },
);
