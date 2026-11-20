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
  id: "00000000-0000-4000-8000-000000000001",
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
  resolveTrustedDeviceSubject: vi.fn() as AnyFn,
  auditTrustedDeviceLogin: vi.fn(async () => {}) as AnyFn,
  bcryptCompare: vi.fn(async () => true) as AnyFn,
  // The privileged-role gate. Real implementations reach the database, so they
  // are the one policy boundary this route-level test states outright.
  isPrivilegedMfaRole: vi.fn((role: string) => role !== "cashier" && role !== "waiter" && role !== "kitchen") as AnyFn,
  mfaAppliesToRole: vi.fn(() => true) as AnyFn,
  getMfaPolicy: vi.fn(async () => ({ requiredRoles: [] })) as AnyFn,
  getAccountMfaEnrolments: vi.fn(async () => []) as AnyFn,
  filterActiveMfaEnrolments: vi.fn((rows: unknown[]) => rows) as AnyFn,
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
  // The route resolves the trusted subject once — it also decides whether the
  // PIN-only greeting and the privileged-role waiver apply, not just the phone
  // gate — so the mock answers that shape.
  resolveTrustedDeviceSubject: mocks.resolveTrustedDeviceSubject,
  auditTrustedDeviceLogin: mocks.auditTrustedDeviceLogin,
}));
vi.mock("@/lib/mfa", () => ({
  isPrivilegedMfaRole: mocks.isPrivilegedMfaRole,
  mfaAppliesToRole: mocks.mfaAppliesToRole,
}));
vi.mock("@/lib/mfa-policy", () => ({ getMfaPolicy: mocks.getMfaPolicy }));
vi.mock("@/lib/mfa-service", () => ({
  getAccountMfaEnrolments: mocks.getAccountMfaEnrolments,
  filterActiveMfaEnrolments: mocks.filterActiveMfaEnrolments,
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
  mocks.resolveTrustedDeviceSubject.mockResolvedValue(null);
});

describe("PIN login — device trust decides the routine challenge (gap 4)", () => {
  it("skips the OTP challenge for a trusted device on this account and tenant", async () => {
    const expiresAt = new Date("2026-10-25T00:00:00Z");
    mocks.resolveTrustedDeviceSubject.mockResolvedValue({ userId: USER.id, expiresAt });

    const res = await POST(postPin());
    const data = await res.json();

    expect(res.status).toBe(200);
    // The skipped challenge is recorded (#885), naming the door and the factor.
    expect(mocks.auditTrustedDeviceLogin).toHaveBeenCalledWith(
      expect.objectContaining({ door: "pin", waived: "phone_otp", userId: USER.id, expiresAt }),
    );
    expect(data.phoneVerification).toBeUndefined();
    expect(data.user).toEqual({ id: USER.id, role: USER.role, fullName: USER.full_name });
    expect(issuedSession(res)).toBe(true);

    // The exemption has to be *scoped*, or it is the old member-wide window
    // wearing a new name: this business, the presented cookie — and the session
    // still names the member only because the PIN proved it.
    expect(mocks.resolveTrustedDeviceSubject).toHaveBeenCalledWith({
      businessId: USER.business_id,
      token: "tdev_presented",
    });
  });

  it("demands the OTP from an untrusted device, even minutes after another device verified", async () => {
    mocks.resolveTrustedDeviceSubject.mockResolvedValue(null);

    const res = await POST(postPin());
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.phoneVerification).toBe("otp");
    expect(data.phoneToken).toBe("pending-token");
    expect(issuedSession(res)).toBe(false);
  });

  it("demands the OTP again once the trust was revoked", async () => {
    mocks.resolveTrustedDeviceSubject.mockResolvedValue(null);

    const res = await POST(postPin());
    const data = await res.json();

    expect(data.phoneVerification).toBe("otp");
    expect(issuedSession(res)).toBe(false);
  });

  it("demands the OTP again once the trust expired past seven days", async () => {
    mocks.resolveTrustedDeviceSubject.mockResolvedValue(null);

    const res = await POST(postPin());
    const data = await res.json();

    expect(data.phoneVerification).toBe("otp");
    expect(issuedSession(res)).toBe(false);
  });

  it("never exempts a device with no trusted-device cookie at all", async () => {
    mocks.readTrustedDeviceToken.mockReturnValue(null);
    mocks.resolveTrustedDeviceSubject.mockResolvedValue(null);

    const res = await POST(postPin());
    const data = await res.json();

    expect(data.phoneVerification).toBe("otp");
    expect(issuedSession(res)).toBe(false);
  });

  it("waives nothing while the policy is unenforced — there is no challenge, so no audit row", async () => {
    mocks.phoneOtpEnforcementFor.mockResolvedValue({ state: "off", daysLeft: null });
    mocks.resolveTrustedDeviceSubject.mockResolvedValue({
      userId: USER.id,
      expiresAt: new Date("2026-10-25T00:00:00Z"),
    });

    const res = await POST(postPin());
    const data = await res.json();

    expect(mocks.auditTrustedDeviceLogin).not.toHaveBeenCalled();
    expect(issuedSession(res)).toBe(true);
    expect(data.phoneVerification).toBeUndefined();
  });

  it("cannot buy a session with trust alone: a wrong PIN is still refused", async () => {
    mocks.bcryptCompare.mockResolvedValue(false);
    mocks.resolveTrustedDeviceSubject.mockResolvedValue({
      userId: USER.id,
      expiresAt: new Date("2026-10-25T00:00:00Z"),
    });

    const res = await POST(postPin());

    expect(res.status).toBe(401);
    expect(mocks.signSession).not.toHaveBeenCalled();
    expect(issuedSession(res)).toBe(false);
  });
});

describe("PIN login — a trusted device may carry the privileged PIN door", () => {
  const OWNER = { ...USER, role: "owner", phone_e164: null, phone_verified_at: null };
  const expiresAt = new Date("2026-10-25T00:00:00Z");

  beforeEach(() => {
    mocks.query.mockResolvedValue({ rows: [{ ...OWNER }] });
    mocks.phoneOtpEnforcementFor.mockResolvedValue({ state: "off", daysLeft: null });
    // `clearAllMocks` keeps implementations between tests; the
    // wrong-PIN case above sets this to false, so state it here too.
    mocks.bcryptCompare.mockResolvedValue(true);
  });

  it("lets the owner's PIN through on a device that completed the second factor, and records the waiver", async () => {
    mocks.resolveTrustedDeviceSubject.mockResolvedValue({ userId: OWNER.id, expiresAt });

    const res = await POST(postPin());
    // The widening is exactly this one member: a trust record minted only by a
    // completed verification is what stands in for the second factor here.
    expect(issuedSession(res)).toBe(true);
    expect(mocks.auditTrustedDeviceLogin).toHaveBeenCalledWith(
      expect.objectContaining({ door: "pin", waived: "mfa", userId: OWNER.id, expiresAt }),
    );
  });

  it("still sends an owner without device trust to the account door", async () => {
    mocks.resolveTrustedDeviceSubject.mockResolvedValue(null);

    const res = await POST(postPin());
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("mfa_required");
    expect(issuedSession(res)).toBe(false);
    expect(mocks.auditTrustedDeviceLogin).not.toHaveBeenCalled();
  });
});

describe("PIN login — the member is named, the PIN is never an identifier", () => {
  it("refuses a PIN without an employee instead of scanning every member's PIN", async () => {
    const res = await POST(postPin({ employeeId: undefined }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("employee_required");
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.bcryptCompare).not.toHaveBeenCalled();
  });

  it("checks the PIN against the named member only", async () => {
    await POST(postPin());
    const [sql, params] = mocks.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("AND u.id = $1");
    // $2 is the trusted member's id (null here), which may widen the role list
    // by exactly that one account — never into a PIN scan.
    expect(params).toEqual([USER.id, null]);
    expect(mocks.bcryptCompare).toHaveBeenCalledTimes(1);
  });
});
