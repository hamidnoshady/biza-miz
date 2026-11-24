import type { PoolClient } from "pg";
import { query, withoutTenantScope, withTenant } from "./db";

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

/** Archive kitchen lines when the branch enters its next configured business day. */
export async function archivePastKitchenTickets(
  businessId: string,
  locationId: string | null = null,
  client?: Pick<PoolClient, "query">,
): Promise<void> {
  const sql = `UPDATE order_items oi
        SET kitchen_archived_at = now(), kitchen_archive_reason = 'business_day'
       FROM orders o JOIN locations l ON l.id = o.location_id
      WHERE l.business_id = $1
        AND ($2::uuid IS NULL OR l.id = $2)
        AND oi.location_id = l.id AND oi.order_id = o.id
        AND o.status IN ('open', 'held', 'completed')
        AND (o.website_approval_state IS NULL OR o.website_approval_state = 'accepted')
        AND oi.status IN ('sent', 'preparing', 'ready')
        AND oi.kitchen_archived_at IS NULL
        AND COALESCE(oi.sent_to_kitchen_at, o.opened_at)
          < app_business_day_start(now(), l.timezone, l.business_day_start_minutes)`;
  const params = [businessId, locationId];
  if (client) await client.query(sql, params);
  else await query(sql, params);
}

let archiveInFlight = false;

/** The scheduler enumerates tenant IDs only. Each update runs under tenant RLS. */
export async function runKitchenArchiveTick(): Promise<void> {
  if (archiveInFlight) return;
  archiveInFlight = true;
  try {
    const { rows } = await withoutTenantScope("platform", () =>
      query<{ id: string }>("SELECT id FROM businesses WHERE status = 'active' ORDER BY id"),
    );
    for (const { id } of rows) {
      try {
        await withTenant(id, () => archivePastKitchenTickets(id));
      } catch (error) {
        console.error("Kitchen archive failed for business", id, error);
      }
    }
  } finally {
    archiveInFlight = false;
  }
}
