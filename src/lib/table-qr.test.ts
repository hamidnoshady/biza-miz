import { describe, expect, it } from "vitest";
import {
  TABLE_QR_REJECTION_STATUS,
  generateTableQrToken,
  hashTableQrToken,
  normalizeTableQrToken,
  tableQrLink,
  tableQrRejection,
  tableQrTokenPrefix,
  tableStatusAcceptsQrOrders,
} from "./table-qr";

describe("table QR tokens", () => {
  it("are prefixed, 192-bit and never the table's uuid", () => {
    const token = generateTableQrToken();
    expect(token).toMatch(/^tqr_[A-Za-z0-9_-]{32}$/);
    // 32 base64url characters = 24 bytes = 192 bits of entropy.
    expect(token.slice(4)).toHaveLength(32);
    expect(token).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });

  it("generates a different token each time", () => {
    const tokens = new Set(Array.from({ length: 50 }, () => generateTableQrToken()));
    expect(tokens.size).toBe(50);
  });

  it("normalises a bare token, a URL query and a /t/ path", () => {
    const token = generateTableQrToken();
    expect(normalizeTableQrToken(token)).toBe(token);
    expect(normalizeTableQrToken(`  ${token}  `)).toBe(token);
    expect(normalizeTableQrToken(`https://cafe.example/menu?tableToken=${token}`)).toBe(token);
    expect(normalizeTableQrToken(`https://cafe.example/menu?t=${token}`)).toBe(token);
    expect(normalizeTableQrToken(`https://cafe.example/t/${token}`)).toBe(token);
  });

  it("refuses anything that is not exactly one of our tokens", () => {
    const token = generateTableQrToken();
    expect(normalizeTableQrToken(null)).toBeNull();
    expect(normalizeTableQrToken(undefined)).toBeNull();
    expect(normalizeTableQrToken("")).toBeNull();
    expect(normalizeTableQrToken(123)).toBeNull();
    expect(normalizeTableQrToken(token.slice(0, -1))).toBeNull();
    expect(normalizeTableQrToken(`${token}x`)).toBeNull();
    expect(normalizeTableQrToken(token.replace("tqr_", "TQR_"))).toBeNull();
    // A uuid is never a valid token — the whole point of the opaque identity.
    expect(normalizeTableQrToken("0b6f9c1e-5a4f-4d6a-9c3f-2f1a4b5c6d7e")).toBeNull();
    expect(normalizeTableQrToken("https://cafe.example/menu?tableToken=nope")).toBeNull();
  });

  it("hashes deterministically, so lookup can be by hash", () => {
    const token = generateTableQrToken();
    expect(hashTableQrToken(token)).toBe(hashTableQrToken(token));
    expect(hashTableQrToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashTableQrToken(token)).not.toBe(hashTableQrToken(generateTableQrToken()));
  });

  it("shows staff a masked prefix that cannot be replayed", () => {
    const token = generateTableQrToken();
    const prefix = tableQrTokenPrefix(token);
    expect(prefix).toBe(token.slice(0, 10));
    expect(prefix.length).toBeLessThan(token.length);
    expect(normalizeTableQrToken(prefix)).toBeNull();
    expect(() => tableQrTokenPrefix("not-a-token")).toThrow("invalid_table_qr_token");
  });
});

describe("table QR link", () => {
  it("puts the token in the site's menu URL and nothing else", () => {
    const token = generateTableQrToken();
    const link = tableQrLink({ token, siteDomain: "Cafe.Example" });
    expect(link).toEqual({
      token,
      url: `https://cafe.example/menu?tableToken=${token}`,
    });
    expect(link!.url).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });

  it("honours a configured menu path but refuses traversal", () => {
    const token = generateTableQrToken();
    expect(tableQrLink({ token, siteDomain: "cafe.example", menuPath: "/order" })!.url).toBe(
      `https://cafe.example/order?tableToken=${token}`,
    );
    expect(tableQrLink({ token, siteDomain: "cafe.example", menuPath: "/../etc" })!.url).toBe(
      `https://cafe.example/menu?tableToken=${token}`,
    );
  });

  it("is null without a usable host or a valid token", () => {
    const token = generateTableQrToken();
    expect(tableQrLink({ token, siteDomain: null })).toBeNull();
    expect(tableQrLink({ token, siteDomain: "http://cafe.example" })).toBeNull();
    expect(tableQrLink({ token, siteDomain: "cafe example" })).toBeNull();
    expect(tableQrLink({ token: "nope", siteDomain: "cafe.example" })).toBeNull();
  });
});

describe("table QR refusals", () => {
  it("separates an unknown print from a rotated/revoked one", () => {
    expect(tableQrRejection("unknown_token")).toEqual({
      ok: false,
      reason: "unknown_token",
      status: 404,
    });
    expect(tableQrRejection("token_rotated").status).toBe(410);
    expect(tableQrRejection("token_revoked").status).toBe(410);
  });

  it("answers a mismatch or an unknown token identically to a stranger", () => {
    expect(TABLE_QR_REJECTION_STATUS.site_mismatch).toBe(404);
    expect(TABLE_QR_REJECTION_STATUS.unknown_token).toBe(404);
    expect(TABLE_QR_REJECTION_STATUS.invalid_token).toBe(404);
  });

  it("reports an unavailable table and a disabled entitlement distinctly", () => {
    expect(TABLE_QR_REJECTION_STATUS.table_unavailable).toBe(409);
    expect(TABLE_QR_REJECTION_STATUS.service_disabled).toBe(403);
  });

  it("accepts orders only on live, in-service tables", () => {
    expect(tableStatusAcceptsQrOrders("free", true)).toBe(true);
    expect(tableStatusAcceptsQrOrders("seated", true)).toBe(true);
    expect(tableStatusAcceptsQrOrders("bill_requested", true)).toBe(true);
    expect(tableStatusAcceptsQrOrders("reserved", true)).toBe(true);
    expect(tableStatusAcceptsQrOrders("cleaning", true)).toBe(false);
    expect(tableStatusAcceptsQrOrders("out_of_service", true)).toBe(false);
    expect(tableStatusAcceptsQrOrders("free", false)).toBe(false);
  });
});
