import { describe, expect, it } from "vitest";
import { businessVatPercent } from "./vat-policy";

describe("businessVatPercent", () => {
  it("reads the business's own configured rate, including 0", () => {
    expect(businessVatPercent({ defaultRate: 10 })).toBe(10);
    expect(businessVatPercent({ defaultRate: 0 })).toBe(0);
    expect(businessVatPercent({ defaultRate: 12.5 })).toBe(12.5);
    expect(businessVatPercent({ defaultRate: "9" })).toBe(9);
  });

  it("never assumes a rate the business did not configure", () => {
    expect(businessVatPercent(null)).toBe(0);
    expect(businessVatPercent(undefined)).toBe(0);
    expect(businessVatPercent({})).toBe(0);
    expect(businessVatPercent({ defaultRate: "" })).toBe(0);
  });

  it("rejects an out-of-range or unreadable rate instead of applying it", () => {
    expect(businessVatPercent({ defaultRate: -1 })).toBe(0);
    expect(businessVatPercent({ defaultRate: 101 })).toBe(0);
    expect(businessVatPercent({ defaultRate: "abc" })).toBe(0);
    expect(businessVatPercent({ defaultRate: Number.NaN })).toBe(0);
  });
});
