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
  /** Round the final price to a multiple of this many Rial (e.g. 10,000 = هزار تومان). */
  roundStepRial?: number | null;
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
  if (!Number.isSafeInteger(n) || n < 0) throw new Error("amount_too_large");
  return n;
}

function roundPrice(value: Decimal, policy: RoundingPolicy, stepRial: number): number {
  if (stepRial <= 1) return roundRial(value, policy);
  const step = new Decimal(stepRial);
  const units = value.div(step);
  let rounded: Decimal;
  switch (policy) {
    case "up":
      rounded = units.ceil();
      break;
    case "down":
      rounded = units.floor();
      break;
    case "nearest":
    default:
      rounded = units.toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
      break;
  }
  const n = rounded.times(step).toNumber();
  if (!Number.isSafeInteger(n) || n < 0) throw new Error("amount_too_large");
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

  if (input.roundStepRial != null) {
    if (!Number.isSafeInteger(input.roundStepRial) || input.roundStepRial < 1) return "roundStepRial_invalid";
  }

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
  let rawPrice = new Decimal(costRial);

  if (input.targetMarkup != null) {
    profitType = "markup";
    profitPercent = input.targetMarkup;
    // markup price = cost * (1 + markup/100)
    rawPrice = new Decimal(costRial).times(new Decimal(1).plus(toDecimal(input.targetMarkup).div(100)));
  } else if (input.targetMargin != null) {
    profitType = "margin";
    profitPercent = input.targetMargin;
    // margin price = cost / (1 - margin/100)
    const divisor = new Decimal(1).minus(toDecimal(input.targetMargin).div(100));
    if (divisor.lte(0)) throw new Error("targetMargin_invalid");
    rawPrice = new Decimal(costRial).div(divisor);
  }

  const stepRial = input.roundStepRial ?? 1;
  let taxAmount: Decimal | null = null;
  let preTaxPrice: Decimal;
  let finalPrice: Decimal;
  let profitAmount: Decimal;

  if (input.tax) {
    const taxRate = toDecimal(input.tax.percent);
    if (input.tax.mode === "exclusive") {
      // Tax is added on top of the profit-bearing shelf price.
      preTaxPrice = new Decimal(roundPrice(rawPrice, rounding, stepRial));
      taxAmount = new Decimal(roundRial(preTaxPrice.times(taxRate).div(100), rounding));
      finalPrice = preTaxPrice.plus(taxAmount);
      profitAmount = preTaxPrice.minus(costRial);
    } else {
      // Inclusive: the suggested price already contains VAT. Profit is computed on
      // the net-of-tax price so VAT is never counted as profit.
      finalPrice = new Decimal(roundPrice(rawPrice, rounding, stepRial));
      const net = finalPrice.div(new Decimal(100).plus(taxRate).div(100));
      preTaxPrice = new Decimal(roundRial(net, rounding));
      taxAmount = finalPrice.minus(preTaxPrice);
      profitAmount = preTaxPrice.minus(costRial);
    }
  } else {
    preTaxPrice = new Decimal(roundPrice(rawPrice, rounding, stepRial));
    finalPrice = preTaxPrice;
    profitAmount = preTaxPrice.minus(costRial);
  }

  const costNum = costRial;
  const overheadNum = overheadTotal.toNumber();
  const profitNum = profitAmount.toNumber();
  const preTaxNum = preTaxPrice.toNumber();
  const taxNum = taxAmount ? taxAmount.toNumber() : null;
  // The tax-added payable can exceed the safe product-price range even when
  // both its components were individually safe. Never return an imprecise
  // Number in the preview/audit payload.
  if (
    !finalPrice.isFinite() ||
    !finalPrice.isInteger() ||
    finalPrice.isNegative() ||
    finalPrice.gt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new Error("amount_too_large");
  }
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
    // In exclusive mode the product's sale-price field is the pre-tax price;
    // VAT is shown separately as payable and must not be baked into the base.
    suggestedPriceRial: input.tax?.mode === "exclusive" ? preTaxNum : finalNum,
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

/**
 * UI-facing contract for the New Product calculator. Same exact-decimal engine
 * as {@link recommendRetailPrice}; turns validation throws into a value and adds
 * the derived fields the preview panel shows. Preview only — never writes price,
 * cost, GL or stock.
 */
export interface RetailRecommendationInput {
  /** Reference purchase price. Must be canonical Rial — not inventory carrying cost. */
  referenceCost: { amountRial: number; currency?: string };
  overhead?: { fixedRial?: number | null; percent?: number | null; base?: OverheadBase };
  target: { kind: "markup" | "margin"; percent: number };
  rounding?: { policy: "none" | "nearest" | "up" | "down"; stepRial?: number | null };
  tax?: { percent: number; mode: TaxMode } | null;
}

export interface RetailRecommendationPreview {
  ok: true;
  suggestedPriceRial: number;
  breakdown: {
    costRial: number;
    grossProfitRial: number;
    /** Gross profit as a share of the pre-tax selling price. */
    marginPercent: number;
    /** Gross profit as a share of cost. Never to be labelled as margin. */
    markupPercent: number;
    profitType: "markup" | "margin" | "none";
    profitPercent: number | null;
    preTaxPriceRial: number;
    taxAmountRial: number | null;
    finalPriceRial: number;
  };
  taxPreview: { taxRial: number; payableRial: number } | null;
}

export type RetailRecommendationOutcome =
  | RetailRecommendationPreview
  | { ok: false; error: string };

const SUPPORTED_REFERENCE_CURRENCIES = new Set(["IRR"]);

export function previewRetailPrice(input: RetailRecommendationInput): RetailRecommendationOutcome {
  const currency = (input.referenceCost?.currency || "IRR").trim().toUpperCase();
  // The engine stores Rial. Accepting IRT/USD here without a rate would silently
  // scale the suggestion by 10 or by an unknown FX rate.
  if (!SUPPORTED_REFERENCE_CURRENCIES.has(currency)) return { ok: false, error: "unsupported_currency" };

  const policy = input.rounding?.policy ?? "nearest";
  const rounding: RoundingPolicy = policy === "none" ? "nearest" : policy;
  const stepRial = policy === "none" ? 1 : input.rounding?.stepRial ?? 1;

  try {
    const result = recommendRetailPrice({
      referencePurchase: input.referenceCost.amountRial,
      fixedOverhead: input.overhead?.fixedRial ?? 0,
      percentOverhead: input.overhead?.percent ?? 0,
      overheadBase: input.overhead?.base ?? "reference",
      targetMarkup: input.target.kind === "markup" ? input.target.percent : null,
      targetMargin: input.target.kind === "margin" ? input.target.percent : null,
      rounding,
      roundStepRial: stepRial,
      tax: input.tax ?? null,
    });

    const b = result.breakdown;
    const grossProfitRial = b.preTaxPrice - b.cost;
    const marginPercent = b.preTaxPrice > 0 ? (grossProfitRial / b.preTaxPrice) * 100 : 0;
    const markupPercent = b.cost > 0 ? (grossProfitRial / b.cost) * 100 : 0;

    return {
      ok: true,
      suggestedPriceRial: result.suggestedPriceRial,
      breakdown: {
        costRial: b.cost,
        grossProfitRial,
        marginPercent: Number(marginPercent.toFixed(2)),
        markupPercent: Number(markupPercent.toFixed(2)),
        profitType: b.profitType,
        profitPercent: b.profitPercent,
        preTaxPriceRial: b.preTaxPrice,
        taxAmountRial: b.taxAmount,
        finalPriceRial: b.finalPrice,
      },
      taxPreview: input.tax
        ? { taxRial: b.taxAmount ?? 0, payableRial: b.finalPrice }
        : null,
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "invalid_input" };
  }
}
