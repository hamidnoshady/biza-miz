import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getPool } from "@/lib/db";
import { resolveActiveLocation } from "@/lib/setup-state";
import { isUuid } from "@/lib/customer-return-domain";
import { recordOrderState } from "@/lib/order-state-sync";
import { recordOrderAudit, type OrderActor } from "@/lib/order-control-service";
import { broadcast } from "@/lib/realtime";

/** Resume an intentionally held order so it returns to the live queue. */
export const POST = withTenantScope(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.ordersCreate);
  if (error) return error;
  const { id } = await context.params;
  if (!isUuid(id)) return NextResponse.json({ error: "invalid_order_id" }, { status: 400 });

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });
  const client = await getPool().connect();
  const actor: OrderActor = { userId: session.sub, role: session.role, businessId: session.businessId };
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ status: string; order_number: string }>(
      `SELECT status, order_number::text FROM orders
        WHERE id=$1 AND location_id=$2 FOR UPDATE`,
      [id, location.id],
    );
    const order = rows[0];
    if (!order) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "order_not_found" }, { status: 404 });
    }
    if (order.status !== "held") {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "order_not_held" }, { status: 409 });
    }
    await client.query("UPDATE orders SET status='open' WHERE id=$1 AND location_id=$2 AND status='held'", [id, location.id]);
    await recordOrderAudit(client, {
      actor,
      locationId: location.id,
      action: "order.resumed",
      entityType: "order",
      entityId: id,
      metadata: { orderNumber: order.order_number },
    });
    await recordOrderState(client, {
      locationId: location.id,
      orderId: id,
      actor: { userId: session.sub, role: session.role },
    });
    await client.query("COMMIT");
    broadcast(location.id, { type: "order.updated", orderId: id });
    return NextResponse.json({ ok: true });
  } catch (caught) {
    await client.query("ROLLBACK").catch(() => undefined);
    console.error("held order resume failed:", caught);
    return NextResponse.json({ error: "order_resume_failed" }, { status: 500 });
  } finally {
    client.release();
  }
});
