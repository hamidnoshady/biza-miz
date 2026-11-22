import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #1386 — the recovery service's purpose binding and anti-enumeration shape.
 *
 * The database half of redemption concurrency lives in the OTP-challenge
 * integration suite; this file pins the service's own decisions: which purpose
 * and phone it binds, when it sends, and that it never invokes the password
 * replacement unless the code actually redeemed.
 */
type AnyFn = ReturnType<typeof vi.fn>;

const mocks = vi.hoisted(() => ({
  query: vi.fn() as AnyFn,
  withoutTenantScope: vi.fn(async (_r: string, fn: () => Promise<unknown>) => fn()) as AnyFn,
  issueOtpChallenge: vi.fn() as AnyFn,
  consumeAllChallenges: vi.fn(async () => 0) as AnyFn,
  redeemOtpChallenge: vi.fn() as AnyFn,
  getSmsProvider: vi.fn() as AnyFn,
  sendOtp: vi.fn(async () => undefined) as AnyFn,
  resetPasswordForVerifiedPhone: vi.fn() as AnyFn,
  checkPhoneOtpRateLimit: vi.fn(async () => ({ allowed: true })) as AnyFn,
}));

vi.mock("./db", () => ({
  query: mocks.query,
  withoutTenantScope: mocks.withoutTenantScope,
}));

vi.mock("./otp-challenge", () => ({
  issueOtpChallenge: mocks.issueOtpChallenge,
  consumeAllChallenges: mocks.consumeAllChallenges,
  redeemOtpChallenge: mocks.redeemOtpChallenge,
  normalizeOtpCode: (value: unknown) =>
    typeof value === "string" && /^\d{6}$/.test(value) ? value : null,
  phoneDerivedSubject: async () => "subject-1",
}));

vi.mock("./sms-config", () => ({
  getSmsProvider: mocks.getSmsProvider,
}));

vi.mock("./phone-otp", () => ({
  canonicalMemberPhone: (value: unknown) =>
    value === "09121234567" || value === "۰۹۱۲۱۲۳۴۵۶۷" ? "+989121234567" : null,
  checkPhoneOtpRateLimit: mocks.checkPhoneOtpRateLimit,
  maskPhoneE164: () => "+989***4567",
}));

vi.mock("./password-reset", () => ({
  validatePasswordStrength: (value: string) =>
    value.length >= 8
      ? { ok: true }
      : { ok: false, error: "password_too_short" },
  resetPasswordForVerifiedPhone: mocks.resetPasswordForVerifiedPhone,
}));

import {
  requestPhonePasswordRecovery,
  verifyPhonePasswordRecovery,
} from "./password-recovery";

beforeEach(() => {
  for (const fn of Object.values(mocks)) (fn as AnyFn).mockClear();
  mocks.withoutTenantScope.mockImplementation(async (_r: string, fn: () => Promise<unknown>) => fn());
  mocks.checkPhoneOtpRateLimit.mockResolvedValue({ allowed: true });
  mocks.getSmsProvider.mockResolvedValue({ sendOtp: mocks.sendOtp });
  mocks.issueOtpChallenge.mockResolvedValue({
    challengeId: "challenge-1",
    code: "123456",
    expiresAt: new Date(Date.now() + 300_000),
  });
});

describe("recovery request", () => {
  it("binds the code to the password_recovery purpose and the verified phone", async () => {
    mocks.query.mockResolvedValue({ rows: [{ id: "platform-1", email: "a@example.test" }] });

    const result = await requestPhonePasswordRecovery("۰۹۱۲۱۲۳۴۵۶۷");

    expect(result).toMatchObject({ ok: true, expiresInSeconds: 300 });
    expect(mocks.issueOtpChallenge).toHaveBeenCalledWith({
      subjectRealm: "password_recovery",
      subjectId: "subject-1",
      purpose: "password_recovery",
      candidatePhoneE164: "+989121234567",
    });
    expect(mocks.sendOtp).toHaveBeenCalledWith("+989121234567", "123456");
  });

  it("sends nothing when the number matches no identity, and answers the same shape", async () => {
    mocks.query.mockResolvedValue({ rows: [] });

    const result = await requestPhonePasswordRecovery("09121234567");

    expect(result).toMatchObject({ ok: true, expiresInSeconds: 300 });
    expect(mocks.issueOtpChallenge).not.toHaveBeenCalled();
    expect(mocks.sendOtp).not.toHaveBeenCalled();
  });

  it("refuses an ambiguous number rather than resetting the wrong account", async () => {
    mocks.query.mockResolvedValue({
      rows: [
        { id: "platform-1", email: "a@example.test" },
        { id: "platform-2", email: "b@example.test" },
      ],
    });

    await requestPhonePasswordRecovery("09121234567");

    expect(mocks.issueOtpChallenge).not.toHaveBeenCalled();
    expect(mocks.sendOtp).not.toHaveBeenCalled();
  });

  it("burns the challenge when the provider cannot send, without surfacing an oracle", async () => {
    mocks.query.mockResolvedValue({ rows: [{ id: "platform-1", email: null }] });
    mocks.sendOtp.mockRejectedValueOnce(new Error("provider down"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await requestPhonePasswordRecovery("09121234567");
    logged.mockRestore();

    expect(result).toMatchObject({ ok: true });
    expect(mocks.consumeAllChallenges).toHaveBeenCalledWith({
      subjectRealm: "password_recovery",
      subjectId: "subject-1",
      purpose: "password_recovery",
    });
  });

  it("refuses a malformed number as the caller's own error", async () => {
    const result = await requestPhonePasswordRecovery("not-a-phone");
    expect(result).toEqual({ ok: false, error: "invalid_phone" });
  });
});

describe("recovery verification", () => {
  it("does not touch the password unless the purpose-bound code redeemed", async () => {
    mocks.redeemOtpChallenge.mockResolvedValue({ ok: false, reason: "wrong_code" });

    const result = await verifyPhonePasswordRecovery({
      phone: "09121234567",
      code: "000000",
      newPassword: "a-new-password",
      confirmPassword: "a-new-password",
    });

    expect(result).toEqual({ ok: false, error: "invalid_code" });
    expect(mocks.redeemOtpChallenge).toHaveBeenCalledWith({
      subjectRealm: "password_recovery",
      subjectId: "subject-1",
      purpose: "password_recovery",
      code: "000000",
      expectedPhoneE164: "+989121234567",
    });
    expect(mocks.resetPasswordForVerifiedPhone).not.toHaveBeenCalled();
  });

  it("replaces the password with the lockout key the password door uses", async () => {
    mocks.redeemOtpChallenge.mockResolvedValue({ ok: true });
    mocks.query.mockResolvedValue({ rows: [{ id: "platform-1", email: null }] });
    mocks.resetPasswordForVerifiedPhone.mockResolvedValue({
      ok: true,
      tokenVersion: 3,
      revokedSessions: 2,
    });

    const result = await verifyPhonePasswordRecovery({
      phone: "09121234567",
      code: "123456",
      newPassword: "a-new-password",
      confirmPassword: "a-new-password",
    });

    expect(result).toEqual({ ok: true, tokenVersion: 3, revokedSessions: 2 });
    expect(mocks.resetPasswordForVerifiedPhone).toHaveBeenCalledWith({
      platformUserId: "platform-1",
      newPassword: "a-new-password",
      // No email, so the phone the password door keys lockout under.
      lockoutKey: "+989121234567",
    });
  });

  it("refuses a weak password before redeeming the code", async () => {
    const result = await verifyPhonePasswordRecovery({
      phone: "09121234567",
      code: "123456",
      newPassword: "short",
      confirmPassword: "short",
    });

    expect(result).toEqual({ ok: false, error: "password_too_short" });
    expect(mocks.redeemOtpChallenge).not.toHaveBeenCalled();
  });
});
