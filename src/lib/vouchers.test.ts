import { describe, expect, it } from "vitest";
import {
  EXTERNAL_REFERENCE_MAX_LENGTH,
  formatVoucherNo,
  normalizeVoucherChangeReason,
  normalizeVoucherReference,
  renumberTargetError,
} from "./vouchers";

describe("formatVoucherNo", () => {
  it("writes the Jalali year and a zero-padded six-digit sequence", () => {
    expect(formatVoucherNo(1405, 1)).toBe("JV-1405-000001");
    expect(formatVoucherNo(1404, 123456)).toBe("JV-1404-123456");
  });

  it("does not truncate a number wider than the padding", () => {
    expect(formatVoucherNo(1405, 1234567)).toBe("JV-1405-1234567");
  });

  it("refuses values that cannot be a document number", () => {
    expect(() => formatVoucherNo(1405, 0)).toThrow("invalid_voucher_number");
    expect(() => formatVoucherNo(1405, 1.5)).toThrow("invalid_voucher_number");
    expect(() => formatVoucherNo(1405, Number.NaN)).toThrow("invalid_voucher_number");
    expect(() => formatVoucherNo(0, 1)).toThrow("invalid_voucher_year");
    expect(() => formatVoucherNo(1405.5, 1)).toThrow("invalid_voucher_year");
  });
});

describe("normalizeVoucherReference", () => {
  it("treats blank and missing input as no reference", () => {
    expect(normalizeVoucherReference(undefined)).toEqual({ ok: true, value: null });
    expect(normalizeVoucherReference(null)).toEqual({ ok: true, value: null });
    expect(normalizeVoucherReference("   ")).toEqual({ ok: true, value: null });
  });

  it("stores Persian digits as ASCII and collapses whitespace", () => {
    expect(normalizeVoucherReference("  بانک-۱۴۰۵/۰۰۴۲  ")).toEqual({ ok: true, value: "بانک-1405/0042" });
    expect(normalizeVoucherReference("INV  #7.b_2")).toEqual({ ok: true, value: "INV #7.b_2" });
  });

  it("rejects over-long references and characters that would break a printed slip", () => {
    const long = "A".repeat(EXTERNAL_REFERENCE_MAX_LENGTH + 1);
    expect(normalizeVoucherReference(long)).toEqual({ ok: false, error: "reference_too_long" });
    expect(normalizeVoucherReference("a;DROP")).toEqual({ ok: false, error: "reference_invalid_characters" });
    expect(normalizeVoucherReference("x\ny")).toEqual({ ok: true, value: "x y" });
    expect(normalizeVoucherReference("<script>")).toEqual({ ok: false, error: "reference_invalid_characters" });
  });
});

describe("normalizeVoucherChangeReason", () => {
  it("requires a non-blank, bounded reason", () => {
    expect(normalizeVoucherChangeReason("  اشتباه در ثبت شماره  ")).toBe("اشتباه در ثبت شماره");
    expect(normalizeVoucherChangeReason("   ")).toBeNull();
    expect(normalizeVoucherChangeReason(undefined)).toBeNull();
    expect(normalizeVoucherChangeReason("x".repeat(501))).toBeNull();
  });
});

describe("renumberTargetError", () => {
  it("accepts only a gap inside the already-issued range", () => {
    expect(renumberTargetError(3, 9, 10)).toBeNull();
  });

  it("refuses a number the sequence has never issued, because a later posting would re-issue it", () => {
    expect(renumberTargetError(11, 9, 10)).toBe("voucher_number_out_of_range");
  });

  it("refuses a no-op and malformed targets", () => {
    expect(renumberTargetError(9, 9, 10)).toBe("same_voucher_number");
    expect(renumberTargetError(0, 9, 10)).toBe("invalid_voucher_number");
    expect(renumberTargetError("3", 9, 10)).toBe("invalid_voucher_number");
    expect(renumberTargetError(2.5, 9, 10)).toBe("invalid_voucher_number");
  });
});
