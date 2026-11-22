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
