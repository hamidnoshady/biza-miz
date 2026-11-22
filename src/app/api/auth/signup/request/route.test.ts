import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * ESH-200 / #1385 — the signup request route's status contract.
 *
 * The service owns the proof and the SMS; this test pins what a public caller
 * is allowed to learn from its outcome, and that a pending request is never
 * cacheable.
 */
const mocks = vi.hoisted(() => ({
  requestSignupOtp: vi.fn(),
}));

vi.mock("@/lib/iam/public-signup", () => ({
  requestSignupOtp: mocks.requestSignupOtp,
}));

import { POST } from "./route";

function request(body: unknown, raw = false): NextRequest {
  return new NextRequest("http://test.local/api/auth/signup/request", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: raw ? (body as string) : JSON.stringify(body),
  });
}

beforeEach(() => {
  mocks.requestSignupOtp.mockReset();
});

describe("POST /api/auth/signup/request", () => {
  it("returns the masked destination and the pending token with no-store", async () => {
    mocks.requestSignupOtp.mockResolvedValue({
      ok: true,
      status: "sent",
      maskedPhone: "+989***4567",
      requestToken: "a".repeat(43),
      expiresInSeconds: 300,
      resendAfterSeconds: 60,
    });

    const res = await POST(
      request({ firstName: "نگار", lastName: "احمدی", phone: "۰۹۱۲۱۲۳۴۵۶۷" }),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, status: "sent", maskedPhone: "+989***4567" });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(body).not.toHaveProperty("code");
    expect(body).not.toHaveProperty("otp");
  });

  it("maps every refusal to a safe status and keeps validation generic", async () => {
    const cases = [
      [{ ok: false, error: "signup_disabled" }, 403],
      [{ ok: false, error: "invalid_name" }, 400],
      [{ ok: false, error: "invalid_phone" }, 400],
      [{ ok: false, error: "rate_limited", retryAfterMs: 30_000 }, 429],
      [{ ok: false, error: "sms_dispatch_failed" }, 502],
    ] as const;

    for (const [result, status] of cases) {
      mocks.requestSignupOtp.mockResolvedValue(result);
      const res = await POST(request({ firstName: "الف", lastName: "ب", phone: "09121234567" }));
      expect(res.status, JSON.stringify(result)).toBe(status);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
    }
  });

  it("refuses a malformed body before the service sees it", async () => {
    const res = await POST(request("{", true));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "bad_request" });
    expect(mocks.requestSignupOtp).not.toHaveBeenCalled();
  });
});
