import type { PoolClient } from "pg";
import { query } from "./db";

export type KitchenWorkflow = "kitchen_team" | "manage_from_orders" | "ready_on_send";

export function isKitchenWorkflow(value: unknown): value is KitchenWorkflow {
  return value === "kitchen_team" || value === "manage_from_orders" || value === "ready_on_send";
}

export async function getKitchenWorkflow(
  businessId: string,
  locationId: string,
  client?: Pick<PoolClient, "query">,
): Promise<KitchenWorkflow> {
  const sql = "SELECT value FROM settings WHERE business_id = $1 AND location_id = $2 AND key = 'kitchen.workflow'";
  const result = client
    ? await client.query<{ value: unknown }>(sql, [businessId, locationId])
    : await query<{ value: unknown }>(sql, [businessId, locationId]);
  const value = result.rows[0]?.value;
  return isKitchenWorkflow(value) ? value : "kitchen_team";
}

/** Caller owns the order lock so payment and the final ready item converge. */
export async function archivePaidKitchenTicket(
  client: Pick<PoolClient, "query">,
  locationId: string,
  orderId: string,
): Promise<void> {
  await client.query(
    `UPDATE order_items oi
        SET kitchen_archived_at = now(), kitchen_archive_reason = 'paid'
       FROM orders o JOIN locations l ON l.id = o.location_id
      WHERE o.id = $2 AND o.location_id = $1 AND oi.location_id = l.id
        AND oi.order_id = o.id AND oi.status = 'ready' AND oi.kitchen_archived_at IS NULL
        AND o.status = 'completed'
        AND (o.website_approval_state IS NULL OR o.website_approval_state = 'accepted')
        AND EXISTS (
          SELECT 1 FROM settings s WHERE s.business_id = l.business_id
            AND s.location_id = l.id AND s.key = 'kitchen.clearAfterPayment' AND s.value = 'true'::jsonb
        )
        AND NOT EXISTS (
          SELECT 1 FROM order_items other WHERE other.order_id = o.id AND other.location_id = l.id
            AND other.status IN ('pending', 'sent', 'preparing') AND other.kitchen_archived_at IS NULL
        )
        AND COALESCE((
          SELECT SUM(p.amount) FROM payments p WHERE p.order_id = o.id
           AND p.location_id = l.id AND p.method <> 'credit'
        ), 0) >= o.total + COALESCE(o.tip_amount, 0)`,
    [locationId, orderId],
  );
}
