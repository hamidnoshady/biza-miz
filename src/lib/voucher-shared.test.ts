import { describe, expect, it } from "vitest";
import {
  decodeVoucherCursor,
  encodeVoucherCursor,
  isCursorTimestamp,
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

  it("validates every decoded field semantically, so the SQL casts never meet a value they reject", () => {
    const good = { date: "2026-09-15", createdAt: "2026-09-15T10:00:00.000Z", id: "123e4567-e89b-12d3-a456-426614174000" };
    // A shaped-but-impossible date, a non-timestamp, a non-UUID: each fails
    // its own cast (`::date`, `::timestamptz`, `::uuid`) with a 500, so each
    // must fail decoding instead.
    for (const bad of [
      { ...good, date: "2026-02-30" },
      { ...good, date: "2026-13-01" },
      { ...good, date: "not-a-date" },
      { ...good, createdAt: "not-a-timestamp" },
      { ...good, createdAt: "2026-09-15 25:00:00" },
      { ...good, createdAt: "2026-02-30T10:00:00Z" },
      { ...good, id: "not-a-uuid" },
      { ...good, id: "unknown" },
      { ...good, id: 42 },
      { date: "2026-09-15", createdAt: "2026-09-15T10:00:00.000Z" },
    ]) {
      expect(decodeVoucherCursor(encodeVoucherCursor(bad as never))).toBeNull();
    }
    // What the server itself issues keeps decoding: PG `timestamptz::text`
    // output beside the ISO spellings.
    for (const createdAt of [
      "2026-09-15 10:00:00+00",
      "2026-09-15 10:00:00.123456+03:30",
      "2026-09-15T10:00:00.000Z",
      "2026-09-15T10:00:00+00:00",
    ]) {
      expect(decodeVoucherCursor(encodeVoucherCursor({ ...good, createdAt }))).toEqual({ ...good, createdAt });
    }
  });
});

describe("isCursorTimestamp", () => {
  it("accepts Postgres and ISO timestamps with real dates and in-range clocks", () => {
    expect(isCursorTimestamp("2026-09-15 10:00:00+00")).toBe(true);
    expect(isCursorTimestamp("2026-09-15 10:00:00.123456+03:30")).toBe(true);
    expect(isCursorTimestamp("2026-09-15T10:00:00.000Z")).toBe(true);
    expect(isCursorTimestamp("2026-09-15T10:00Z")).toBe(true);
    expect(isCursorTimestamp("2024-02-29 23:59:59+00")).toBe(true);
    expect(isCursorTimestamp("not-a-timestamp")).toBe(false);
    expect(isCursorTimestamp("2026-09-15")).toBe(false);
    expect(isCursorTimestamp("2026-02-30T10:00:00Z")).toBe(false);
    expect(isCursorTimestamp("2026-09-15 25:00:00")).toBe(false);
    expect(isCursorTimestamp("2026-09-15T10:61:00Z")).toBe(false);
    expect(isCursorTimestamp("")).toBe(false);
    expect(isCursorTimestamp(null)).toBe(false);
    expect(isCursorTimestamp(42)).toBe(false);
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
