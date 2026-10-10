import { describe, expect, it } from "vitest";
import {
  decodeVoucherCursor,
  encodeVoucherCursor,
  newIdempotencyKey,
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
