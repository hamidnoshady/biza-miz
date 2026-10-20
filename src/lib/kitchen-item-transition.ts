import { query, withTenantTransaction } from "./db";
import { canKitchenBump, canMarkServed, type OrderItemStatus } from "./order-item-status";

export type KitchenItemTransitionResult =
  | { kind: "updated"; orderId: string }
  | { kind: "missing" }
  | { kind: "duplicate"; currentStatus: OrderItemStatus }
  | { kind: "conflict"; currentStatus: OrderItemStatus };

/**
 * The canonical CAS used by both online KDS/waiter actions and offline/hybrid
 * replay. The parent order and line are locked in one tenant transaction and
 * the status is compared again at the write boundary.
 */
export async function transitionKitchenItem(input: {
  businessId: string;
  locationId: string;
  itemId: string;
  to: "preparing" | "ready" | "served";
  mayBumpKitchen: boolean;
  mayServe: boolean;
  actorUserId: string;
}): Promise<KitchenItemTransitionResult> {
  return withTenantTransaction(
    input.businessId,
    async () => {
      const { rows } = await query<{
        id: string;
        status: OrderItemStatus;
        order_id: string;
      }>(
        `SELECT oi.id, oi.status, oi.order_id
           FROM order_items oi JOIN orders o ON o.id=oi.order_id
          WHERE oi.id=$1 AND oi.location_id=$2 AND o.location_id=$2
            AND o.status IN ('open','held','completed')
          FOR UPDATE OF o,oi`,
        [input.itemId, input.locationId],
      );
      const item = rows[0];
      if (!item) return { kind: "missing" } as const;
      if (item.status === input.to) {
        return { kind: "duplicate", currentStatus: item.status } as const;
      }

      if (
        !(input.mayBumpKitchen && canKitchenBump(item.status, input.to)) &&
        !(input.mayServe && canMarkServed(item.status, input.to))
      ) {
        return { kind: "conflict", currentStatus: item.status } as const;
      }

      const { rows: changed } = await query<{ id: string }>(
        `UPDATE order_items oi
            SET status=$3::order_item_status,
                ready_at=CASE WHEN $3::order_item_status='ready'::order_item_status
                              THEN now() ELSE ready_at END
          WHERE oi.id=$1 AND oi.location_id=$2 AND oi.status=$4
            AND EXISTS (SELECT 1 FROM orders o WHERE o.id=oi.order_id AND o.location_id=$2
                         AND o.status IN ('open','held','completed'))
          RETURNING oi.id`,
        [input.itemId, input.locationId, input.to, item.status],
      );
      if (!changed.length) {
        const { rows: current } = await query<{ status: OrderItemStatus }>(
          "SELECT status FROM order_items WHERE id=$1 AND location_id=$2",
          [input.itemId, input.locationId],
        );
        return current[0]
          ? ({ kind: "conflict", currentStatus: current[0].status } as const)
          : ({ kind: "missing" } as const);
      }
      return { kind: "updated", orderId: item.order_id } as const;
    },
    { locationId: input.locationId, userId: input.actorUserId },
  );
}
