import { describe, expect, it } from "vitest";
import {
  formatRial,
  normalizeNumericString,
  parseOptionalSafeIntInput,
  parseSafeIntInput,
  parseThresholdsInput,
  rialToToman,
  tomanLabel,
  tomanToRial,
} from "./platform-money";

describe("platform-money normalization and validation", () => {
  it("normalizes Persian and Arabic digits and strips thousand separators", () => {
    expect(normalizeNumericString("۱۲۳٬۴۵۶")).toBe("123456");
    expect(normalizeNumericString("١٢٣,٤٥٦")).toBe("123456");
    expect(normalizeNumericString("  ۵۰۰_۰۰۰ ")).toBe("500000");
    expect(normalizeNumericString("۱۰۰،۰۰۰")).toBe("100000");
  });

  it("parses safe integer inputs and rejects malformed, fractional, or out-of-range values", () => {
    expect(parseSafeIntInput("۲۵۰٬۰۰۰")).toBe(250_000);
    expect(parseSafeIntInput(100_000)).toBe(100_000);
    expect(parseSafeIntInput("0", { min: 0 })).toBe(0);
    expect(parseSafeIntInput("0", { allowZero: false })).toBeNull();
    expect(parseSafeIntInput("-50", { min: 0 })).toBeNull();
    expect(parseSafeIntInput("-۵۰", { min: -1000 })).toBe(-50);
    expect(parseSafeIntInput("12.5")).toBeNull();
    expect(parseSafeIntInput("۱۲٫۵")).toBeNull();
    expect(parseSafeIntInput("abc")).toBeNull();
    expect(parseSafeIntInput("")).toBeNull();
    expect(parseSafeIntInput(Number.NaN)).toBeNull();
    expect(parseSafeIntInput(Number.POSITIVE_INFINITY)).toBeNull();
    expect(parseSafeIntInput("99999999999999999999")).toBeNull();
  });

  it("parses optional integer inputs distinguishing unset from invalid", () => {
    expect(parseOptionalSafeIntInput("")).toEqual({ ok: true, value: null });
    expect(parseOptionalSafeIntInput(null)).toEqual({ ok: true, value: null });
    expect(parseOptionalSafeIntInput(undefined)).toEqual({ ok: true, value: null });
    expect(parseOptionalSafeIntInput("۱٬۰۰۰٬۰۰۰")).toEqual({ ok: true, value: 1_000_000 });
    expect(parseOptionalSafeIntInput("invalid")).toEqual({ ok: false });
    expect(parseOptionalSafeIntInput("-10", { min: 0 })).toEqual({ ok: false });
  });

  it("parses and deduplicates percentage thresholds", () => {
    expect(parseThresholdsInput("۵۰، ۷۵, ۹۰, ۱۰۰, ۷۵")).toEqual([50, 75, 90, 100]);
    expect(parseThresholdsInput([90, "50", 100])).toEqual([50, 90, 100]);
    expect(parseThresholdsInput("0, 50")).toBeNull();
    expect(parseThresholdsInput("50, 120")).toBeNull();
    expect(parseThresholdsInput("abc")).toBeNull();
  });

  it("converts between Rial and Toman", () => {
    expect(rialToToman(100_000)).toBe(10_000);
    expect(tomanToRial(10_000)).toBe(100_000);
    expect(tomanLabel(100_000)).toContain("تومان");
    expect(formatRial(100_000)).toBeTruthy();
  });
});
