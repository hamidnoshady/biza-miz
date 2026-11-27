import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * #1386 — business switching after identity authentication.
 *
 *  - A switch is spent only on a membership the proven identity holds; any
 *    other business answers exactly like a non-existent one (no probing).
 *  - What the session's recent authentication proved travels with it. If the
 *    switch dropped `otpOnlyAssurance`, an OTP-only session could upgrade
 *    itself for free by hopping to another of the person's businesses and then
 *    remove a TOTP on the strength of SMS alone.
 */
type AnyFn = ReturnType<typeof vi.fn>;

const mocks = vi.hoisted(() => ({
  getSession: vi.fn() as AnyFn,
  signSession: vi.fn(async () => "switched-session") as AnyFn,
  membershipForBusiness: vi.fn() as AnyFn,
  createSession: vi.fn(async () => ({ session: { id: "emp-session-b" } })) as AnyFn,
  pendingRevocationFor: vi.fn(() => null) as AnyFn,
  endPendingRevocation: vi.fn(async () => "ended") as AnyFn,
}));

vi.mock("@/lib/auth", () => ({
  SESSION_COOKIE: "pos_session",
  getSession: mocks.getSession,
  sessionCookieOptions: () => ({ httpOnly: true, path: "/" }),
  signSession: mocks.signSession,
  withTenantScope: (handler: unknown) => handler,
}));
vi.mock("@/lib/db", () => ({
  withTenant: async (_id: string, fn: () => Promise<unknown>) => fn(),
  withoutTenantScope: async (_reason: string, fn: () => Promise<unknown>) => fn(),
}));
vi.mock("@/lib/employee-service", () => ({ createSession: mocks.createSession }));
vi.mock("@/lib/host", () => ({ hostRoutingEnabled: () => false }));
vi.mock("@/lib/logout-service", () => ({
  pendingRevocationFor: mocks.pendingRevocationFor,
  endPendingRevocation: mocks.endPendingRevocation,
}));
vi.mock("@/lib/memberships", () => ({
  membershipForBusiness: mocks.membershipForBusiness,
  membershipBlockedReason: () => null,
}));

import { POST } from "./route";

const IDENTITY = "22222222-2222-4222-8222-222222222222";
const BUSINESS_A = "11111111-1111-4111-8111-111111111111";
const BUSINESS_B = "44444444-4444-4444-8444-444444444444";

function switchTo(businessId: string): NextRequest {
  return new NextRequest("http://test.local/api/auth/switch-business", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ businessId }),
  });
}

beforeEach(() => {
  for (const fn of Object.values(mocks)) (fn as AnyFn).mockClear();
  mocks.getSession.mockResolvedValue({
    sub: "member-a",
    role: "owner",
    businessId: BUSINESS_A,
    platformUserId: IDENTITY,
    tokenVersion: 3,
    mfaVerified: false,
    recentAuthAt: 1_800_000_000,
    otpOnlyAssurance: true,
  });
  mocks.membershipForBusiness.mockResolvedValue({
    userId: "member-b",
    role: "manager",
    businessId: BUSINESS_B,
    businessSlug: "b",
    businessSubdomain: "b",
    locationId: null,
    fullName: "آزمون",
  });
});

describe("business switch", () => {
  it("carries what the recent authentication proved into the new business", async () => {
    const res = await POST(switchTo(BUSINESS_B));
    expect(res.status).toBe(200);
    expect(mocks.signSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sub: "member-b",
        businessId: BUSINESS_B,
        recentAuthAt: 1_800_000_000,
        mfaVerified: false,
        otpOnlyAssurance: true,
      }),
    );
  });

  it("resolves the target membership from the proven identity only", async () => {
    await POST(switchTo(BUSINESS_B));
    expect(mocks.membershipForBusiness).toHaveBeenCalledWith(IDENTITY, BUSINESS_B);
  });

  it("answers a business the identity is not a member of as plain forbidden", async () => {
    mocks.membershipForBusiness.mockResolvedValue(null);
    const res = await POST(switchTo(BUSINESS_B));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.signSession).not.toHaveBeenCalled();
  });
});
