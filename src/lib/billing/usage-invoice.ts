/**
 * Issue #902 §9 item 3 (second half) — turning ratings into invoice lines.
 *
 * A rating is per event; an invoice line is per *thing that was charged for*, on
 * one set of terms. This module is the join between the two, and it is pure: the
 * database half (`usage-invoice-service.ts`) reads the ratings and writes what
 * this returns, so the arithmetic that a business actually pays can be tested
 * without a pool.
 *
 * The grouping key is deliberately not just the meter. Two rows of
 * `messaging.sms_segment` in one month can have been priced by two different
 * retail versions — a promotion expired mid-month, a markup changed. Folding
 * them into one line would produce a line whose "which version?" answer is a lie
 * of exactly the kind 0270 removed from the ratings. So a line is one
 * **meter + basis + version**, which is also the most a reader can act on:
 *
 *   «پیامک — نسخهٔ قیمت خرده‌فروشی ۷»   ← one line, one version
 *   «پیامک — نسخهٔ قیمت خرده‌فروشی ۸»   ← the rest of the month, after the change
 *
 * Three rules worth stating, because each is a place this could quietly go wrong:
 *
 *   1. **`amountRial` is the sum of the ratings.** It is what is billed. The unit
 *      price is *derived* from it so the line has a unit, and it may not multiply
 *      back exactly when an allowance consumed part of the quantity — which is
 *      why nothing downstream recomputes the amount from the unit.
 *   2. **A zero-rated event produces no line.** A line of ۰ ریال is not something
 *      anyone can pay, and it would make every invoice carry noise from events
 *      that were entirely covered by a plan allowance.
 *   3. **A rating with no recorded basis is still billed**, with no version cited.
 *      It was written before 0270; refusing to bill it would let an accounting
 *      change decide whether a business owes money.
 *
 * The module imports only the meter catalogue and two formatting helpers, so it
 * stays safe for a client component to import.
 */
import { meterByKey } from "./catalog/meters";
import { toPersianDigits } from "../digits";
import { PRICE_BASIS_LABELS, type PriceBasis } from "./rating-basis";

/** One billable rating, as read from `billing_usage_ratings` + its event. */
export interface BillableRating {
  usageEventId: string;
  meterKey: string;
  /** The metered quantity (segments, tokens, requests…), for the line's unit. */
  quantity: number;
  ratedAmountRial: number;
  /** NULL for a rating written before 0270 — billed, but citing nothing. */
  priceBasis: PriceBasis | null;
  priceVersionId: string | null;
  retailPriceVersionId: string | null;
  retailPriceVersion: number | null;
}

export interface UsageInvoiceLine {
  meterKey: string;
  description: string;
  quantity: number;
  unitAmountRial: number;
  /** The sum of the ratings in this line. Authoritative; never recomputed. */
  amountRial: number;
  priceBasis: PriceBasis | null;
  priceVersionId: string | null;
  retailPriceVersionId: string | null;
  retailPriceVersion: number | null;
  /**
   * The ratings behind this line, with what each contributed, so the write can
   * link them one by one and the sum can be checked against `amountRial`.
   */
  ratings: { usageEventId: string; amountRial: number }[];
}

export interface UsageInvoiceBody {
  lines: UsageInvoiceLine[];
  subtotalRial: number;
  totalRial: number;
  /** Ratings considered, including the zero-rated ones that produced no line. */
  ratingCount: number;
  /** Ratings that produced a line. */
  billedCount: number;
}

function money(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

/**
 * The provenance half of a line's description — the part that says which price
 * produced it, in first-party words. A meter version's own number is not
 * available here (only its id), so it cites the catalogue rather than inventing
 * a number; a retail version cites the number, because that is the one an
 * operator publishes and a business can be shown.
 */
export function provenanceLabel(input: {
  priceBasis: PriceBasis | null;
  retailPriceVersion: number | null;
}): string {
  if (input.priceBasis === null) return "";
  const label = PRICE_BASIS_LABELS[input.priceBasis];
  if (input.priceBasis === "retail_price_version" && input.retailPriceVersion !== null) {
    return `${label} ${toPersianDigits(Math.trunc(input.retailPriceVersion))}`;
  }
  return label;
}

function lineDescription(input: {
  meterKey: string;
  priceBasis: PriceBasis | null;
  retailPriceVersion: number | null;
}): string {
  // The catalogue's own Persian name; a meter the catalogue does not know (an
  // event written by a newer deployment) keeps its key rather than a blank.
  const name = meterByKey(input.meterKey)?.name ?? input.meterKey;
  const provenance = provenanceLabel(input);
  return provenance ? `${name} — ${provenance}` : name;
}

function groupKey(rating: BillableRating): string {
  // Version *and* basis: a retail version 7 line and a meter-priced line for the
  // same meter are different terms, so they are different lines.
  return [
    rating.meterKey,
    rating.priceBasis ?? "unrecorded",
    rating.priceBasis === "retail_price_version"
      ? `retail:${rating.retailPriceVersion ?? ""}`
      : `meter:${rating.priceVersionId ?? ""}`,
  ].join("|");
}

/**
 * Fold a month's ratings into invoice lines. Input order is irrelevant except
 * for determinism, which the sort at the end establishes: biggest line first,
 * then by description, so an invoice reads the same on every read.
 */
export function groupUsageInvoiceLines(ratings: readonly BillableRating[]): UsageInvoiceBody {
  const groups = new Map<string, UsageInvoiceLine>();
  let ratingCount = 0;

  for (const rating of ratings) {
    ratingCount += 1;
    const amount = money(rating.ratedAmountRial);
    // Rule 2: nothing to pay, nothing to bill. Still counted above, so a caller
    // can tell "no usage" from "usage entirely within the allowance".
    if (amount === 0) continue;

    const key = groupKey(rating);
    const existing = groups.get(key);
    if (existing) {
      existing.amountRial += amount;
      existing.quantity += money(rating.quantity);
      existing.ratings.push({ usageEventId: rating.usageEventId, amountRial: amount });
      continue;
    }
    groups.set(key, {
      meterKey: rating.meterKey,
      description: lineDescription(rating),
      quantity: money(rating.quantity),
      unitAmountRial: 0,
      amountRial: amount,
      priceBasis: rating.priceBasis,
      priceVersionId: rating.priceBasis === "meter_price_version" ? rating.priceVersionId : null,
      retailPriceVersionId:
        rating.priceBasis === "retail_price_version" ? rating.retailPriceVersionId : null,
      retailPriceVersion: rating.priceBasis === "retail_price_version" ? rating.retailPriceVersion : null,
      ratings: [{ usageEventId: rating.usageEventId, amountRial: amount }],
    });
  }

  const lines = [...groups.values()];
  for (const line of lines) {
    // Rule 1: the unit is derived from the amount, never the reverse. Rounded to
    // the nearest Rial because a unit price is a display figure; `amountRial`
    // stays exact.
    line.unitAmountRial = line.quantity > 0 ? Math.round(line.amountRial / line.quantity) : line.amountRial;
  }
  lines.sort((a, b) => b.amountRial - a.amountRial || a.description.localeCompare(b.description, "fa"));

  const subtotalRial = lines.reduce((sum, line) => sum + line.amountRial, 0);
  return {
    lines,
    subtotalRial,
    // Usage is billed in Rial; tax is a plan/commercial-settings concern and is
    // deliberately not invented here (§9 item 3 is about *which price*, not
    // about a tax policy for metered usage).
    totalRial: subtotalRial,
    ratingCount,
    billedCount: lines.reduce((sum, line) => sum + line.ratings.length, 0),
  };
}
