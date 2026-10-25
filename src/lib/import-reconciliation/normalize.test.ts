import { describe, expect, it } from "vitest";
import {
  compareDecimal,
  decimalDelta,
  decimalEquals,
  importAmountToRial,
  normalizeBarcodeKey,
  normalizeEmailKey,
  normalizeNameKey,
  normalizePhoneKey,
  normalizeReferenceKey,
  normalizeSkuKey,
} from "./normalize";

describe("identity keys", () => {
  it("folds Persian digits, case and spacing in a SKU", () => {
    expect(normalizeSkuKey("  ab ۱۲۳ ")).toBe("AB 123");
    expect(normalizeSkuKey("ab‌۱۲۳")).toBe("AB123");
  });

  it("never turns a placeholder or blank into a key", () => {
    for (const raw of ["", "  ", "-", "N/A", "null", "ندارد", undefined, null]) {
      expect(normalizeSkuKey(raw as string | null | undefined)).toBeNull();
    }
    expect(normalizeBarcodeKey("-")).toBeNull();
    expect(normalizeNameKey("--")).toBeNull();
  });

  it("accepts only digit barcodes of a plausible length", () => {
    expect(normalizeBarcodeKey("۶۲۶۰۰۰۰۰۰۰۰۱۲")).toBe("6260000000012");
    expect(normalizeBarcodeKey("12-345")).toBeNull();
    expect(normalizeBarcodeKey("ABC123456")).toBeNull();
  });

  it("folds Arabic letter variants in names", () => {
    expect(normalizeNameKey("كتاب  يک")).toBe(normalizeNameKey("کتاب یک"));
  });

  it("normalises phone to E.164 and rejects garbage", () => {
    expect(normalizePhoneKey("۰۹۱۲ ۱۲۳ ۴۵۶۷")).toBe("+989121234567");
    expect(normalizePhoneKey("+98 912 123 4567")).toBe("+989121234567");
    expect(normalizePhoneKey("12")).toBeNull();
  });

  it("lower-cases e-mail and rejects non-addresses", () => {
    expect(normalizeEmailKey(" Ali@Example.COM ")).toBe("ali@example.com");
    expect(normalizeEmailKey("not an email")).toBeNull();
  });

  it("keys references without spacing or case", () => {
    expect(normalizeReferenceKey(" inv- ۱۰ ۲")).toBe("INV-102");
  });
});

describe("exact money and quantity", () => {
  it("converts Toman to Rial exactly and refuses sub-Rial fractions", () => {
    expect(importAmountToRial("12,500", "toman")).toBe("125000");
    expect(importAmountToRial("۱۲٬۵۰۰", "toman")).toBe("125000");
    expect(importAmountToRial("12.5", "toman")).toBe("125");
    expect(importAmountToRial("12.55", "toman")).toBeNull();
    expect(importAmountToRial("1000.5", "rial")).toBeNull();
    expect(importAmountToRial("1000.0", "rial")).toBe("1000");
    expect(importAmountToRial("abc", "rial")).toBeNull();
    expect(importAmountToRial(null, "rial")).toBeNull();
  });

  it("handles a negative amount (a refund) without sign errors", () => {
    expect(importAmountToRial("-5", "toman")).toBe("-50");
  });

  it("compares and subtracts decimals without floating point", () => {
    expect(decimalEquals("1.50", "1.5")).toBe(true);
    expect(decimalEquals("0.1", "0.10000")).toBe(true);
    expect(compareDecimal("2", "10")).toBe(-1);
    expect(decimalDelta("10.5", "7.25")).toBe("3.25");
    expect(decimalDelta("1", "3")).toBe("-2");
    expect(decimalDelta("0.1", "0.3")).toBe("-0.2");
    expect(decimalDelta("5", "5")).toBe("0");
  });
});
