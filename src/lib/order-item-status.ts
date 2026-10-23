/**
 * Kitchen ticket status machine — pure functions.
 *
 * order_items.status flow (see migrations/0001_foundation.sql order_item_status enum):
 *   pending → sent → preparing → ready → served
 * with `voided` reachable from any non-served state. "Sent" is the moment an
 * item becomes a kitchen ticket line (sent_to_kitchen_at is set); the KDS only
 * ever shows sent/preparing/ready items. Bumping is kitchen-driven
 * (sent→preparing, preparing→ready); marking served is waiter/cashier-driven
 * (ready→served), once the food has actually left the pass.
 */
export type OrderItemStatus = "pending" | "sent" | "preparing" | "ready" | "served" | "voided";

const TRANSITIONS: Record<OrderItemStatus, OrderItemStatus[]> = {
  pending: ["sent", "voided"],
  sent: ["preparing", "voided"],
  preparing: ["ready", "voided"],
  ready: ["served", "voided"],
  served: [],
  voided: [],
};

export function canTransitionItemStatus(from: OrderItemStatus, to: OrderItemStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/** Kitchen (KDS "bump") may only move sent→preparing or preparing→ready. */
export function canKitchenBump(from: OrderItemStatus, to: OrderItemStatus): boolean {
  return (from === "sent" && to === "preparing") || (from === "preparing" && to === "ready");
}

/** Waiter/cashier may only mark a ready item as served (delivered to the table). */
export function canMarkServed(from: OrderItemStatus, to: OrderItemStatus): boolean {
  return from === "ready" && to === "served";
}

/** True once all non-voided food is ready/served; empty/all-voided orders never notify. */
export function isKitchenOrderReady(statuses: readonly OrderItemStatus[]): boolean {
  return statuses.length > 0 && statuses.some((status) => status !== "voided") &&
    statuses.every((status) => status === "ready" || status === "served" || status === "voided");
}

export const ORDER_ITEM_STATUS_LABELS: Record<OrderItemStatus, string> = {
  pending: "در انتظار",
  sent: "ارسال‌شده به آشپزخانه",
  preparing: "در حال آماده‌سازی",
  ready: "آماده",
  served: "سرو شده",
  voided: "باطل",
};

/** Default: a ticket flags as "running late" 10 minutes after being sent to the kitchen. */
export const DEFAULT_TICKET_AGING_MINUTES = 10;

/** Minutes elapsed since a ticket was sent to the kitchen, given "now" (both epoch ms). */
export function ticketAgeMinutes(sentAtMs: number, nowMs: number): number {
  return Math.max(0, (nowMs - sentAtMs) / 60_000);
}

export function isTicketLate(
  sentAtMs: number,
  nowMs: number,
  thresholdMinutes: number = DEFAULT_TICKET_AGING_MINUTES,
): boolean {
  return ticketAgeMinutes(sentAtMs, nowMs) >= thresholdMinutes;
}
