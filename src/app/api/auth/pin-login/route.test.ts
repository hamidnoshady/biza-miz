import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Issue #885, gap 4 — the PIN door's assurance decision.
 *
 * The rule under test is the one the *route* composes: once the PIN has
 * proved who is asking, is a second factor still owed? `pinGateCloses` owns
 * the arithmetic and has its own unit tests; what only a route-level test can
 * pin is that this door actually consults trusted-device state and acts on
 * it, rather than reading the member-wide `users.otp_login_at` stamp that
 * used to exempt every till in the shop because one of them had verified.
 *
 * So `verifyTrustedDevice` is mocked (the four verdicts it can return) while
 * `pinGateCloses` and `memberPhoneState` are the real implementations. The
 * assertions are about which of the two responses the caller gets:
 *
 *  - challenge  — `{ phoneVerification, phoneToken, ... }`, no session cookie
 *  - session    — `{ user }` plus the `pos_session` cookie
 *
 * A trusted device skips the *routine* challenge only. The PIN is still
 * proven on every case below, and nothing here widens what the resulting
 * session may do — `authorize` decides that afterwards.
 */

type AnyFn = ReturnType<typeof vi.fn>;

const USER = {
  id: "user-1",
  business_id: "biz-1",
  business_slug: "alpha",
  business_subdomain: "alpha",
  location_id: null,
  role: "cashier",
  full_name: "صندوق‌دار",
  pin_hash: "hash",
  phone_e164: "+989121000001",
  phone_verified_at: new Date("2026-01-01T00:00:00Z"),
};

const mocks = vi.hoisted(() => ({
  query: vi.fn() as AnyFn,
  withTenant: vi.fn(async (_id: string, fn: () => Promise<unknown>) => fn()) as AnyFn,
  readDeploymentProfile: vi.fn(async () => ({ profile: "cloud" })) as AnyFn,
  pinEligibleRolesSql: vi.fn(() => "('cashier','manager')") as AnyFn,
  resolveLoginBusinessId: vi.fn(async () => ({ businessId: "biz-1", error: null })) as AnyFn,
  checkLoginLockout: vi.fn(async () => ({ locked: false, lockedUntil: null })) as AnyFn,
  auditLoginFailure: vi.fn(async () => {}) as AnyFn,
  createSession: vi.fn(async () => ({ session: { id: "emp-session-1" } })) as AnyFn,
  ensureEmployeeProfile: vi.fn(async () => {}) as AnyFn,
  resolveDeviceId: vi.fn(async () => null) as AnyFn,
  signSession: vi.fn(async () => "signed-session") as AnyFn,
  phoneOtpEnforcementFor: vi.fn(async () => ({ state: "enforced", daysLeft: 0 })) as AnyFn,
  maskPhoneE164: vi.fn((p: string) => `***${p.slice(-4)}`) as AnyFn,
  signPhonePendingToken: vi.fn(async () => "pending-token") as AnyFn,
  readTrustedDeviceToken: vi.fn(() => "tdev_presented") as AnyFn,
  verifyTrustedDevice: vi.fn() as AnyFn,
  bcryptCompare: vi.fn(async () => true) as AnyFn,
}));

vi.mock("@/lib/db", () => ({ query: mocks.query, withTenant: mocks.withTenant }));
vi.mock("@/lib/deployment-mode", () => ({ readDeploymentProfile: mocks.readDeploymentProfile }));
vi.mock("@/lib/login-eligibility", () => ({ pinEligibleRolesSql: mocks.pinEligibleRolesSql }));
vi.mock("@/lib/host", () => ({ requestHost: () => "alpha.example.com" }));
vi.mock("@/lib/team", () => ({ PIN_MIN_LENGTH: 4, PIN_MAX_LENGTH: 12 }));
vi.mock("@/lib/device-service", () => ({ resolveDeviceId: mocks.resolveDeviceId }));
vi.mock("@/lib/employee-service", () => ({
  resolveLoginBusinessId: mocks.resolveLoginBusinessId,
  checkLoginLockout: mocks.checkLoginLockout,
  auditLoginFailure: mocks.auditLoginFailure,
  createSession: mocks.createSession,
  ensureEmployeeProfile: mocks.ensureEmployeeProfile,
}));
vi.mock("@/lib/phone-otp", () => ({
  phoneOtpEnforcementFor: mocks.phoneOtpEnforcementFor,
  maskPhoneE164: mocks.maskPhoneE164,
  signPhonePendingToken: mocks.signPhonePendingToken,
}));
vi.mock("@/lib/trusted-device", () => ({
  readTrustedDeviceToken: mocks.readTrustedDeviceToken,
  verifyTrustedDevice: mocks.verifyTrustedDevice,
}));
vi.mock("@/lib/auth", () => ({
  SESSION_COOKIE: "pos_session",
  sessionCookieOptions: () => ({ httpOnly: true }),
  signSession: mocks.signSession,
}));
vi.mock("bcryptjs", () => ({ default: { compare: mocks.bcryptCompare } }));

const { POST } = await import("./route");

function postPin(body: Record<string, unknown> = {}) {
  return new NextRequest("http://localhost/api/auth/pin-login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pin: "1234", employeeId: USER.id, businessId: "biz-1", ...body }),
  });
}

/** True when the response minted a session rather than demanding a factor. */
function issuedSession(res: Response) {
  return res.headers.getSetCookie?.().some((c) => c.startsWith("pos_session=")) ?? false;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.query.mockResolvedValue({ rows: [{ ...USER }] });
  mocks.readDeploymentProfile.mockResolvedValue({ profile: "cloud" });
  mocks.phoneOtpEnforcementFor.mockResolvedValue({ state: "enforced", daysLeft: 0 });
  mocks.readTrustedDeviceToken.mockReturnValue("tdev_presented");
});

describe("PIN login — device trust decides the routine challenge (gap 4)", () => {
  it("skips the OTP challenge for a trusted device on this account and tenant", async () => {
    mocks.verifyTrustedDevice.mockResolvedValue({ trusted: true, reason: "trusted" });

    const res = await POST(postPin());
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.phoneVerification).toBeUndefined();
    expect(data.user).toEqual({ id: USER.id, role: USER.role, fullName: USER.full_name });
    expect(issuedSession(res)).toBe(true);

    // The exemption has to be *scoped*, or it is the old member-wide window
    // wearing a new name: this business, this member, the presented cookie.
    expect(mocks.verifyTrustedDevice).toHaveBeenCalledWith({
      businessId: USER.business_id,
      userId: USER.id,
      token: "tdev_presented",
    });
  });

  it("demands the OTP from an untrusted device, even minutes after another device verified", async () => {
    mocks.verifyTrustedDevice.mockResolvedValue({ trusted: false, reason: "wrong_subject" });

    const res = await POST(postPin());
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.phoneVerification).toBe("otp");
    expect(data.phoneToken).toBe("pending-token");
    expect(issuedSession(res)).toBe(false);
  });

  it("demands the OTP again once the trust was revoked", async () => {
    mocks.verifyTrustedDevice.mockResolvedValue({ trusted: false, reason: "revoked" });

    const res = await POST(postPin());
    const data = await res.json();

    expect(data.phoneVerification).toBe("otp");
    expect(issuedSession(res)).toBe(false);
  });

  it("demands the OTP again once the trust expired past seven days", async () => {
    mocks.verifyTrustedDevice.mockResolvedValue({ trusted: false, reason: "expired" });

    const res = await POST(postPin());
    const data = await res.json();

    expect(data.phoneVerification).toBe("otp");
    expect(issuedSession(res)).toBe(false);
  });

  it("never exempts a device with no trusted-device cookie at all", async () => {
    mocks.readTrustedDeviceToken.mockReturnValue(null);
    mocks.verifyTrustedDevice.mockResolvedValue({ trusted: false, reason: "missing" });

    const res = await POST(postPin());
    const data = await res.json();

    expect(data.phoneVerification).toBe("otp");
    expect(issuedSession(res)).toBe(false);
  });

  it("does not consult the trust table while the policy is unenforced — there is nothing to waive", async () => {
    mocks.phoneOtpEnforcementFor.mockResolvedValue({ state: "off", daysLeft: null });

    const res = await POST(postPin());
    const data = await res.json();

    expect(mocks.verifyTrustedDevice).not.toHaveBeenCalled();
    expect(issuedSession(res)).toBe(true);
    expect(data.phoneVerification).toBeUndefined();
  });

  it("cannot buy a session with trust alone: a wrong PIN is refused before trust is read", async () => {
    mocks.bcryptCompare.mockResolvedValue(false);

    const res = await POST(postPin());

    expect(res.status).toBe(401);
    expect(mocks.verifyTrustedDevice).not.toHaveBeenCalled();
    expect(issuedSession(res)).toBe(false);
  });
});
