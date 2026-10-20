/**
 * The retail price-history vocabulary and its Persian labels — issue #924 F07.
 *
 * `price-history.ts` is the transactional writer (it imports the database
 * pool), so a browser component that only wants to *label* a source must not
 * pull it into the bundle. This module has no server dependencies and is the
 * single list both sides read: the writer's type, the read endpoint's filter
 * validation and the matrix's history dialog.
 */

/** Where a retail price change came from. Mirrors the column's check constraint. */
export const PRODUCT_PRICE_SOURCES = [
  "manual",
  "bulk",
  "import",
  "ai",
  "sync",
  "system",
  "recommendation",
] as const;

export type ProductPriceSource = (typeof PRODUCT_PRICE_SOURCES)[number];

/** The Persian labels the history dialog shows — one list, not per-screen copy. */
export const PRODUCT_PRICE_SOURCE_LABELS: Record<ProductPriceSource, string> = {
  manual: "دستی",
  bulk: "بروزرسانی گروهی",
  import: "ورود اطلاعات",
  ai: "هوش مصنوعی",
  sync: "همگام‌سازی",
  system: "سیستم",
  recommendation: "قیمت پیشنهادی",
};

/** Which price a row belongs to: the sale column, the purchase column or a named list. */
export const PRODUCT_PRICE_KINDS = ["sale", "purchase", "list"] as const;

export type ProductPriceKind = (typeof PRODUCT_PRICE_KINDS)[number];

export const PRODUCT_PRICE_KIND_LABELS: Record<ProductPriceKind, string> = {
  sale: "قیمت فروش",
  purchase: "قیمت خرید",
  list: "لیست قیمت",
};

export function isProductPriceSource(value: unknown): value is ProductPriceSource {
  return typeof value === "string" && (PRODUCT_PRICE_SOURCES as readonly string[]).includes(value);
}

export function isProductPriceKind(value: unknown): value is ProductPriceKind {
  return typeof value === "string" && (PRODUCT_PRICE_KINDS as readonly string[]).includes(value);
}

/** A stored source this build does not know about is shown as itself, never dropped. */
export function productPriceSourceLabel(value: string): string {
  return isProductPriceSource(value) ? PRODUCT_PRICE_SOURCE_LABELS[value] : value;
}

export function productPriceKindLabel(value: string): string {
  return isProductPriceKind(value) ? PRODUCT_PRICE_KIND_LABELS[value] : value;
}
