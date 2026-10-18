import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Issue #885, gap 4 — the password door's assurance decision.
 *
 * The password has already been proven by the time this decision is reached,
 * so what a trusted device may skip is the *second* factor and nothing else:
 * the membership, its business and the global identity are all re-read fresh,
 * and `authorize` still decides everything the resulting session can do.
 *
 * `verifyTrustedDevice` is mocked across its verdicts; the MFA policy helpers
 * (`shouldChallengeMfaOnLogin`, `enrolmentRequirement`, `mfaAppliesToRole`)
 * and the input validators are the real implementations, so the test pins the
 * route's *composition* of them rather than restating their internals.
 *
 * Two outcomes are distinguishable from the response:
 *  - `mfaRequired: true` + an `mfaToken`, no session cookie
 *  - `{ user, business }` + the `pos_session` cookie
 */

type AnyFn = ReturnType<typeof vi.fn>;

const IDENTITY = {
  id: "platform-1",
  full_name: "مدیر",
  password_hash: "hash",
  is_active: true,
  token_version: 1,
};

const MEMBERSHIP = {
  businessId: "biz-1",
  businessName: "Alpha",
  businessSlug: "alpha",
  businessSubdomain: "alpha",
  userId: "user-1",
  role: "manager",
  fullName: "مدیر",
  locationId: null,
  isActive: true,
  businessStatus: "active",
};

const ENROLMENT = { method: "totp", confirmed: true };

const mocks = vi.hoisted(() => ({
  query: vi.fn() as AnyFn,
  withoutTenantScope: vi.fn(async (_r: string, fn: () => Promise<unknown>) => fn()) as AnyFn,
  withTenant: vi.fn(async (_id: string, fn: () => Promise<unknown>) => fn()) as AnyFn,
  signSession: vi.fn(async () => "signed-session") as AnyFn,
  createSession: vi.fn(async () => ({ session: { id: "emp-1" } })) as AnyFn,
  hostRoutingEnabled: vi.fn(() => false) as AnyFn,
  requestHost: vi.fn(() => null) as AnyFn,
  checkAuthLockout: vi.fn(async () => ({ locked: false, lockedUntil: null })) as AnyFn,
  recordAuthFailure: vi.fn(async () => {}) as AnyFn,
  recordAuthSuccess: vi.fn(async () => {}) as AnyFn,
  membershipsForPlatformUser: vi.fn(async () => [{ ...MEMBERSHIP }]) as AnyFn,
  membershipBlockedReason: vi.fn(() => null) as AnyFn,
  getMfaPolicy: vi.fn(async () => ({ requireForManagers: true })) as AnyFn,
  getAccountMfaEnrolments: vi.fn(async () => [{ ...ENROLMENT }]) as AnyFn,
  filterActiveMfaEnrolments: vi.fn((rows: unknown[]) => rows) as AnyFn,
  getMfaGracePeriod: vi.fn(async () => null as Date | null) as AnyFn,
  markMfaGracePeriod: vi.fn(async () => {}) as AnyFn,
  signMfaPendingToken: vi.fn(async () => "mfa-pending") as AnyFn,
  readTrustedDeviceToken: vi.fn(() => "tdev_presented") as AnyFn,
  verifyTrustedDevice: vi.fn() as AnyFn,
  auditTrustedDeviceLogin: vi.fn(async () => {}) as AnyFn,
  revokeTrustedDevicesForPlatformUser: vi.fn(async () => 1) as AnyFn,
  bcryptCompare: vi.fn(async () => true) as AnyFn,
}));

vi.mock("@/lib/db", () => ({
  query: mocks.query,
  withTenant: mocks.withTenant,
  withoutTenantScope: mocks.withoutTenantScope,
}));
vi.mock("@/lib/auth", () => ({
  SESSION_COOKIE: "pos_session",
  sessionCookieOptions: () => ({ httpOnly: true }),
  signSession: mocks.signSession,
}));
vi.mock("@/lib/employee-service", () => ({ createSession: mocks.createSession }));
vi.mock("@/lib/host", () => ({
  hostRoutingEnabled: mocks.hostRoutingEnabled,
  parseHost: () => ({ kind: "root" }),
  requestHost: mocks.requestHost,
  rootDomain: () => "example.com",
}));
vi.mock("@/lib/host-resolution", () => ({
  resolveBusinessByLabel: vi.fn(async () => null),
}));
vi.mock("@/lib/login-lockout-service", () => ({
  checkAuthLockout: mocks.checkAuthLockout,
  recordAuthFailure: mocks.recordAuthFailure,
  recordAuthSuccess: mocks.recordAuthSuccess,
}));
vi.mock("@/lib/memberships", () => ({
  membershipsForPlatformUser: mocks.membershipsForPlatformUser,
  membershipBlockedReason: mocks.membershipBlockedReason,
}));
vi.mock("@/lib/mfa-service", () => ({
  getAccountMfaEnrolments: mocks.getAccountMfaEnrolments,
  filterActiveMfaEnrolments: mocks.filterActiveMfaEnrolments,
  getMfaGracePeriod: mocks.getMfaGracePeriod,
  markMfaGracePeriod: mocks.markMfaGracePeriod,
  signMfaPendingToken: mocks.signMfaPendingToken,
}));
vi.mock("@/lib/mfa-policy", () => ({ getMfaPolicy: mocks.getMfaPolicy }));
vi.mock("@/lib/trusted-device", () => ({
  readTrustedDeviceToken: mocks.readTrustedDeviceToken,
  verifyTrustedDevice: mocks.verifyTrustedDevice,
  auditTrustedDeviceLogin: mocks.auditTrustedDeviceLogin,
  revokeTrustedDevicesForPlatformUser: mocks.revokeTrustedDevicesForPlatformUser,
}));
vi.mock("bcryptjs", () => ({ default: { compare: mocks.bcryptCompare } }));

// `@/lib/mfa` and `@/lib/login-contract` stay real: the challenge rule and the
// input bounds are exactly what this route is supposed to be composing.
vi.mock("@/lib/mfa", async (importActual) => await importActual<typeof import("@/lib/mfa")>());
vi.mock("@/lib/login-contract", async (importActual) =>
  await importActual<typeof import("@/lib/login-contract")>(),
);

const { POST } = await import("./route");

function postLogin(body: Record<string, unknown> = {}) {
  return new NextRequest("http://localhost/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "manager@alpha.test",
      password: "correct horse battery",
      businessId: "biz-1",
      ...body,
    }),
  });
}

function issuedSession(res: Response) {
  return res.headers.getSetCookie?.().some((c) => c.startsWith("pos_session=")) ?? false;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.query.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM platform_users WHERE email")) return { rows: [{ ...IDENTITY }] };
    return { rows: [] };
  });
  mocks.membershipsForPlatformUser.mockResolvedValue([{ ...MEMBERSHIP }]);
  mocks.getAccountMfaEnrolments.mockResolvedValue([{ ...ENROLMENT }]);
  mocks.getMfaPolicy.mockResolvedValue({ requireForManagers: true });
  mocks.readTrustedDeviceToken.mockReturnValue("tdev_presented");
  mocks.bcryptCompare.mockResolvedValue(true);
});

describe("password login — device trust waives the second factor only (gap 4)", () => {
  it("skips MFA for a trusted device on this account and tenant", async () => {
    mocks.verifyTrustedDevice.mockResolvedValue({ trusted: true, reason: "trusted" });

    const res = await POST(postLogin());
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.mfaRequired).toBeUndefined();
    expect(data.business).toMatchObject({ id: "biz-1", slug: "alpha" });
    expect(issuedSession(res)).toBe(true);

    expect(mocks.verifyTrustedDevice).toHaveBeenCalledWith({
      businessId: MEMBERSHIP.businessId,
      userId: MEMBERSHIP.userId,
      token: "tdev_presented",
    });
  });

  it("demands MFA from an untrusted device", async () => {
    mocks.verifyTrustedDevice.mockResolvedValue({ trusted: false, reason: "wrong_subject" });

    const res = await POST(postLogin());
    const data = await res.json();

    expect(data.mfaRequired).toBe(true);
    expect(data.mfaToken).toBe("mfa-pending");
    expect(issuedSession(res)).toBe(false);
  });

  it("demands MFA again once the trust was revoked", async () => {
    mocks.verifyTrustedDevice.mockResolvedValue({ trusted: false, reason: "revoked" });

    const res = await POST(postLogin());
    const data = await res.json();

    expect(data.mfaRequired).toBe(true);
    expect(issuedSession(res)).toBe(false);
  });

  it("demands MFA again once the trust expired past seven days", async () => {
    mocks.verifyTrustedDevice.mockResolvedValue({ trusted: false, reason: "expired" });

    const res = await POST(postLogin());
    const data = await res.json();

    expect(data.mfaRequired).toBe(true);
    expect(issuedSession(res)).toBe(false);
  });

  it("demands MFA when no trusted-device cookie was presented at all", async () => {
    mocks.readTrustedDeviceToken.mockReturnValue(null);
    mocks.verifyTrustedDevice.mockResolvedValue({ trusted: false, reason: "missing" });

    const res = await POST(postLogin());
    const data = await res.json();

    expect(data.mfaRequired).toBe(true);
    expect(issuedSession(res)).toBe(false);
  });

  it("spends no trust query when no second factor is owed", async () => {
    mocks.getAccountMfaEnrolments.mockResolvedValue([]);
    mocks.getMfaPolicy.mockResolvedValue({ requireForManagers: false });

    const res = await POST(postLogin());

    expect(mocks.verifyTrustedDevice).not.toHaveBeenCalled();
    expect(issuedSession(res)).toBe(true);
  });

  it("cannot buy a session with trust alone: a wrong password is refused first", async () => {
    mocks.bcryptCompare.mockResolvedValue(false);
    mocks.verifyTrustedDevice.mockResolvedValue({ trusted: true, reason: "trusted" });

    const res = await POST(postLogin());

    expect(res.status).toBe(401);
    expect(mocks.verifyTrustedDevice).not.toHaveBeenCalled();
    expect(issuedSession(res)).toBe(false);
  });

  it("refuses a malformed credential before touching bcrypt or the trust table", async () => {
    const res = await POST(postLogin({ email: 1, password: [] }));

    expect(res.status).toBe(400);
    expect(mocks.bcryptCompare).not.toHaveBeenCalled();
    expect(mocks.verifyTrustedDevice).not.toHaveBeenCalled();
  });
});

describe("password login — trusted devices are visible and lockout takes them back (#885)", () => {
  it("records a trusted-device login before it issues the session", async () => {
    const expiresAt = new Date("2026-10-25T00:00:00Z");
    mocks.verifyTrustedDevice.mockResolvedValue({ trusted: true, expiresAt });
    const order: string[] = [];
    mocks.auditTrustedDeviceLogin.mockImplementation(async () => {
      order.push("audit");
    });
    mocks.createSession.mockImplementation(async () => {
      order.push("session");
      return { session: { id: "emp-1" } };
    });

    const res = await POST(postLogin());

    expect(issuedSession(res)).toBe(true);
    expect(mocks.auditTrustedDeviceLogin).toHaveBeenCalledWith({
      businessId: "biz-1",
      userId: "user-1",
      platformUserId: "platform-1",
      door: "password",
      waived: "mfa",
      expiresAt,
    });
    expect(order).toEqual(["audit", "session"]);
  });

  it("refuses the login when the audit row cannot be written", async () => {
    mocks.verifyTrustedDevice.mockResolvedValue({ trusted: true, expiresAt: new Date() });
    mocks.auditTrustedDeviceLogin.mockRejectedValueOnce(new Error("audit down"));

    await expect(POST(postLogin())).rejects.toThrow("audit down");
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it("writes no trusted-device row when the second factor was actually completed", async () => {
    mocks.verifyTrustedDevice.mockResolvedValue({ trusted: false, reason: "missing" });

    await POST(postLogin());

    expect(mocks.auditTrustedDeviceLogin).not.toHaveBeenCalled();
  });

  it("revokes the identity's trusted devices on the failure that locks the account", async () => {
    mocks.bcryptCompare.mockResolvedValue(false);
    mocks.checkAuthLockout.mockResolvedValue({ locked: true, lockedUntil: "2026-10-18T12:00:00Z" });

    const res = await POST(postLogin());

    // A wrong password still answers like any other: no hint that it locked.
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid_credentials" });
    expect(mocks.revokeTrustedDevicesForPlatformUser).toHaveBeenCalledWith({
      platformUserId: "platform-1",
      reason: "account_locked",
    });
  });

  it("leaves trust alone for a failure below the lockout threshold", async () => {
    mocks.bcryptCompare.mockResolvedValue(false);
    mocks.checkAuthLockout.mockResolvedValue({ locked: false, lockedUntil: null });

    await POST(postLogin());

    expect(mocks.revokeTrustedDevicesForPlatformUser).not.toHaveBeenCalled();
  });

  it("revokes nothing for an unknown address even when its attempts are locked", async () => {
    mocks.query.mockImplementation(async () => ({ rows: [] }));
    mocks.checkAuthLockout.mockResolvedValue({ locked: true, lockedUntil: "2026-10-18T12:00:00Z" });

    const res = await POST(postLogin());

    expect(res.status).toBe(401);
    expect(mocks.revokeTrustedDevicesForPlatformUser).not.toHaveBeenCalled();
  });
});
