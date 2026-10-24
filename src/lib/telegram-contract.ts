import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { parseHost } from "./host";

export const TELEGRAM_INIT_DATA_MAX_AGE_SECONDS = 5 * 60;
export const TELEGRAM_LINK_CHALLENGE_SECONDS = 5 * 60;
export const TELEGRAM_MAX_WEBHOOK_BYTES = 64 * 1024;

export interface TelegramBotConfig {
  botToken: string;
  botUsername: string;
  webhookSecret: string;
  webhookUrl: string;
  publicOrigin: string;
  rootDomain: string;
}

export type TelegramConfigResult =
  | { enabled: false; reason: "disabled" | "configuration_incomplete" }
  | { enabled: true; config: TelegramBotConfig };

function httpsOrigin(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Telegram is off by default and becomes available only with one complete,
 * platform-owned bot configuration. No business setting can provide a token.
 */
export function telegramConfig(
  env: Record<string, string | undefined> = process.env,
): TelegramConfigResult {
  if (env.TELEGRAM_ENABLED !== "true") return { enabled: false, reason: "disabled" };

  const rootDomain = env.ROOT_DOMAIN?.trim().toLowerCase().replace(/^\.+|\.+$/g, "") ?? "";
  const botToken = env.TELEGRAM_BOT_TOKEN?.trim() ?? "";
  const botUsername = env.TELEGRAM_BOT_USERNAME?.trim().replace(/^@/, "") ?? "";
  const webhookSecret = env.TELEGRAM_WEBHOOK_SECRET?.trim() ?? "";
  const publicOrigin = env.TELEGRAM_PUBLIC_ORIGIN?.trim() ?? "";
  const webhookUrl = env.TELEGRAM_WEBHOOK_URL?.trim() ?? "";
  const normalizedOrigin = httpsOrigin(publicOrigin);

  let normalizedWebhook: string | null = null;
  try {
    const parsed = new URL(webhookUrl);
    if (
      parsed.protocol === "https:" &&
      !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      !parsed.hash &&
      parsed.pathname === "/api/telegram/webhook"
    ) {
      normalizedWebhook = parsed.href;
    }
  } catch {
    // Invalid configuration fails closed below; never return the raw value.
  }

  const valid =
    rootDomain.length > 0 &&
    normalizedOrigin !== null &&
    parseHost(new URL(normalizedOrigin).hostname, rootDomain).kind === "apex" &&
    normalizedWebhook !== null &&
    new URL(normalizedWebhook).origin === normalizedOrigin &&
    /^\d+:[A-Za-z0-9_-]{20,}$/.test(botToken) &&
    /^[A-Za-z0-9_]{5,32}$/.test(botUsername) &&
    /^[A-Za-z0-9_-]{32,256}$/.test(webhookSecret);

  if (!valid) return { enabled: false, reason: "configuration_incomplete" };
  return {
    enabled: true,
    config: {
      botToken,
      botUsername,
      webhookSecret,
      webhookUrl: normalizedWebhook!,
      publicOrigin: normalizedOrigin!,
      rootDomain,
    },
  };
}

export interface VerifiedTelegramInitData {
  telegramUserId: string;
  authDate: number;
  /** Hash of the canonical signed data-check-string, not the raw user payload. */
  replayKey: string;
  expiresAt: Date;
}

export type TelegramInitDataResult =
  | { ok: true; value: VerifiedTelegramInitData }
  | { ok: false; error: "invalid_init_data" | "expired_init_data" | "future_init_data" | "private_chat_required" };

/**
 * Verify the official Telegram Web App HMAC envelope, age and private-chat
 * context. `initDataUnsafe` and client-supplied IDs are never inputs here.
 */
export function verifyTelegramInitData(
  raw: string,
  botToken: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): TelegramInitDataResult {
  if (raw.length === 0 || raw.length > 8192 || !botToken) {
    return { ok: false, error: "invalid_init_data" };
  }

  const values = new Map<string, string>();
  try {
    for (const [key, value] of new URLSearchParams(raw)) {
      if (!key || values.has(key)) return { ok: false, error: "invalid_init_data" };
      values.set(key, value);
    }
  } catch {
    return { ok: false, error: "invalid_init_data" };
  }

  const suppliedHash = values.get("hash");
  const authDateRaw = values.get("auth_date");
  const userRaw = values.get("user");
  if (
    !suppliedHash ||
    !/^[a-f0-9]{64}$/i.test(suppliedHash) ||
    !authDateRaw ||
    !userRaw
  ) {
    return { ok: false, error: "invalid_init_data" };
  }

  const authDate = Number(authDateRaw);
  if (!Number.isSafeInteger(authDate) || authDate <= 0) {
    return { ok: false, error: "invalid_init_data" };
  }
  if (authDate > nowSeconds + 30) return { ok: false, error: "future_init_data" };
  if (nowSeconds - authDate > TELEGRAM_INIT_DATA_MAX_AGE_SECONDS) {
    return { ok: false, error: "expired_init_data" };
  }

  let user: unknown;
  try {
    user = JSON.parse(userRaw);
  } catch {
    return { ok: false, error: "invalid_init_data" };
  }
  if (!user || typeof user !== "object") return { ok: false, error: "invalid_init_data" };
  const userRecord = user as { id?: unknown; is_bot?: unknown };
  const telegramId =
    typeof userRecord.id === "number"
      ? userRecord.id
      : typeof userRecord.id === "string" && /^\d+$/.test(userRecord.id)
        ? Number(userRecord.id)
        : NaN;
  if (!Number.isSafeInteger(telegramId) || telegramId <= 0 || userRecord.is_bot === true) {
    return { ok: false, error: "invalid_init_data" };
  }

  const chatType = values.get("chat_type");
  if (chatType !== undefined && chatType !== "private") {
    return { ok: false, error: "private_chat_required" };
  }

  const checkString = [...values.entries()]
    .filter(([key]) => key !== "hash")
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expectedHash = createHmac("sha256", secretKey).update(checkString).digest();
  const actualHash = Buffer.from(suppliedHash, "hex");
  if (actualHash.length !== expectedHash.length || !timingSafeEqual(actualHash, expectedHash)) {
    return { ok: false, error: "invalid_init_data" };
  }

  return {
    ok: true,
    value: {
      telegramUserId: String(telegramId),
      authDate,
      replayKey: createHash("sha256").update(checkString).digest("hex"),
      expiresAt: new Date((authDate + TELEGRAM_INIT_DATA_MAX_AGE_SECONDS) * 1000),
    },
  };
}

/** Constant-time comparison for Telegram's webhook secret header. */
export function constantTimeSecretEquals(actual: string | null, expected: string): boolean {
  if (!actual) return false;
  const left = Buffer.from(actual, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

export function isSafeTelegramId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
