import { describe, expect, it } from "vitest";
import {
  evaluateDeviceTrust,
  trustedDeviceCookieOptions,
  trustedDeviceExpiry,
  TRUSTED_DEVICE_TTL_MS,
  type TrustedDeviceCandidate,
} from "./trusted-device";

/**
 * Issue #885 — the pure half of the seven-day trusted-device policy.
 *
 * The database half is covered in `integration/trusted-device.integration.test.ts`.
 * What lives here is the arithmetic and the rule set, pinned against a fixed
 * clock: "expired at the exact boundary" is the whole feature, and a test that
 * reads `new Date()` cannot tell a correct implementation from one that is off
 * by a millisecond.
 */

const NOW = new Date("2026-10-09T12:00:00.000Z");
const BUSINESS = "11111111-1111-4111-8111-111111111111";
const OTHER_BUSINESS = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";
const OTHER_USER = "44444444-4444-4444-8444-444444444444";

function entry(overrides: Partial<TrustedDeviceCandidate> = {}): TrustedDeviceCandidate {
  return {
    id: "55555555-5555-4555-8555-555555555555",
    businessId: BUSINESS,
    userId: USER,
    expiresAt: new Date(NOW.getTime() + 3 * 86_400_000),
    revokedAt: null,
    ...overrides,
  };
}

const scope = { businessId: BUSINESS, userId: USER };

describe("trustedDeviceExpiry", () => {
  it("is exactly seven days, which the policy fixes and no setting may change", () => {
    expect(TRUSTED_DEVICE_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(trustedDeviceExpiry(NOW).getTime() - NOW.getTime()).toBe(TRUSTED_DEVICE_TTL_MS);
  });
});

describe("evaluateDeviceTrust", () => {
  it("holds for a live, unrevoked entry on the right account and tenant", () => {
    const candidate = entry();
    expect(evaluateDeviceTrust(candidate, scope, NOW)).toEqual({
      trusted: true,
      expiresAt: candidate.expiresAt,
    });
  });

  it("is a miss when nothing was presented", () => {
    expect(evaluateDeviceTrust(null, scope, NOW)).toEqual({ trusted: false, reason: "missing" });
  });

  it("refuses a revoked entry before it looks at the clock", () => {
    // Revocation must win over an expiry that has not arrived yet, and over a
    // scope that matches — otherwise a device revoked minutes ago would still
    // be trusted until it lapsed on its own.
    const revoked = entry({ revokedAt: new Date(NOW.getTime() - 60_000) });
    expect(evaluateDeviceTrust(revoked, scope, NOW)).toEqual({
      trusted: false,
      reason: "revoked",
    });
  });

  it("refuses an entry belonging to another account or another tenant", () => {
    // This is the rule the membership-wide `users.otp_login_at` window could
    // not express, and the reason trust is a table rather than a column.
    expect(evaluateDeviceTrust(entry({ userId: OTHER_USER }), scope, NOW)).toEqual({
      trusted: false,
      reason: "wrong_subject",
    });
    expect(evaluateDeviceTrust(entry({ businessId: OTHER_BUSINESS }), scope, NOW)).toEqual({
      trusted: false,
      reason: "wrong_subject",
    });
    // Both wrong at once is still one answer.
    expect(
      evaluateDeviceTrust(entry({ userId: OTHER_USER, businessId: OTHER_BUSINESS }), scope, NOW),
    ).toEqual({ trusted: false, reason: "wrong_subject" });
  });

  describe("the seven-day boundary", () => {
    const expiresAt = new Date(NOW.getTime() + TRUSTED_DEVICE_TTL_MS);

    it("still holds on the last millisecond of the seventh day", () => {
      expect(
        evaluateDeviceTrust(
          entry({ expiresAt }),
          scope,
          new Date(expiresAt.getTime() - 1),
        ),
      ).toEqual({ trusted: true, expiresAt });
    });

    it("stops at the exact instant, not one tick later", () => {
      expect(evaluateDeviceTrust(entry({ expiresAt }), scope, expiresAt)).toEqual({
        trusted: false,
        reason: "expired",
      });
    });

    it("is expired afterwards, including far afterwards", () => {
      expect(
        evaluateDeviceTrust(entry({ expiresAt }), scope, new Date(expiresAt.getTime() + 1)),
      ).toEqual({ trusted: false, reason: "expired" });
      expect(
        evaluateDeviceTrust(entry({ expiresAt }), scope, new Date(expiresAt.getTime() + 365 * 86_400_000)),
      ).toEqual({ trusted: false, reason: "expired" });
    });

    it("treats an unparseable expiry as expired rather than as open-ended", () => {
      // A corrupt row must fail closed. Reading an invalid date as "no expiry"
      // would turn one bad row into a permanent trust.
      expect(evaluateDeviceTrust(entry({ expiresAt: "not a date" }), scope, NOW)).toEqual({
        trusted: false,
        reason: "expired",
      });
    });
  });

  it("accepts a string or Date expiry alike", () => {
    const iso = new Date(NOW.getTime() + 86_400_000).toISOString();
    expect(evaluateDeviceTrust(entry({ expiresAt: iso }), scope, NOW)).toEqual({
      trusted: true,
      expiresAt: new Date(iso),
    });
  });
});

describe("trustedDeviceCookieOptions", () => {
  it("mirrors the session cookie's posture and the server-side lifetime", () => {
    const options = trustedDeviceCookieOptions();
    expect(options.httpOnly).toBe(true);
    expect(options.sameSite).toBe("lax");
    expect(options.path).toBe("/");
    // No Domain attribute: the credential stays on the issuing host, exactly
    // like `pos_session`, so it cannot be replayed across a tenant's origins.
    expect("domain" in options).toBe(false);
    // A cookie that outlived the row would only cost a lookup miss, but one
    // that expired early would silently end trust before its time.
    expect(options.maxAge).toBe(Math.floor(TRUSTED_DEVICE_TTL_MS / 1000));
  });
});
