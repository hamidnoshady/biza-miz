import { query } from "./db";
/** Durable, multi-instance throttle shared by the register and test APIs.
 * It contains no endpoint/token material. A rejected request never sends. */
export async function notificationApiAllowed(
  businessId: string,
  userId: string,
  action: "register" | "test",
) {
  const { rowCount } = await query(
    `INSERT INTO notification_push_budgets(business_id,scope,next_at)
    VALUES ($1,$2,now()+interval '30 seconds') ON CONFLICT(business_id,scope) DO UPDATE
    SET next_at=EXCLUDED.next_at WHERE notification_push_budgets.next_at<=now() RETURNING scope`,
    [businessId, `api:${action}:${userId}`],
  );
  return !!rowCount;
}
export function objectBody(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
