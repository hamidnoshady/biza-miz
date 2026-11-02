/**
 * Issue #1207 §A — the one action a product row may offer, and why it is
 * named the way it is.
 *
 * The list used to show one control, «انتشار / پیوند فروشگاه», on every
 * eligible row. That name was wrong in both directions: a row already linked
 * to a store is not being published, and nothing about it was automatic — the
 * click opens a review, the review sends a queued change, and the store's
 * acknowledgement is what links or updates anything. Owner evidence on
 * 2026-10-31: two Gliss rows with SKU `zza05023`, one linked to WooCommerce and
 * one «بدون پیوند ووکامرس», both carrying the same verbose control.
 *
 * So the label is derived, not hard-coded (framework-free and DB-free, per
 * repo convention, so the unit suite can pin every branch):
 *
 *  - a row with a store mapping anywhere ⇒ «به‌روزرسانی دستی» (short
 *    «به‌روزرسانی»): a manual review-and-send. Automatic stock/price sync is
 *    asynchronous and independent of this button — the copy says so;
 *  - a row no store owns ⇒ «انتشار در فروشگاه», with «پیوند به محصول موجود»
 *    as the optional alternative, never the word "update";
 *  - a row flagged as a probable duplicate ⇒ «بررسی محصول تکراری» before any
 *    new publication, so the screen cannot manufacture a third twin.
 */
import type { ProductWooLink } from "@/lib/integrations/product-links-service";

/**
 * One store's delivery health, as a badge states it. `acknowledged` is the
 * store's own confirmation of the newest outbound change — deliberately a
 * different word from `linked`, because a mapping alone is not a delivery.
 */
export type StoreLinkState = "linked" | "acknowledged" | "queued" | "failed" | "paused";

/**
 * Which state a mapping is in. A failure anywhere (the connection itself, or
 * the newest outbound delivery) outranks a queued one: the reader needs the
 * thing that needs them, not the thing that is merely in flight.
 */
export function storeLinkState(link: Pick<ProductWooLink, "connectionStatus" | "lastOutboundStatus">): StoreLinkState {
  if (link.connectionStatus === "error" || link.lastOutboundStatus === "failed" || link.lastOutboundStatus === "dead") {
    return "failed";
  }
  if (link.connectionStatus === "paused") return "paused";
  if (link.lastOutboundStatus === "pending" || link.lastOutboundStatus === "processing") return "queued";
  if (link.lastOutboundStatus === "sent") return "acknowledged";
  return "linked";
}

/** The badge text for one store's state — the same words the list always used. */
export const STORE_LINK_STATE_LABEL: Record<StoreLinkState, string> = {
  linked: "متصل",
  acknowledged: "ارسال تأیید شد",
  queued: "در صف ارسال",
  failed: "نیازمند بررسی",
  paused: "اتصال متوقف",
};

/** The badge tone for one store's state (see `StatusBadge`). */
export const STORE_LINK_STATE_TONE: Record<StoreLinkState, "positive" | "active" | "danger" | "neutral"> = {
  linked: "positive",
  acknowledged: "positive",
  queued: "active",
  failed: "danger",
  paused: "neutral",
};

/**
 * The row-level link state the list's own filter is written in: the worst
 * store wins, and a row with no mapping at all is `unlinked`.
 */
export type ProductLinkState = "linked" | "queued" | "failed" | "paused" | "unlinked";

export function productLinkState(links: readonly Pick<ProductWooLink, "connectionStatus" | "lastOutboundStatus">[]): ProductLinkState {
  if (links.length === 0) return "unlinked";
  const states = links.map(storeLinkState);
  for (const state of ["failed", "queued", "paused"] as const) {
    if (states.includes(state)) return state;
  }
  return "linked";
}

/** The Woo/duplicate filter's values. */
export type ProductWooFilter = "all" | "linked" | "unlinked" | "duplicate" | "queued" | "failed";

export const PRODUCT_WOO_FILTERS: readonly { value: ProductWooFilter; label: string }[] = [
  { value: "all", label: "همهٔ وضعیت‌های فروشگاه" },
  { value: "linked", label: "متصل" },
  { value: "unlinked", label: "محلی / بدون پیوند" },
  { value: "duplicate", label: "احتمال تکراری" },
  { value: "queued", label: "در صف" },
  { value: "failed", label: "ناموفق" },
];

/** True when the row belongs to the selected Woo/duplicate filter. */
export function matchesWooFilter(linkState: ProductLinkState, duplicate: boolean, filter: ProductWooFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "duplicate":
      return duplicate;
    case "linked":
      return linkState === "linked";
    case "unlinked":
      return linkState === "unlinked";
    case "queued":
      return linkState === "queued";
    case "failed":
      return linkState === "failed";
  }
}

/**
 * §B's remaining two filters — «Source and per-store filters when appropriate».
 *
 * Source is the integration that owns the row (`items` carries one mapping's
 * provider, see `item-source.ts`); a row nothing owns is `local`. A store filter
 * is only meaningful when more than one store is connected, which is why the
 * screen renders it conditionally rather than as a one-option dropdown.
 */
export type ProductSourceFilter = "all" | "woocommerce" | "holoo" | "local";

export const PRODUCT_SOURCE_FILTERS: readonly { value: ProductSourceFilter; label: string }[] = [
  { value: "all", label: "همهٔ منابع" },
  { value: "woocommerce", label: "ووکامرس" },
  { value: "holoo", label: "هلو" },
  { value: "local", label: "محلی (بدون منبع)" },
];

/** True when the row's owning integration matches the source filter. */
export function matchesSourceFilter(
  source: { provider: string } | null | undefined,
  filter: ProductSourceFilter,
): boolean {
  if (filter === "all") return true;
  if (filter === "local") return !source;
  return source?.provider === filter;
}

/** The value the per-store filter uses for "no store chosen". */
export const ALL_STORES = "all";

/**
 * True when the row is mapped to the chosen store. `ALL_STORES` matches every
 * row — including rows no store knows, which is the store filter's `all` and not
 * its "unlinked" state (the Woo filter already draws that line).
 */
export function matchesStoreFilter(
  links: readonly Pick<ProductWooLink, "connectionId">[],
  storeId: string,
): boolean {
  if (!storeId || storeId === ALL_STORES) return true;
  return links.some((link) => link.connectionId === storeId);
}

/** The distinct stores in a link list, in the order the server returned them. */
export function storesInLinks(
  links: readonly Pick<ProductWooLink, "connectionId" | "storeName">[],
): { id: string; name: string }[] {
  const seen = new Map<string, string>();
  for (const link of links) if (!seen.has(link.connectionId)) seen.set(link.connectionId, link.storeName);
  return [...seen.entries()].map(([id, name]) => ({ id, name }));
}

/**
 * What the row's primary control is.
 * `manual_update` and `publish` are the two store actions; `review_duplicate`
 * is the pre-emptive one a probable duplicate gets instead of a publication.
 */
export type ProductRowActionKind = "manual_update" | "publish" | "review_duplicate";

export interface ProductRowAction {
  kind: ProductRowActionKind;
  /** The full label on a roomy screen. */
  label: string;
  /** The compact label the row uses when space is tight. */
  shortLabel: string;
  /** One line that says what the control does — and does not do. */
  hint: string;
}

/** «همگام‌سازی خودکار موجودی و قیمت جدا و غیرهمزمان است؛ این فقط ارسال دستی پس از بازبینی است.» */
const MANUAL_UPDATE_HINT =
  "همگام‌سازی خودکار موجودی و قیمت به‌صورت غیرهمزمان و بی‌نیاز از این دکمه انجام می‌شود؛ این یک ارسال دستی پس از بازبینی است و فقط پس از تأیید فروشگاه اعمال می‌شود.";

const PUBLISH_HINT =
  "این محصول هنوز به فروشگاهی وصل نیست؛ با انتشار، محصول تازه‌ای در فروشگاه ساخته می‌شود. اگر همان محصول از قبل در فروشگاه هست، آن را پیوند دهید تا ردیف تکراری ساخته نشود.";

const REVIEW_HINT =
  "این ردیف با ردیف دیگری کد کالای یکسان دارد؛ پیش از انتشار یا ادغام، تفاوت‌ها را ببینید. کد کالای مشترک به‌تنهایی دلیل یکی‌بودن دو محصول نیست.";

/**
 * The single primary control for one row.
 *
 * A probable duplicate with no store mapping gets `review_duplicate`: it is
 * the only row shape where clicking "publish" could create another twin. A
 * linked duplicate keeps its manual update (it creates nothing) and the review
 * is offered beside it by the row, not instead of it.
 */
export function productRowAction({
  links,
  duplicate,
}: {
  links: readonly Pick<ProductWooLink, "connectionStatus" | "lastOutboundStatus">[];
  duplicate: boolean;
}): ProductRowAction {
  if (links.length === 0) {
    return duplicate
      ? { kind: "review_duplicate", label: "بررسی محصول تکراری", shortLabel: "بررسی تکراری", hint: REVIEW_HINT }
      : { kind: "publish", label: "انتشار در فروشگاه", shortLabel: "انتشار", hint: PUBLISH_HINT };
  }
  return { kind: "manual_update", label: "به‌روزرسانی دستی", shortLabel: "به‌روزرسانی", hint: MANUAL_UPDATE_HINT };
}

/**
 * Whether a duplicate review is the row's *gate* — i.e. new publication stays
 * closed until the review is recorded. True only for the row shape where the
 * next press of the store button would create something new.
 */
export function duplicateReviewGatesPublication(links: readonly unknown[], duplicate: boolean): boolean {
  return duplicate && links.length === 0;
}
