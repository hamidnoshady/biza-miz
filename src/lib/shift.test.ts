import { describe, expect, it } from "vitest";
import { isValidCashFloat, reconcileCash, shiftStatus } from "./shift";

describe("shiftStatus", () => {
  it("is open when there is no end time", () => {
    expect(shiftStatus({ endedAt: null })).toBe("open");
  });

  it("is closed once an end time is set", () => {
    expect(shiftStatus({ endedAt: "2026-01-01T12:00:00Z" })).toBe("closed");
    expect(shiftStatus({ endedAt: new Date("2026-01-01T12:00:00Z") })).toBe("closed");
  });
});

describe("isValidCashFloat", () => {
  it("accepts a non-negative integer", () => {
    expect(isValidCashFloat(0)).toBe(true);
    expect(isValidCashFloat(500_000)).toBe(true);
  });

  it("rejects negative amounts", () => {
    expect(isValidCashFloat(-1)).toBe(false);
  });

  it("rejects non-integer amounts", () => {
    expect(isValidCashFloat(1000.5)).toBe(false);
    expect(isValidCashFloat(NaN)).toBe(false);
    expect(isValidCashFloat(Infinity)).toBe(false);
  });

  it("rejects an integer beyond the exactly representable range", () => {
    // 1e21 is an integer to `Number.isInteger`, but not a Rial amount any
    // bigint round-trip (the sync path) can carry.
    expect(isValidCashFloat(1e21)).toBe(false);
    expect(isValidCashFloat(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(isValidCashFloat(Number.MAX_SAFE_INTEGER + 1)).toBe(false);
  });
});

describe("reconcileCash", () => {
  it("expects the opening float plus cash sales, and reports zero variance on an exact count", () => {
    const result = reconcileCash(500_000, 1_800_000, 1_300_000);
    expect(result.expectedCash).toBe(1_800_000);
    expect(result.variance).toBe(0);
  });

  it("reports a positive variance when the drawer counted over expected", () => {
    const result = reconcileCash(500_000, 1_850_000, 1_300_000);
    expect(result.variance).toBe(50_000);
  });

  it("reports a negative variance when the drawer counted short", () => {
    const result = reconcileCash(500_000, 1_700_000, 1_300_000);
    expect(result.variance).toBe(-100_000);
  });
});
