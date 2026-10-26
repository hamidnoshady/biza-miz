import { query, withoutTenantScope } from "./db";
import { getRealmSecret } from "./jwt-secret";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { SmsProvider, NoopProvider } from "./sms";
import { KavenegarProvider } from "./sms-kavenegar";

/**
 * Phase 24 Wave 2 — where the Kavenegar connection comes from.
 *
 * Per CLAUDE.md, anything that administers clients across businesses belongs
 * to the console, so the connection lives in the `platform_sms_config`
 * singleton (migration 0076) with the API key encrypted at rest — the same
 * shape and the same guards as `platform_ai_config`. The `KAVENEGAR_*`
 * environment variables remain as an operator bootstrap fallback, exactly as
 * the `AI_*` ones work: an install can send its first OTP before anyone has
 * opened the console.
 *
 * Precedence is database-then-environment, so a value typed in the console
 * always wins over one baked into a container image.
 */

/** What the console shows about the connection — never the key itself. */
export interface PublicSmsConfig {
  /** True when a key is stored in the database (as opposed to inherited from the environment). */
  hasStoredKey: boolean;
  /** Last four characters of the effective key, for "is this the one I think it is". */
  keyHint: string | null;
  otpTemplate: string;
  /** True when the effective key comes from KAVENEGAR_API_KEY rather than the console. */
  fromEnvironment: boolean;
  /** False when neither source has a key: OTPs are logged, not sent. */
  configured: boolean;
  updatedAt: string | null;
}

/** The default Kavenegar template name, matching the historical env-var default. */
export const DEFAULT_OTP_TEMPLATE = "verify";

interface ResolvedSmsConfig {
  apiKey: string | null;
  template: string;
  fromEnvironment: boolean;
  hasStoredKey: boolean;
  updatedAt: Date | null;
}

async function readSmsConfig(): Promise<ResolvedSmsConfig> {
  const { rows } = await withoutTenantScope("platform", () =>
    query<{ api_key_enc: Buffer | null; otp_template: string | null; updated_at: Date }>(
      `SELECT api_key_enc, otp_template, updated_at FROM platform_sms_config WHERE id = 1`,
    ),
  );

  const envKey = process.env.KAVENEGAR_API_KEY || null;
  const envTemplate = process.env.KAVENEGAR_OTP_TEMPLATE || DEFAULT_OTP_TEMPLATE;

  const row = rows[0];
  if (!row?.api_key_enc) {
    return {
      apiKey: envKey,
      template: row?.otp_template || envTemplate,
      fromEnvironment: envKey !== null,
      hasStoredKey: false,
      updatedAt: row?.updated_at ?? null,
    };
  }

  const stored = decryptApiKey(row.api_key_enc, await getSmsSecretKey());
  if (!stored) {
    // A key that will not decrypt is a key that will not send. Fall back to the
    // environment rather than silently failing every OTP: on a re-keyed install
    // the env var is exactly the bootstrap path that gets SMS working again.
    console.error("Failed to decrypt SMS API key; falling back to KAVENEGAR_API_KEY");
    return {
      apiKey: envKey,
      template: row.otp_template || envTemplate,
      fromEnvironment: envKey !== null,
      hasStoredKey: true,
      updatedAt: row.updated_at,
    };
  }

  return {
    apiKey: stored,
    template: row.otp_template || envTemplate,
    fromEnvironment: false,
    hasStoredKey: true,
    updatedAt: row.updated_at,
  };
}

function decryptApiKey(data: Buffer, key: Buffer): string | null {
  try {
    // IV(12) ‖ TAG(16) ‖ ciphertext, AES-256-GCM.
    const iv = data.subarray(0, 12);
    const tag = data.subarray(12, 28);
    const ciphertext = data.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

function encryptApiKey(plain: string, key: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plain, "utf8")), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

/**
 * Issue #902 — the ONE master credential, for the second caller that needs it.
 *
 * The customer-management API (child accounts, templates, provider funding) is
 * driven by the same master account that sends login OTPs, so it resolves the
 * key through the same database-then-environment precedence. A separate key
 * store for "the reseller account" would recreate the split this issue had to
 * close: two configurations that can disagree about which account is billing
 * the platform.
 */
export async function getKavenegarMasterKey(): Promise<{
  apiKey: string | null;
  fromEnvironment: boolean;
  updatedAt: string | null;
}> {
  const config = await readSmsConfig();
  return {
    apiKey: config.apiKey,
    fromEnvironment: config.fromEnvironment,
    updatedAt: config.updatedAt?.toISOString() ?? null,
  };
}

export async function getSmsProvider(): Promise<SmsProvider> {
  const config = await readSmsConfig();
  if (config.apiKey) {
    return new KavenegarProvider(config.apiKey, config.template);
  }
  // No key anywhere: log the OTP instead of throwing. An offline/local install
  // has no SMS by definition and must still boot — it enrols TOTP instead.
  return new NoopProvider();
}

/** The console's read view. Never returns the key; only whether there is one and its last four. */
export async function getPublicSmsConfig(): Promise<PublicSmsConfig> {
  const config = await readSmsConfig();
  return {
    hasStoredKey: config.hasStoredKey,
    keyHint: config.apiKey ? `••••${config.apiKey.slice(-4)}` : null,
    otpTemplate: config.template,
    fromEnvironment: config.fromEnvironment,
    configured: config.apiKey !== null,
    updatedAt: config.updatedAt?.toISOString() ?? null,
  };
}

export interface SaveSmsConfigInput {
  /** Omitted or empty leaves the stored key untouched — the console never round-trips it. */
  apiKey?: string | null;
  otpTemplate?: string;
  /** Explicitly drop the stored key and fall back to the environment. */
  clearApiKey?: boolean;
}

export async function savePlatformSmsConfig(input: SaveSmsConfigInput): Promise<PublicSmsConfig> {
  const template = (input.otpTemplate ?? "").trim() || DEFAULT_OTP_TEMPLATE;
  const key = await getSmsSecretKey();

  await withoutTenantScope("platform", async () => {
    if (input.clearApiKey) {
      await query(
        `INSERT INTO platform_sms_config (id, api_key_enc, otp_template, updated_at)
         VALUES (1, NULL, $1, now())
         ON CONFLICT (id) DO UPDATE SET api_key_enc = NULL, otp_template = $1, updated_at = now()`,
        [template],
      );
      return;
    }

    const apiKey = (input.apiKey ?? "").trim();
    if (apiKey.length === 0) {
      // Template-only edit: leave `api_key_enc` exactly as it was. A blank key
      // field in the console means "unchanged", never "erase" — erasing is the
      // explicit `clearApiKey` above.
      await query(
        `INSERT INTO platform_sms_config (id, otp_template, updated_at)
         VALUES (1, $1, now())
         ON CONFLICT (id) DO UPDATE SET otp_template = $1, updated_at = now()`,
        [template],
      );
      return;
    }

    await query(
      `INSERT INTO platform_sms_config (id, api_key_enc, otp_template, updated_at)
       VALUES (1, $1, $2, now())
       ON CONFLICT (id) DO UPDATE SET api_key_enc = $1, otp_template = $2, updated_at = now()`,
      [encryptApiKey(apiKey, key), template],
    );
  });

  return getPublicSmsConfig();
}

async function getSmsSecretKey(): Promise<Buffer> {
  return Buffer.from(await getRealmSecret("platform"));
}
