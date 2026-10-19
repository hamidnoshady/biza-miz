/**
 * Retail New Product price recommendation — exact-decimal calculation.
 *
 * Cross-issue contract: #951 owns UI in `/accounting/products/new`; this
 * issue owns the reusable calculation and authorized write integration.
 * #844 (café) is café-specific and not copied into retail costing/GL.
 *
 * Definitions:
 *   cost = referencePurchase + overhead
 *   overhead = fixedOverhead + (referencePurchase * percentOverhead / 100)  // when base = reference
 *            | fixedOverhead + ((referencePurchase+fixedOverhead) * percentOverhead /100) // when base = cost_before_percent
 *   markup price = cost * (1 + markup/100)
 *   margin price = cost / (1 - margin/100)   for margin < 100%
 *
 * Never label markup as margin. All arithmetic exact via Decimal.js.
 * Rounding: to nearest Rial (integer) with policy 'nearest' | 'up' | 'down'.
 * Tax preview: exclusive vs inclusive, clearly separated, never folded into profit.
 */

import Decimal from "decimal.js";

export type OverheadBase = "reference" | "with_fixed";
export type RoundingPolicy = "nearest" | "up" | "down";
export type TaxMode = "exclusive" | "inclusive";

export interface RecommendationInput {
  /** Canonical reference purchase price in Rial (integer, >=0). Not inventory cost. */
  referencePurchase: number | null;
  /** Fixed overhead per unit in Rial (>=0). */
  fixedOverhead?: number | null;
  /** Percentage overhead (0..1000). */
  percentOverhead?: number | null;
  /** Declared base for percentage overhead. */
  overheadBase?: OverheadBase;
  /** Target markup percent (0..10000). Mutually exclusive with targetMargin. */
  targetMarkup?: number | null;
  /** Target gross margin percent (0.. <100). Mutually exclusive with targetMarkup. */
  targetMargin?: number | null;
  /** Monetary rounding policy (default nearest). */
  rounding?: RoundingPolicy;
  /** Optional tax preview. */
  tax?: {
    mode: TaxMode;
    percent: number; // 0..100
  } | null;
}

export interface RecommendationResult {
  /** Total cost = reference + overhead (Rial, integer). */
  costRial: number;
  /** Breakdown for audit/UI. */
  breakdown: {
    referencePurchase: number;
    fixedOverhead: number;
    percentOverheadAmount: number;
    overheadTotal: number;
    cost: number;
    profitType: "markup" | "margin" | "none";
    profitPercent: number | null;
    profitAmount: number;
    preTaxPrice: number;
    taxAmount: number | null;
    finalPrice: number;
    taxMode: TaxMode | null;
  };
  /** Suggested selling price (pre-tax if exclusive, post-tax if inclusive preview). */
  suggestedPriceRial: number;
}

function toDecimal(value: number | null | undefined, fallback = 0): Decimal {
  if (value == null) return new Decimal(fallback);
  return new Decimal(value);
}

function roundRial(value: Decimal, policy: RoundingPolicy): number {
  let rounded: Decimal;
  switch (policy) {
    case "up":
      rounded = value.ceil();
      break;
    case "down":
      rounded = value.floor();
      break;
    case "nearest":
    default:
      rounded = value.toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
      break;
  }
  // Clamp to safe integer and non-negative
  const n = rounded.toNumber();
  if (!Number.isSafeInteger(n) || n < 0) throw new Error("rounded_out_of_range");
  return n;
}

function validateInput(input: RecommendationInput): string | null {
  if (input.referencePurchase == null) return "referencePurchase_required";
  if (!Number.isFinite(input.referencePurchase) || input.referencePurchase < 0) return "referencePurchase_invalid";
  if (!Number.isInteger(input.referencePurchase)) return "referencePurchase_must_be_integer";
  if (input.referencePurchase > Number.MAX_SAFE_INTEGER) return "referencePurchase_too_large";

  const fixed = input.fixedOverhead ?? 0;
  if (fixed != null && (!Number.isFinite(fixed) || fixed < 0 || !Number.isInteger(fixed))) return "fixedOverhead_invalid";
  if (fixed != null && fixed > Number.MAX_SAFE_INTEGER) return "fixedOverhead_too_large";

  const percentOver = input.percentOverhead ?? 0;
  if (percentOver != null && (!Number.isFinite(percentOver) || percentOver < 0 || percentOver > 1000)) return "percentOverhead_invalid";

  const markup = input.targetMarkup;
  const margin = input.targetMargin;
  if (markup != null && margin != null) return "markup_and_margin_mutually_exclusive";
  if (markup != null && (!Number.isFinite(markup) || markup < 0 || markup > 10000)) return "targetMarkup_invalid";
  if (margin != null && (!Number.isFinite(margin) || margin < 0 || margin >= 100)) return "targetMargin_invalid";

  if (input.tax) {
    if (input.tax.percent < 0 || input.tax.percent > 100 || !Number.isFinite(input.tax.percent)) return "tax_percent_invalid";
    if (input.tax.mode !== "exclusive" && input.tax.mode !== "inclusive") return "tax_mode_invalid";
  }
  return null;
}

export function recommendRetailPrice(input: RecommendationInput): RecommendationResult {
  const error = validateInput(input);
  if (error) throw new Error(error);

  const rounding = input.rounding ?? "nearest";
  const ref = toDecimal(input.referencePurchase!, 0);
  const fixed = toDecimal(input.fixedOverhead ?? 0, 0);
  const percentOver = toDecimal(input.percentOverhead ?? 0, 0);
  const base: OverheadBase = input.overheadBase ?? "reference";

  // Overhead calculation
  let percentBaseAmount: Decimal;
  if (base === "reference") {
    percentBaseAmount = ref.times(percentOver).div(100);
  } else {
    percentBaseAmount = ref.plus(fixed).times(percentOver).div(100);
  }
  // Overhead amounts are monetary — round to Rial before summing to keep integer cost
  const fixedRounded = new Decimal(roundRial(fixed, rounding));
  const percentRounded = new Decimal(roundRial(percentBaseAmount, rounding));
  const overheadTotal = fixedRounded.plus(percentRounded);
  const cost = ref.plus(overheadTotal);
  const costRial = roundRial(cost, rounding);

  let profitType: "markup" | "margin" | "none" = "none";
  let profitPercent: number | null = null;
  let profitAmount = new Decimal(0);
  let preTaxPrice = new Decimal(costRial);

  if (input.targetMarkup != null) {
    profitType = "markup";
    profitPercent = input.targetMarkup;
    const markupDec = toDecimal(input.targetMarkup);
    // markup price = cost * (1 + markup/100)
    preTaxPrice = new Decimal(costRial).times(new Decimal(1).plus(markupDec.div(100)));
    profitAmount = preTaxPrice.minus(costRial);
  } else if (input.targetMargin != null) {
    profitType = "margin";
    profitPercent = input.targetMargin;
    const marginDec = toDecimal(input.targetMargin);
    // margin price = cost / (1 - margin/100)
    const divisor = new Decimal(1).minus(marginDec.div(100));
    if (divisor.lte(0)) throw new Error("targetMargin_invalid");
    preTaxPrice = new Decimal(costRial).div(divisor);
    profitAmount = preTaxPrice.minus(costRial);
  }

  preTaxPrice = new Decimal(roundRial(preTaxPrice, rounding));
  profitAmount = new Decimal(roundRial(profitAmount, rounding));

  let taxAmount: Decimal | null = null;
  let finalPrice = preTaxPrice;

  if (input.tax) {
    const taxRate = toDecimal(input.tax.percent);
    if (input.tax.mode === "exclusive") {
      // tax preview added on top: final = preTax * (1 + tax/100)
      taxAmount = preTaxPrice.times(taxRate).div(100);
      taxAmount = new Decimal(roundRial(taxAmount, rounding));
      finalPrice = preTaxPrice.plus(taxAmount);
    } else {
      // inclusive: preTax already includes tax; show tax portion separately
      // final = preTax, taxPortion = final * tax / (100 + tax)
      // This never folds VAT into profit calculation; profit computed before tax.
      taxAmount = finalPrice.times(taxRate).div(new Decimal(100).plus(taxRate));
      taxAmount = new Decimal(roundRial(taxAmount, rounding));
      // finalPrice stays as computed pre-tax inclusive; actually inclusive means
      // the suggested price IS the final, so no extra tax added. We keep final = preTax.
      // The preview shows tax portion contained within.
    }
    finalPrice = new Decimal(roundRial(finalPrice, rounding));
  }

  const costNum = costRial;
  const overheadNum = overheadTotal.toNumber();
  const profitNum = profitAmount.toNumber();
  const preTaxNum = preTaxPrice.toNumber();
  const taxNum = taxAmount ? taxAmount.toNumber() : null;
  const finalNum = finalPrice.toNumber();

  return {
    costRial: costNum,
    breakdown: {
      referencePurchase: ref.toNumber(),
      fixedOverhead: fixedRounded.toNumber(),
      percentOverheadAmount: percentRounded.toNumber(),
      overheadTotal: overheadNum,
      cost: costNum,
      profitType,
      profitPercent,
      profitAmount: profitNum,
      preTaxPrice: preTaxNum,
      taxAmount: taxNum,
      finalPrice: finalNum,
      taxMode: input.tax?.mode ?? null,
    },
    suggestedPriceRial: finalNum,
  };
}

/**
 * Helper for UI preview: distinguishes markup vs margin labels.
 */
export function profitLabel(type: "markup" | "margin" | "none"): string {
  if (type === "markup") return "سود بر اساس بهای تمام‌شده (markup)";
  if (type === "margin") return "سود بر اساس قیمت فروش (margin)";
  return "بدون سود هدف";
}
