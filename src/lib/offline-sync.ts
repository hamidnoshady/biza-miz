import { canKitchenBump, canMarkServed, type OrderItemStatus } from "./order-item-status";
import { PERMISSIONS, type Permission } from "./permissions";

export type StatusReplayOutcome = "apply" | "duplicate" | "conflict";

/** Match each queued operation to the same capability used by its online route. */
export function replayPermissionsFor(
  eventType: string,
  status?: string,
): Permission[] | null {
  if (eventType === "order.create" || eventType === "order.add_items") {
    return [PERMISSIONS.ordersCreate];
  }
  if (eventType === "order_item.status") {
    if (status === "voided") return [PERMISSIONS.ordersVoidItem];
    if (status === "served") return [PERMISSIONS.ordersView];
    if (status === "preparing" || status === "ready") return [PERMISSIONS.kitchenView];
  }
  return null;
}

/**
 * Decide whether an already-authorized kitchen/serving action is still legal
 * against the latest persisted state. Authorization is resolved separately by
 * authorizeSyncReplay(); this state-machine helper intentionally knows no
 * roles, names, or event-registry permission aliases.
 */
export function classifyStatusReplay(
  current: OrderItemStatus,
  requested: OrderItemStatus,
  mayBumpKitchen: boolean,
  mayServe: boolean,
): StatusReplayOutcome {
  if (current === requested) return "duplicate";
  const canBump = mayBumpKitchen && canKitchenBump(current, requested);
  const canServeItem = mayServe && canMarkServed(current, requested);
  return canBump || canServeItem ? "apply" : "conflict";
}
