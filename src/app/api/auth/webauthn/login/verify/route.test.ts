import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Issue #885, gap 4 — what assurance the biometric door provides.
 *
 * Every other primary path in this audit had the same shape: prove a
 * credential, then decide whether a *routine second factor* is still owed,
 * with a trusted device allowed to waive that second factor. WebAuthn has no
 * such second decision, and that is the point worth pinning rather than an
 * omission to paper over:
 *
 * A verified WebAuthn assertion is a signature made by a hardware-bound key
 * over a server-issued challenge, on this origin. It is already the second
 * factor — possession plus (normally) a user gesture — so there is no
 * additional routine challenge here for a trusted device to skip. Consulting
 * `trusted_devices` on this path could only *weaken* it: a stale trust row
 * would have nothing left to waive, and reading it would invite someone to
 * treat "trusted" as a substitute for the ceremony.
 *
 * So this file asserts the opposite of an exemption:
 *  - the assertion is verified before anything is minted,
 *  - a failed ceremony mints nothing and is audited,
 *  - the route never consults trusted-device state at all,
 *  - the credential is bound to the employee it was registered for,
 *  - the session it mints is the same shape `pin-login` mints, so nothing
 *    downstream can tell biometric apart and grant it more.
 *
 * The database half — that the credential row really belongs to that
 * employee, and that the challenge really is single-use — is exercised
 * against a real PostgreSQL in `integration/staff-login-tenant.integration.test.ts`.
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
};

const mocks = vi.hoisted(() => ({
  query: vi.fn() as AnyFn,
  withTenant: vi.fn(async (_id: string, fn: () => Promise<unknown>) => fn()) as AnyFn,
  resolveLoginBusinessId: vi.fn(async () => ({ businessId: "biz-1", error: null })) as AnyFn,
  checkLoginLockout: vi.fn(async () => ({ locked: false, lockedUntil: null })) as AnyFn,
  completeWebauthnAuthentication: vi.fn() as AnyFn,
  auditLoginFailure: vi.fn(async () => {}) as AnyFn,
  createSession: vi.fn(async () => ({ session: { id: "emp-1" } })) as AnyFn,
  resolveDeviceId: vi.fn(async () => null) as AnyFn,
  signSession: vi.fn(async () => "signed-session") as AnyFn,
  expectedOriginsFor: vi.fn(() => ["https://alpha.example.com"]) as AnyFn,
  // Spies on the module gap 4 would have had to touch if this path exempted
  // anything. They are asserted *not* to have been called.
  verifyTrustedDevice: vi.fn(async () => ({ trusted: true, reason: "trusted" })) as AnyFn,
  readTrustedDeviceToken: vi.fn(() => "tdev_presented") as AnyFn,
  issueTrustedDevice: vi.fn(async () => ({ token: "tdev_new", expiresAt: new Date() })) as AnyFn,
}));

vi.mock("@/lib/db", () => ({ query: mocks.query, withTenant: mocks.withTenant }));
vi.mock("@/lib/auth", () => ({
  SESSION_COOKIE: "pos_session",
  sessionCookieOptions: () => ({ httpOnly: true }),
  signSession: mocks.signSession,
}));
vi.mock("@/lib/employee-service", () => ({
  resolveLoginBusinessId: mocks.resolveLoginBusinessId,
  checkLoginLockout: mocks.checkLoginLockout,
  completeWebauthnAuthentication: mocks.completeWebauthnAuthentication,
  auditLoginFailure: mocks.auditLoginFailure,
  createSession: mocks.createSession,
}));
vi.mock("@/lib/device-service", () => ({ resolveDeviceId: mocks.resolveDeviceId }));
vi.mock("@/lib/webauthn", () => ({ expectedOriginsFor: mocks.expectedOriginsFor }));
vi.mock("@/lib/host", () => ({ requestHost: () => "alpha.example.com" }));
vi.mock("@/lib/trusted-device", () => ({
  verifyTrustedDevice: mocks.verifyTrustedDevice,
  readTrustedDeviceToken: mocks.readTrustedDeviceToken,
  issueTrustedDevice: mocks.issueTrustedDevice,
}));
vi.mock("@/lib/login-eligibility", () => ({
  WEBAUTHN_LOGIN_ROLES_SQL: "('cashier','manager')",
}));

const { POST } = await import("./route");

function postAssertion(body: Record<string, unknown> = {}) {
  return new NextRequest("http://localhost/api/auth/webauthn/login/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      employeeId: USER.id,
      response: { id: "assertion", rawId: "assertion", type: "public-key" },
      challengeToken: "challenge-1",
      businessId: "biz-1",
      ...body,
    }),
  });
}

function issuedSession(res: Response) {
  return res.headers.getSetCookie?.().some((c) => c.startsWith("pos_session=")) ?? false;
}

beforeEach(() => {
  // `clearAllMocks` wipes call history but *not* implementations, so a test
  // that installs a locked-account or empty-membership stub would otherwise
  // leak into every test after it. Each stub that a test overrides is
  // therefore re-established here.
  vi.clearAllMocks();
  mocks.query.mockResolvedValue({ rows: [{ ...USER }] });
  mocks.completeWebauthnAuthentication.mockResolvedValue({ credentialId: "cred-1" });
  mocks.checkLoginLockout.mockResolvedValue({ locked: false, lockedUntil: null });
  mocks.auditLoginFailure.mockResolvedValue(undefined);
});

describe("biometric login — the ceremony is the assurance (gap 4)", () => {
  it("mints a session only after the assertion verifies", async () => {
    const res = await POST(postAssertion());
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.user).toEqual({ id: USER.id, role: USER.role, fullName: USER.full_name });
    expect(issuedSession(res)).toBe(true);
    expect(mocks.completeWebauthnAuthentication).toHaveBeenCalled();
  });

  it("mints nothing and audits when the ceremony fails", async () => {
    mocks.completeWebauthnAuthentication.mockResolvedValue(null);

    const res = await POST(postAssertion());

    expect(res.status).toBe(401);
    expect(issuedSession(res)).toBe(false);
    expect(mocks.auditLoginFailure).toHaveBeenCalledWith("biz-1", USER.id, "invalid_assertion");
    // A failed ceremony must not reach the membership query at all.
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("refuses a locked account before attempting the ceremony", async () => {
    mocks.checkLoginLockout.mockResolvedValue({ locked: true, lockedUntil: "2026-01-01" });

    const res = await POST(postAssertion());

    expect(res.status).toBe(423);
    expect(mocks.completeWebauthnAuthentication).not.toHaveBeenCalled();
    expect(issuedSession(res)).toBe(false);
  });

  it("refuses a member who is inactive or outside the biometric-eligible roles", async () => {
    mocks.query.mockResolvedValue({ rows: [] });

    const res = await POST(postAssertion());

    expect(res.status).toBe(401);
    expect(issuedSession(res)).toBe(false);
    expect(mocks.auditLoginFailure).toHaveBeenCalledWith("biz-1", USER.id, "employee_inactive");
  });

  it("never consults trusted-device state: there is no routine factor here to waive", async () => {
    const res = await POST(postAssertion());

    // Asserted against a login that actually succeeded, so a short-circuited
    // response cannot make this pass by never reaching the decision at all.
    expect(res.status).toBe(200);
    expect(issuedSession(res)).toBe(true);

    // If either of these ever starts firing, someone has wired a trust
    // exemption into a path whose primary credential is already
    // possession-bound. That would mean a stale seven-day row could stand in
    // for the ceremony.
    expect(mocks.verifyTrustedDevice).not.toHaveBeenCalled();
    expect(mocks.readTrustedDeviceToken).not.toHaveBeenCalled();
    expect(mocks.issueTrustedDevice).not.toHaveBeenCalled();
  });

  it("mints the same session shape pin-login does, binding the credential used", async () => {
    const res = await POST(postAssertion());

    expect(issuedSession(res)).toBe(true);
    // `employeeSessionId` is what makes `checkEmployeeSession` re-validate the
    // session live, exactly as it does for a PIN login — biometric is a
    // different way to prove identity, not a more privileged kind of session.
    expect(mocks.createSession).toHaveBeenCalledWith(
      USER.id,
      USER.business_id,
      expect.objectContaining({ credentialId: "cred-1" }),
    );
    expect(mocks.signSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sub: USER.id,
        businessId: USER.business_id,
        // This fixture has no linked global identity, so the route's
        // `LEFT JOIN platform_users` yields nothing and the claim is absent
        // rather than an explicit null. What matters is that it is *not*
        // populated: no global capability rides on a site-local biometric.
        platformUserId: undefined,
      }),
    );
    expect(res.headers.getSetCookie?.()[0]).toContain("pos_session=");
  });
});
