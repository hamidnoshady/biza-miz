import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Issue #1003 item 2 — the session-less staff roster sends what the picker
 * renders and nothing else. The employee entries are the picker's own fields
 * (it signs in by id and shows name, role and photo); the Hybrid credential
 * notice used to pass the whole health record through — member ids and roles,
 * internal plane state, timestamps and the raw last sync error — and is now
 * two counts and the missing members' names.
 */

type AnyFn = ReturnType<typeof vi.fn>;

const ENTRY = {
  id: "00000000-0000-4000-8000-000000000011",
  fullName: "صندوق‌دار",
  role: "cashier",
  photoUrl: null,
  hasWebauthn: false,
  loginMode: "pin",
  phoneState: "none",
};

const HEALTH = {
  configured: true,
  overall: "degraded",
  degradedBy: "credentials",
  reason: "pin_members_missing",
  siteDeviceId: "site-device-1",
  credentials: {
    status: "degraded",
    lastSuccessAt: "2026-10-20T10:00:00.000Z",
    lastError: "login_credentials_http_500 from https://cloud.internal.example:8443/api/iam/login-credentials",
  },
  pinGap: {
    expected: 3,
    usable: 2,
    missing: 1,
    missingMembers: [{ id: "00000000-0000-4000-8000-000000000099", fullName: "کارمند آشپزخانه", role: "kitchen" }],
  },
};

const mocks = vi.hoisted(() => ({
  withTenant: vi.fn(async (_id: string, fn: () => Promise<unknown>) => fn()) as AnyFn,
  resolveDeviceId: vi.fn(async () => null) as AnyFn,
  readDeploymentProfile: vi.fn() as AnyFn,
  loginRoster: vi.fn() as AnyFn,
  resolveLoginBusinessId: vi.fn() as AnyFn,
  readHybridIdentityStatus: vi.fn() as AnyFn,
  phoneOtpEnforcementFor: vi.fn() as AnyFn,
  readTrustedDeviceToken: vi.fn(() => null) as AnyFn,
  resolveTrustedDeviceSubject: vi.fn(async () => null) as AnyFn,
}));

vi.mock("@/lib/db", () => ({ withTenant: mocks.withTenant }));
vi.mock("@/lib/device-service", () => ({ resolveDeviceId: mocks.resolveDeviceId }));
vi.mock("@/lib/host", () => ({ requestHost: () => "alpha.example.com" }));
vi.mock("@/lib/deployment-mode", () => ({ readDeploymentProfile: mocks.readDeploymentProfile }));
vi.mock("@/lib/employee-service", () => ({
  loginRoster: mocks.loginRoster,
  resolveLoginBusinessId: mocks.resolveLoginBusinessId,
}));
vi.mock("@/lib/iam/login-credential-sync", () => ({ readHybridIdentityStatus: mocks.readHybridIdentityStatus }));
vi.mock("@/lib/phone-otp", () => ({ phoneOtpEnforcementFor: mocks.phoneOtpEnforcementFor }));
vi.mock("@/lib/trusted-device", () => ({
  readTrustedDeviceToken: mocks.readTrustedDeviceToken,
  resolveTrustedDeviceSubject: mocks.resolveTrustedDeviceSubject,
}));

import { GET } from "./route";

function roster() {
  return GET(new NextRequest("http://localhost/api/auth/pin-login/roster"));
}

beforeEach(() => {
  mocks.resolveLoginBusinessId.mockResolvedValue({ businessId: "biz-1", error: null });
  mocks.loginRoster.mockResolvedValue([ENTRY]);
  mocks.phoneOtpEnforcementFor.mockResolvedValue({ state: "off", daysLeft: null, policy: { enforcedAt: null } });
  mocks.readDeploymentProfile.mockResolvedValue({ profile: "hybrid" });
  mocks.readHybridIdentityStatus.mockResolvedValue(HEALTH);
});
afterEach(() => vi.clearAllMocks());

describe("GET /api/auth/pin-login/roster", () => {
  it("lists the picker's fields for each member", async () => {
    const body = await (await roster()).json();
    expect(body.employees).toEqual([ENTRY]);
    expect(body.policy).toEqual({ state: "off", daysLeft: null, enforcedAt: null });
  });

  it("reports a Hybrid credential gap as counts and names only", async () => {
    const response = await roster();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.credentialSync).toEqual({
      expected: 3,
      missing: 1,
      missingMembers: [{ fullName: "کارمند آشپزخانه" }],
    });
    const wire = JSON.stringify(body.credentialSync);
    for (const leaked of [
      HEALTH.pinGap.missingMembers[0].id,
      "kitchen",
      "cloud.internal.example",
      "login_credentials_http_500",
      HEALTH.credentials.lastSuccessAt,
      "degraded",
    ]) {
      expect(wire, leaked).not.toContain(leaked);
    }
  });

  it("says nothing about credentials on a Hybrid site that is not configured, or off Hybrid", async () => {
    mocks.readHybridIdentityStatus.mockResolvedValue({ ...HEALTH, configured: false });
    expect((await (await roster()).json()).credentialSync).toBeNull();

    mocks.readDeploymentProfile.mockResolvedValue({ profile: "local" });
    mocks.readHybridIdentityStatus.mockClear();
    expect((await (await roster()).json()).credentialSync).toBeNull();
    expect(mocks.readHybridIdentityStatus).not.toHaveBeenCalled();
  });

  it("refuses a request it cannot name a business for", async () => {
    mocks.resolveLoginBusinessId.mockResolvedValue({ businessId: null, error: "business_required" });
    const response = await roster();
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "business_required" });
    expect(mocks.loginRoster).not.toHaveBeenCalled();
  });
});
