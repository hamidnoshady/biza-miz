import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveActiveLocation } from "@/lib/setup-state";
import { broadcast } from "@/lib/realtime";
import {
  decideCafeOrderApproval,
  type CafeApprovalDecision,
} from "@/lib/cms/cafe-order-approval-service";

const isUuid = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v.trim());

/**
 * Staff decision on an incoming website café order: accept releases the held
 * lines into kitchen dispatch and queues `accepted` for CMS; reject records the
 * reason and queues `rejected` for CMS.
 */
export const POST = withTenantScope(async (
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) => {
  const { id } = await context.params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: "invalid_order_id" }, { status: 400 });
  }

  let body: { decision?: unknown; reason?: unknown };
  try {
    body = (await request.json()) as { decision?: unknown; reason?: unknown };
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const decision = body.decision;
  if (decision !== "accepted" && decision !== "rejected") {
    return NextResponse.json({ error: "invalid_decision" }, { status: 400 });
  }

  const permission =
    decision === "accepted" ? PERMISSIONS.ordersCreate : PERMISSIONS.ordersVoid;
  const guard = await requirePermission(permission);
  if (guard.error) return guard.error;
  const { session } = guard;

  const location = await resolveActiveLocation(session);
  if (!location) {
    return NextResponse.json({ error: "no_location" }, { status: 409 });
  }

  const result = await decideCafeOrderApproval({
    businessId: session.businessId,
    locationId: location.id,
    orderId: id,
    decision: decision as CafeApprovalDecision,
    actor: { userId: session.sub, role: session.role },
    reason: typeof body.reason === "string" ? body.reason : null,
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  if (result.changed) {
    broadcast(location.id, { type: "order.updated", orderId: id });
  }
  return NextResponse.json({
    orderId: id,
    decision: result.state,
    state: result.state,
    changed: result.changed,
    dispatchedItemIds: result.dispatchedItemIds,
  });
});
