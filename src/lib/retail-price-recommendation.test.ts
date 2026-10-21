import { describe, expect, it } from "vitest";
import { previewRetailPrice, recommendRetailPrice } from "./retail-price-recommendation";

describe("retail price recommendation", () => {
  it("cost = reference + fixed overhead", () => {
    const r = recommendRetailPrice({ referencePurchase: 100_000, fixedOverhead: 10_000 });
    expect(r.costRial).toBe(110_000);
    expect(r.breakdown.overheadTotal).toBe(10_000);
  });

  it("percent overhead with declared base", () => {
    const a = recommendRetailPrice({ referencePurchase: 100_000, percentOverhead: 10, overheadBase: "reference" });
    expect(a.costRial).toBe(110_000);
    const b = recommendRetailPrice({ referencePurchase: 100_000, fixedOverhead: 10_000, percentOverhead: 10, overheadBase: "with_fixed" });
    // (100k+10k)*10% =11k +10k =21k overhead =>121k cost
    expect(b.costRial).toBe(121_000);
  });

  it("markup price = cost*(1+markup/100)", () => {
    const r = recommendRetailPrice({ referencePurchase: 100_000, targetMarkup: 20 });
    // cost 100k, markup 20% =>120k
    expect(r.suggestedPriceRial).toBe(120_000);
    expect(r.breakdown.profitType).toBe("markup");
  });

  it("margin price = cost/(1-margin/100)", () => {
    const r = recommendRetailPrice({ referencePurchase: 100_000, targetMargin: 20 });
    // 100k /0.8=125k
    expect(r.suggestedPriceRial).toBe(125_000);
    expect(r.breakdown.profitType).toBe("margin");
  });

  it("never labels markup as margin", () => {
    const a = recommendRetailPrice({ referencePurchase: 100_000, targetMarkup: 10 });
    const b = recommendRetailPrice({ referencePurchase: 100_000, targetMargin: 10 });
    expect(a.breakdown.profitType).toBe("markup");
    expect(b.breakdown.profitType).toBe("margin");
  });

  it("rounding policies", () => {
    const nearest = recommendRetailPrice({ referencePurchase: 100_000, targetMarkup: 33.333, rounding: "nearest" });
    expect(Number.isInteger(nearest.suggestedPriceRial)).toBe(true);
    const up = recommendRetailPrice({ referencePurchase: 100_000, targetMarkup: 33.333, rounding: "up" });
    const down = recommendRetailPrice({ referencePurchase: 100_000, targetMarkup: 33.333, rounding: "down" });
    expect(up.suggestedPriceRial).toBeGreaterThanOrEqual(down.suggestedPriceRial);
  });

  it("tax preview exclusive vs inclusive", () => {
    const exclusive = recommendRetailPrice({ referencePurchase: 100_000, targetMarkup: 10, tax: { mode: "exclusive", percent: 10 } });
    // preTax 110k, tax 11k =>121k final
    expect(exclusive.breakdown.taxAmount).toBe(11_000);
    expect(exclusive.suggestedPriceRial).toBe(121_000);
    const inclusive = recommendRetailPrice({ referencePurchase: 100_000, targetMarkup: 10, tax: { mode: "inclusive", percent: 10 } });
    // preTax 110k inclusive, tax portion ~10k, final stays 110k
    expect(inclusive.suggestedPriceRial).toBe(110_000);
    expect(inclusive.breakdown.taxAmount).not.toBeNull();
  });

  it("rejects invalid inputs", () => {
    expect(() => recommendRetailPrice({ referencePurchase: -1 })).toThrow();
    expect(() => recommendRetailPrice({ referencePurchase: 100_000, targetMarkup: 10, targetMargin: 10 })).toThrow();
    expect(() => recommendRetailPrice({ referencePurchase: 100_000, targetMargin: 100 })).toThrow();
    expect(() => recommendRetailPrice({ referencePurchase: 100_000, targetMargin: -5 })).toThrow();
  });

  it("handles 0 reference and zero-cost goods", () => {
    const r = recommendRetailPrice({ referencePurchase: 0, targetMarkup: 10 });
    expect(r.costRial).toBe(0);
    expect(r.suggestedPriceRial).toBe(0);
  });

  it("margin below 100% formula", () => {
    const r = recommendRetailPrice({ referencePurchase: 80_000, fixedOverhead: 20_000, targetMargin: 25 });
    // cost 100k, margin 25% =>133333
    expect(r.suggestedPriceRial).toBe(133_333);
  });

  it("high Rial values remain integer and safe", () => {
    const r = recommendRetailPrice({ referencePurchase: 9_000_000_000, targetMarkup: 10 });
    expect(r.suggestedPriceRial).toBe(9_900_000_000);
  });
});

describe("previewRetailPrice (UI contract)", () => {
  it("returns derived margin and markup without conflating them", () => {
    const r = previewRetailPrice({
      referenceCost: { amountRial: 100_000 },
      target: { kind: "markup", percent: 20 },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.suggestedPriceRial).toBe(120_000);
    expect(r.breakdown.grossProfitRial).toBe(20_000);
    expect(r.breakdown.markupPercent).toBe(20);
    expect(r.breakdown.marginPercent).toBe(16.67);
    expect(r.taxPreview).toBeNull();
  });

  it("margin target yields the documented margin, not markup", () => {
    const r = previewRetailPrice({
      referenceCost: { amountRial: 100_000 },
      target: { kind: "margin", percent: 20 },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.suggestedPriceRial).toBe(125_000);
    expect(r.breakdown.marginPercent).toBe(20);
  });

  it("inclusive VAT is extracted and never counted as profit", () => {
    const r = previewRetailPrice({
      referenceCost: { amountRial: 100_000 },
      target: { kind: "markup", percent: 10 },
      tax: { percent: 10, mode: "inclusive" },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.suggestedPriceRial).toBe(110_000);
    expect(r.breakdown.preTaxPriceRial).toBe(100_000);
    expect(r.taxPreview).toEqual({ taxRial: 10_000, payableRial: 110_000 });
    // Net-of-VAT price equals cost, so there is no profit to report.
    expect(r.breakdown.grossProfitRial).toBe(0);
  });

  it("exclusive VAT adds tax on top of the profit-bearing price", () => {
    const r = previewRetailPrice({
      referenceCost: { amountRial: 100_000 },
      target: { kind: "markup", percent: 10 },
      tax: { percent: 10, mode: "exclusive" },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.breakdown.grossProfitRial).toBe(10_000);
    expect(r.suggestedPriceRial).toBe(121_000);
    expect(r.taxPreview).toEqual({ taxRial: 11_000, payableRial: 121_000 });
  });

  it("rounds the suggested price to the configured step", () => {
    const r = previewRetailPrice({
      referenceCost: { amountRial: 100_000 },
      target: { kind: "markup", percent: 33.333 },
      rounding: { policy: "nearest", stepRial: 10_000 },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.suggestedPriceRial).toBe(130_000);
    expect(r.suggestedPriceRial % 10_000).toBe(0);
  });

  it("rejects non-Rial reference currency rather than guessing a rate", () => {
    const r = previewRetailPrice({
      referenceCost: { amountRial: 100_000, currency: "IRT" },
      target: { kind: "markup", percent: 10 },
    });
    expect(r).toEqual({ ok: false, error: "unsupported_currency" });
  });

  it("returns validation failures as values", () => {
    const r = previewRetailPrice({
      referenceCost: { amountRial: 100_000 },
      target: { kind: "margin", percent: 100 },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("targetMargin_invalid");
  });
});
