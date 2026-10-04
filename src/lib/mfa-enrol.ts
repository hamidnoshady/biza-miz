/**
 * Phase 24 Wave 2 — two-factor enrolment, shared across realms and surfaces.
 *
 * Four places enrol a second factor:
 *   - `/api/auth/mfa/enrol`          (tenant login interstitial, pending-token auth)
 *   - `/api/platform/auth/mfa/enrol` (console login interstitial, pending-token auth)
 *   - `/api/auth/mfa/self`           (tenant dashboard settings, session auth)
 *   - `/api/platform/mfa`            (console «امنیت» / «حساب من» page, session auth)
 *
 * Per Issue #809 (Finding 4), interactive enrolment is always two-step:
 *   1. Stage pending enrolment (`confirmed_at = NULL`, `is_primary = false`).
 *   2. Confirm possession with a valid 6-digit code (`confirmMfaEnrolment`),
 *      which stamps `confirmed_at = now()`, promotes `is_primary` when no
 *      confirmed primary exists yet, and mints initial recovery codes.
 */
import { createHmac, randomInt } from "node:crypto";
import { generateSecret, generateURI } from "otplib";
import { query, withoutTenantScope } from "./db";
import { getRealmSecret } from "./jwt-secret";
import { isMobilePhone, phoneE164 } from "./phone";
import { totpQrDataUrl } from "./totp-qr";
import {
  getAccountMfaEnrolments,
  provisionMfaEnrolment,
  type MfaSubjectRealm,
} from "./mfa-service";
import { checkMfaChallengeRateLimit, recordMfaChallenge } from "./mfa-rate-limit";
import { getSmsProvider } from "./sms-config";

export type EnrolMfaError =
  | "invalid_method"
  | "invalid_phone"
  | "already_enrolled"
  | "rate_limited"
  | "sms_dispatch_failed";

export type EnrolMfaResult =
  | {
      ok: true;
      method: "totp" | "sms_otp";
      status: "pending_confirmation";
      totpSecret: string | null;
      totpUrl: string | null;
      totpQr: string | null;
      phone: string | null;
      maskedPhone: string | null;
      recoveryCodes: string[];
    }
  | {
      ok: false;
      error: EnrolMfaError;
      retryAfterMs?: number;
    };

/**
 * Fallback issuer when no business name applies (a platform admin, or an
 * identity that owns more than one business).
 */
const TOTP_ISSUER = "pos-system";

/**
 * Look up the business name to show in the authenticator app for a
 * `platform_user` enrolment.
 */
async function totpIssuerFor(
  subjectRealm: MfaSubjectRealm,
  subjectId: string,
): Promise<string> {
  if (subjectRealm !== "platform_user") return TOTP_ISSUER;
  const { rows } = await query<{ name: string }>(
    `SELECT DISTINCT b.name
       FROM users u
       JOIN businesses b ON b.id = u.business_id
      WHERE u.platform_user_id = $1
        AND b.status <> 'archived'
      LIMIT 2`,
    [subjectId],
  );
  if (rows.length === 1 && rows[0].name.trim()) return rows[0].name.trim();
  return TOTP_ISSUER;
}

export function maskPhoneNumber(phone: string | null | undefined): string | null {
  if (!phone) return null;
  return phone.length > 4 ? `***${phone.slice(-4)}` : phone;
}

/**
 * Issue and send a 6-digit SMS OTP challenge for an account's `sms_otp`
 * enrolment (either confirmed or pending confirmation).
 */
export async function issueSmsMfaChallenge(input: {
  subjectRealm: MfaSubjectRealm;
  subjectId: string;
  email: string;
}): Promise<
  | { ok: true; maskedPhone: string | null }
  | {
      ok: false;
      error: "sms_not_enrolled" | "rate_limited" | "sms_dispatch_failed";
      retryAfterMs?: number;
    }
> {
  return withoutTenantScope("platform", async () => {
    const enrolments = await getAccountMfaEnrolments(input.subjectRealm, input.subjectId);
    const smsEnrolment = enrolments.find((e) => e.method === "sms_otp");
    if (!smsEnrolment || !smsEnrolment.phone_e164) {
      return { ok: false, error: "sms_not_enrolled" };
    }

    const rateLimit = await checkMfaChallengeRateLimit(input.email);
    if (!rateLimit.allowed) {
      return {
        ok: false,
        error: "rate_limited",
        retryAfterMs: rateLimit.retryAfterMs,
      };
    }

    const otp = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const secret = await getRealmSecret("platform");
    const hashedOtp = createHmac("sha256", secret).update(otp).digest("hex");

    await query(
      `DELETE FROM mfa_challenges WHERE subject_realm = $1 AND subject_id = $2`,
      [input.subjectRealm, input.subjectId],
    );
    await query(
      `INSERT INTO mfa_challenges (subject_realm, subject_id, hashed_otp, expires_at)
       VALUES ($1, $2, $3, now() + interval '5 minutes')`,
      [input.subjectRealm, input.subjectId, hashedOtp],
    );

    await recordMfaChallenge(input.email);

    try {
      const sms = await getSmsProvider();
      await sms.sendOtp(smsEnrolment.phone_e164, otp);
    } catch (err) {
      console.error("Failed to send SMS OTP", err);
      return { ok: false, error: "sms_dispatch_failed" };
    }

    return { ok: true, maskedPhone: maskPhoneNumber(smsEnrolment.phone_e164) };
  });
}

export async function enrolMfaMethod(input: {
  subjectRealm: MfaSubjectRealm;
  subjectId: string;
  email: string;
  method: unknown;
  phone?: unknown;
  /**
   * When true and `method === "sms_otp"`, immediately sends a 6-digit SMS
   * challenge to the staged phone number so the caller can confirm it in one
   * round trip.
   */
  sendSmsChallenge?: boolean;
}): Promise<EnrolMfaResult> {
  if (input.method !== "totp" && input.method !== "sms_otp") {
    return { ok: false, error: "invalid_method" };
  }
  const method = input.method;

  let normalizedPhone: string | null = null;
  if (method === "sms_otp") {
    const rawPhone = typeof input.phone === "string" ? input.phone : "";
    if (!isMobilePhone(rawPhone)) {
      return { ok: false, error: "invalid_phone" };
    }
    normalizedPhone = phoneE164(rawPhone);
    if (!normalizedPhone) {
      return { ok: false, error: "invalid_phone" };
    }
  }

  return withoutTenantScope("platform", async () => {
    const enrolments = await getAccountMfaEnrolments(input.subjectRealm, input.subjectId);
    // Only block if this method is already CONFIRMED. An unconfirmed pending
    // enrolment can be replaced if the user restarted setup before confirming.
    if (enrolments.some((e) => e.method === method && e.confirmed_at !== null)) {
      return { ok: false, error: "already_enrolled" };
    }

    let totpSecret: string | null = null;
    let totpUrl: string | null = null;
    let totpQr: string | null = null;
    if (method === "totp") {
      const issuer = await totpIssuerFor(input.subjectRealm, input.subjectId);
      totpSecret = generateSecret();
      totpUrl = generateURI({
        label: input.email,
        issuer,
        secret: totpSecret,
        strategy: "totp",
      });
      totpQr = await totpQrDataUrl(totpUrl);
    }

    await provisionMfaEnrolment(
      { query: (text: string, params?: unknown[]) => query(text, params as unknown[]) },
      input.subjectRealm,
      input.subjectId,
      method,
      false,
      normalizedPhone,
      totpSecret ? Buffer.from(totpSecret) : null,
      { confirmed: false },
    );

    if (method === "sms_otp" && input.sendSmsChallenge) {
      const challenge = await issueSmsMfaChallenge({
        subjectRealm: input.subjectRealm,
        subjectId: input.subjectId,
        email: input.email,
      });
      if (!challenge.ok && challenge.error !== "sms_not_enrolled") {
        return {
          ok: false,
          error: challenge.error,
          retryAfterMs: challenge.retryAfterMs,
        };
      }
    }

    return {
      ok: true,
      method,
      status: "pending_confirmation",
      totpSecret,
      totpUrl,
      totpQr,
      phone: normalizedPhone,
      maskedPhone: maskPhoneNumber(normalizedPhone),
      recoveryCodes: [],
    };
  });
}
