import type { PoolClient } from "pg";
import type { Role } from "./auth";
import {
  assertOrderControl,
  isManagerRole,
  parseOrderControlPolicy,
  type ControlledOrderAction,
} from "./order-controls";

export interface OrderActor {
  userId: string | null;
  role: Role;
  businessId: string;
}

export async function enforceOrderControl(
  client: PoolClient,
  input: {
    actor: OrderActor;
    locationId: string;
    orderId: string;
    action: ControlledOrderAction;
    discountPercent?: number;
  },
): Promise<void> {
  // A branch override wins; the business-wide control is the fallback. Keep
  // both reads on the caller's transaction client so the policy check and the
  // mutation commit or roll back together.
  const { rows: settings } = await client.query<{ value: unknown }>(
    `SELECT value FROM settings
      WHERE business_id = $1 AND key = 'orders.controls'
        AND (location_id = $2 OR location_id IS NULL)
      ORDER BY (location_id = $2) DESC
      LIMIT 1`,
    [input.actor.businessId, input.locationId],
  );
  const { rows: kitchen } = await client.query<{ kitchen_started: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM order_items
        WHERE order_id = $1
          AND status <> 'voided'
          AND (status IN ('sent', 'preparing', 'ready', 'served') OR sent_to_kitchen_at IS NOT NULL)
     ) AS kitchen_started`,
    [input.orderId],
  );
  assertOrderControl({
    policy: parseOrderControlPolicy(settings[0]?.value),
    actorRole: input.actor.role,
    action: input.action,
    discountPercent: input.discountPercent,
    kitchenStarted: kitchen[0]?.kitchen_started ?? false,
  });
}

export async function recordOrderAudit(
  client: PoolClient,
  input: {
    actor: OrderActor;
    locationId: string;
    action: string;
    entityType: "order" | "order_item";
    entityId: string;
    reason?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  // The tenant audit schema is audit_log(business_id, location_id, user_id,
  // action, entity, entity_id, payload). `audit_events` is not a tenant table.
  await client.query(
    `INSERT INTO audit_log
       (business_id, location_id, user_id, action, entity, entity_id, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      input.actor.businessId,
      input.locationId,
      input.actor.userId,
      input.action,
      input.entityType,
      input.entityId,
      JSON.stringify({
        ...input.metadata,
        reason: input.reason ?? null,
        actorRole: input.actor.role,
        managerAuthorizedBy: isManagerRole(input.actor.role) ? input.actor.userId : null,
      }),
    ],
  );
}
