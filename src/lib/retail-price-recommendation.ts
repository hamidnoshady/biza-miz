import Decimal from "decimal.js";

export type ProfitTargetMode = "markup" | "gross_margin";

export interface RetailPriceRecommendationInput {
  purchaseCostRial: string | null;
  fixedOverheadRial: string | null;
  overheadPercent: string;
  targetPercent: string;
  targetMode: ProfitTargetMode;
}

export interface RetailPriceRecommendation {
  purchaseCostRial: string;
  fixedOverheadRial: string;
  percentageOverheadRial: string;
  totalCostRial: string;
  targetProfitRial: string;
  suggestedPriceRial: string;
  realizedMarkupPercent: string;
  realizedMarginPercent: string;
}

export type RetailPriceRecommendationResult =
  | { ok: true; value: RetailPriceRecommendation }
  | { ok: false; error: "missing_cost" | "invalid_amount" | "invalid_percent" | "invalid_margin" | "amount_too_large" };

const MAX_DECIMAL_DIGITS = 30;
const MAX_PERCENT = new Decimal(100_000);

function amount(value: string | null): Decimal | null {
  if (value === null || value.trim() === "") return null;
  if (!/^\d+$/.test(value) || value.length > MAX_DECIMAL_DIGITS) throw new Error("invalid_amount");
  const parsed = new Decimal(value);
  if (!parsed.isFinite() || parsed.isNegative()) throw new Error("invalid_amount");
  return parsed;
}

function percent(value: string): Decimal {
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) || value.length > 32) throw new Error("invalid_percent");
  const parsed = new Decimal(value);
  if (!parsed.isFinite() || parsed.isNegative() || parsed.gt(MAX_PERCENT)) throw new Error("invalid_percent");
  return parsed;
}

/**
 * Advisory retail price estimate. All monetary values are integer Rial text;
 * percentages remain decimal text. No JS floating-point conversion is used.
 * Percentage overhead is explicitly based on purchase/reference cost.
 */
export function recommendRetailPrice(input: RetailPriceRecommendationInput): RetailPriceRecommendationResult {
  try {
    const purchaseCost = amount(input.purchaseCostRial);
    if (purchaseCost === null || purchaseCost.isZero()) return { ok: false, error: "missing_cost" };
    const fixedOverhead = amount(input.fixedOverheadRial) ?? new Decimal(0);
    const overheadRate = percent(input.overheadPercent || "0");
    const targetRate = percent(input.targetPercent || "0");
    if (input.targetMode === "gross_margin" && targetRate.gte(100)) {
      return { ok: false, error: "invalid_margin" };
    }

    const percentageOverhead = purchaseCost.mul(overheadRate).div(100);
    const totalCost = purchaseCost.plus(fixedOverhead).plus(percentageOverhead);
    if (!totalCost.isFinite() || totalCost.gt(`1${"0".repeat(MAX_DECIMAL_DIGITS)}`)) {
      return { ok: false, error: "amount_too_large" };
    }
    const unroundedPrice = input.targetMode === "gross_margin"
      ? totalCost.div(new Decimal(1).minus(targetRate.div(100)))
      : totalCost.mul(new Decimal(1).plus(targetRate.div(100)));
    const suggested = unroundedPrice.toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
    const profit = suggested.minus(totalCost);
    const markup = profit.div(totalCost).mul(100);
    const margin = profit.div(suggested).mul(100);
    return {
      ok: true,
      value: {
        purchaseCostRial: purchaseCost.toFixed(0),
        fixedOverheadRial: fixedOverhead.toFixed(0),
        percentageOverheadRial: percentageOverhead.toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0),
        totalCostRial: totalCost.toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0),
        targetProfitRial: profit.toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0),
        suggestedPriceRial: suggested.toFixed(0),
        realizedMarkupPercent: markup.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2),
        realizedMarginPercent: margin.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2),
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid_amount";
    return {
      ok: false,
      error: message === "invalid_percent" ? "invalid_percent" : message === "amount_too_large" ? "amount_too_large" : "invalid_amount",
    };
  }
}
