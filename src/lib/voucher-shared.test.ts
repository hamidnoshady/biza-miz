import { describe, expect, it } from "vitest";
import {
  decodeVoucherCursor,
  encodeVoucherCursor,
  isSettlementMethod,
  newIdempotencyKey,
  settlementCodeForMethod,
  voucherReference,
} from "./voucher-shared";

describe("voucher cursor", () => {
  it("round-trips through base64url", () => {
    const cursor = { date: "2026-09-15", createdAt: "2026-09-15T10:00:00.000Z", id: "123e4567-e89b-12d3-a456-426614174000" };
    const encoded = encodeVoucherCursor(cursor);
    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("/");
    expect(encoded).not.toContain("=");
    expect(decodeVoucherCursor(encoded)).toEqual(cursor);
  });

  it("rejects garbage", () => {
    expect(decodeVoucherCursor("not-a-cursor")).toBeNull();
    expect(decodeVoucherCursor("")).toBeNull();
    expect(decodeVoucherCursor(null)).toBeNull();
  });
});

describe("settlement methods", () => {
  it("accepts exactly cash/bank/clearing", () => {
    expect(isSettlementMethod("cash")).toBe(true);
    expect(isSettlementMethod("bank")).toBe(true);
    expect(isSettlementMethod("clearing")).toBe(true);
    expect(isSettlementMethod("cheque")).toBe(false);
    expect(isSettlementMethod("")).toBe(false);
    expect(isSettlementMethod(undefined)).toBe(false);
  });

  it("maps bank to 1110 and clearing to 1120 (issue #829)", () => {
    expect(settlementCodeForMethod("cash")).toBe("1100");
    expect(settlementCodeForMethod("bank")).toBe("1110");
    expect(settlementCodeForMethod("clearing")).toBe("1120");
  });
});

describe("voucherReference", () => {
  it("formats stable document references", () => {
    expect(voucherReference("receipt", 1)).toBe("دریافت #1");
    expect(voucherReference("payment", 42)).toBe("پرداخت #42");
  });
});

describe("newIdempotencyKey", () => {
  it("returns a unique key per call", () => {
    expect(newIdempotencyKey()).not.toBe(newIdempotencyKey());
  });
});
