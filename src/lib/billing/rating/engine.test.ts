import { describe, expect, it } from "vitest";
import {
  applyTaxAndRounding,
  calculateCommercialQuote,
  rateQuantity,
  rateStorageDay,
  selectPriceVersion,
} from "./engine";

const v4 = {
  version: 4,
  effectiveFrom: "2026-09-01T00:00:00.000Z",
  effectiveUntil: "2027-01-01T00:00:00.000Z",
  unitAmountRial: 100,
  unitSize: 1,
};
const v5 = {
  version: 5,
  effectiveFrom: "2027-01-01T00:00:00.000Z",
  effectiveUntil: null,
  unitAmountRial: 200,
  unitSize: 1,
};

describe("rating", () => {
  it("selects the price version effective at the usage instant", () => {
    expect(selectPriceVersion([v5, v4], "2026-09-18T00:00:00.000Z")?.version).toBe(4);
    expect(selectPriceVersion([v5, v4], "2027-02-01T00:00:00.000Z")?.version).toBe(5);
  });

  it("consumes allowance before overage and refuses a missing price", () => {
    const rated = rateQuantity({
      quantity: 150,
      includedRemaining: 100,
      overageEnabled: true,
      hardLimit: null,
      price: { unitAmountRial: 10, unitSize: 1 },
      rounding: "ceil",
    });
    expect(rated.includedConsumed).toBe(100);
    expect(rated.overageQuantity).toBe(50);
    expect(rated.amountRial).toBe(500);
    expect(rated.blocked).toBe(false);

    const missing = rateQuantity({
      quantity: 10,
      includedRemaining: 0,
      overageEnabled: true,
      hardLimit: null,
      price: null,
      rounding: "ceil",
    });
    expect(missing.blocked).toBe(true);
    expect(missing.blockReason).toBe("no_price");
    expect(missing.amountRial).toBe(0);
  });

  it("applies taxRateBps and rounding (ceil vs floor) consistently", () => {
    const ceilTax = applyTaxAndRounding({
      subtotalRial: 1_005,
      taxRateBps: 900, // 9% -> 90.45
      rounding: "ceil",
    });
    expect(ceilTax.taxRial).toBe(91);
    expect(ceilTax.totalRial).toBe(1_096);

    const floorTax = applyTaxAndRounding({
      subtotalRial: 1_005,
      taxRateBps: 900, // 9% -> 90.45
      rounding: "floor",
    });
    expect(floorTax.taxRial).toBe(90);
    expect(floorTax.totalRial).toBe(1_095);
  });

  it("rates daily storage with ceil and floor rounding", () => {
    const halfGbBytes = 512 * 1024 * 1024;
    const tariff = {
      billingEnabled: true,
      dailyFlatRial: 1_000,
      dailyPerGbRial: 101,
      freeQuotaMb: 0,
    };
    expect(rateStorageDay(halfGbBytes, tariff, "ceil").perGbRial).toBe(51);
    expect(rateStorageDay(halfGbBytes, tariff, "floor").perGbRial).toBe(50);
  });

  it("computes commercial quotes for plan + recurring add-ons, top-ups (with minimum check), and meters", () => {
    const planQuote = calculateCommercialQuote({
      kind: "plan",
      basePlanRial: 1_000_000,
      addons: [{ featureKey: "crm", description: "CRM", amountRial: 200_000 }],
      taxRateBps: 1_000, // 10%
      rounding: "ceil",
    });
    expect(planQuote.valid).toBe(true);
    expect(planQuote.subtotalRial).toBe(1_200_000);
    expect(planQuote.taxRial).toBe(120_000);
    expect(planQuote.totalRial).toBe(1_320_000);

    const lowTopUp = calculateCommercialQuote({
      kind: "topup",
      amountRial: 50_000,
      minimumTopUpRial: 100_000,
      isPackage: false,
    });
    expect(lowTopUp.valid).toBe(false);
    expect(lowTopUp.error).toBe("below_minimum_top_up");

    const okTopUp = calculateCommercialQuote({
      kind: "topup",
      amountRial: 200_000,
      minimumTopUpRial: 100_000,
      isPackage: false,
      taxRateBps: 900,
      rounding: "ceil",
    });
    expect(okTopUp.valid).toBe(true);
    expect(okTopUp.creditRial).toBe(200_000);
    expect(okTopUp.taxRial).toBe(18_000);
    expect(okTopUp.totalRial).toBe(218_000);
  });
});
