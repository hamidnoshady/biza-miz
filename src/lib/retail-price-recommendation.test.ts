import { describe, expect, it } from "vitest";
import { recommendRetailPrice } from "./retail-price-recommendation";

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
