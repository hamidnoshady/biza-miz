import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * #1386 — the direct phone-login request path.
 *
 * The branch under test is the one with no business named (the cloud root):
 * it must resolve the canonical global identity first, answer an unknown or
 * ambiguous number exactly like a known one without sending an SMS, and bind
 * the challenge to the login purpose.
 */
type AnyFn = ReturnType<typeof vi.fn>;

const mocks = vi.hoisted(() => ({
  query: vi.fn() as AnyFn,
  withoutTenantScope: vi.fn(async (_r: string, fn: () => Promise<unknown>) => fn()) as AnyFn,
  withTenant: vi.fn(async (_id: string, fn: () => Promise<unknown>) => fn()) as AnyFn,
  resolveLoginBusinessId: vi.fn() as AnyFn,
  checkLoginLockout: vi.fn(async () => ({ locked: false, lockedUntil: null })) as AnyFn,
  requestHost: vi.fn(() => null) as AnyFn,
  issueOtpChallenge: vi.fn() as AnyFn,
  consumeAllChallenges: vi.fn(async () => 0) as AnyFn,
  phoneDerivedSubject: vi.fn(async () => "phone-subject") as AnyFn,
  signPhonePendingToken: vi.fn(async () => "pending-token") as AnyFn,
  sendEmployeePhoneOtp: vi.fn() as AnyFn,
  checkPhoneOtpRateLimit: vi.fn(async () => ({ allowed: true })) as AnyFn,
  getSmsProvider: vi.fn() as AnyFn,
  sendOtp: vi.fn(async () => undefined) as AnyFn,
}));

vi.mock("@/lib/db", () => ({
  query: mocks.query,
  withoutTenantScope: mocks.withoutTenantScope,
  withTenant: mocks.withTenant,
}));
vi.mock("@/lib/host", () => ({ requestHost: mocks.requestHost }));
vi.mock("@/lib/employee-service", () => ({
  resolveLoginBusinessId: mocks.resolveLoginBusinessId,
  checkLoginLockout: mocks.checkLoginLockout,
}));
vi.mock("@/lib/otp-challenge", () => ({
  issueOtpChallenge: mocks.issueOtpChallenge,
  consumeAllChallenges: mocks.consumeAllChallenges,
  phoneDerivedSubject: mocks.phoneDerivedSubject,
  PENDING_PHONE_REALM: "phone_pending",
}));
vi.mock("@/lib/sms-config", () => ({ getSmsProvider: mocks.getSmsProvider }));
vi.mock("@/lib/phone-otp", () => ({
  PENDING_PHONE_REALM: "phone_pending",
  canonicalMemberPhone: (value: unknown) =>
    value === "09121234567" ? "+989121234567" : null,
  maskPhoneE164: () => "+989***4567",
  checkPhoneOtpRateLimit: mocks.checkPhoneOtpRateLimit,
  sendEmployeePhoneOtp: mocks.sendEmployeePhoneOtp,
  signPhonePendingToken: mocks.signPhonePendingToken,
  verifyPhonePendingToken: vi.fn(),
}));

import { POST } from "./route";

function request(body: Record<string, unknown> = {}) {
  return new NextRequest("http://test.local/api/auth/phone-otp/request", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone: "09121234567", ...body }),
  });
}

beforeEach(() => {
  for (const fn of Object.values(mocks)) (fn as AnyFn).mockClear();
  mocks.withoutTenantScope.mockImplementation(async (_r: string, fn: () => Promise<unknown>) => fn());
  mocks.resolveLoginBusinessId.mockResolvedValue({
    businessId: null,
    error: "business_required",
  });
  mocks.getSmsProvider.mockResolvedValue({ sendOtp: mocks.sendOtp });
  mocks.issueOtpChallenge.mockResolvedValue({
    challengeId: "challenge-1",
    code: "123456",
    expiresAt: new Date(Date.now() + 300_000),
  });
  mocks.signPhonePendingToken.mockResolvedValue("pending-token");
  mocks.phoneDerivedSubject.mockResolvedValue("phone-subject");
  mocks.checkPhoneOtpRateLimit.mockResolvedValue({ allowed: true });
});

describe("direct phone login request", () => {
  it("resolves the global identity and sends one login-purpose code", async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM platform_users p")) return { rows: [{ id: "platform-1" }] };
      return { rows: [] };
    });

    const res = await POST(request());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("sent");
    expect(body.purpose).toBe("login");
    expect(mocks.issueOtpChallenge).toHaveBeenCalledWith({
      subjectRealm: "phone_pending",
      subjectId: "phone-subject",
      purpose: "login",
      candidatePhoneE164: "+989121234567",
    });
    expect(mocks.sendOtp).toHaveBeenCalledWith("+989121234567", "123456");
  });

  it("answers an unknown number without sending and without naming the miss", async () => {
    mocks.query.mockResolvedValue({ rows: [] });

    const res = await POST(request());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("sent");
    // Anti-enumeration: a token is returned so verify can only say "wrong code".
    expect(body.token).toBe("pending-token");
    expect(mocks.issueOtpChallenge).not.toHaveBeenCalled();
    expect(mocks.sendOtp).not.toHaveBeenCalled();
  });

  it("refuses an ambiguous global number without sending", async () => {
    mocks.query.mockResolvedValue({
      rows: [{ id: "platform-1" }, { id: "platform-2" }],
    });

    const res = await POST(request());

    expect(res.status).toBe(200);
    expect(mocks.sendOtp).not.toHaveBeenCalled();
    expect(mocks.issueOtpChallenge).not.toHaveBeenCalled();
  });

  it("does not send when the per-phone limiter is spent", async () => {
    mocks.query.mockResolvedValue({ rows: [{ id: "platform-1" }] });
    mocks.checkPhoneOtpRateLimit.mockResolvedValue({
      allowed: false,
      retryAfterMs: 60_000,
    });

    const res = await POST(request());

    expect(res.status).toBe(429);
    expect(mocks.sendOtp).not.toHaveBeenCalled();
  });
});
