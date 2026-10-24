import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  recordSecurityAudit: vi.fn(),
}));

vi.mock("./db", () => ({
  query: mocks.query,
  withTenant: (_businessId: string, fn: () => unknown) => fn(),
  withTenantTransaction: (_businessId: string, fn: () => unknown) => fn(),
  withoutTenantScope: (_reason: string, fn: () => unknown) => fn(),
  withoutTenantScopeTransaction: (_reason: string, fn: () => unknown) => fn(),
}));
vi.mock("./deployment-role", () => ({ deploymentRole: () => "central" }));
vi.mock("./deployment-mode", () => ({ readDeploymentProfile: async () => ({ profile: "cloud" }) }));
vi.mock("./features", () => ({ isFeatureEnabled: async () => true }));
vi.mock("./host", () => ({
  hostRoutingEnabled: () => true,
  businessHost: (label: string, root: string) => `${label}.${root}`,
  parseHost: () => ({ kind: "apex" }),
}));
vi.mock("./security-audit", () => ({
  SECURITY_AUDIT_ACTIONS: {
    telegramLinkChallengeCreated: "auth.telegram_link_challenge_created",
    telegramIdentityLinked: "auth.telegram_identity_linked",
    telegramIdentityUnlinked: "auth.telegram_identity_unlinked",
  },
  recordSecurityAudit: mocks.recordSecurityAudit,
  transactionAuditExecutor: () => ({ query: vi.fn() }),
}));

import {
  activeTelegramAccountForTelegramUser,
  activeTelegramLinkForPlatformUser,
  consumeTelegramInitData,
  finishTelegramWebhookUpdate,
  issueTelegramLinkChallenge,
  redeemTelegramLinkChallenge,
  reserveTelegramWebhookUpdate,
  revokeTelegramIdentityLink,
  telegramBusinessAvailability,
} from "./telegram-service";

const ENV_KEYS = [
  "TELEGRAM_ENABLED",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_BOT_USERNAME",
  "TELEGRAM_WEBHOOK_SECRET",
  "TELEGRAM_PUBLIC_ORIGIN",
  "TELEGRAM_WEBHOOK_URL",
  "ROOT_DOMAIN",
] as const;
const savedEnv = new Map<string, string | undefined>();

function enableTelegram() {
  process.env.TELEGRAM_ENABLED = "true";
  process.env.TELEGRAM_BOT_TOKEN = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi_123";
  process.env.TELEGRAM_BOT_USERNAME = "BizaMizOfficialBot";
  process.env.TELEGRAM_WEBHOOK_SECRET = "A".repeat(40);
  process.env.TELEGRAM_PUBLIC_ORIGIN = "https://example.com";
  process.env.TELEGRAM_WEBHOOK_URL = "https://example.com/api/telegram/webhook";
  process.env.ROOT_DOMAIN = "example.com";
}

beforeEach(() => {
  mocks.query.mockReset();
  mocks.recordSecurityAudit.mockReset();
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
  enableTelegram();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("Telegram business availability", () => {
  it("requires central Cloud profile, an enabled integrations entitlement, and the global bot config", async () => {
    await expect(telegramBusinessAvailability("business-1")).resolves.toMatchObject({
      available: true,
      botUsername: "BizaMizOfficialBot",
      rootDomain: "example.com",
    });
    process.env.TELEGRAM_ENABLED = "false";
    await expect(telegramBusinessAvailability("business-1")).resolves.toEqual({
      available: false,
      error: "telegram_disabled",
    });
  });
});

describe("global Telegram identity lookup", () => {
  it("returns the active link without exposing a route to another tenant", async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [{ id: "link-1", generation: 2, linked_at: new Date("2026-01-01T00:00:00Z"), telegram_user_id: "1234567" }],
    });
    const link = await activeTelegramLinkForPlatformUser("platform-user-1");
    expect(link).toMatchObject({ id: "link-1", generation: 2, telegramUserId: "1234567" });
    expect(mocks.query.mock.calls[0][0]).toContain("WHERE platform_user_id = $1 AND revoked_at IS NULL");
  });

  it("does not resolve a revoked or inactive Telegram identity", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] });
    await expect(activeTelegramAccountForTelegramUser("1234567")).resolves.toBeNull();
    expect(mocks.query.mock.calls[0][0]).toContain("p.is_active = true");
    expect(mocks.query.mock.calls[0][0]).toContain("l.revoked_at IS NULL");
  });
});

describe("link challenges and Telegram replay handling", () => {
  it("mints only a hashed short-lived state bound to the live browser session", async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "challenge-1", expires_at: new Date("2026-01-01T00:05:00Z") }] });
    const result = await issueTelegramLinkChallenge({
      sub: "membership-1",
      businessId: "business-1",
      platformUserId: "platform-user-1",
      employeeSessionId: "employee-session-1",
      tokenVersion: 4,
    } as never);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.deepLink).toMatch(/^https:\/\/t\.me\/BizaMizOfficialBot\?start=[A-Za-z0-9_-]{43}$/);
    expect(result.challengeId).toBe("challenge-1");
    expect(mocks.query.mock.calls[1][0]).toContain("token_hash");
    const params = mocks.query.mock.calls[1][1] as unknown[];
    expect(params[4]).toMatch(/^[a-f0-9]{64}$/);
    expect(params).not.toContain(result.deepLink.split("start=")[1]);
    expect(mocks.recordSecurityAudit).toHaveBeenCalledOnce();
  });

  it("uses a unique replay digest and reports a duplicate exchange", async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ init_data_hash: "a".repeat(64) }] });
    await expect(
      consumeTelegramInitData({ replayKey: "a".repeat(64), telegramUserId: "123", linkId: "link-1", expiresAt: new Date() }),
    ).resolves.toBe(true);
    mocks.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    await expect(
      consumeTelegramInitData({ replayKey: "a".repeat(64), telegramUserId: "123", linkId: "link-1", expiresAt: new Date() }),
    ).resolves.toBe(false);
    expect(mocks.query.mock.calls[1][0]).toContain("ON CONFLICT (init_data_hash) DO NOTHING");
  });
});

describe("durable Telegram webhook inbox", () => {
  it("claims a new update id once and leaves processed updates deduplicated", async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ attempt_count: 1 }] });
    await expect(reserveTelegramWebhookUpdate(1001)).resolves.toEqual({ status: "reserved", attemptCount: 1 });
    expect(mocks.query.mock.calls[1][0]).toContain("ON CONFLICT (update_id) DO UPDATE");
    expect(mocks.query.mock.calls[1][0]).toContain("status = 'failed'");
    expect(mocks.query.mock.calls[1][0]).toContain("processing_started_at < now() - interval '2 minutes'");

    mocks.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ status: "processed" }] });
    await expect(reserveTelegramWebhookUpdate(1001)).resolves.toEqual({ status: "processed" });
  });

  it("keeps an in-progress retry unacknowledged so Telegram retries after the lease", async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ status: "processing" }] });
    await expect(reserveTelegramWebhookUpdate(1001)).resolves.toEqual({ status: "in_progress" });
  });

  it("stores only a bounded safe error code when processing fails", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] });
    await finishTelegramWebhookUpdate(1001, 2, { ok: false, errorCode: "telegram_api_429" });
    expect(mocks.query.mock.calls.at(-1)?.[0]).toContain("attempt_count = $2");
    expect(mocks.query.mock.calls.at(-1)?.[0]).toContain("status = 'processing'");
    expect(mocks.query.mock.calls.at(-1)?.[1]).toEqual([1001, 2, "failed", "telegram_api_429"]);

    mocks.query.mockResolvedValueOnce({ rows: [] });
    await finishTelegramWebhookUpdate(1001, 3, { ok: false, errorCode: "private user content" });
    expect(mocks.query.mock.calls.at(-1)?.[1]).toEqual([1001, 3, "failed", "processing_failed"]);
  });
});

describe("atomic browser-to-Telegram link redemption", () => {
  it("consumes a live challenge once and writes the link audit in the transaction", async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{
        id: "challenge-1",
        business_id: "business-1",
        membership_id: "membership-1",
        platform_user_id: "platform-user-1",
        employee_session_id: "employee-session-1",
        token_version: 4,
        session_live: true,
        consumed_at: null,
        consumed_by_link_id: null,
      }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "link-1", generation: 1 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await redeemTelegramLinkChallenge("A".repeat(43), "123456789");
    expect(result).toMatchObject({
      ok: true,
      platformUserId: "platform-user-1",
      alreadyLinked: false,
    });
    if (result.ok) {
      expect(result.linkId).toBe((mocks.query.mock.calls[3][1] as unknown[])[0]);
    }
    expect(mocks.query.mock.calls[0][0]).toContain("FOR UPDATE OF c");
    expect(mocks.query.mock.calls[3][0]).toContain("ON CONFLICT DO NOTHING");
    expect(mocks.recordSecurityAudit).toHaveBeenCalledOnce();
  });

  it("replays a consumed challenge as success only for its same still-active Telegram identity", async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{
        id: "challenge-1",
        business_id: "business-1",
        membership_id: "membership-1",
        platform_user_id: "platform-user-1",
        employee_session_id: "employee-session-1",
        token_version: 4,
        session_live: false,
        consumed_at: new Date(),
        consumed_by_link_id: "link-1",
      }] })
      .mockResolvedValueOnce({ rows: [{ id: "link-1" }] });
    await expect(redeemTelegramLinkChallenge("A".repeat(43), "123456789")).resolves.toEqual({
      ok: true,
      linkId: "link-1",
      platformUserId: "platform-user-1",
      alreadyLinked: true,
    });
    expect(mocks.recordSecurityAudit).not.toHaveBeenCalled();
    expect(mocks.query).toHaveBeenCalledTimes(2);
  });

  it("refuses challenge tokens outside the unguessable 256-bit format", async () => {
    await expect(redeemTelegramLinkChallenge("short", "123456789")).resolves.toEqual({
      ok: false,
      error: "invalid_or_expired_link",
    });
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("revokes all Telegram sessions when the linked identity is removed", async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ id: "link-1" }] })
      .mockResolvedValueOnce({ rows: [{ id: "session-1" }, { id: "session-2" }] });
    await expect(
      revokeTelegramIdentityLink({
        sub: "membership-1",
        businessId: "business-1",
        platformUserId: "platform-user-1",
      } as never),
    ).resolves.toEqual({ unlinked: true, revokedSessionCount: 2 });
    expect(mocks.query.mock.calls[1][0]).toContain("es.login_method = 'telegram'");
    expect(mocks.recordSecurityAudit).toHaveBeenCalledOnce();
  });
});
