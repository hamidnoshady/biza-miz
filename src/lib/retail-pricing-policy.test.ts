import { describe, expect, it } from "vitest";
import {
  DEFAULT_RETAIL_PRICING_POLICY,
  NO_RETAIL_PRICING_OVERRIDES,
  normalizeRetailPricingPolicy,
  parseRetailPricingPolicyInput,
  suggestRetailPrice,
  type RetailPricingPolicy,
} from "./retail-pricing-policy";

const POLICY: RetailPricingPolicy = {
  ...DEFAULT_RETAIL_PRICING_POLICY,
  fixedOverheadRial: 50_000,
  percentOverhead: 10,
  profitMode: "markup",
  profitPercent: 20,
  rounding: "none",
};

const BASE = { policy: POLICY, overrides: NO_RETAIL_PRICING_OVERRIDES, taxPercent: null, minUnitRial: 10 };

describe("normalizeRetailPricingPolicy", () => {
  it("falls back to the defaults for nothing, junk or an old backup", () => {
    expect(normalizeRetailPricingPolicy(null)).toEqual(DEFAULT_RETAIL_PRICING_POLICY);
    expect(normalizeRetailPricingPolicy("x")).toEqual(DEFAULT_RETAIL_PRICING_POLICY);
    expect(normalizeRetailPricingPolicy([])).toEqual(DEFAULT_RETAIL_PRICING_POLICY);
  });

  it("drops single malformed values without touching the rest", () => {
    const policy = normalizeRetailPricingPolicy({
      fixedOverheadRial: -1,
      percentOverhead: 12,
      profitMode: "margin",
      profitPercent: 100, // a margin of 100% has no price
      rounding: "sideways",
      roundStepRial: 0,
      taxMode: "inclusive",
    });
    expect(policy).toMatchObject({
      fixedOverheadRial: null,
      percentOverhead: 12,
      profitMode: "margin",
      profitPercent: null,
      rounding: DEFAULT_RETAIL_PRICING_POLICY.rounding,
      roundStepRial: DEFAULT_RETAIL_PRICING_POLICY.roundStepRial,
      taxMode: "inclusive",
    });
  });
});

describe("parseRetailPricingPolicyInput", () => {
  it("keeps what the body omits and clears what it sets to null", () => {
    const result = parseRetailPricingPolicyInput({ profitPercent: null, rounding: "up" }, POLICY);
    expect(result).toEqual({ ok: true, policy: { ...POLICY, profitPercent: null, rounding: "up" } });
  });

  it("judges the profit percent against the mode being saved", () => {
    expect(parseRetailPricingPolicyInput({ profitPercent: 150 }, POLICY).ok).toBe(true);
    // 150% is a fine markup and an impossible margin.
    expect(parseRetailPricingPolicyInput({ profitMode: "margin", profitPercent: 150 }, POLICY)).toEqual({
      ok: false,
      error: "invalid_profit_percent",
    });
    expect(parseRetailPricingPolicyInput({ profitMode: "margin" }, { ...POLICY, profitPercent: 150 })).toEqual({
      ok: false,
      error: "invalid_profit_percent",
    });
  });

  it("rejects values JavaScript would happily coerce", () => {
    for (const body of [
      { fixedOverheadRial: "5000" },
      { fixedOverheadRial: 10.5 },
      { fixedOverheadRial: -1 },
      { percentOverhead: "" },
      { percentOverhead: 1001 },
      { roundStepRial: 0 },
      { roundStepRial: false },
    ]) {
      expect(parseRetailPricingPolicyInput(body, POLICY).ok).toBe(false);
    }
    expect(parseRetailPricingPolicyInput({ rounding: "none " }, POLICY)).toEqual({ ok: false, error: "invalid_rounding" });
    expect(parseRetailPricingPolicyInput({ taxMode: "both" }, POLICY)).toEqual({ ok: false, error: "invalid_tax_mode" });
    expect(parseRetailPricingPolicyInput(null, POLICY)).toEqual({ ok: false, error: "invalid_body" });
    expect(parseRetailPricingPolicyInput([], POLICY)).toEqual({ ok: false, error: "invalid_body" });
  });
});

describe("suggestRetailPrice", () => {
  it("adds the business overhead to the reference cost, then the profit", () => {
    const outcome = suggestRetailPrice({ ...BASE, referenceCostRial: 1_000_000 });
    // 1,000,000 + 100,000 (10%) + 50,000 = 1,150,000; × 1.2 = 1,380,000.
    expect(outcome).toMatchObject({ ok: true, sources: { overhead: "policy", profit: "policy" } });
    if (outcome.ok) expect(outcome.recommendation.suggestedPriceRial).toBe(1_380_000);
  });

  it("asks for a cost and a profit target rather than suggesting the cost back", () => {
    expect(suggestRetailPrice({ ...BASE, referenceCostRial: null })).toEqual({ ok: false, reason: "no_cost" });
    expect(suggestRetailPrice({ ...BASE, referenceCostRial: 0 })).toEqual({ ok: false, reason: "no_cost" });
    expect(suggestRetailPrice({ ...BASE, policy: { ...POLICY, profitPercent: null }, referenceCostRial: 1_000_000 })).toEqual({
      ok: false,
      reason: "no_profit",
    });
  });

  it("lets each overhead figure and the profit be overridden on its own", () => {
    const outcome = suggestRetailPrice({
      ...BASE,
      referenceCostRial: 1_000_000,
      overrides: { fixedOverheadRial: 0, percentOverhead: null, profitMode: "margin", profitPercent: 20 },
    });
    // Fixed overhead overridden to zero, the business's 10% kept, margin 20%:
    // (1,000,000 + 100,000) / 0.8 = 1,375,000.
    expect(outcome).toMatchObject({ ok: true, sources: { overhead: "product", profit: "product" } });
    if (outcome.ok) {
      expect(outcome.recommendation.suggestedPriceRial).toBe(1_375_000);
      expect(outcome.recommendation.mode).toBe("margin");
      expect(outcome.recommendation.inputs).toMatchObject({
        fixedOverheadRial: 0,
        percentOverhead: 10,
        marginPercent: 20,
        markupPercent: null,
      });
    }
  });

  it("rounds to the policy step but never below what the price field can hold", () => {
    const stepped = suggestRetailPrice({
      ...BASE,
      policy: { ...POLICY, rounding: "up", roundStepRial: 100_000 },
      referenceCostRial: 1_000_000,
    });
    if (stepped.ok) expect(stepped.recommendation.suggestedPriceRial).toBe(1_400_000);

    const exact = suggestRetailPrice({
      ...BASE,
      policy: { ...POLICY, fixedOverheadRial: null, percentOverhead: null, profitPercent: 5, rounding: "none" },
      referenceCostRial: 1_010,
    });
    // 1,060.5 Rial is not a whole Toman; the field takes 10-Rial steps.
    if (exact.ok) expect(exact.recommendation.suggestedPriceRial % 10).toBe(0);
  });

  it("keeps exclusive tax out of the price and inside the shelf price when inclusive", () => {
    const exclusive = suggestRetailPrice({
      ...BASE,
      policy: { ...POLICY, fixedOverheadRial: null, percentOverhead: null, profitPercent: 10, taxMode: "exclusive" },
      referenceCostRial: 1_000_000,
      taxPercent: 10,
    });
    const inclusive = suggestRetailPrice({
      ...BASE,
      policy: { ...POLICY, fixedOverheadRial: null, percentOverhead: null, profitPercent: 10, taxMode: "inclusive" },
      referenceCostRial: 1_000_000,
      taxPercent: 10,
    });
    expect(exclusive.ok && exclusive.recommendation.suggestedPriceRial).toBe(1_100_000);
    // Inclusive: the suggestion is the shelf price and already contains the tax,
    // so the profit is what is left once the tax is taken out of it.
    expect(inclusive.ok && inclusive.recommendation.suggestedPriceRial).toBe(1_100_000);
    expect(inclusive.ok && inclusive.preview.breakdown.taxAmountRial).toBe(100_000);
    expect(inclusive.ok && inclusive.preview.breakdown.grossProfitRial).toBe(0);
  });

  it("treats a zero tax rate as no tax", () => {
    const outcome = suggestRetailPrice({
      ...BASE,
      policy: { ...POLICY, taxMode: "inclusive" },
      referenceCostRial: 1_000_000,
      taxPercent: 0,
    });
    if (outcome.ok) expect(outcome.recommendation.inputs).toMatchObject({ taxPercent: null, taxMode: null });
  });
});
