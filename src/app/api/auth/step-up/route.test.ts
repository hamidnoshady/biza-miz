import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * #1386 — the tenant step-up route after the passwordless door.
 *
 * Two things are pinned here:
 *
 *  1. **What the step-up proved is recorded.** A TOTP / recovery code clears an
 *     OTP-only session; an SMS step-up is SMS-only; password / PIN refresh the
 *     clock without upgrading it. `GET` narrows the picker to the methods that
 *     can satisfy the sensitive route's retry.
 *  2. **Phone-first identities are first-class.** Lockout and the SMS rate
 *     limit are keyed on the global identity (email, else verified phone), not
 *     on the membership's `users.email` — which a phone-first member does not
 *     have, and which used to leave their step-up with no lockout, a refused
 *     password method and a shared `""` SMS bucket.
 */
type AnyFn = ReturnType<typeof vi.fn>;

const mocks = vi.hoisted(() => ({
  requireMember: vi.fn() as AnyFn,
  signSession: vi.fn(async () => "next-session") as AnyFn,
  query: vi.fn() as AnyFn,
  recordSecurityAudit: vi.fn(async () => {}) as AnyFn,
  verifyPassword: vi.fn(async () => true) as AnyFn,
  checkAuthLockout: vi.fn(async () => ({ locked: false, lockedUntil: null })) as AnyFn,
  recordAuthFailure: vi.fn(async () => {}) as AnyFn,
  recordAuthSuccess: vi.fn(async () => {}) as AnyFn,
  verifyExistingConfirmedMfaFactor: vi.fn(async () => ({ outcome: "verified" })) as AnyFn,
  issueSmsMfaChallenge: vi.fn(async () => ({
    ok: true,
    maskedPhone: "0912***0001",
    candidatePhoneE164: "+989121000001",
  })) as AnyFn,
  readSelfCredentialState: vi.fn() as AnyFn,
  verifySelfPin: vi.fn(async () => true) as AnyFn,
  sensitiveStepUpDecision: vi.fn(async () => ({
    distinctFactorRequired: false,
    allowedMethods: [],
  })) as AnyFn,
}));

vi.mock("@/lib/auth", () => ({
  SESSION_COOKIE: "pos_session",
  requireMember: mocks.requireMember,
  sessionCookieOptions: () => ({ httpOnly: true, path: "/" }),
  signSession: mocks.signSession,
  withTenantScope: (handler: unknown) => handler,
}));
vi.mock("@/lib/db", () => ({
  query: mocks.query,
  withoutTenantScope: async (_reason: string, fn: () => Promise<unknown>) => fn(),
}));
vi.mock("@/lib/security-audit", () => ({
  SELF_CREDENTIAL_AUDIT_ACTIONS: { stepUp: "auth.step_up", stepUpFailed: "auth.step_up_failed" },
  recordSecurityAudit: mocks.recordSecurityAudit,
}));
vi.mock("@/lib/team-service", () => ({ verifyPassword: mocks.verifyPassword }));
vi.mock("@/lib/login-lockout-service", () => ({
  checkAuthLockout: mocks.checkAuthLockout,
  recordAuthFailure: mocks.recordAuthFailure,
  recordAuthSuccess: mocks.recordAuthSuccess,
}));
vi.mock("@/lib/mfa-verify", () => ({
  verifyExistingConfirmedMfaFactor: mocks.verifyExistingConfirmedMfaFactor,
}));
vi.mock("@/lib/mfa-enrol", () => ({ issueSmsMfaChallenge: mocks.issueSmsMfaChallenge }));
vi.mock("@/lib/self-credentials", () => ({
  readSelfCredentialState: mocks.readSelfCredentialState,
  verifySelfPin: mocks.verifySelfPin,
}));
vi.mock("@/lib/sensitive-step-up", () => ({
  sensitiveStepUpDecision: mocks.sensitiveStepUpDecision,
}));

import { GET, POST } from "./route";

const BUSINESS = "11111111-1111-4111-8111-111111111111";
const MEMBER = "33333333-3333-4333-8333-333333333333";
const IDENTITY = "22222222-2222-4222-8222-222222222222";
const PHONE = "+989121000001";

function session(overrides: Record<string, unknown> = {}) {
  return {
    sub: MEMBER,
    businessId: BUSINESS,
    platformUserId: IDENTITY,
    role: "cashier",
    recentAuthAt: Math.floor(Date.now() / 1000) - 3600,
    ...overrides,
  };
}

/** The identity-key row: a phone-first identity has no email anywhere. */
function keyRow(overrides: Record<string, unknown> = {}) {
  return {
    rows: [{ member_email: null, identity_email: null, identity_phone: PHONE, ...overrides }],
    rowCount: 1,
  };
}

function post(body: unknown): NextRequest {
  return new NextRequest("http://test.local/api/auth/step-up", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function signedClaims(): Record<string, unknown> {
  const call = mocks.signSession.mock.calls.at(-1);
  return (call?.[0] ?? {}) as Record<string, unknown>;
}

beforeEach(() => {
  for (const fn of Object.values(mocks)) (fn as AnyFn).mockClear();
  mocks.requireMember.mockResolvedValue({ session: session(), error: null });
  mocks.query.mockResolvedValue(keyRow());
  mocks.verifyPassword.mockResolvedValue(true);
  mocks.verifyExistingConfirmedMfaFactor.mockResolvedValue({ outcome: "verified" });
  mocks.sensitiveStepUpDecision.mockResolvedValue({
    distinctFactorRequired: false,
    allowedMethods: [],
  });
  mocks.readSelfCredentialState.mockResolvedValue({
    hasPassword: true,
    hasTotp: true,
    hasSms: true,
    hasPin: true,
    hasRecoveryCodes: true,
    loginManagedByCloud: false,
  });
});

describe("GET — the picker offers only methods that can satisfy the retry", () => {
  it("lists every verifiable method for an ordinary session", async () => {
    const res = await GET();
    const body = await res.json();
    expect(body.availableMethods).toEqual(["password", "totp", "sms_otp", "pin", "recovery"]);
    expect(body.distinctFactorRequired).toBe(false);
  });

  it("narrows to TOTP / recovery after an OTP-only sign-in on a TOTP account", async () => {
    mocks.requireMember.mockResolvedValue({
      session: session({ otpOnlyAssurance: true, recentAuthAt: Math.floor(Date.now() / 1000) }),
      error: null,
    });
    mocks.sensitiveStepUpDecision.mockResolvedValue({
      distinctFactorRequired: true,
      allowedMethods: ["totp", "recovery"],
    });

    const body = await (await GET()).json();

    expect(body.availableMethods).toEqual(["totp", "recovery"]);
    expect(Object.keys(body.methodLabels)).toEqual(["totp", "recovery"]);
    expect(body.distinctFactorRequired).toBe(true);
    // Fresh by the clock, but not "recent" for a sensitive change yet.
    expect(body.recentAuth).toBe(false);
  });
});

describe("POST — what the step-up proved is recorded on the session", () => {
  it("clears an OTP-only session when the TOTP is proved", async () => {
    mocks.requireMember.mockResolvedValue({
      session: session({ otpOnlyAssurance: true }),
      error: null,
    });
    const res = await POST(post({ method: "totp", credential: "123456" }));
    expect(res.status).toBe(200);
    expect(signedClaims().otpOnlyAssurance).toBe(false);
    expect(typeof signedClaims().recentAuthAt).toBe("number");
  });

  it("clears it with a recovery code too", async () => {
    mocks.requireMember.mockResolvedValue({
      session: session({ otpOnlyAssurance: true }),
      error: null,
    });
    await POST(post({ method: "recovery", credential: "ABCD-EFGH" }));
    expect(signedClaims().otpOnlyAssurance).toBe(false);
  });

  it("marks an SMS step-up as SMS-only even on a password session", async () => {
    await POST(post({ method: "sms_otp", credential: "123456" }));
    expect(signedClaims().otpOnlyAssurance).toBe(true);
  });

  it("does not let a password step-up upgrade an OTP-only session", async () => {
    mocks.requireMember.mockResolvedValue({
      session: session({ otpOnlyAssurance: true }),
      error: null,
    });
    await POST(post({ method: "password", credential: "correct horse" }));
    expect(signedClaims().otpOnlyAssurance).toBe(true);
  });

  it("issues no refreshed session for a failed proof", async () => {
    mocks.verifyExistingConfirmedMfaFactor.mockResolvedValue({ outcome: "rejected" });
    const res = await POST(post({ method: "totp", credential: "000000" }));
    expect(res.status).toBe(401);
    expect(mocks.signSession).not.toHaveBeenCalled();
  });
});

describe("POST — phone-first identities", () => {
  it("counts lockout under the verified phone when the identity has no email", async () => {
    mocks.verifyPassword.mockResolvedValue(false);
    const res = await POST(post({ method: "password", credential: "wrong" }));

    expect(res.status).toBe(401);
    expect(mocks.checkAuthLockout).toHaveBeenCalledWith("tenant_password", PHONE, expect.anything());
    expect(mocks.recordAuthFailure).toHaveBeenCalledWith("tenant_password", PHONE);
  });

  it("accepts the password method for a phone-first identity that set one", async () => {
    const res = await POST(post({ method: "password", credential: "correct horse" }));
    expect(res.status).toBe(200);
    expect(mocks.verifyPassword).toHaveBeenCalledWith(MEMBER, "correct horse");
    expect(mocks.recordAuthSuccess).toHaveBeenCalledWith("tenant_password", PHONE);
  });

  it("refuses the step-up while the identity is locked, before reading the secret", async () => {
    mocks.checkAuthLockout.mockResolvedValueOnce({ locked: true, lockedUntil: "2026-11-26T15:00:00Z" });
    const res = await POST(post({ method: "password", credential: "correct horse" }));
    expect(res.status).toBe(423);
    expect(mocks.verifyPassword).not.toHaveBeenCalled();
  });

  it("prefers the identity email, the same key the password door uses", async () => {
    mocks.query.mockResolvedValue(keyRow({ identity_email: "owner@example.com", member_email: "old@example.com" }));
    await POST(post({ method: "password", credential: "correct horse" }));
    expect(mocks.checkAuthLockout).toHaveBeenCalledWith(
      "tenant_password",
      "owner@example.com",
      expect.anything(),
    );
  });

  it("rate-limits the step-up SMS per identity, never under a shared empty key", async () => {
    const res = await POST(post({ action: "send_sms" }));
    expect(res.status).toBe(200);
    expect(mocks.issueSmsMfaChallenge).toHaveBeenCalledWith(
      expect.objectContaining({ subjectId: IDENTITY, email: PHONE, purpose: "step_up_sms" }),
    );
  });

  it("falls back to the identity id rather than an empty key", async () => {
    mocks.query.mockResolvedValue(keyRow({ identity_phone: null }));
    await POST(post({ action: "send_sms" }));
    expect(mocks.issueSmsMfaChallenge).toHaveBeenCalledWith(
      expect.objectContaining({ email: IDENTITY }),
    );
  });

  it("keeps a member without a global identity off the password method", async () => {
    mocks.requireMember.mockResolvedValue({
      session: session({ platformUserId: null }),
      error: null,
    });
    mocks.query.mockResolvedValue(keyRow({ member_email: "staff@example.com" }));
    const res = await POST(post({ method: "password", credential: "x" }));
    expect(res.status).toBe(400);
    expect(mocks.verifyPassword).not.toHaveBeenCalled();
  });
});
