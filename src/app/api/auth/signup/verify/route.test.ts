import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * ESH-200 / #1385 — the signup verify route's two safe outcomes.
 *
 * A new (or business-less) person gets the encrypted onboarding continuation; a
 * person who already belongs to a business is sent to sign-in and the stale
 * continuation is cleared. Neither path mints a tenant session, and neither
 * body contains an OTP.
 */
const mocks = vi.hoisted(() => ({
  verifySignupOtp: vi.fn(),
  signOnboardingToken: vi.fn(),
}));

vi.mock("@/lib/iam/public-signup", () => ({
  verifySignupOtp: mocks.verifySignupOtp,
}));

vi.mock("@/lib/iam/onboarding-session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/iam/onboarding-session")>();
  return {
    ...actual,
    signOnboardingToken: mocks.signOnboardingToken,
  };
});

import { POST } from "./route";

function request(body: unknown, raw = false): NextRequest {
  return new NextRequest("http://test.local/api/auth/signup/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: raw ? (body as string) : JSON.stringify(body),
  });
}

beforeEach(() => {
  mocks.verifySignupOtp.mockReset();
  mocks.signOnboardingToken.mockReset();
  mocks.signOnboardingToken.mockResolvedValue("encrypted-onboarding-token");
});

describe("POST /api/auth/signup/verify", () => {
  it("sets the short-lived continuation for a new business-less identity", async () => {
    mocks.verifySignupOtp.mockResolvedValue({
      ok: true,
      platformUserId: "11111111-1111-4111-8111-111111111111",
      created: true,
      resumed: false,
      hasBusinessMemberships: false,
    });

    const res = await POST(
      request({
        firstName: "نگار",
        lastName: "احمدی",
        phone: "09121234567",
        code: "123456",
        requestToken: "a".repeat(43),
      }),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, created: true, next: "/onboarding" });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("set-cookie")).toContain("pos_onboarding=");
    expect(JSON.stringify(body)).not.toMatch(/\b123456\b/);
  });

  it("sends an existing business member to sign in and clears any stale continuation", async () => {
    mocks.verifySignupOtp.mockResolvedValue({
      ok: true,
      platformUserId: "11111111-1111-4111-8111-111111111111",
      created: false,
      resumed: false,
      hasBusinessMemberships: true,
    });

    const res = await POST(request({ phone: "09121234567", code: "123456" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, next: "/login", message: "account_exists" });
    expect(mocks.signOnboardingToken).not.toHaveBeenCalled();
    expect(res.headers.get("set-cookie")).toContain("pos_onboarding=;");
    expect(res.headers.get("set-cookie")).toContain("Expires=Thu, 01 Jan 1970");
  });

  it("maps invalid, ambiguous and unavailable outcomes without leaking an OTP", async () => {
    const cases = [
      [{ ok: false, error: "signup_disabled" }, 403],
      [{ ok: false, error: "signup_maintenance" }, 403],
      [{ ok: false, error: "invalid_code" }, 401],
      [{ ok: false, error: "account_ambiguous" }, 409],
      [{ ok: false, error: "account_unavailable" }, 409],
    ] as const;

    for (const [result, status] of cases) {
      mocks.verifySignupOtp.mockResolvedValue(result);
      const res = await POST(request({ phone: "09121234567", code: "000000" }));
      expect(res.status, JSON.stringify(result)).toBe(status);
      expect(res.headers.get("set-cookie")).toBeNull();
    }
  });

  it("turns a continuation-signing failure into a recoverable retry", async () => {
    mocks.verifySignupOtp.mockResolvedValue({
      ok: true,
      platformUserId: "11111111-1111-4111-8111-111111111111",
      created: true,
      resumed: false,
      hasBusinessMemberships: false,
    });
    mocks.signOnboardingToken.mockRejectedValue(new Error("secret unavailable"));

    const res = await POST(request({ phone: "09121234567", code: "123456" }));
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({ error: "continuation_failed" });
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("refuses a malformed body before the service sees it", async () => {
    const res = await POST(request("{", true));
    expect(res.status).toBe(400);
    expect(mocks.verifySignupOtp).not.toHaveBeenCalled();
  });
});
