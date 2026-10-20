import { describe, expect, it } from "vitest";
import { recommendRetailPrice } from "./retail-price-recommendation";

const base = {
  purchaseCostRial: "10000",
  fixedOverheadRial: "1000",
  overheadPercent: "10",
  targetPercent: "20",
};

describe("retail price recommendation", () => {
  it("uses purchase cost as the percentage-overhead base and calculates markup", () => {
    const result = recommendRetailPrice({ ...base, targetMode: "markup" });
    expect(result).toEqual({
      ok: true,
      value: {
        purchaseCostRial: "10000",
        fixedOverheadRial: "1000",
        percentageOverheadRial: "1000",
        totalCostRial: "12000",
        targetProfitRial: "2400",
        suggestedPriceRial: "14400",
        realizedMarkupPercent: "20.00",
        realizedMarginPercent: "16.67",
      },
    });
  });

  it("calculates gross margin as cost divided by one minus the target margin", () => {
    const result = recommendRetailPrice({
      ...base,
      targetPercent: "25",
      targetMode: "gross_margin",
    });
    expect(result.ok && result.value.suggestedPriceRial).toBe("16000");
    expect(result.ok && result.value.realizedMarginPercent).toBe("25.00");
  });

  it("rounds to integer Rial deterministically without floating-point arithmetic", () => {
    const result = recommendRetailPrice({
      purchaseCostRial: "1",
      fixedOverheadRial: "0",
      overheadPercent: "0",
      targetPercent: "50",
      targetMode: "markup",
    });
    expect(result.ok && result.value.suggestedPriceRial).toBe("2");
  });

  it("reports missing or invalid input and rejects a 100 percent gross margin", () => {
    expect(recommendRetailPrice({ ...base, purchaseCostRial: null, targetMode: "markup" })).toEqual({ ok: false, error: "missing_cost" });
    expect(recommendRetailPrice({ ...base, targetPercent: "100", targetMode: "gross_margin" })).toEqual({ ok: false, error: "invalid_margin" });
    expect(recommendRetailPrice({ ...base, overheadPercent: "-1", targetMode: "markup" })).toEqual({ ok: false, error: "invalid_percent" });
  });
});
