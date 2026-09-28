import type { PoolClient } from "pg";

export interface LockedOpenOrder {
  id: string;
  status: "open";
  type: "dine_in" | "takeaway" | "delivery";
  customer_id: string | null;
  guest_count: number | null;
  subtotal: string;
  discount: string;
  discount_type: "percent" | "amount" | null;
  discount_value: string | null;
  service_charge: string;
  tax: string;
  total: string;
  note: string | null;
}

export type LockOpenOrderResult =
  | { ok: true; order: LockedOpenOrder }
  | { ok: false; error: "order_not_found"; status: 404 }
  | { ok: false; error: "order_not_open"; status: 409 };

/**
 * Transaction boundary for every mutation of an existing order.
 *
 * Call only after BEGIN and before locking inventory rows. PostgreSQL waits
 * here when checkout is in flight, so the losing mutation observes the final
 * order status and returns 409 without writing anything.
 */
export async function lockOpenOrder(
  client: PoolClient,
  locationId: string,
  orderId: string,
): Promise<LockOpenOrderResult> {
  const { rows } = await client.query<LockedOpenOrder & { status: string }>(
    `SELECT id, status, type, customer_id, guest_count, subtotal::text, discount::text, discount_type,
            discount_value::text, service_charge::text, tax::text, total::text, note
       FROM orders
      WHERE id = $1 AND location_id = $2
      FOR UPDATE`,
    [orderId, locationId],
  );
  const order = rows[0];
  if (!order) return { ok: false, error: "order_not_found", status: 404 };
  // `held` is an intentionally paused order, not a payable state. It remains
  // active for table/session occupancy, but must be resumed to `open` before
  // checkout so line edits, kitchen state and settlement cannot race.
  if (order.status !== "open") return { ok: false, error: "order_not_open", status: 409 };
  return { ok: true, order: order as LockedOpenOrder };
}
