import { describe, expect, it } from "vitest";
import {
  computeRepairCharge,
  computeWatchSalePrice,
  validateRepairChargeInput,
  validateWatchSalePriceInput,
} from "./watch-pricing";

describe("computeWatchSalePrice", () => {
  it("applies VAT to the whole net price — unlike gold, nothing here is VAT-exempt", () => {
    const breakdown = computeWatchSalePrice({ price: 50_000_000, vatPercent: 9 });
    expect(breakdown).toEqual({
      price: "50000000",
      discount: "0",
      net: "50000000",
      vat: "4500000",
      total: "54500000",
    });
  });

  it("takes VAT on the discounted price, not the list price", () => {
    const breakdown = computeWatchSalePrice({ price: 50_000_000, discount: 5_000_000, vatPercent: 9 });
    expect(breakdown.net).toBe("45000000");
    expect(breakdown.vat).toBe("4050000");
    expect(breakdown.total).toBe("49050000");
  });

  it("rounds VAT to whole Rial so the components always sum to the total", () => {
    const breakdown = computeWatchSalePrice({ price: 1_234_567, vatPercent: 9 });
    expect(breakdown.vat).toBe("111111"); // 111,111.03 -> 111,111
    expect(BigInt(breakdown.net) + BigInt(breakdown.vat)).toBe(BigInt(breakdown.total));
  });

  it("handles a zero VAT rate", () => {
    const breakdown = computeWatchSalePrice({ price: 10_000_000, vatPercent: 0 });
    expect(breakdown.vat).toBe("0");
    expect(breakdown.total).toBe("10000000");
  });

  it("rejects a non-positive or fractional price, an over-price discount, and an out-of-range VAT rate", () => {
    expect(validateWatchSalePriceInput({ price: 0, vatPercent: 9 }).length).toBe(1);
    expect(validateWatchSalePriceInput({ price: 1.5, vatPercent: 9 }).length).toBe(1);
    expect(validateWatchSalePriceInput({ price: 100, discount: 200, vatPercent: 9 }).length).toBe(1);
    expect(validateWatchSalePriceInput({ price: 100, vatPercent: 120 }).length).toBe(1);
    expect(() => computeWatchSalePrice({ price: -1, vatPercent: 9 })).toThrow();
  });
});

describe("computeRepairCharge", () => {
  it("bills labor plus parts, with VAT on the sum", () => {
    const breakdown = computeRepairCharge({ laborCharge: 2_000_000, partsCharge: 800_000, vatPercent: 9 });
    expect(breakdown).toEqual({
      laborCharge: "2000000",
      partsCharge: "800000",
      discount: "0",
      net: "2800000",
      vat: "252000",
      total: "3052000",
    });
  });

  it("subtracts an agreed discount before VAT (issue #795 item 11)", () => {
    const breakdown = computeRepairCharge({
      laborCharge: 2_000_000,
      partsCharge: 800_000,
      discount: 300_000,
      vatPercent: 9,
    });
    expect(breakdown).toEqual({
      laborCharge: "2000000",
      partsCharge: "800000",
      discount: "300000",
      net: "2500000",
      vat: "225000",
      total: "2725000",
    });
    // The discount may wipe the bill but never exceed it.
    expect(
      validateRepairChargeInput({ laborCharge: 100, partsCharge: 0, discount: 101, vatPercent: 9 }).length,
    ).toBe(1);
    expect(
      validateRepairChargeInput({ laborCharge: 100, partsCharge: 0, discount: 100, vatPercent: 9 }).length,
    ).toBe(0);
  });

  it("computes an all-zero bill for a warranty repair", () => {
    const breakdown = computeRepairCharge({ laborCharge: 0, partsCharge: 0, vatPercent: 9 });
    expect(breakdown.net).toBe("0");
    expect(breakdown.total).toBe("0");
  });

  it("rejects negative or fractional amounts and an out-of-range VAT rate", () => {
    expect(validateRepairChargeInput({ laborCharge: -1, partsCharge: 0, vatPercent: 9 }).length).toBe(1);
    expect(validateRepairChargeInput({ laborCharge: 0, partsCharge: 1.5, vatPercent: 9 }).length).toBe(1);
    expect(validateRepairChargeInput({ laborCharge: 0, partsCharge: 0, vatPercent: -1 }).length).toBe(1);
  });
});
