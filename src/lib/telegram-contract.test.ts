import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  constantTimeSecretEquals,
  telegramConfig,
  verifyTelegramInitData,
} from "./telegram-contract";

const BOT_TOKEN = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi_123";
const BASE_NOW = 1_800_000_000;

function signedInitData(
  fields: Record<string, string>,
  token = BOT_TOKEN,
): string {
  const values = new Map(Object.entries(fields));
  const checkString = [...values.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secretKey = createHmac("sha256", "WebAppData").update(token).digest();
  const hash = createHmac("sha256", secretKey).update(checkString).digest("hex");
  values.set("hash", hash);
  return [...values.entries()]
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
}

const validFields = (overrides: Record<string, string> = {}) => ({
  auth_date: String(BASE_NOW),
  chat_type: "private",
  user: JSON.stringify({ id: 987654321, first_name: "Test" }),
  ...overrides,
});

describe("telegramConfig", () => {
  const configured = {
    TELEGRAM_ENABLED: "true",
    ROOT_DOMAIN: "example.com",
    TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    TELEGRAM_BOT_USERNAME: "BizaMizOfficialBot",
    TELEGRAM_WEBHOOK_SECRET: "A".repeat(40),
    TELEGRAM_PUBLIC_ORIGIN: "https://example.com",
    TELEGRAM_WEBHOOK_URL: "https://example.com/api/telegram/webhook",
  };

  it("is disabled by default", () => {
    expect(telegramConfig({})).toEqual({ enabled: false, reason: "disabled" });
    expect(telegramConfig({ ...configured, TELEGRAM_ENABLED: "yes" })).toEqual({
      enabled: false,
      reason: "disabled",
    });
  });

  it("accepts one complete central HTTPS bot configuration", () => {
    expect(telegramConfig(configured)).toMatchObject({
      enabled: true,
      config: {
        botUsername: "BizaMizOfficialBot",
        publicOrigin: "https://example.com",
        webhookUrl: "https://example.com/api/telegram/webhook",
      },
    });
  });

  it.each([
    ["tenant origin", { TELEGRAM_PUBLIC_ORIGIN: "https://tenant.example.com" }],
    ["non-HTTPS origin", { TELEGRAM_PUBLIC_ORIGIN: "http://example.com" }],
    ["cross-origin webhook", { TELEGRAM_WEBHOOK_URL: "https://hooks.example.net/api/telegram/webhook" }],
    ["wrong webhook path", { TELEGRAM_WEBHOOK_URL: "https://example.com/webhook" }],
    ["short secret", { TELEGRAM_WEBHOOK_SECRET: "short" }],
    ["missing root domain", { ROOT_DOMAIN: "" }],
  ])("fails closed for invalid %s configuration", (_name, patch) => {
    expect(telegramConfig({ ...configured, ...patch })).toEqual({
      enabled: false,
      reason: "configuration_incomplete",
    });
  });
});

describe("verifyTelegramInitData", () => {
  it("verifies a Telegram HMAC and returns only a numeric id and replay digest", () => {
    const raw = signedInitData(validFields());
    const result = verifyTelegramInitData(raw, BOT_TOKEN, BASE_NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.telegramUserId).toBe("987654321");
    expect(result.value.authDate).toBe(BASE_NOW);
    expect(result.value.replayKey).toMatch(/^[a-f0-9]{64}$/);
    expect(result.value).not.toHaveProperty("user");
    expect(result.value).not.toHaveProperty("raw");
  });

  it("canonicalizes parameter order so reordered copies have the same replay key", () => {
    const fields = validFields({ query_id: "AAEAAAE" });
    const raw = signedInitData(fields);
    const reordered = signedInitData(Object.fromEntries(Object.entries(fields).reverse()));
    const first = verifyTelegramInitData(raw, BOT_TOKEN, BASE_NOW);
    const second = verifyTelegramInitData(reordered, BOT_TOKEN, BASE_NOW);
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) expect(first.value.replayKey).toBe(second.value.replayKey);
  });

  it("rejects a forged signature and a signature from another bot", () => {
    const raw = signedInitData(validFields());
    expect(verifyTelegramInitData(`${raw}&user=%7B%22id%22%3A3%7D`, BOT_TOKEN, BASE_NOW)).toMatchObject({
      ok: false,
      error: "invalid_init_data",
    });
    expect(verifyTelegramInitData(raw, "987654321:wrong-bot-secret", BASE_NOW)).toMatchObject({
      ok: false,
      error: "invalid_init_data",
    });
  });

  it("rejects duplicate fields and bot/malformed Telegram users", () => {
    const raw = signedInitData(validFields());
    expect(verifyTelegramInitData(`${raw}&auth_date=${BASE_NOW}`, BOT_TOKEN, BASE_NOW)).toMatchObject({
      ok: false,
      error: "invalid_init_data",
    });
    for (const user of [
      JSON.stringify({ id: -1 }),
      JSON.stringify({ id: Number.MAX_SAFE_INTEGER + 1 }),
      JSON.stringify({ id: 123, is_bot: true }),
      "not-json",
    ]) {
      expect(
        verifyTelegramInitData(signedInitData(validFields({ user })), BOT_TOKEN, BASE_NOW),
      ).toMatchObject({ ok: false, error: "invalid_init_data" });
    }
  });

  it("enforces the auth-date window and private-chat restriction", () => {
    expect(
      verifyTelegramInitData(signedInitData(validFields({ auth_date: String(BASE_NOW - 301) })), BOT_TOKEN, BASE_NOW),
    ).toMatchObject({ ok: false, error: "expired_init_data" });
    expect(
      verifyTelegramInitData(signedInitData(validFields({ auth_date: String(BASE_NOW + 31) })), BOT_TOKEN, BASE_NOW),
    ).toMatchObject({ ok: false, error: "future_init_data" });
    expect(
      verifyTelegramInitData(signedInitData(validFields({ chat_type: "group" })), BOT_TOKEN, BASE_NOW),
    ).toMatchObject({ ok: false, error: "private_chat_required" });
  });
});

describe("constantTimeSecretEquals", () => {
  it("accepts equal secrets and rejects missing, different-length, or different values", () => {
    expect(constantTimeSecretEquals("abc123", "abc123")).toBe(true);
    expect(constantTimeSecretEquals(null, "abc123")).toBe(false);
    expect(constantTimeSecretEquals("abc", "abc123")).toBe(false);
    expect(constantTimeSecretEquals("abc124", "abc123")).toBe(false);
  });
});
