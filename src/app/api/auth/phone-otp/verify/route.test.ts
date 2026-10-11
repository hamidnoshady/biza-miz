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
  verifyTrustedDevice: vi.fn(async () => ({ trusted: false, reason: "missing" })) as AnyFn,
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
  return {
    ...actual,
    issueTrustedDevice: mocks.issueTrustedDevice,
    verifyTrustedDevice: mocks.verifyTrustedDevice,
  };
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

/**
 * A pending token, the shape the request route now mints.
 *
 * #854 moved the challenge *binding* off the token and onto the
 * `mfa_challenges` row: the token carries which ceremony this is
 * (`mayAttachPhone` / `phone`) and the route derives the purpose and the
 * expected number from that, passing both to the verifier, which checks them
 * against the row under `FOR UPDATE`. So the binding is asserted here as the
 * arguments handed to the verifier rather than as token fields.
 */
function boundPayload(overrides: Record<string, unknown> = {}) {
  return {
    sub: USER,
    businessId: BUSINESS,
    mayAttachPhone: false,
    phone: null,
    candidatePhone: null,
    multiBusiness: false,
    otpProven: false,
    realm: "phone",
    ...overrides,
  };
}

beforeEach(() => {
  for (const fn of Object.values(mocks)) (fn as AnyFn).mockClear();
  mocks.verifyPhonePendingToken.mockResolvedValue(boundPayload());
  mocks.verifyEmployeePhoneOtp.mockResolvedValue(true);
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
      boundPayload({ sub: null }),
    );
    const unknownNumber = await POST(request("123456"));

    mocks.verifyPhonePendingToken.mockResolvedValue(boundPayload());
    mocks.verifyEmployeePhoneOtp.mockResolvedValue(false);
    const wrongCode = await POST(request("123456"));

    // Both status and body. Comparing only the status would let a differing
    // `error` field leak the answer, which is the whole oracle.
    expect(unknownNumber.status).toBe(wrongCode.status);
    expect(await unknownNumber.json()).toEqual(await wrongCode.json());
    expect(unknownNumber.status).toBe(401);
  });

  it("does not consult the challenge at all for an unmatched number", async () => {
    mocks.verifyPhonePendingToken.mockResolvedValue(
      boundPayload({ sub: null }),
    );
    await POST(request("123456"));

    // Nothing to verify and nobody to lock out. Reaching the database here
    // would be a way to tell the two cases apart by timing.
    expect(mocks.verifyEmployeePhoneOtp).not.toHaveBeenCalled();
    expect(mocks.auditLoginFailure).not.toHaveBeenCalled();
  });
});

describe("challenge binding (L02)", () => {
  /*
   * Where the binding lives changed between #885 and #854, and #854's place is
   * the stronger one. #885 carried `cid` and `destination` on the token and
   * re-checked them against the row here; #854 binds `purpose` and
   * `candidate_phone_e164` *on the row* and redeems under `FOR UPDATE`, so of
   * N concurrent verifies exactly one can consume the challenge and the
   * attempt ceiling is exact rather than approximate. The token no longer
   * needs to assert the binding, which also removes a field a caller could
   * tamper with.
   *
   * What is still the route's job, and what these tests pin, is deriving the
   * right purpose and the right expected number from the ceremony the token
   * describes — because a wrong purpose is what would let a code minted for
   * one ceremony be spent on another.
   */
  it("derives the login purpose for an ordinary door login", async () => {
    await POST(request("۱۲۳۴۵۶"));

    expect(mocks.verifyEmployeePhoneOtp).toHaveBeenCalledWith({
      userId: USER,
      purpose: "login",
      expectedPhoneE164: null,
      // Persian digits, canonicalised at this boundary too (L11).
      code: "123456",
    });
  });

  it("derives the phone-change purpose and binds the number being written", async () => {
    mocks.verifyPhonePendingToken.mockResolvedValue(
      boundPayload({ mayAttachPhone: true, phone: PHONE }),
    );
    await POST(request("۱۲۳۴۵۶"));

    // The number is bound from the *token*, never from the request body, so a
    // caller cannot redirect the write by editing the body.
    expect(mocks.verifyEmployeePhoneOtp).toHaveBeenCalledWith({
      userId: USER,
      purpose: "change_login_phone",
      expectedPhoneE164: PHONE,
      code: "123456",
    });
  });

  it("refuses a verifier rejection as a wrong code, never as a pass", async () => {
    mocks.verifyEmployeePhoneOtp.mockResolvedValue(false);
    const res = await POST(request("123456"));

    // Every binding failure — no row, wrong purpose, wrong number, expired,
    // attempts exhausted — collapses to the same answer, so the response
    // cannot be used to learn which one it was.
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid_code" });
    expect(mocks.auditLoginFailure).toHaveBeenCalled();
  });

  it("rejects a code that is not six digits before touching anything", async () => {
    const res = await POST(request("12ab"));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid_code" });
    expect(mocks.verifyEmployeePhoneOtp).not.toHaveBeenCalled();
  });

  it("collapses an expired challenge into the same answer as a wrong code", async () => {
    /*
     * This used to assert a distinct `code_expired`. #854's verifier returns a
     * bare boolean, so the route can no longer tell expiry from a wrong code —
     * and that is the better contract, not a regression: a distinct
     * "expired" answer is an oracle that confirms a live challenge row exists
     * for this member. Every refusal therefore collapses to `invalid_code`,
     * which is also exactly what the anti-enumeration path answers.
     */
    mocks.verifyEmployeePhoneOtp.mockResolvedValue(false);
    const res = await POST(request("123456"));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid_code" });
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
    // `undefined`, not the 5,000-character string the caller sent.
    expect(mocks.resolveDeviceId).toHaveBeenCalledWith(undefined, BUSINESS);
  });
});

/**
 * Issue #885, gap 3 — the phone-primary door must honour trusted-device state
 * before challenging for MFA, exactly as the password door does.
 *
 * Without this the two doors disagreed: a device trusted after a full
 * password+MFA verification was still asked for MFA when the same member came
 * in through the phone door. That reads as the feature not working, and it
 * meant the exemption depended on which door a member happened to use.
 *
 * What these tests also pin is what the exemption does *not* reach: the phone
 * OTP is still redeemed on this request, and a login that skipped a factor
 * does not get to mint a fresh seven-day trust out of it.
 */
describe("trusted-device exemption before MFA (gap 3)", () => {
  /** An owner with a confirmed TOTP enrolment, so an MFA challenge is due. */
  function managerWithMfa() {
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
  }

  it("waives the MFA challenge for a device this member has trusted", async () => {
    managerWithMfa();
    mocks.verifyTrustedDevice.mockResolvedValue({ trusted: true, expiresAt: new Date() });

    const res = await POST(request("123456"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.mfaRequired).toBeUndefined();
    expect(mocks.signMfaPendingToken).not.toHaveBeenCalled();
    // The session is the real one — the exemption waives a challenge, it does
    // not mint anything on its own.
    expect(res.cookies.get("pos_session")?.value).toBeTruthy();
  });

  it("still proves the primary factor: the OTP was redeemed before the waiver", async () => {
    managerWithMfa();
    mocks.verifyTrustedDevice.mockResolvedValue({ trusted: true, expiresAt: new Date() });

    await POST(request("123456"));

    // Trust is never a substitute for the phone proof; it only skips the
    // *second* factor. Redemption still happened first, for this member and
    // this ceremony, and the stamps still committed.
    expect(mocks.verifyEmployeePhoneOtp).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER, purpose: "login", code: "123456" }),
    );
    expect(mocks.stampPhoneVerified).toHaveBeenCalled();
  });

  it("challenges as usual when the device holds no trust", async () => {
    managerWithMfa();
    mocks.verifyTrustedDevice.mockResolvedValue({ trusted: false, reason: "missing" });

    const body = await (await POST(request("123456"))).json();

    expect(body.mfaRequired).toBe(true);
    expect(mocks.signMfaPendingToken).toHaveBeenCalledTimes(1);
  });

  it("challenges when the trust lapsed or was revoked", async () => {
    managerWithMfa();
    for (const reason of ["expired", "revoked"] as const) {
      mocks.signMfaPendingToken.mockClear();
      mocks.verifyTrustedDevice.mockResolvedValue({ trusted: false, reason });

      const body = await (await POST(request("123456"))).json();

      expect(body.mfaRequired).toBe(true);
      expect(mocks.signMfaPendingToken).toHaveBeenCalledTimes(1);
    }
  });

  it("consults trust only when a challenge is actually due", async () => {
    // No platform identity, so the MFA branch is never entered. Spending a
    // trusted_devices query on every cashier login would be cost for nothing.
    await POST(request("123456"));

    expect(mocks.verifyTrustedDevice).not.toHaveBeenCalled();
  });

  it("does not extend trust on a login whose MFA was waived", async () => {
    // Load-bearing. Trust is earned by *completing* every factor. If a waived
    // MFA could re-mint it, a trusted device would roll its own seven-day
    // window forward on every ordinary login and the expiry would never bite.
    managerWithMfa();
    mocks.verifyTrustedDevice.mockResolvedValue({ trusted: true, expiresAt: new Date() });

    const res = await POST(request("123456", { trustDevice: true }));

    expect(res.status).toBe(200);
    expect(mocks.issueTrustedDevice).not.toHaveBeenCalled();
    expect(res.cookies.get("pos_trusted_device")).toBeUndefined();
  });
});
