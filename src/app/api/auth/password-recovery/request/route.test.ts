import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * #1386 — the recovery request endpoint's response contract.
 *
 * The route's whole security job is that a known number and an unknown one are
 * indistinguishable. The service already arranges that; these tests pin the
 * route so a future branch cannot add "no such account" or a different status
 * for the miss.
 */
const mocks = vi.hoisted(() => ({
  requestPhonePasswordRecovery: vi.fn(),
}));

vi.mock("@/lib/password-recovery", () => ({
  requestPhonePasswordRecovery: mocks.requestPhonePasswordRecovery,
}));

import { POST } from "./route";

function request(body: unknown) {
  return new NextRequest("http://test.local/api/auth/password-recovery/request", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  mocks.requestPhonePasswordRecovery.mockReset();
});

describe("password-recovery request", () => {
  it("answers a known and an unknown number with the same body and status", async () => {
    mocks.requestPhonePasswordRecovery.mockResolvedValue({
      ok: true,
      maskedPhone: "+989***0001",
      expiresInSeconds: 300,
    });
    const known = await POST(request({ phone: "09120000001" }));

    mocks.requestPhonePasswordRecovery.mockResolvedValue({
      ok: true,
      maskedPhone: "+989***9999",
      expiresInSeconds: 300,
    });
    const unknown = await POST(request({ phone: "09129999999" }));

    expect(known.status).toBe(unknown.status);
    const [knownBody, unknownBody] = await Promise.all([known.json(), unknown.json()]);
    // The masked number is the caller's own input, so it may differ; everything
    // that could describe account existence must not.
    expect({ ...knownBody, maskedPhone: null }).toEqual({
      ...unknownBody,
      maskedPhone: null,
    });
    expect(knownBody.status).toBe("sent");
  });

  it("refuses a malformed number as the caller's own error", async () => {
    mocks.requestPhonePasswordRecovery.mockResolvedValue({
      ok: false,
      error: "invalid_phone",
    });
    const res = await POST(request({ phone: "not-a-phone" }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_phone" });
  });

  it("names the retry window when the per-number limiter is spent", async () => {
    mocks.requestPhonePasswordRecovery.mockResolvedValue({
      ok: false,
      error: "rate_limited",
      retryAfterMs: 60_000,
    });
    const res = await POST(request({ phone: "09120000001" }));

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(await res.json()).toMatchObject({ error: "rate_limited", retryAfterMs: 60_000 });
  });

  it("refuses a malformed body rather than throwing", async () => {
    const res = await POST(request("{not json"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_request" });
  });
});
