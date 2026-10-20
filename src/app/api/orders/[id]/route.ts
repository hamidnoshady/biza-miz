import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getPool } from "@/lib/db";
import { recomputeOrderTotals } from "@/lib/order-totals";
import { getOrderDetail } from "@/lib/order-read-service";
import { normalizeDiscountInput } from "@/lib/order-discount-service";
import { checkTableSectionAuthorization } from "@/lib/floor";
import { resolveActiveLocation } from "@/lib/setup-state";
import { broadcast } from "@/lib/realtime";
import { lockOpenOrder } from "@/lib/order-lock";
import { ensureSessionForTable, releaseSessionIfIdle, releaseTableAfterOrderSettled } from "@/lib/table-session-service";
import { recordOrderState } from "@/lib/order-state-sync";
import { recordNotification } from "@/lib/notification-events";
import { notificationDedupeKey } from "@/lib/notifications";
import { tomanText } from "@/lib/ai-labels";
import { toPersianDigits } from "@/lib/digits";
import { discountPercentForControl, normalizeVoidReason } from "@/lib/order-controls";
import { enforceOrderControl, recordOrderAudit, type OrderActor } from "@/lib/order-control-service";
import { isUuid } from "@/lib/customer-return-domain";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorResponse(error: unknown): NextResponse | null {
  const message = error instanceof Error ? error.message : "";
  const status = typeof error === "object" && error !== null &&
    "status" in error && typeof error.status === "number"
    ? error.status
    : 0;
  if (status >= 400 && status < 500) return NextResponse.json({ error: message }, { status });
  return null;
}

export const GET = withTenantScope(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.ordersView);
  if (error) return error;
  const { id } = await context.params;
  if (!isUuid(id)) return NextResponse.json({ error: "invalid_order_id" }, { status: 400 });

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const detail = await getOrderDetail(location.id, id);
  if (!detail) return NextResponse.json({ error: "order_not_found" }, { status: 404 });
  return NextResponse.json(detail);
});

/** Update note/discount, customer/table or void an open order. */
export const PATCH = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.ordersCreate);
  if (error) return error;
  const { id } = await context.params;
  if (!isUuid(id)) return NextResponse.json({ error: "invalid_order_id" }, { status: 400 });

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!isRecord(rawBody) || Object.keys(rawBody).length === 0) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (rawBody.note !== undefined && rawBody.note !== null &&
      (typeof rawBody.note !== "string" || rawBody.note.length > 500)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (rawBody.customerId !== undefined && rawBody.customerId !== null && !isUuid(rawBody.customerId)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (rawBody.tableId !== undefined && rawBody.tableId !== null && !isUuid(rawBody.tableId)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (rawBody.discount !== undefined) {
    if (!isRecord(rawBody.discount) || !("type" in rawBody.discount) ||
        Object.keys(rawBody.discount).some((key) => key !== "type" && key !== "value")) {
      return NextResponse.json({ error: "invalid_discount" }, { status: 400 });
    }
    const discountType = rawBody.discount.type;
    const discountValue = rawBody.discount.value;
    if (discountType !== null && discountType !== "percent" && discountType !== "amount") {
      return NextResponse.json({ error: "invalid_discount" }, { status: 400 });
    }
    if ((discountValue !== undefined && typeof discountValue !== "number") ||
        (discountType === null && discountValue !== undefined)) {
      return NextResponse.json({ error: "invalid_discount" }, { status: 400 });
    }
    if (discountType !== null && (
      typeof discountValue !== "number" || !Number.isFinite(discountValue) || discountValue < 0 ||
      discountType === "percent" && discountValue > 100 ||
      discountType === "amount" && !Number.isSafeInteger(discountValue)
    )) {
      return NextResponse.json({ error: "invalid_discount" }, { status: 400 });
    }
  }
  if (rawBody.void !== undefined &&
      (!isRecord(rawBody.void) ||
       Object.keys(rawBody.void).some((key) => key !== "reason") ||
       Object.keys(rawBody).some((key) => key !== "void") ||
       (rawBody.void.reason !== undefined && typeof rawBody.void.reason !== "string"))) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const knownKeys = new Set(["note", "discount", "customerId", "tableId", "void"]);
  if (Object.keys(rawBody).some((key) => !knownKeys.has(key))) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const discountInput = rawBody.discount === undefined
    ? undefined
    : normalizeDiscountInput(rawBody.discount as { type?: "percent" | "amount" | null; value?: number });
  if (discountInput === null) {
    return NextResponse.json({ error: "invalid_discount" }, { status: 400 });
  }
  const body = rawBody as {
    note?: string | null;
    customerId?: string | null;
    tableId?: string | null;
    discount?: { type?: "percent" | "amount" | null; value?: number };
    void?: { reason?: string };
  };

  // Two dedicated authorities, enforced HERE rather than inherited from the
  // `orders.create` gate above (issue #913 item 3): touching the discount —
  // setting, editing or clearing it — needs `orders.discount`, and cancelling
  // the whole open bill needs `orders.void`. A direct HTTP call takes the
  // same route as the UI; `orders.create` on its own reaches neither.
  if (body.void !== undefined) {
    const voidGuard = await requirePermission(PERMISSIONS.ordersVoid);
    if (voidGuard.error) return voidGuard.error;
  }
  if (body.discount !== undefined) {
    const discountGuard = await requirePermission(PERMISSIONS.ordersDiscount);
    if (discountGuard.error) return discountGuard.error;
  }
  let voidReason: string | null = null;
  if (body.void) {
    try {
      voidReason = normalizeVoidReason(body.void.reason);
    } catch (caught) {
      return NextResponse.json({ error: caught instanceof Error ? caught.message : "void_reason_required" }, { status: 400 });
    }
  }

  let voided: { orderNumber: string; total: number } | null = null;
  // The session this patch freed — set only when voiding/moving/detaching
  // left the previous session with no active order (issue #913 item 6), and
  // broadcast after COMMIT exactly like the payment path does, so the floor
  // plan converges on the same occupancy model whatever released the table.
  let releasedSessionId: string | null = null;

  const client = await getPool().connect();
  const actor: OrderActor = { userId: session.sub, role: session.role, businessId: session.businessId };
  try {
    await client.query("BEGIN");
    const locked = await lockOpenOrder(client, location.id, id);
    if (!locked.ok) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: locked.error }, { status: locked.status });
    }

    const sectionCheckIds = [
      ...(locked.order.table_id ? [locked.order.table_id] : []),
      ...(body.tableId ? [String(body.tableId)] : []),
    ];
    if (sectionCheckIds.length > 0) {
      const sectionAuth = await checkTableSectionAuthorization(
        session,
        location.id,
        sectionCheckIds,
      );
      if (!sectionAuth.allowed) {
        await client.query("ROLLBACK");
        return NextResponse.json({ error: "section_not_assigned" }, { status: 403 });
      }
    }

    if (body.void) {
      await enforceOrderControl(client, { actor, locationId: location.id, orderId: id, action: "order_void" });
      const { rowCount, rows: voidedRows } = await client.query<{ order_number: string; total: string }>(
        `UPDATE orders SET status='voided', voided_reason=$2, closed_by=$3, closed_at=now()
          WHERE id=$1 AND status='open'
          RETURNING order_number::text AS order_number, total::text AS total`,
        [id, voidReason, session.sub],
      );
      if (rowCount !== 1) {
        await client.query("ROLLBACK");
        return NextResponse.json({ error: "order_not_open" }, { status: 409 });
      }
      voided = { orderNumber: voidedRows[0].order_number, total: Number(voidedRows[0].total) };
      await recordOrderAudit(client, {
        actor,
        locationId: location.id,
        action: "order.voided",
        entityType: "order",
        entityId: id,
        reason: voidReason,
        metadata: { orderNumber: voided.orderNumber, totalRial: voidedRows[0].total },
      });
      // Voiding an OPEN order ends its claim on the table when no other
      // open/held/completed order remains in that session (issue #913 item 6).
      if (locked.order.table_session_id) {
        const released = await releaseSessionIfIdle(
          client,
          location.id,
          locked.order.table_session_id,
          session.sub,
        );
        if (released) releasedSessionId = released.sessionId;
      }
    } else {
      if (discountInput !== undefined) {
        await enforceOrderControl(client, {
          actor,
          locationId: location.id,
          orderId: id,
          action: "discount",
          discountPercent: discountPercentForControl({
            type: discountInput.type,
            value: discountInput.type === null ? 0 : discountInput.value,
            subtotal: locked.order.subtotal,
          }),
        });
      }

      if (body.customerId !== undefined) {
        if (body.customerId) {
          const { rowCount } = await client.query(
            `SELECT 1 FROM parties WHERE id=$1 AND business_id=$2 AND is_active`,
            [body.customerId, session.businessId],
          );
          if (rowCount !== 1) {
            await client.query("ROLLBACK");
            return NextResponse.json({ error: "customer_not_found" }, { status: 404 });
          }
        }
        await client.query("UPDATE orders SET customer_id=$2 WHERE id=$1", [id, body.customerId || null]);
        await recordOrderAudit(client, {
          actor, locationId: location.id, action: "order.customer_changed", entityType: "order", entityId: id,
          metadata: { previousCustomerId: locked.order.customer_id, customerId: body.customerId || null },
        });
      }
      if (body.tableId !== undefined) {
        const normalizedTableId = body.tableId?.trim() || null;
        // The session this order is being taken OUT of — reconciled below,
        // after the row moves, so a last-order move A→B (and a plain detach)
        // frees A's session while a session with surviving orders stays open.
        const previousSessionId = locked.order.table_session_id;
        if (!normalizedTableId) {
          await client.query(`UPDATE orders SET table_id=NULL, table_session_id=NULL WHERE id=$1`, [id]);
          if (previousSessionId) {
            const released = await releaseSessionIfIdle(client, location.id, previousSessionId, session.sub);
            if (released) releasedSessionId = released.sessionId;
          }
        } else {
          const { rows: tableRows } = await client.query<{ id: string; status: string }>(
            `SELECT id, status FROM dining_tables WHERE id=$1 AND location_id=$2 AND is_active FOR UPDATE`,
            [normalizedTableId, location.id],
          );
          if (tableRows.length === 0) {
            await client.query("ROLLBACK");
            return NextResponse.json({ error: "table_not_found" }, { status: 404 });
          }
          if (tableRows[0].status === "cleaning" || tableRows[0].status === "out_of_service") {
            await client.query("ROLLBACK");
            return NextResponse.json({ error: "table_unavailable" }, { status: 409 });
          }
          const tableSessionId = await ensureSessionForTable(client, location.id, normalizedTableId, session.sub, locked.order.guest_count);
          await client.query(`UPDATE orders SET table_id=$2, table_session_id=$3 WHERE id=$1`, [id, normalizedTableId, tableSessionId]);
          if (previousSessionId && previousSessionId !== tableSessionId) {
            const released = await releaseSessionIfIdle(client, location.id, previousSessionId, session.sub);
            if (released) releasedSessionId = released.sessionId;
          }
        }
        await recordOrderAudit(client, {
          actor, locationId: location.id, action: "order.table_changed", entityType: "order", entityId: id,
          metadata: { tableId: normalizedTableId },
        });
      }
      if (body.note !== undefined) {
        await client.query("UPDATE orders SET note=$2 WHERE id=$1", [id, body.note?.trim() || null]);
        await recordOrderAudit(client, {
          actor, locationId: location.id, action: "order.note_changed", entityType: "order", entityId: id,
          metadata: { note: body.note?.trim() || null },
        });
      }
      if (discountInput !== undefined) {
        const totals = await recomputeOrderTotals(client, id, discountInput);
        await recordOrderAudit(client, {
          actor, locationId: location.id, action: "order.discount_changed", entityType: "order", entityId: id,
          metadata: {
            previousDiscountType: locked.order.discount_type,
            previousDiscountValue: locked.order.discount_value,
            discountType: discountInput.type,
            discountValue: discountInput.type === null ? 0 : discountInput.value,
            discountAmountRial: totals.discount,
            subtotalRial: totals.subtotal,
          },
        });
        await recordOrderState(client, { locationId: location.id, orderId: id, actor: { userId: session.sub, role: session.role } });
        await client.query("COMMIT");
        broadcast(location.id, { type: "order.updated", orderId: id });
        if (releasedSessionId) {
          broadcast(location.id, { type: "table_session.updated", sessionId: releasedSessionId });
        }
        return NextResponse.json({ ok: true, totals });
      }
    }
    await recordOrderState(client, { locationId: location.id, orderId: id, actor: { userId: session.sub, role: session.role } });
    await client.query("COMMIT");
  } catch (caught) {
    await client.query("ROLLBACK");
    const response = errorResponse(caught);
    if (response) return response;
    throw caught;
  } finally {
    client.release();
  }

  broadcast(location.id, { type: "order.updated", orderId: id });
  if (releasedSessionId) {
    broadcast(location.id, { type: "table_session.updated", sessionId: releasedSessionId });
  }

  if (voided) {
    try {
      await recordNotification({
        businessId: session.businessId,
        locationId: location.id,
        eventKey: "order.voided",
        severity: "important",
        title: `سفارش ${toPersianDigits(voided.orderNumber)} باطل شد`,
        body: `${tomanText(voided.total)}${voidReason ? ` — ${voidReason}` : ""}`,
        url: "/accounting/orders",
        amountRial: voided.total,
        dedupeKey: notificationDedupeKey("order.voided", id),
        payload: { orderId: id, orderNumber: voided.orderNumber },
      });
    } catch (notificationError) {
      console.error("order void notification failed:", notificationError);
    }
  }
  return NextResponse.json({ ok: true });
});
