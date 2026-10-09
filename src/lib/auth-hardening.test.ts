/**
 * Issue #854 — the pure halves of the hardening pass, in one place:
 * the OTP purpose vocabulary and code normalisation, the self-service PIN
 * policy, and the pure checks that used to be duplicated across routes.
 *
 * The database-touching halves (`redeemOtpChallenge`'s locking, `setPin`'s
 * blind index, `requestMemberPasswordReset`'s delivery choice) are covered by
 * `integration/auth-account-security.integration.test.ts` and
 * `integration/phone-otp.integration.test.ts`, which run against a real
 * Postgres — nothing here pretends to prove a concurrency guarantee.
 */
import { describe, expect, it } from "vitest";
import {
  OTP_MAX_ATTEMPTS,
  OTP_PURPOSES,
  OTP_TTL_MINUTES,
  challengeIsLive,
  isOtpPurpose,
  normalizeOtpCode,
} from "./otp-challenge";
import { PIN_MAX_LENGTH, PIN_MIN_LENGTH, PIN_POLICY_HINT, isValidPin } from "./pin-policy";
import { toLatinDigits } from "./digits";

describe("OTP purposes", () => {
  it("separates login, phone-change, enrolment, step-up and recovery", () => {
    /**
     * Issue #854 P0.8 / invariant 4: a code is only spendable for the purpose
     * it was issued for. The vocabulary has to be explicit for that to be
     * checkable, so it is pinned here — adding a purpose is a deliberate act.
     */
    expect([...OTP_PURPOSES]).toEqual([
      "login",
      "verify_login_phone",
      "change_login_phone",
      "mfa_login",
      "mfa_enrol_sms",
      "step_up_sms",
      "password_recovery",
    ]);
    expect(isOtpPurpose("login")).toBe(true);
    expect(isOtpPurpose("mfaLogin")).toBe(false);
  });

  it("keeps a five-minute window and a five-guess ceiling", () => {
    expect(OTP_TTL_MINUTES).toBe(5);
    expect(OTP_MAX_ATTEMPTS).toBe(5);
  });
});

describe("normalizeOtpCode (P2.23)", () => {
  it("accepts Latin digits", () => {
    expect(normalizeOtpCode("123456")).toBe("123456");
  });

  it("accepts Persian and Arabic-Indic digits", () => {
    /**
     * A member reading a code off an SMS app may be typing «۱۲۳۴۵۶». The PIN
     * path already normalised; the OTP path did not, so the *correct* code was
     * rejected with "invalid code" and the member had no way to tell why.
     */
    expect(toLatinDigits("۱۲۳۴۵۶")).toBe("123456");
    expect(normalizeOtpCode(toLatinDigits("۱۲۳۴۵۶"))).toBe("123456");
    expect(normalizeOtpCode(toLatinDigits("١٢٣٤٥٦"))).toBe("123456");
  });

  it("tolerates the spaces and dashes people paste in", () => {
    expect(normalizeOtpCode(" 123 456 ")).toBe("123456");
    expect(normalizeOtpCode("123-456")).toBe("123456");
  });

  it("refuses anything that is not six digits", () => {
    for (const bad of ["12345", "1234567", "abcdef", "", "  ", undefined, 123456]) {
      expect(normalizeOtpCode(bad as unknown)).toBeNull();
    }
  });
});

describe("challengeIsLive", () => {
  const base = { consumedAt: null, expiresAt: new Date(Date.now() + 60_000), attempts: 0 };

  it("is live while unconsumed, unexpired and under the attempt ceiling", () => {
    expect(challengeIsLive(base)).toBe(true);
  });

  it("is dead once consumed — the transition the row lock protects", () => {
    expect(challengeIsLive({ ...base, consumedAt: new Date() })).toBe(false);
  });

  it("is dead once expired", () => {
    expect(challengeIsLive({ ...base, expiresAt: new Date(Date.now() - 1_000) })).toBe(false);
  });

  it("is dead once the guesses are spent", () => {
    expect(challengeIsLive({ ...base, attempts: OTP_MAX_ATTEMPTS })).toBe(false);
  });
});

describe("PIN policy", () => {
  it("counts only digits, within the documented length", () => {
    expect(PIN_MIN_LENGTH).toBe(4);
    expect(PIN_MAX_LENGTH).toBe(12);
    expect(isValidPin("4821")).toBe(true);
    expect(isValidPin("482111223344")).toBe(true);
    expect(isValidPin("482")).toBe(false);
    expect(isValidPin("4821112233445")).toBe(false);
    expect(isValidPin("12a4")).toBe(false);
    expect(isValidPin("")).toBe(false);
  });

  it("states the rule in Persian for the UI to show", () => {
    expect(PIN_POLICY_HINT).toContain("۴");
  });
});
