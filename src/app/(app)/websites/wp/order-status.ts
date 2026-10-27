/**
 * How a WooCommerce order status reads on screen, shared by the orders list
 * and the order modal so a status is never spelled two ways.
 *
 * WooCommerce's seven canonical statuses have fixed Persian labels. A store
 * can register its own (`shipped`, `awaiting-pickup`, …): those arrive as a
 * bare slug, so they are shown as that slug made readable rather than hidden
 * behind «وضعیت نامشخص» — the owner named the status, the owner will
 * recognise it.
 */
export const ORDER_STATUS_LABELS: Record<string, string> = {
  pending: "در انتظار پرداخت",
  processing: "در حال پردازش",
  "on-hold": "معلق",
  completed: "تکمیل‌شده",
  cancelled: "لغو شده",
  refunded: "برگشت خورده",
  failed: "ناموفق",
};

export const CANONICAL_ORDER_STATUSES = Object.keys(ORDER_STATUS_LABELS);

export type OrderBadgeTone = "active" | "positive" | "neutral" | "danger";

export function orderStatusLabel(status: string): string {
  if (!status) return "وضعیت نامشخص";
  return ORDER_STATUS_LABELS[status] ?? status.replace(/^wc-/, "").replace(/[-_]+/g, " ");
}

export function orderStatusTone(status: string): OrderBadgeTone {
  if (status === "completed") return "positive";
  if (status === "pending" || status === "processing" || status === "on-hold") return "active";
  if (status === "cancelled" || status === "refunded" || status === "failed") return "danger";
  return "neutral";
}

/**
 * The statuses an order can be moved to: the seven canonical ones, then any
 * custom status the store has used. The server accepts a custom slug only
 * when the store already reported it, so this list offers nothing it refuses.
 */
export function orderStatusChoices(storeStatuses: readonly string[]): string[] {
  const custom = storeStatuses.filter((status) => status && !(status in ORDER_STATUS_LABELS));
  return [...CANONICAL_ORDER_STATUSES, ...custom];
}
