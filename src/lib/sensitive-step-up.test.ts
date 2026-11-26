import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #1386 — the server guard composes freshness with the distinct-factor rule.
 *
 * The factor read is mocked; the policy (`decideSensitiveStepUp`) and the
 * `distinctSecondFactorMethods` filter are the real ones, so these pin the
 * wiring an attacker would actually meet.
 */
const mocks = vi.hoisted(() => ({
  getAccountMfaEnrolments: vi.fn(),
}));

vi.mock("./mfa-service", async () => {
  const { isActiveMfaEnrolment } = await vi.importActual<typeof import("./mfa")>("./mfa");
  return {
    getAccountMfaEnrolments: mocks.getAccountMfaEnrolments,
    filterActiveMfaEnrolments: (rows: { method: string; confirmed_at: Date | null; is_primary: boolean }[]) =>
      rows.filter((row) => isActiveMfaEnrolment(row as never)),
  };
});

import { requireSensitiveRecentAuth, sensitiveStepUpDecision } from "./sensitive-step-up";

const NOW = () => Math.floor(Date.now() / 1000);
const PLATFORM_USER = "22222222-2222-4222-8222-222222222222";

function enrolment(method: "totp" | "sms_otp", confirmed = true) {
  return {
    id: `${method}-1`,
    method,
    is_primary: method === "totp",
    phone_e164: method === "sms_otp" ? "+989121000001" : null,
    confirmed_at: confirmed ? new Date("2026-11-01T00:00:00Z") : null,
    created_at: new Date("2026-11-01T00:00:00Z"),
  };
}

beforeEach(() => {
  mocks.getAccountMfaEnrolments.mockReset();
  mocks.getAccountMfaEnrolments.mockResolvedValue([]);
});

describe("requireSensitiveRecentAuth", () => {
  it("still refuses a stale session with the plain recent-auth answer", async () => {
    const res = await requireSensitiveRecentAuth({
      platformUserId: PLATFORM_USER,
      recentAuthAt: NOW() - 60 * 60,
    });
    expect(res?.status).toBe(403);
    expect(await res?.json()).toEqual({ error: "recent_auth_required", maxAgeSeconds: 900 });
    // Stale is decided before any factor is read.
    expect(mocks.getAccountMfaEnrolments).not.toHaveBeenCalled();
  });

  it("asks an OTP-only session for the TOTP the account holds", async () => {
    mocks.getAccountMfaEnrolments.mockResolvedValue([enrolment("totp"), enrolment("sms_otp")]);
    const res = await requireSensitiveRecentAuth({
      platformUserId: PLATFORM_USER,
      recentAuthAt: NOW(),
      otpOnlyAssurance: true,
    });
    expect(res?.status).toBe(403);
    // Same error code every client already handles, plus the narrowing.
    expect(await res?.json()).toEqual({
      error: "recent_auth_required",
      distinctFactorRequired: true,
      allowedMethods: ["totp", "recovery"],
    });
  });

  it("lets an OTP-only session through when SMS is the only factor", async () => {
    mocks.getAccountMfaEnrolments.mockResolvedValue([enrolment("sms_otp")]);
    expect(
      await requireSensitiveRecentAuth({
        platformUserId: PLATFORM_USER,
        recentAuthAt: NOW(),
        otpOnlyAssurance: true,
      }),
    ).toBeNull();
  });

  it("ignores an unconfirmed (half-enrolled) TOTP — it is not a factor yet", async () => {
    mocks.getAccountMfaEnrolments.mockResolvedValue([
      { ...enrolment("totp", false), is_primary: false },
    ]);
    expect(
      await requireSensitiveRecentAuth({
        platformUserId: PLATFORM_USER,
        recentAuthAt: NOW(),
        otpOnlyAssurance: true,
      }),
    ).toBeNull();
  });

  it("costs no query and changes nothing for password / MFA / legacy sessions", async () => {
    mocks.getAccountMfaEnrolments.mockResolvedValue([enrolment("totp")]);
    for (const claim of [undefined, false]) {
      expect(
        await requireSensitiveRecentAuth({
          platformUserId: PLATFORM_USER,
          recentAuthAt: NOW(),
          otpOnlyAssurance: claim,
        }),
      ).toBeNull();
    }
    expect(mocks.getAccountMfaEnrolments).not.toHaveBeenCalled();
  });

  it("has nothing to ask of a member with no global identity", async () => {
    expect(
      await sensitiveStepUpDecision({ platformUserId: null, recentAuthAt: NOW(), otpOnlyAssurance: true }),
    ).toEqual({ distinctFactorRequired: false, allowedMethods: [] });
    expect(mocks.getAccountMfaEnrolments).not.toHaveBeenCalled();
  });
});
