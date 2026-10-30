/**
 * Issue #902 §9 item 3 — which price produced a rated amount.
 *
 * `billing_usage_ratings` used to carry exactly one provenance column,
 * `price_version_id`, pointing at the *meter* catalogue (`billing_price_versions`).
 * Every messaging charge is priced by `kavenegar_retail_price_versions` instead,
 * so the rating pointed at a version whose numbers were never used: a confident,
 * false answer to "which price version produced this line?".
 *
 * The rule this module encodes, in one place, so the runtime and its test cannot
 * disagree:
 *
 *   1. A retail-priced amount cites the retail version and **nothing** in the
 *      meter column — the two catalogues are different tables.
 *   2. An amount the caller computed itself (a feature price, a config rate: AI
 *      tokens, media storage, activation) cites **nothing**. It used no price
 *      version, so the honest answer is "explicit amount", not "whatever meter
 *      version happened to be current".
 *   3. An amount rated from a published meter price cites that version.
 *
 * Rule 2 is a behaviour change and the point of the slice: before it, a rating
 * was *always* stamped with the active meter version, even when the number beside
 * it came from somewhere else.
 *
 * The module is pure — no database import — so a test can exercise every branch
 * without a pool, and so it stays safe to import from anywhere.
 */

/** How a rated amount was arrived at. Mirrors `billing_usage_ratings.price_basis`. */
export type PriceBasis = "meter_price_version" | "retail_price_version" | "explicit_amount";

export interface RatingBasisInput {
  /** The amount the caller rated, or null when the meter's own price should rate it. */
  ratedAmountRial: number | null;
  /** A meter price version the caller named explicitly. */
  priceVersionId: string | null;
  /** The retail version that priced this charge, when the charge came from §4's pricing. */
  retailPriceVersionId: string | null;
  retailPriceVersion: number | null;
  /** The meter price version the runtime resolved from the meter, if it looked one up. */
  resolvedMeterPriceVersionId: string | null;
}

export interface RatingBasis {
  basis: PriceBasis;
  /** `billing_price_versions.id`, or null when no meter version priced this. */
  priceVersionId: string | null;
  retailPriceVersionId: string | null;
  retailPriceVersion: number | null;
}

/**
 * Decide what the rating row may claim.
 *
 * A retail version wins outright: it is the most specific true statement
 * available, and it also settles the meter column to NULL (rule 1). Otherwise an
 * explicit amount means no citation at all (rule 2), and only a genuinely
 * meter-rated row cites the meter (rule 3).
 */
export function resolveRatingBasis(input: RatingBasisInput): RatingBasis {
  // A negative version is refused, not clamped: `0` already means "the built-in
  // default", so clamping a bad input to 0 would turn a nonsense number into a
  // specific, wrong claim. `null` falls through to the honest answer below.
  const retailVersion =
    input.retailPriceVersion !== null &&
    Number.isFinite(input.retailPriceVersion) &&
    input.retailPriceVersion >= 0
      ? Math.trunc(input.retailPriceVersion)
      : null;

  if (retailVersion !== null) {
    return {
      basis: "retail_price_version",
      // Never the meter's column: a different catalogue, and citing it would be
      // the exact false provenance this slice removes.
      priceVersionId: null,
      retailPriceVersionId: input.retailPriceVersionId,
      retailPriceVersion: retailVersion,
    };
  }

  if (input.ratedAmountRial !== null) {
    return {
      basis: "explicit_amount",
      priceVersionId: null,
      retailPriceVersionId: null,
      retailPriceVersion: null,
    };
  }

  return {
    basis: "meter_price_version",
    priceVersionId: input.priceVersionId ?? input.resolvedMeterPriceVersionId,
    retailPriceVersionId: null,
    retailPriceVersion: null,
  };
}

/** Persian labels for the console. First-party words; no supplier vocabulary. */
export const PRICE_BASIS_LABELS: Record<PriceBasis, string> = {
  meter_price_version: "تعرفهٔ منتشرشدهٔ سنجه",
  retail_price_version: "نسخهٔ قیمت خرده‌فروشی",
  explicit_amount: "مبلغ محاسبه‌شدهٔ صریح",
};
