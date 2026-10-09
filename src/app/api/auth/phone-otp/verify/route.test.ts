import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Issue #885 — the phone-OTP verify route's response contract.
 *
 * The rules this pins are ones the route *chooses*, not rules a helper decides,
 * so they have to be asserted against the handler rather than against
 * `verifyEmployeePhoneOtp`:
 *
 *  1. A number that matched nothing must answer byte-for-byte like a wrong
 *     code (L15). The request route already goes out of its way to answer an
 *     unknown number exactly as it answers a known one; if this half answered
 *     differently, the whole suppression would be undone by one response
 *     field, and a caller who typed a number could read off whether it
 *     belonged to a member.
 *  2. A token that names a member but no challenge is refused, because there
 *     is nothing it could be redeemed against (L02).
 *  3. Verification is bound to the exact challenge the token carries, and
 *     every part of that binding is passed through (L02).
 *  4. The seven-day trust is offered on this path only because every required
 *     factor has completed here, and is *not* granted when a second factor is
 *     still outstanding.
 *
 * The database half — that redemption really is single-use under concurrency,
 * that a mismatched binding really is refused by the row — is covered against
 * a real PostgreSQL in `integration/phone-otp.integration.test.ts`.
 */

/**
 * Loosely-typed stand-ins.
 *
 * `vi.hoisted` would otherwise infer the narrowest possible type from each
 * stub's first return value — `rows: never[]`, a literal `"none"` — and every
 * test that returns something more specific would fail `tsc` even though it
 * runs correctly. The point of these mocks is the *wiring* under test, so the
 * types here are deliberately permissive rather than faithful.
 */
type AnyFn = ReturnType<typeof vi.fn>;

const mocks = vi.hoisted(() => ({
  verifyPhonePendingToken: vi.fn() as AnyFn,
  verifyEmployeePhoneOtp: vi.fn() as AnyFn,
  stampPhoneVerified: vi.fn(async () => {}) as AnyFn,
  checkLoginLockout: vi.fn(async () => ({ locked: false, lockedUntil: null })) as AnyFn,
  auditLoginFailure: vi.fn(async () => {}) as AnyFn,
  createSession: vi.fn(async () => ({ session: { id: "emp-session-1" } })) as AnyFn,
  ensureEmployeeProfile: vi.fn(async () => {}) as AnyFn,
  resolveDeviceId: vi.fn(async () => null) as AnyFn,
  query: vi.fn() as AnyFn,
  withTenant: vi.fn(async (_id: string, fn: () => Promise<unknown>) => fn()) as AnyFn,
  signSession: vi.fn(async () => "signed-session") as AnyFn,
  signMfaPendingToken: vi.fn(async () => "mfa-pending") as AnyFn,
  getAccountMfaEnrolments: vi.fn(async () => [] as unknown[]) as AnyFn,
  filterActiveMfaEnrolments: vi.fn((rows: unknown[]) => rows) as AnyFn,
  getMfaGracePeriod: vi.fn(async () => null as Date | null) as AnyFn,
  markMfaGracePeriod: vi.fn(async () => {}) as AnyFn,
  getMfaPolicy: vi.fn(async () => ({ requireForManagers: false })) as AnyFn,
  mfaAppliesToRole: vi.fn(() => false) as AnyFn,
  distinctSecondFactorMethods: vi.fn(() => [] as string[]) as AnyFn,
  enrolmentRequirement: vi.fn(() => "none" as string) as AnyFn,
  shouldChallengeMfaOnLogin: vi.fn(() => false) as AnyFn,
  graceDaysRemaining: vi.fn(() => null as number | null) as AnyFn,
  issueTrustedDevice: vi.fn(async () => ({ token: "tdev_new", expiresAt: new Date() })) as AnyFn,
}));

vi.mock("@/lib/phone-otp", () => ({
  verifyPhonePendingToken: mocks.verifyPhonePendingToken,
  verifyEmployeePhoneOtp: mocks.verifyEmployeePhoneOtp,
  stampPhoneVerified: mocks.stampPhoneVerified,
}));
vi.mock("@/lib/db", () => ({ query: mocks.query, withTenant: mocks.withTenant }));
vi.mock("@/lib/employee-service", () => ({
  checkLoginLockout: mocks.checkLoginLockout,
  auditLoginFailure: mocks.auditLoginFailure,
  createSession: mocks.createSession,
  ensureEmployeeProfile: mocks.ensureEmployeeProfile,
}));
vi.mock("@/lib/device-service", () => ({ resolveDeviceId: mocks.resolveDeviceId }));
vi.mock("@/lib/trusted-device", async () => {
  const actual = await vi.importActual<typeof import("@/lib/trusted-device")>(
    "@/lib/trusted-device",
  );
  return { ...actual, issueTrustedDevice: mocks.issueTrustedDevice };
});
vi.mock("@/lib/mfa", () => ({
  distinctSecondFactorMethods: mocks.distinctSecondFactorMethods,
  enrolmentRequirement: mocks.enrolmentRequirement,
  graceDaysRemaining: mocks.graceDaysRemaining,
  mfaAppliesToRole: mocks.mfaAppliesToRole,
  MFA_GRACE_DAYS_TENANT: 14,
  shouldChallengeMfaOnLogin: mocks.shouldChallengeMfaOnLogin,
}));
vi.mock("@/lib/mfa-policy", () => ({ getMfaPolicy: mocks.getMfaPolicy }));
vi.mock("@/lib/mfa-service", () => ({
  filterActiveMfaEnrolments: mocks.filterActiveMfaEnrolments,
  getAccountMfaEnrolments: mocks.getAccountMfaEnrolments,
  getMfaGracePeriod: mocks.getMfaGracePeriod,
  markMfaGracePeriod: mocks.markMfaGracePeriod,
  signMfaPendingToken: mocks.signMfaPendingToken,
}));

import { POST } from "./route";

const BUSINESS = "11111111-1111-4111-8111-111111111111";
const USER = "33333333-3333-4333-8333-333333333333";
const CHALLENGE = "55555555-5555-4555-8555-555555555555";
const PHONE = "+989121000001";

function request(code: string, extra: Record<string, unknown> = {}): NextRequest {
  return new NextRequest("http://test.local/api/auth/phone-otp/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer pending-token" },
    body: JSON.stringify({ code, ...extra }),
  });
}

/** A fully-bound pending token, the shape the request route now mints. */
function boundPayload(overrides: Record<string, unknown> = {}) {
  return {
    sub: USER,
    businessId: BUSINESS,
    mayAttachPhone: false,
    phone: null,
    cid: CHALLENGE,
    destination: PHONE,
    purpose: "login",
    realm: "phone",
    ...overrides,
  };
}

beforeEach(() => {
  for (const fn of Object.values(mocks)) (fn as AnyFn).mockClear();
  mocks.verifyPhonePendingToken.mockResolvedValue(boundPayload());
  mocks.verifyEmployeePhoneOtp.mockResolvedValue({ verified: true });
  // A member row with no linked global identity, so the MFA branch is skipped
  // and the response is the plain session.
  mocks.query.mockResolvedValue({
    rows: [
      {
        id: USER,
        business_id: BUSINESS,
        business_slug: "test",
        business_subdomain: "test",
        location_id: null,
        role: "cashier",
        full_name: "آزمون",
        platform_user_id: null,
        identity_active: true,
        token_version: 1,
      },
    ],
    rowCount: 1,
  });
});

describe("anti-enumeration (L15)", () => {
  it("answers an unmatched number byte-for-byte like a wrong code", async () => {
    // The token the request route hands back for a number nothing matched: no
    // subject, so its verify can never succeed.
    mocks.verifyPhonePendingToken.mockResolvedValue(
      boundPayload({ sub: null, cid: null, destination: null }),
    );
    const unknownNumber = await POST(request("123456"));

    mocks.verifyPhonePendingToken.mockResolvedValue(boundPayload());
    mocks.verifyEmployeePhoneOtp.mockResolvedValue({ verified: false, reason: "wrong_code" });
    const wrongCode = await POST(request("123456"));

    // Both status and body. Comparing only the status would let a differing
    // `error` field leak the answer, which is the whole oracle.
    expect(unknownNumber.status).toBe(wrongCode.status);
    expect(await unknownNumber.json()).toEqual(await wrongCode.json());
    expect(unknownNumber.status).toBe(401);
  });

  it("does not consult the challenge at all for an unmatched number", async () => {
    mocks.verifyPhonePendingToken.mockResolvedValue(
      boundPayload({ sub: null, cid: null, destination: null }),
    );
    await POST(request("123456"));

    // Nothing to verify and nobody to lock out. Reaching the database here
    // would be a way to tell the two cases apart by timing.
    expect(mocks.verifyEmployeePhoneOtp).not.toHaveBeenCalled();
    expect(mocks.auditLoginFailure).not.toHaveBeenCalled();
  });
});

describe("challenge binding (L02)", () => {
  it("refuses a token that names a member but no challenge", async () => {
    // A pre-#885 token: it predates the binding, so there is no row it could
    // be redeemed against.
    mocks.verifyPhonePendingToken.mockResolvedValue(
      boundPayload({ cid: null, destination: null }),
    );
    const res = await POST(request("123456"));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(mocks.verifyEmployeePhoneOtp).not.toHaveBeenCalled();
  });

  it("passes the whole binding through to the verifier", async () => {
    mocks.verifyPhonePendingToken.mockResolvedValue(
      boundPayload({ purpose: "attach", mayAttachPhone: true, phone: PHONE }),
    );
    await POST(request("۱۲۳۴۵۶"));

    // Every field the token asserts about the challenge has to reach the row
    // check, or the binding is decoration.
    expect(mocks.verifyEmployeePhoneOtp).toHaveBeenCalledWith({
      challengeId: CHALLENGE,
      userId: USER,
      businessId: BUSINESS,
      purpose: "attach",
      destination: PHONE,
      // Persian digits, canonicalised at this boundary too (L11).
      code: "123456",
    });
  });

  it("rejects a code that is not six digits before touching anything", async () => {
    const res = await POST(request("12ab"));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid_code" });
    expect(mocks.verifyEmployeePhoneOtp).not.toHaveBeenCalled();
  });

  it("reports an expired challenge as expired rather than as a wrong code", async () => {
    mocks.verifyEmployeePhoneOtp.mockResolvedValue({ verified: false, reason: "expired" });
    const res = await POST(request("123456"));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "code_expired" });
    expect(mocks.auditLoginFailure).toHaveBeenCalled();
  });
});

describe("the seven-day trusted-device offer", () => {
  it("registers trust when every required factor completed on this request", async () => {
    const res = await POST(request("123456", { trustDevice: true }));

    expect(res.status).toBe(200);
    expect(mocks.issueTrustedDevice).toHaveBeenCalledTimes(1);
    expect((mocks.issueTrustedDevice.mock.calls[0] as [Record<string, unknown>])[0]).toMatchObject({
      businessId: BUSINESS,
      userId: USER,
      factorSummary: "phone_otp",
    });
    // The credential is set as the cookie; the response body carries nothing.
    expect(res.cookies.get("pos_trusted_device")?.value).toBe("tdev_new");
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain("tdev_new");
  });

  it("does not register trust when the member did not ask for it", async () => {
    const res = await POST(request("123456"));

    expect(res.status).toBe(200);
    expect(mocks.issueTrustedDevice).not.toHaveBeenCalled();
    expect(res.cookies.get("pos_trusted_device")).toBeUndefined();
  });

  it("offers but does not grant trust when a second factor is still outstanding", async () => {
    // The policy is that trust follows *all* required verification. A device
    // that has not finished the last factor must not be trusted by the step
    // that came before it.
    mocks.query.mockResolvedValue({
      rows: [
        {
          id: USER,
          business_id: BUSINESS,
          business_slug: "test",
          business_subdomain: "test",
          location_id: null,
          role: "owner",
          full_name: "مالک",
          platform_user_id: "99999999-9999-4999-8999-999999999999",
          identity_active: true,
          token_version: 1,
        },
      ],
      rowCount: 1,
    });
    mocks.mfaAppliesToRole.mockReturnValue(true);
    mocks.getAccountMfaEnrolments.mockResolvedValue([{ method: "totp", confirmed_at: new Date() }]);
    mocks.enrolmentRequirement.mockReturnValue("required");
    mocks.shouldChallengeMfaOnLogin.mockReturnValue(true);

    const res = await POST(request("123456", { trustDevice: true }));
    const body = await res.json();

    expect(body.mfaRequired).toBe(true);
    // Offered, so the MFA step can carry the intent forward.
    expect(body.trustOffered).toBe(true);
    // Not granted, because the ceremony is not over.
    expect(mocks.issueTrustedDevice).not.toHaveBeenCalled();
    expect(res.cookies.get("pos_trusted_device")).toBeUndefined();
  });
});

describe("runtime input handling (L14)", () => {
  it("refuses a malformed body rather than throwing", async () => {
    const res = await POST(
      new NextRequest("http://test.local/api/auth/phone-otp/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
        body: "{not json",
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_request" });
  });

  it("answers 401 with no bearer token", async () => {
    const res = await POST(
      new NextRequest("http://test.local/api/auth/phone-otp/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: "123456" }),
      }),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("bounds a device token instead of passing an arbitrary value through", async () => {
    await POST(request("123456", { deviceToken: "x".repeat(5000) }));

    // Over the bound it is dropped rather than forwarded to a row lookup.
    expect(mocks.resolveDeviceId).toHaveBeenCalledWith(null, BUSINESS);
  });
});
