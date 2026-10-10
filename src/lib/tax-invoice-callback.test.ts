import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { readTaxCallbackBody, verifyTaxCallbackSignature } from "./tax-invoice-callback";

const tenant = "11111111-1111-4111-8111-111111111111";
const secret = "test-only-callback-key-at-least-32-chars";
const now = new Date("2026-10-10T10:00:00Z");
const timestamp = String(now.getTime());
const body = '{"status":"accepted"}';
const sign = (raw = body, t = timestamp, business = tenant) => createHmac("sha256", secret).update(`${t}\n${business}\n${raw}`).digest("hex");

describe("callback authentication", () => {
  it("binds exact raw bytes, timestamp and tenant", () => {
    expect(verifyTaxCallbackSignature(tenant, body, timestamp, sign(), secret, now)).toBe(true);
    expect(verifyTaxCallbackSignature(tenant, body + " ", timestamp, sign(), secret, now)).toBe(false);
    expect(verifyTaxCallbackSignature("other", body, timestamp, sign(), secret, now)).toBe(false);
    expect(verifyTaxCallbackSignature(tenant, body, String(now.getTime() - 300001), sign(), secret, now)).toBe(false);
  });
  it("fails closed on absent, weak, malformed and stale keys/headers", () => {
    for (const signature of [null, "", "a", "z".repeat(64), "a".repeat(128)]) expect(verifyTaxCallbackSignature(tenant, body, timestamp, signature, secret, now)).toBe(false);
    expect(verifyTaxCallbackSignature(tenant, body, timestamp, sign(), undefined, now)).toBe(false);
    expect(verifyTaxCallbackSignature(tenant, body, timestamp, sign(), "weak", now)).toBe(false);
    expect(verifyTaxCallbackSignature(tenant, body, timestamp, sign(), secret, new Date(now.getTime() + 300001))).toBe(false);
  });
  it("bounds streamed bytes without trusting Content-Length", async () => {
    const req = new Request("https://example.com/callback", { method: "POST", body: "x".repeat(65537) });
    await expect(readTaxCallbackBody(req)).rejects.toMatchObject({ status: 413 });
    expect(await readTaxCallbackBody(new Request("https://example.com/callback", { method: "POST", body }))).toBe(body);
  });
});
