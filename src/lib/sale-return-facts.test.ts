import { describe, expect, it } from "vitest";
import { allocateProportionally, parseSaleMerchSnapshot } from "./sale-return-facts";

describe("allocateProportionally (GH #1567 F4)", () => {
  it("splits exactly — the parts always sum to the total", () => {
    expect(allocateProportionally(100n, [1n, 1n, 1n])).toEqual([34n, 33n, 33n]);
    expect(allocateProportionally(50_000n, [200_000n, 100_000n])).toEqual([33_333n, 16_667n]);
    const parts = allocateProportionally(1_000_001n, [7n, 13n, 0n, 29n]);
    expect(parts.reduce((a, b) => a + b, 0n)).toBe(1_000_001n);
    expect(parts[2]).toBe(0n);
  });

  it("falls back to an even split when every weight is zero, and handles nothing to split", () => {
    expect(allocateProportionally(0n, [5n, 5n])).toEqual([0n, 0n]);
    expect(allocateProportionally(10n, []).length).toBe(0);
    const even = allocateProportionally(10n, [0n, 0n, 0n]);
    expect(even.reduce((a, b) => a + b, 0n)).toBe(10n);
  });
});

describe("parseSaleMerchSnapshot", () => {
  it("returns null for a legacy line with no snapshot and keeps nulls honest", () => {
    expect(parseSaleMerchSnapshot(undefined)).toBeNull();
    expect(parseSaleMerchSnapshot(null)).toBeNull();
    expect(parseSaleMerchSnapshot({ collection: "بهار", season: null, category: "", brandId: null })).toEqual({
      collection: "بهار", season: null, category: null, brandId: null,
    });
  });
});
