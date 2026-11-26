import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #1386 — linking Telegram adds a login door (`tenant_telegram`), so it uses
 * the sensitive guard like passkey registration. Unlinking only removes a way
 * in, so it stays on plain recency and the owner can always cut it off. The
 * guard and policy are real; the factor read and Telegram service are mocked.
 */
type AnyFn = ReturnType<typeof vi.fn>;

const mocks = vi.hoisted(() => ({
  requireMember: vi.fn() as AnyFn,
  issueTelegramLinkChallenge: vi.fn(async () => ({ ok: true, code: "link-code" })) as AnyFn,
  revokeTelegramIdentityLink: vi.fn(async () => ({ ok: true })) as AnyFn,
  getAccountMfaEnrolments: vi.fn() as AnyFn,
}));

vi.mock("@/lib/auth", () => ({
  requireMember: mocks.requireMember,
  withTenantScope: (handler: unknown) => handler,
}));
vi.mock("@/lib/telegram-service", () => ({
  issueTelegramLinkChallenge: mocks.issueTelegramLinkChallenge,
  readTelegramConnectionStatus: async () => ({}),
  revokeTelegramIdentityLink: mocks.revokeTelegramIdentityLink,
  telegramBusinessAvailability: async () => ({ available: true }),
}));
vi.mock("@/lib/mfa-service", async () => {
  const { isActiveMfaEnrolment } = await vi.importActual<typeof import("@/lib/mfa")>("@/lib/mfa");
  return {
    getAccountMfaEnrolments: mocks.getAccountMfaEnrolments,
    filterActiveMfaEnrolments: (rows: unknown[]) =>
      rows.filter((row) => isActiveMfaEnrolment(row as never)),
  };
});

import { DELETE, POST } from "./route";

const IDENTITY = "22222222-2222-4222-8222-222222222222";
const NOW = () => Math.floor(Date.now() / 1000);
const TOTP = {
  id: "totp-1",
  method: "totp",
  is_primary: true,
  phone_e164: null,
  confirmed_at: new Date("2026-11-01T00:00:00Z"),
  created_at: new Date("2026-11-01T00:00:00Z"),
};

function signedIn(claims: Record<string, unknown>) {
  mocks.requireMember.mockResolvedValue({
    session: { sub: "member-1", businessId: "biz-1", platformUserId: IDENTITY, ...claims },
    membership: { role: "owner" },
    error: null,
  });
}

const call = (handler: unknown) => (handler as () => Promise<Response>)();

beforeEach(() => {
  mocks.issueTelegramLinkChallenge.mockClear();
  mocks.revokeTelegramIdentityLink.mockClear();
  mocks.getAccountMfaEnrolments.mockReset();
  mocks.getAccountMfaEnrolments.mockResolvedValue([TOTP]);
});

describe("POST /api/connections/telegram (link)", () => {
  it("refuses an OTP-only session on an account holding a TOTP, and issues no link", async () => {
    signedIn({ recentAuthAt: NOW(), otpOnlyAssurance: true });
    const res = await call(POST);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      error: "recent_auth_required",
      distinctFactorRequired: true,
      allowedMethods: ["totp", "recovery"],
    });
    expect(mocks.issueTelegramLinkChallenge).not.toHaveBeenCalled();
  });

  it("issues the link after the distinct factor is proved", async () => {
    signedIn({ recentAuthAt: NOW(), otpOnlyAssurance: false });
    const res = await call(POST);
    expect(res.status).toBe(200);
    expect(mocks.issueTelegramLinkChallenge).toHaveBeenCalledTimes(1);
  });

  it("lets an SMS-only account (nothing stronger enrolled) link with its SMS proof", async () => {
    mocks.getAccountMfaEnrolments.mockResolvedValue([]);
    signedIn({ recentAuthAt: NOW(), otpOnlyAssurance: true });
    const res = await call(POST);
    expect(res.status).toBe(200);
  });
});

describe("DELETE /api/connections/telegram (unlink)", () => {
  it("stays on plain recency, so an OTP-only owner can always cut the door off", async () => {
    signedIn({ recentAuthAt: NOW(), otpOnlyAssurance: true });
    const res = await call(DELETE);
    expect(res.status).toBe(200);
    expect(mocks.revokeTelegramIdentityLink).toHaveBeenCalledTimes(1);
    expect(mocks.getAccountMfaEnrolments).not.toHaveBeenCalled();
  });
});
