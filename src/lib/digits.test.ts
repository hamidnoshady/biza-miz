import { describe, expect, it } from "vitest";
import {
  formatPersianNumber,
  formatPersianNumericText,
  formatQuantity,
  groupDigits,
  normalizeNumericText,
  normalizeSecurityDigits,
  toLatinDigits,
  toPersianDigits,
} from "./digits";

describe("digits", () => {
  it("converts ASCII to Persian digits", () => {
    expect(toPersianDigits(1234567890)).toBe("۱۲۳۴۵۶۷۸۹۰");
    expect(toPersianDigits("سفارش 42")).toBe("سفارش ۴۲");
  });

  it("converts Persian and Arabic-Indic digits back to ASCII", () => {
    expect(toLatinDigits("۱۲۳۴")).toBe("1234");
    expect(toLatinDigits("٥٦٧")).toBe("567");
    expect(toLatinDigits("mixed ۱2٣")).toBe("mixed 123");
  });

  it("round-trips", () => {
    expect(toLatinDigits(toPersianDigits("9876543210"))).toBe("9876543210");
  });

  it("groups thousands", () => {
    expect(groupDigits(1250000)).toBe("1٬250٬000");
    expect(groupDigits(-42000)).toBe("-42٬000");
    expect(groupDigits(999)).toBe("999");
    expect(groupDigits(12345678901234567890n)).toBe("12٬345٬678٬901٬234٬567٬890");
  });

  it("formats grouped Persian numbers", () => {
    expect(formatPersianNumber(1250000)).toBe("۱٬۲۵۰٬۰۰۰");
  });

  it("normalizes Persian, Arabic-Indic, and grouped input text without losing decimals", () => {
    expect(normalizeNumericText("2030")).toBe("2030");
    expect(normalizeNumericText("۲٬۰۳۰")).toBe("2030");
    expect(normalizeNumericText("٢٠٣٠")).toBe("2030");
    expect(normalizeNumericText("۱۲٫۵")).toBe("12.5");
    expect(normalizeNumericText("١٢٫٥")).toBe("12.5");
    expect(normalizeNumericText("۱٬۲۵۰٬۰۰۰٫۵۰")).toBe("1250000.50");
    expect(normalizeNumericText("١,٢٥٠,٠٠٠.٥٠")).toBe("1250000.50");
    expect(normalizeNumericText("۰۰۰۱۲")).toBe("12");
    expect(normalizeNumericText("−۱۲٫۵")).toBe("-12.5");
    expect(normalizeNumericText("۱۲٫۵", { allowDecimal: false })).toBe("12");
    expect(normalizeNumericText("22,5", { allowDecimal: true, grouping: false })).toBe("22.5");
    expect(normalizeNumericText("-۱۲", { allowNegative: false })).toBe("12");
  });

  it("formats editable numeric text with Persian digits, separators, and decimal mark", () => {
    expect(formatPersianNumericText("2030")).toBe("۲٬۰۳۰");
    expect(formatPersianNumericText("12.5")).toBe("۱۲٫۵");
    expect(formatPersianNumericText("1250000.50")).toBe("۱٬۲۵۰٬۰۰۰٫۵۰");
    expect(formatPersianNumericText("-12500.5")).toBe("-۱۲٬۵۰۰٫۵");
    expect(formatPersianNumericText("12.")).toBe("۱۲٫");
    expect(formatPersianNumericText("1250000", { grouping: false })).toBe("۱۲۵۰۰۰۰");
  });

  it("trims exact-decimal quantities for display", () => {
    expect(formatQuantity("18.000000000")).toBe("۱۸");
    expect(formatQuantity("1000.000000000")).toBe("۱٬۰۰۰");
    expect(formatQuantity("0.500000000")).toBe("۰٫۵");
    expect(formatQuantity("-2.500000000")).toBe("-۲٫۵");
    expect(formatQuantity(0)).toBe("۰");
    expect(formatQuantity("12.3456")).toBe("۱۲٫۳۴۶"); // rounds beyond maxDecimals
    expect(formatQuantity("12.3456", 4)).toBe("۱۲٫۳۴۵۶");
  });

  it("normalizes security-code entry (issue #854 pass 4): converts, never strips", () => {
    // A Persian keyboard must type a valid OTP/PIN: localized digits are
    // converted to ASCII, not silently dropped by a /\D/g strip.
    expect(normalizeSecurityDigits("۱۲۳۴۵۶")).toBe("123456");
    expect(normalizeSecurityDigits("١٢٣٤٥٦")).toBe("123456");
    expect(normalizeSecurityDigits("۱2٣4")).toBe("1234");
    // Non-digits are dropped; the value stays digits-only for the server.
    expect(normalizeSecurityDigits("12a34-b")).toBe("1234");
    expect(normalizeSecurityDigits("  42  ")).toBe("42");
    expect(normalizeSecurityDigits("")).toBe("");
  });

  it("enforces the maximum length a code field accepts", () => {
    expect(normalizeSecurityDigits("1234567890", 6)).toBe("123456");
    expect(normalizeSecurityDigits("۱۲۳۴۵۶۷۸۹۰", 6)).toBe("123456");
    expect(normalizeSecurityDigits("12", 6)).toBe("12");
    expect(normalizeSecurityDigits("۹۸۷۶۵۴۳۲۱۰۹۸", 12)).toBe("987654321098");
  });
});
