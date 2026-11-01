/**
 * How a WooCommerce order status reads on screen, shared by the orders list,
 * the order modal and the picker so a status is never spelled two ways.
 *
 * Issue #1215 / P1‑3 changed what a label is allowed to be:
 *
 *  1. **The store's own name first.** The plugin reports
 *     `wc_get_order_statuses()` (`registeredOrderStatuses`), so a custom status
 *     shows the display name the owner gave it («ارسال شد»), not a slug.
 *  2. **Then the seven canonical Persian labels** — they are fixed and known.
 *  3. **Otherwise the raw slug, clearly marked.** It used to be prettified
 *     (`awaiting-pickup` → «awaiting pickup»), which *looked* like a name the
 *     store had given it. Now it is shown verbatim (LTR) and the badge says the
 *     name could not be read, so nobody mistakes a guess for the store's word.
 *
 * `wc-` is stripped everywhere (`wc-processing` and `processing` are the same
 * status; WooCommerce itself uses both spellings), and the picker offers the
 * canonical statuses plus the ones *this* store registered or already used —
 * never a status it would refuse.
 */
import {
  normalizeOrderStatusSlug,
  registeredOrderStatuses,
} from "@/lib/integrations/plugin-capabilities";

/** The seven statuses every WooCommerce store has, in the order the picker offers them. */
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

/** The registered registry as a lookup, from the connection's capability blob. */
export function orderStatusRegistry(
  capabilities: Record<string, unknown> | null | undefined,
): ReadonlyMap<string, string> {
  return new Map(registeredOrderStatuses(capabilities).map((entry) => [entry.slug, entry.label]));
}

/**
 * Whether a status has a *real* name — the store's registered label or one of
 * the seven canonical ones. False means the label below is a raw slug.
 */
export function orderStatusNamed(
  status: string,
  registry: ReadonlyMap<string, string> | null = null,
): boolean {
  const slug = normalizeOrderStatusSlug(status);
  if (!slug) return false;
  return Boolean(registry?.get(slug)) || slug in ORDER_STATUS_LABELS;
}

export function orderStatusLabel(status: string, registry: ReadonlyMap<string, string> | null = null): string {
  const slug = normalizeOrderStatusSlug(status);
  if (!slug) return "وضعیت نامشخص";
  return registry?.get(slug) ?? ORDER_STATUS_LABELS[slug] ?? slug;
}

export function orderStatusTone(status: string): OrderBadgeTone {
  const slug = normalizeOrderStatusSlug(status);
  if (slug === "completed") return "positive";
  if (slug === "pending" || slug === "processing" || slug === "on-hold") return "active";
  if (slug === "cancelled" || slug === "refunded" || slug === "failed") return "danger";
  return "neutral";
}

/**
 * The statuses an order of *this* store can be moved to: the seven canonical
 * ones, then the store's registered custom statuses, then any custom status it
 * has already used on an order. The server accepts exactly this union
 * (`sanitizeOrderStatus` with the registered registry), so the picker never
 * offers something the API would refuse.
 */
export function orderStatusChoices(
  storeStatuses: readonly string[],
  registry: ReadonlyMap<string, string> | null = null,
): string[] {
  const seen = new Set(CANONICAL_ORDER_STATUSES);
  const out = [...CANONICAL_ORDER_STATUSES];
  const push = (value: string) => {
    const slug = normalizeOrderStatusSlug(value);
    if (!slug || seen.has(slug)) return;
    seen.add(slug);
    out.push(slug);
  };
  for (const slug of registry?.keys() ?? []) push(slug);
  for (const slug of storeStatuses) push(slug);
  return out;
}
