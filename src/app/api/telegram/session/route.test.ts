import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  deploymentRole: vi.fn(),
  resolveBusiness: vi.fn(),
  botConfig: vi.fn(),
  verifyInitData: vi.fn(),
  availability: vi.fn(),
  identityActive: vi.fn(),
  accountForSession: vi.fn(),
  consumeInitData: vi.fn(),
  lockout: vi.fn(),
  recordAuthSuccess: vi.fn(),
  query: vi.fn(),
  withTenant: vi.fn(),
  withoutTenantScope: vi.fn(),
  allEnrolments: vi.fn(),
  activeEnrolments: vi.fn(),
  gracePeriod: vi.fn(),
  markGracePeriod: vi.fn(),
  mfaPolicy: vi.fn(),
  mfaApplies: vi.fn(),
  enrolmentRequirement: vi.fn(),
  shouldChallenge: vi.fn(),
  graceDaysRemaining: vi.fn(),
  signMfaToken: vi.fn(),
  createSession: vi.fn(),
  signSession: vi.fn(),
}));

vi.mock("@/lib/employee-service", () => ({ createSession: mocks.createSession }));
vi.mock("@/lib/auth", () => ({
  SESSION_COOKIE: "biza_session",
  sessionCookieOptions: (session?: { telegramIdentityLinkId?: string | null }) => ({
    httpOnly: true,
    secure: true,
    sameSite: session?.telegramIdentityLinkId ? "none" : "lax",
    ...(session?.telegramIdentityLinkId ? { partitioned: true } : {}),
    path: "/",
  }),
  signSession: mocks.signSession,
}));
vi.mock("@/lib/db", () => ({
  query: mocks.query,
  withTenant: mocks.withTenant,
  withoutTenantScope: mocks.withoutTenantScope,
}));
vi.mock("@/lib/host-resolution", () => ({ resolveBusinessByLabel: mocks.resolveBusiness }));
vi.mock("@/lib/host", () => ({
  businessHost: (label: string, root: string) => `${label}.${root}`,
  hostRoutingEnabled: () => true,
  parseHost: () => ({ kind: "business", label: "store" }),
  requestHost: () => "store.example.com",
}));
vi.mock("@/lib/deployment-role", () => ({ deploymentRole: mocks.deploymentRole }));
vi.mock("@/lib/telegram-service", () => ({
  consumeTelegramInitData: mocks.consumeInitData,
  isTelegramIdentitySessionActive: mocks.identityActive,
  telegramAccountForSessionExchange: mocks.accountForSession,
  telegramBusinessAvailability: mocks.availability,
}));
vi.mock("@/lib/telegram-contract", () => ({
  telegramConfig: mocks.botConfig,
  verifyTelegramInitData: mocks.verifyInitData,
}));
vi.mock("@/lib/login-lockout-service", () => ({
  checkAuthLockout: mocks.lockout,
  recordAuthSuccess: mocks.recordAuthSuccess,
}));
vi.mock("@/lib/login-lockout", () => ({ PASSWORD_LOCKOUT_POLICY: { threshold: 5 } }));
vi.mock("@/lib/mfa-service", () => ({
  filterActiveMfaEnrolments: mocks.activeEnrolments,
  getAccountMfaEnrolments: mocks.allEnrolments,
  getMfaGracePeriod: mocks.gracePeriod,
  markMfaGracePeriod: mocks.markGracePeriod,
  signMfaPendingToken: mocks.signMfaToken,
}));
vi.mock("@/lib/mfa", () => ({
  MFA_GRACE_DAYS_TENANT: 7,
  enrolmentRequirement: mocks.enrolmentRequirement,
  graceDaysRemaining: mocks.graceDaysRemaining,
  mfaAppliesToRole: mocks.mfaApplies,
  shouldChallengeMfaOnLogin: mocks.shouldChallenge,
}));
vi.mock("@/lib/mfa-policy", () => ({ getMfaPolicy: mocks.mfaPolicy }));

import { POST } from "./route";

const originalRootDomain = process.env.ROOT_DOMAIN;

afterEach(() => {
  if (originalRootDomain === undefined) delete process.env.ROOT_DOMAIN;
  else process.env.ROOT_DOMAIN = originalRootDomain;
});

const botConfig = {
  botToken: "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi_123",
  botUsername: "BizaMizOfficialBot",
  webhookSecret: "A".repeat(40),
  webhookUrl: "https://example.com/api/telegram/webhook",
  publicOrigin: "https://example.com",
  rootDomain: "example.com",
};

const membership = {
  userId: "membership-1",
  businessId: "business-from-host",
  role: "cashier",
  businessSlug: "store",
  businessSubdomain: "store",
  locationId: "location-1",
  fullName: "Test Member",
  businessName: "Store",
  businessStatus: "active",
};

const linkedAccount = {
  platformUserId: "platform-user-1",
  linkId: "123e4567-e89b-42d3-a456-426614174000",
  linkGeneration: 1,
  tokenVersion: 3,
  email: "member@example.com",
  membership,
};

function request(body: unknown = { initData: "signed-init-data" }) {
  return new NextRequest("https://store.example.com/api/telegram/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  process.env.ROOT_DOMAIN = "example.com";
  mocks.deploymentRole.mockReset().mockReturnValue("central");
  mocks.resolveBusiness.mockReset().mockResolvedValue({
    businessId: "business-from-host",
    status: "active",
    viaAlias: false,
    subdomain: "store",
  });
  mocks.botConfig.mockReset().mockReturnValue({ enabled: true, config: botConfig });
  mocks.verifyInitData.mockReset().mockReturnValue({
    ok: true,
    value: { telegramUserId: "77223344", replayKey: "a".repeat(64), expiresAt: new Date("2026-10-22T12:00:00Z") },
  });
  mocks.availability.mockReset().mockResolvedValue({ available: true });
  mocks.identityActive.mockReset().mockResolvedValue(true);
  mocks.accountForSession.mockReset().mockResolvedValue(linkedAccount);
  mocks.consumeInitData.mockReset().mockResolvedValue(true);
  mocks.lockout.mockReset().mockResolvedValue({ locked: false });
  mocks.recordAuthSuccess.mockReset().mockResolvedValue(undefined);
  mocks.query.mockReset().mockResolvedValue({ rows: [] });
  mocks.withTenant.mockReset().mockImplementation((_businessId: string, fn: () => unknown) => fn());
  mocks.withoutTenantScope.mockReset().mockImplementation((_reason: string, fn: () => unknown) => fn());
  mocks.allEnrolments.mockReset().mockResolvedValue([]);
  mocks.activeEnrolments.mockReset().mockImplementation((enrolments: unknown[]) => enrolments);
  mocks.gracePeriod.mockReset().mockResolvedValue(null);
  mocks.markGracePeriod.mockReset().mockResolvedValue(undefined);
  mocks.mfaPolicy.mockReset().mockResolvedValue({});
  mocks.mfaApplies.mockReset().mockReturnValue(false);
  mocks.enrolmentRequirement.mockReset().mockReturnValue("not_required");
  mocks.shouldChallenge.mockReset().mockReturnValue(false);
  mocks.graceDaysRemaining.mockReset().mockReturnValue(0);
  mocks.signMfaToken.mockReset().mockResolvedValue("pending-mfa-token");
  mocks.createSession.mockReset().mockResolvedValue({
    token: "employee-token-unused",
    session: { id: "employee-session-1" },
  });
  mocks.signSession.mockReset().mockResolvedValue("signed-session-token");
});

describe("POST /api/telegram/session", () => {
  it("uses the canonical request host, not a client business id, to bind the Telegram identity", async () => {
    const response = await POST(request({ initData: "signed-init-data", businessId: "attacker-chosen-business" }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "verified",
      user: { id: "membership-1", role: "cashier" },
      business: { id: "business-from-host" },
    });
    expect(mocks.resolveBusiness).toHaveBeenCalledWith("store");
    expect(mocks.verifyInitData).toHaveBeenCalledWith("signed-init-data", botConfig.botToken);
    expect(mocks.accountForSession).toHaveBeenCalledWith({
      telegramUserId: "77223344",
      businessId: "business-from-host",
    });
    expect(mocks.consumeInitData).toHaveBeenCalledWith({
      replayKey: "a".repeat(64),
      telegramUserId: "77223344",
      linkId: linkedAccount.linkId,
      expiresAt: expect.any(Date),
    });
    expect(mocks.createSession).toHaveBeenCalledWith("membership-1", "business-from-host", expect.objectContaining({
      loginMethod: "telegram",
      deviceLabel: "Telegram Mini App",
      locationId: "location-1",
    }));
    expect(mocks.signSession).toHaveBeenCalledWith(expect.objectContaining({
      platformUserId: "platform-user-1",
      tokenVersion: 3,
      telegramIdentityLinkId: linkedAccount.linkId,
      telegramIdentityGeneration: 1,
      employeeSessionId: "employee-session-1",
    }));
    expect(response.headers.get("cache-control")).toContain("no-store");
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("biza_session=");
    expect(setCookie).toContain("Secure");
    expect(setCookie.toLowerCase()).toContain("samesite=none");
    expect(setCookie.toLowerCase()).toContain("partitioned");
    expect(setCookie).not.toContain("Domain=");
  });

  it("stops on local runtimes before loading the bot configuration", async () => {
    mocks.deploymentRole.mockReturnValue("site");
    const response = await POST(request());
    expect(response.status).toBe(404);
    expect(mocks.botConfig).not.toHaveBeenCalled();
    expect(mocks.accountForSession).not.toHaveBeenCalled();
  });

  it("returns one generic denial for unlinked accounts or missing current membership", async () => {
    mocks.accountForSession.mockResolvedValue(null);
    const response = await POST(request());
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "account_unlinked_or_membership_unavailable" });
    expect(mocks.consumeInitData).not.toHaveBeenCalled();
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it("refuses replayed signed initData before creating an employee session", async () => {
    mocks.consumeInitData.mockResolvedValue(false);
    const response = await POST(request());
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "telegram_init_data_replayed" });
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it("runs the existing account MFA ceremony and does not mint a session before the second factor", async () => {
    mocks.allEnrolments.mockResolvedValue([{ method: "totp", confirmed_at: new Date() }]);
    mocks.activeEnrolments.mockReturnValue([{ method: "totp" }]);
    mocks.mfaApplies.mockReturnValue(true);
    mocks.enrolmentRequirement.mockReturnValue("required");
    mocks.shouldChallenge.mockReturnValue(true);

    const response = await POST(request());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      mfaRequired: true,
      mfaState: "required",
      mfaToken: "pending-mfa-token",
      mfaMethod: "totp",
      availableMethods: ["totp"],
    });
    expect(mocks.signMfaToken).toHaveBeenCalledWith(expect.objectContaining({
      sub: "platform-user-1",
      authRealm: "tenant_telegram",
      primaryAuth: "telegram",
      businessId: "business-from-host",
      telegramIdentityLinkId: linkedAccount.linkId,
      telegramIdentityGeneration: 1,
      telegramTokenVersion: 3,
    }));
    expect(mocks.createSession).not.toHaveBeenCalled();
  });
});
