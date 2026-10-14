/**
 * The price-change source vocabulary and its Persian labels — issue #844 —
 * in a client-safe module.
 *
 * `menu-price-service.ts` is the transactional writer (it imports the db
 * pool), so a browser component that only wants to *label* a source must not
 * pull it into the bundle. This file has no server dependencies; the service
 * re-exports everything here, so one canonical list serves both sides.
 */
import { toPersianDigits } from "./digits";

/** Where a price change came from. Stored as the `source` check constraint. */
export const PRICE_CHANGE_SOURCES = [
  "manual",
  "suggested",
  "import",
  "ai",
  "integration",
  "sync",
  "migration",
] as const;

export type PriceChangeSource = (typeof PRICE_CHANGE_SOURCES)[number];

/** The Persian labels the history screen shows — one list, not per-screen copy. */
export const PRICE_SOURCE_LABELS: Record<PriceChangeSource, string> = {
  manual: "دستی",
  suggested: "قیمت پیشنهادی",
  import: "ورود اطلاعات",
  ai: "هوش مصنوعی",
  integration: "اتصال خارجی",
  sync: "همگام‌سازی",
  migration: "مهاجرت",
};

export function isPriceChangeSource(value: unknown): value is PriceChangeSource {
  return typeof value === "string" && (PRICE_CHANGE_SOURCES as readonly string[]).includes(value);
}

/**
 * The confirmation line of the price-change dialog —
 * «۴۰٬۰۰۰ → ۴۵٬۰۰۰ تومان (+۱۲٫۵٪)» — as one string. Display-only Persian
 * digits; `format` renders a price in the business's unit (the caller passes
 * `formatMoney`-style formatting so the unit is the business's own).
 */
export function priceChangeSummary(
  oldPriceRial: number,
  newPriceRial: number,
  format: (rial: number) => string,
): { text: string; deltaRial: number; percent: number | null } {
  const deltaRial = newPriceRial - oldPriceRial;
  const percent = oldPriceRial > 0 ? Math.round((deltaRial / oldPriceRial) * 1000) / 10 : null;
  const sign = deltaRial > 0 ? "+" : deltaRial < 0 ? "−" : "";
  // `percent` carries its own sign for a decrease; the glyph is already on
  // `sign`, so the number is absolute — otherwise the line reads «−-۱۱٫۱٪».
  const percentText =
    percent === null
      ? ""
      : ` (${sign}${toPersianDigits(String(Math.abs(percent)).replace(".", "٫"))}٪)`;
  return {
    text: `${format(oldPriceRial)} → ${format(newPriceRial)}${percentText}`,
    deltaRial,
    percent,
  };
}
