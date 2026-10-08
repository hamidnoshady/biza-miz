import { describe, expect, it } from "vitest";
import type { NextRequest } from "next/server";
import { idempotencyKeyOf } from "./idempotency";

function requestWith(headers: Record<string, string> = {}): NextRequest {
  return new Request("https://example.test/api/ledger/cheques", {
    method: "POST",
    headers,
  }) as unknown as NextRequest;
}

describe("idempotencyKeyOf", () => {
  it("reads the conventional header", () => {
    expect(idempotencyKeyOf(requestWith({ "Idempotency-Key": "abc-123" }))).toBe("abc-123");
  });

  it("accepts a body field for clients that cannot set headers, and prefers it", () => {
    expect(idempotencyKeyOf(requestWith(), "from-body")).toBe("from-body");
    expect(idempotencyKeyOf(requestWith({ "Idempotency-Key": "header" }), "body")).toBe("body");
  });

  it("treats an absent, blank or non-string key as no key at all", () => {
    expect(idempotencyKeyOf(requestWith())).toBeNull();
    expect(idempotencyKeyOf(requestWith({ "Idempotency-Key": "   " }))).toBeNull();
    expect(idempotencyKeyOf(requestWith(), 42)).toBeNull();
    expect(idempotencyKeyOf(requestWith(), "  ")).toBeNull();
  });

  it("bounds the key: it ends up in a unique index, not a log line", () => {
    expect(idempotencyKeyOf(requestWith({ "Idempotency-Key": "x".repeat(500) }))).toHaveLength(200);
  });
});
