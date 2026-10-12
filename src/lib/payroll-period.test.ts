import { describe, expect, it } from "vitest";
import {
  normalizePeriodText,
  parsePayrollPeriod,
  payrollPeriodKey,
  payrollPeriodKeyForLabel,
  resolvePayrollPeriodFilter,
  resolvePayrollPeriodKey,
} from "./payroll-period";

/** The same calendar month, written every way a person (or a paste) might. */
const MORDAD_1404_VARIANTS = [
  "مرداد ۱۴۰۴", // Persian digits
  "مرداد 1404", // ASCII digits
  "مرداد ١٤٠٤", // Arabic-Indic digits
  "  مرداد   ۱۴۰۴  ", // padding and a double space
  "مرداد\u00a0۱۴۰۴", // no-break space
  "مرداد\u200f ۱۴۰۴", // right-to-left mark from a paste
  "حقوق مرداد ماه ۱۴۰۴", // extra words around the month
  "1404/05",
  "۱۴۰۴-۰۵",
  "۱۴۰۴.۵",
];

/** The spellings a *key* may arrive in: the canonical shape, written with any digits, dash or padding. */
const MORDAD_1404_KEY_VARIANTS = [
  "1404-05",
  "۱۴۰۴-۰۵", // Persian digits
  "١٤٠٤-٠٥", // Arabic-Indic digits
  " 1404 - 05 ", // padding around the dash
  "1404\u200f-05", // right-to-left mark from a paste
  "1404–05", // en dash
  "1404−05", // minus sign
  "\u00a01404-05\u00a0", // no-break spaces
];

describe("normalizePeriodText", () => {
  it("folds digits, Arabic letter variants, invisible marks and spacing to one spelling", () => {
    expect(normalizePeriodText("  مرداد\u200c   ۱۴۰۴ ")).toBe("مرداد 1404");
    expect(normalizePeriodText("ارديبهشت ١٤٠٤")).toBe(normalizePeriodText("اردیبهشت 1404"));
    expect(normalizePeriodText("كار")).toBe("کار");
    expect(normalizePeriodText("آبان")).toBe(normalizePeriodText("ابان"));
    expect(normalizePeriodText("JULY 2025")).toBe("july 2025");
  });

  it("is idempotent", () => {
    for (const text of MORDAD_1404_VARIANTS) {
      const once = normalizePeriodText(text);
      expect(normalizePeriodText(once)).toBe(once);
    }
  });
});

describe("parsePayrollPeriod", () => {
  it("resolves every spelling of one month to the same calendar month", () => {
    for (const text of MORDAD_1404_VARIANTS) {
      expect(parsePayrollPeriod(text), text).toEqual({ year: 1404, month: 5 });
    }
  });

  it("knows all twelve month names, including the آ/ا and ی/ي spellings", () => {
    const names = ["فروردین", "اردیبهشت", "خرداد", "تیر", "مرداد", "شهریور", "مهر", "آبان", "آذر", "دی", "بهمن", "اسفند"];
    names.forEach((name, index) => {
      expect(parsePayrollPeriod(`${name} ۱۴۰۳`)).toEqual({ year: 1403, month: index + 1 });
    });
    expect(parsePayrollPeriod("ابان 1403")).toEqual({ year: 1403, month: 8 });
    expect(parsePayrollPeriod("اذر 1403")).toEqual({ year: 1403, month: 9 });
    expect(parsePayrollPeriod("فروردين 1403")).toEqual({ year: 1403, month: 1 });
  });

  it("does not guess when the text is ambiguous or not a month", () => {
    expect(parsePayrollPeriod("مرداد")).toBeNull(); // no year
    expect(parsePayrollPeriod("۱۴۰۴")).toBeNull(); // no month
    expect(parsePayrollPeriod("مرداد و شهریور ۱۴۰۴")).toBeNull(); // two months
    expect(parsePayrollPeriod("مرداد ۱۴۰۳ ۱۴۰۴")).toBeNull(); // two years
    expect(parsePayrollPeriod("1404/13")).toBeNull(); // no thirteenth month
    expect(parsePayrollPeriod("1404/00")).toBeNull();
    expect(parsePayrollPeriod("مرداد 2025")).toBeNull(); // not a Jalali year
    expect(parsePayrollPeriod("")).toBeNull();
    expect(parsePayrollPeriod("   ")).toBeNull();
  });
});

describe("resolvePayrollPeriodKey (the accrual request)", () => {
  it("gives every spelling of a key the same month, key, label and calendar range", () => {
    for (const input of MORDAD_1404_KEY_VARIANTS) {
      const resolved = resolvePayrollPeriodKey(input);
      expect(resolved.ok, input).toBe(true);
      if (!resolved.ok) continue;
      expect(resolved.period.key).toBe("1404-05");
      expect(resolved.period.label).toBe("مرداد 1404");
      // Mordad 1404 is 31 days: 1404-05-01 = 2025-07-23 … 1404-05-31 = 2025-08-22.
      expect(resolved.period.startsOn).toBe("2025-07-23");
      expect(resolved.period.endsOn).toBe("2025-08-22");
    }
  });

  it("refuses a heading, a non-month, a non-string and a year Jalali cannot be", () => {
    for (const input of [
      "مرداد ۱۴۰۴", // a heading is not a key
      "1404-5", // the month is two digits
      "1404/05", // the separator is a dash
      "1404.05",
      "1404-13",
      "1404-00",
      "1404",
      "2025-07", // Gregorian year
      "1200-05",
      "1600-05",
      "1404-05-01",
      "",
      "   ",
      "banana",
      202405,
      null,
      undefined,
      { year: 1404, month: 5 },
      ["1404-05"],
    ]) {
      expect(resolvePayrollPeriodKey(input), JSON.stringify(input)).toEqual({ ok: false, error: "invalid_period" });
    }
  });
});

describe("resolvePayrollPeriodFilter (the history's period filter)", () => {
  it("compares identities, not spellings: a key or a heading resolves to the same month", () => {
    for (const input of [...MORDAD_1404_VARIANTS, ...MORDAD_1404_KEY_VARIANTS]) {
      const resolved = resolvePayrollPeriodFilter(input);
      expect(resolved.ok, input).toBe(true);
      if (resolved.ok) expect(resolved.period.key, input).toBe("1404-05");
    }
  });

  it("refuses what names no single month", () => {
    for (const input of ["مرداد", "پاداش عید", "", "1404-13"]) {
      expect(resolvePayrollPeriodFilter(input), input).toEqual({ ok: false, error: "invalid_period" });
    }
  });
});

describe("period keys", () => {
  it("zero-pads the month so keys sort and compare as text", () => {
    expect(payrollPeriodKey({ year: 1404, month: 5 })).toBe("1404-05");
    expect(payrollPeriodKey({ year: 1404, month: 12 })).toBe("1404-12");
  });

  it("derives, from a legacy run's free-text label, the key of the month it duplicates", () => {
    expect(payrollPeriodKeyForLabel("مرداد 1404")).toBe("1404-05");
    expect(payrollPeriodKeyForLabel("  مرداد   ۱۴۰۴ ")).toBe("1404-05");
    expect(payrollPeriodKeyForLabel("حقوق مرداد ماه ۱۴۰۴")).toBe("1404-05");
  });

  it("returns null for a legacy label that names no single month (nothing to collide with)", () => {
    expect(payrollPeriodKeyForLabel("مرداد")).toBeNull();
    expect(payrollPeriodKeyForLabel("پاداش عید")).toBeNull();
    expect(payrollPeriodKeyForLabel("")).toBeNull();
  });
});
