import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getPool } from "@/lib/db";
import { recomputeOrderTotals } from "@/lib/order-totals";
import { getOrderDetail } from "@/lib/order-read-service";
import { normalizeDiscountInput } from "@/lib/order-discount-service";
import { resolveActiveLocation } from "@/lib/setup-state";
import { broadcast } from "@/lib/realtime";
import { lockOpenOrder } from "@/lib/order-lock";
import { ensureSessionForTable } from "@/lib/table-session-service";
import { recordOrderState } from "@/lib/order-state-sync";
import { recordNotification } from "@/lib/notification-events";
import { notificationDedupeKey } from "@/lib/notifications";
import { tomanText } from "@/lib/ai-labels";
import { toPersianDigits } from "@/lib/digits";

export const GET = withTenantScope(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.ordersView);
  if (error) return error;
  const { id } = await context.params;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const detail = await getOrderDetail(location.id, id);
  if (!detail) return NextResponse.json({ error: "order_not_found" }, { status: 404 });
  return NextResponse.json(detail);
});

interface PatchBody {
  note?: string;
  discount?: { type?: "percent" | "amount" | null; value?: number };
  customerId?: string | null;
  tableId?: string | null;
  void?: { reason?: string };
}

/** Update note/discount, or void the whole order — only while status = 'open'. */
export const PATCH = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.ordersCreate);
  if (error) return error;
  const { id } = await context.params;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  let body: PatchBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const discountInput = body.discount === undefined ? undefined : normalizeDiscountInput(body.discount);
  if (discountInput === null) {
    return NextResponse.json({ error: "invalid_discount" }, { status: 400 });
  }

  // Captured inside the transaction, notified after it commits: a void that
  // rolls back must not have produced a notification about a bill that is still
  // open. See recordNotification for why the enqueue itself cannot fail this.
  let voided: { orderNumber: string; total: number } | null = null;

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const locked = await lockOpenOrder(client, location.id, id);
    if (!locked.ok) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: locked.error }, { status: locked.status });
    }

    if (body.void) {
      const { rowCount, rows: voidedRows } = await client.query<{ order_number: string; total: string }>(
        `UPDATE orders SET status = 'voided', voided_reason = $2, closed_by = $3, closed_at = now()
          WHERE id = $1 AND status = 'open'
          RETURNING order_number::text AS order_number, total::text AS total`,
        [id, body.void.reason?.trim() || null, session.sub],
      );
      if (rowCount !== 1) {
        await client.query("ROLLBACK");
        return NextResponse.json({ error: "order_not_open" }, { status: 409 });
      }
      voided = { orderNumber: voidedRows[0].order_number, total: Number(voidedRows[0].total) };
    } else {
      if (body.customerId !== undefined) {
        if (body.customerId) {
          const { rowCount } = await client.query(
            `SELECT 1 FROM parties WHERE id = $1 AND business_id = $2 AND is_active`,
            [body.customerId, session.businessId],
          );
          if (rowCount !== 1) {
            await client.query("ROLLBACK");
            return NextResponse.json({ error: "customer_not_found" }, { status: 404 });
          }
        }
        await client.query("UPDATE orders SET customer_id = $2 WHERE id = $1", [id, body.customerId || null]);
      }
      if (body.tableId !== undefined) {
        const rawTableId = (body.tableId as unknown as string | null) ?? null;
        const normalizedTableId = typeof rawTableId === "string" ? rawTableId.trim() : rawTableId;
        if (!normalizedTableId) {
          await client.query(`UPDATE orders SET table_id = NULL, table_session_id = NULL WHERE id = $1`, [id]);
        } else {
          const { rows: tableRows } = await client.query<{ id: string; status: string }>(
            `SELECT id, status FROM dining_tables WHERE id = $1 AND location_id = $2 AND is_active FOR UPDATE`,
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
          await client.query(
            `UPDATE orders SET table_id = $2, table_session_id = $3 WHERE id = $1`,
            [id, normalizedTableId, tableSessionId],
          );
        }
      }
      if (body.note !== undefined) {
        await client.query("UPDATE orders SET note = $2 WHERE id = $1", [id, body.note?.trim() || null]);
      }
      if (discountInput !== undefined) {
        const totals = await recomputeOrderTotals(client, id, discountInput);
        await recordOrderState(client, { locationId: location.id, orderId: id, actor: { userId: session.sub, role: session.role } });
        await client.query("COMMIT");
        broadcast(location.id, { type: "order.updated", orderId: id });
        return NextResponse.json({ ok: true, totals });
      }
    }
    // The void, customer, table or note change travels to the paired peer
    // with the rest of the bill (order-state-sync.ts), atomically with it.
    await recordOrderState(client, { locationId: location.id, orderId: id, actor: { userId: session.sub, role: session.role } });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  broadcast(location.id, { type: "order.updated", orderId: id });

  if (voided) {
    await recordNotification({
      businessId: session.businessId,
      locationId: location.id,
      eventKey: "order.voided",
      severity: "important",
      title: `سفارش ${toPersianDigits(voided.orderNumber)} باطل شد`,
      body: `${tomanText(voided.total)}${body.void?.reason?.trim() ? ` — ${body.void.reason.trim()}` : ""}`,
      url: "/accounting/orders",
      // The amount is what an owner's «فقط ابطال‌های بزرگ» threshold is
      // compared against (notification_rules.min_amount_rial).
      amountRial: voided.total,
      dedupeKey: notificationDedupeKey("order.voided", id),
      payload: { orderId: id, orderNumber: voided.orderNumber },
    });
  }
  return NextResponse.json({ ok: true });
});
