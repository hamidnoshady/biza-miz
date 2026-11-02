/**
 * The business-wide policy behind the New Product «پیشنهاد قیمت فروش».
 *
 * Overhead, the profit target, rounding and the tax basis are decisions the
 * owner makes once for the whole catalogue, in «تنظیمات ← قیمت‌گذاری». The
 * product form only *reads* them; what a single product may do is override the
 * overhead or the profit for itself (a bulky item that costs more to carry, a
 * loss-leader that earns less). Everything here is pure and framework-free so
 * the settings screen, the form and the API validate against one definition.
 *
 * Money is integer Rial, as everywhere else — the screens convert to the
 * business's display unit.
 */
import type { ParsedPriceRecommendation } from "./product-input";
import {
  previewRetailPrice,
  type OverheadBase,
  type RetailRecommendationOutcome,
  type TaxMode,
} from "./retail-price-recommendation";

export type ProfitMode = "markup" | "margin";
export type RetailRoundingPolicy = "none" | "nearest" | "up" | "down";

export interface RetailPricingPolicy {
  /** Fixed overhead added to every unit's reference cost, in Rial. Null = none. */
  fixedOverheadRial: number | null;
  /** Percentage overhead (0–1000). Null = none. */
  percentOverhead: number | null;
  /** What the percentage is taken from: the reference cost alone, or the cost plus the fixed overhead. */
  overheadBase: OverheadBase;
  /** Whether the profit target is a markup on cost or a margin on the selling price. */
  profitMode: ProfitMode;
  /** The profit target. Null until an owner sets one — no price is suggested without it. */
  profitPercent: number | null;
  rounding: RetailRoundingPolicy;
  /** The multiple the suggestion is rounded to, in Rial. Unused while `rounding` is `none`. */
  roundStepRial: number;
  /** Whether the sale-price field holds the price before tax (`exclusive`) or the tax-inclusive price. */
  taxMode: TaxMode;
}

export const MAX_RETAIL_FIXED_OVERHEAD_RIAL = 1_000_000_000_000;
export const MAX_RETAIL_OVERHEAD_PERCENT = 1000;
export const MAX_RETAIL_MARKUP_PERCENT = 10_000;
/** A margin of 100% would need an infinite price. */
export const MAX_RETAIL_MARGIN_PERCENT_EXCLUSIVE = 100;
export const MAX_RETAIL_ROUND_STEP_RIAL = 1_000_000_000;

export const DEFAULT_RETAIL_PRICING_POLICY: RetailPricingPolicy = {
  fixedOverheadRial: null,
  percentOverhead: null,
  overheadBase: "reference",
  profitMode: "markup",
  profitPercent: null,
  rounding: "nearest",
  // ۱٬۰۰۰ تومان — the step the calculator has always started from.
  roundStepRial: 10_000,
  taxMode: "exclusive",
};

const PROFIT_MODES: readonly ProfitMode[] = ["markup", "margin"];
const ROUNDINGS: readonly RetailRoundingPolicy[] = ["none", "nearest", "up", "down"];
const OVERHEAD_BASES: readonly OverheadBase[] = ["reference", "with_fixed"];
const TAX_MODES: readonly TaxMode[] = ["exclusive", "inclusive"];

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function boundedNumber(value: unknown, options: { min: number; max: number; maxInclusive?: boolean; integer?: boolean }): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < options.min) return null;
  if (options.maxInclusive === false ? value >= options.max : value > options.max) return null;
  if (options.integer && !Number.isInteger(value)) return null;
  return value;
}

/** The highest profit target the chosen mode can express. */
export function profitPercentLimit(mode: ProfitMode): { max: number; maxInclusive: boolean } {
  return mode === "margin"
    ? { max: MAX_RETAIL_MARGIN_PERCENT_EXCLUSIVE, maxInclusive: false }
    : { max: MAX_RETAIL_MARKUP_PERCENT, maxInclusive: true };
}

/**
 * Reads a stored value back. Settings predate their validators and can come
 * from an old backup, so anything malformed degrades to the default instead of
 * turning a suggestion into NaN.
 */
export function normalizeRetailPricingPolicy(raw: unknown): RetailPricingPolicy {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const profitMode = pick(source.profitMode, PROFIT_MODES, DEFAULT_RETAIL_PRICING_POLICY.profitMode);
  const limit = profitPercentLimit(profitMode);
  return {
    fixedOverheadRial: boundedNumber(source.fixedOverheadRial, { min: 0, max: MAX_RETAIL_FIXED_OVERHEAD_RIAL, integer: true }),
    percentOverhead: boundedNumber(source.percentOverhead, { min: 0, max: MAX_RETAIL_OVERHEAD_PERCENT }),
    overheadBase: pick(source.overheadBase, OVERHEAD_BASES, DEFAULT_RETAIL_PRICING_POLICY.overheadBase),
    profitMode,
    profitPercent: boundedNumber(source.profitPercent, { min: 0, ...limit }),
    rounding: pick(source.rounding, ROUNDINGS, DEFAULT_RETAIL_PRICING_POLICY.rounding),
    roundStepRial:
      boundedNumber(source.roundStepRial, { min: 1, max: MAX_RETAIL_ROUND_STEP_RIAL, integer: true }) ??
      DEFAULT_RETAIL_PRICING_POLICY.roundStepRial,
    taxMode: pick(source.taxMode, TAX_MODES, DEFAULT_RETAIL_PRICING_POLICY.taxMode),
  };
}

export type RetailPricingPolicyIssue =
  | "invalid_body"
  | "invalid_fixed_overhead"
  | "invalid_percent_overhead"
  | "invalid_overhead_base"
  | "invalid_profit_mode"
  | "invalid_profit_percent"
  | "invalid_rounding"
  | "invalid_round_step"
  | "invalid_tax_mode";

/**
 * Validates a PUT body strictly. An omitted key keeps `existing`; an explicit
 * `null` clears the three optional numbers. Wrong types are rejected rather
 * than coerced — `Number("")` is zero and used to pass elsewhere.
 */
export function parseRetailPricingPolicyInput(
  body: unknown,
  existing: RetailPricingPolicy,
): { ok: true; policy: RetailPricingPolicy } | { ok: false; error: RetailPricingPolicyIssue } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "invalid_body" };
  const input = body as Record<string, unknown>;
  const has = (key: string) => Object.prototype.hasOwnProperty.call(input, key);

  const enumField = <T extends string>(key: string, allowed: readonly T[], current: T): T | null => {
    if (!has(key)) return current;
    return typeof input[key] === "string" && (allowed as readonly string[]).includes(input[key] as string)
      ? (input[key] as T)
      : null;
  };
  const optionalNumber = (
    key: string,
    current: number | null,
    options: { min: number; max: number; maxInclusive?: boolean; integer?: boolean },
  ): { ok: true; value: number | null } | { ok: false } => {
    if (!has(key)) return { ok: true, value: current };
    if (input[key] === null) return { ok: true, value: null };
    const value = boundedNumber(input[key], options);
    return value === null ? { ok: false } : { ok: true, value };
  };

  const profitMode = enumField("profitMode", PROFIT_MODES, existing.profitMode);
  if (profitMode === null) return { ok: false, error: "invalid_profit_mode" };
  const overheadBase = enumField("overheadBase", OVERHEAD_BASES, existing.overheadBase);
  if (overheadBase === null) return { ok: false, error: "invalid_overhead_base" };
  const rounding = enumField("rounding", ROUNDINGS, existing.rounding);
  if (rounding === null) return { ok: false, error: "invalid_rounding" };
  const taxMode = enumField("taxMode", TAX_MODES, existing.taxMode);
  if (taxMode === null) return { ok: false, error: "invalid_tax_mode" };

  const fixed = optionalNumber("fixedOverheadRial", existing.fixedOverheadRial, {
    min: 0,
    max: MAX_RETAIL_FIXED_OVERHEAD_RIAL,
    integer: true,
  });
  if (!fixed.ok) return { ok: false, error: "invalid_fixed_overhead" };
  const percent = optionalNumber("percentOverhead", existing.percentOverhead, { min: 0, max: MAX_RETAIL_OVERHEAD_PERCENT });
  if (!percent.ok) return { ok: false, error: "invalid_percent_overhead" };
  // Judged against the mode being saved, not the one stored: switching to
  // margin with an old 150% markup must fail, not be saved and then hidden.
  const profit = optionalNumber("profitPercent", existing.profitPercent, { min: 0, ...profitPercentLimit(profitMode) });
  if (!profit.ok) return { ok: false, error: "invalid_profit_percent" };
  // A kept value is judged too: it was stored under another mode.
  if (profit.value !== null && boundedNumber(profit.value, { min: 0, ...profitPercentLimit(profitMode) }) === null) {
    return { ok: false, error: "invalid_profit_percent" };
  }

  let roundStepRial = existing.roundStepRial;
  if (has("roundStepRial")) {
    const step = boundedNumber(input.roundStepRial, { min: 1, max: MAX_RETAIL_ROUND_STEP_RIAL, integer: true });
    if (step === null) return { ok: false, error: "invalid_round_step" };
    roundStepRial = step;
  }

  return {
    ok: true,
    policy: {
      fixedOverheadRial: fixed.value,
      percentOverhead: percent.value,
      overheadBase,
      profitMode,
      profitPercent: profit.value,
      rounding,
      roundStepRial,
      taxMode,
    },
  };
}

/**
 * What one product may change for itself. Every field is optional and empty
 * means «use the business setting»; nothing here is a second default.
 */
export interface RetailPricingOverrides {
  fixedOverheadRial: number | null;
  percentOverhead: number | null;
  profitMode: ProfitMode;
  profitPercent: number | null;
}

export const NO_RETAIL_PRICING_OVERRIDES: RetailPricingOverrides = {
  fixedOverheadRial: null,
  percentOverhead: null,
  profitMode: "markup",
  profitPercent: null,
};

export type RetailSuggestionOutcome =
  | {
      ok: true;
      preview: Extract<RetailRecommendationOutcome, { ok: true }>;
      recommendation: ParsedPriceRecommendation;
      /** Where each figure came from — the screen says so, and the audit row keeps it. */
      sources: { overhead: "policy" | "product"; profit: "policy" | "product" };
    }
  | { ok: false; reason: "no_cost" | "no_profit" | "calculation_failed"; error?: string };

/**
 * One calculation for the screen and for the audit row it may later become.
 *
 * `minUnitRial` is the smallest amount the sale-price field can hold (10 Rial
 * for a Toman business, 1 for a Rial one): even with no extra rounding the
 * suggestion has to be something the field can show.
 */
export function suggestRetailPrice(input: {
  policy: RetailPricingPolicy;
  overrides: RetailPricingOverrides;
  referenceCostRial: number | null;
  /** The tax rate that applies to this product, or null for none. */
  taxPercent: number | null;
  minUnitRial: number;
}): RetailSuggestionOutcome {
  const { policy, overrides, referenceCostRial, taxPercent, minUnitRial } = input;
  if (referenceCostRial == null || !(referenceCostRial > 0)) return { ok: false, reason: "no_cost" };

  const productProfit = overrides.profitPercent != null;
  const profitMode = productProfit ? overrides.profitMode : policy.profitMode;
  const profitPercent = productProfit ? overrides.profitPercent : policy.profitPercent;
  if (profitPercent == null) return { ok: false, reason: "no_profit" };

  // Each overhead figure is overridden on its own: a product that only needs
  // its own fixed amount keeps the business's percentage.
  const productOverhead = overrides.fixedOverheadRial != null || overrides.percentOverhead != null;
  const fixedRial = overrides.fixedOverheadRial ?? policy.fixedOverheadRial ?? 0;
  const percent = overrides.percentOverhead ?? policy.percentOverhead ?? 0;
  const overheadBase = policy.overheadBase;

  const roundStepRial = policy.rounding === "none" ? Math.max(1, minUnitRial) : Math.max(policy.roundStepRial, minUnitRial);
  const tax = taxPercent != null && taxPercent > 0 ? { percent: taxPercent, mode: policy.taxMode } : null;

  const preview = previewRetailPrice({
    referenceCost: { amountRial: referenceCostRial, currency: "IRR" },
    overhead: { fixedRial, percent, base: overheadBase },
    target: { kind: profitMode, percent: profitPercent },
    // "No extra rounding" still rounds to the smallest amount the field holds.
    rounding: { policy: policy.rounding === "none" ? "nearest" : policy.rounding, stepRial: roundStepRial },
    tax,
  });
  if (!preview.ok) return { ok: false, reason: "calculation_failed", error: preview.error };
  if (!(preview.suggestedPriceRial > 0)) return { ok: false, reason: "calculation_failed", error: "non_positive_price" };

  return {
    ok: true,
    preview,
    sources: { overhead: productOverhead ? "product" : "policy", profit: productProfit ? "product" : "policy" },
    recommendation: {
      suggestedPriceRial: preview.suggestedPriceRial,
      mode: profitMode,
      inputs: {
        referenceCostRial,
        fixedOverheadRial: fixedRial,
        percentOverhead: percent,
        overheadBase,
        markupPercent: profitMode === "markup" ? profitPercent : null,
        marginPercent: profitMode === "margin" ? profitPercent : null,
        rounding: policy.rounding === "none" ? "nearest" : policy.rounding,
        roundingSelection: policy.rounding,
        roundStepRial,
        taxPercent: tax ? tax.percent : null,
        taxMode: tax ? tax.mode : null,
        suggestedPriceRial: preview.suggestedPriceRial,
        overheadSource: productOverhead ? "product" : "policy",
        profitSource: productProfit ? "product" : "policy",
      },
    },
  };
}
