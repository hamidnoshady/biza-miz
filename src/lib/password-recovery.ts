/**
 * #1386 — password recovery through a **purpose-bound** verified-phone OTP.
 *
 * This is deliberately separate from `phone-otp` login:
 *
 *  - login proves a number and mints a session (purpose `login`);
 *  - recovery proves the same number and is allowed to replace the password
 *    (purpose `password_recovery`).
 *
 * A code issued for one purpose is refused by the other (`redeemOtpChallenge`
 * filters on purpose), so a login SMS can never be replayed as a reset and a
 * reset SMS can never become a session.
 *
 * Anti-enumeration is the other design constraint. An unauthenticated caller
 * must not learn whether a phone belongs to an account, so:
 *
 *  - a well-formed request always answers the same neutral `sent` shape;
 *  - an unknown number gets no SMS, but the request endpoint's answer is
 *    byte-identical;
 *  - verification answers every failure as `invalid_code`;
 *  - provider failure is logged, never surfaced (a 502 for known numbers only
 *    would be an oracle).
 */
import { consumeAllChallenges, issueOtpChallenge, normalizeOtpCode, phoneDerivedSubject, redeemOtpChallenge } from "./otp-challenge";
import { query, withoutTenantScope } from "./db";
import { getSmsProvider } from "./sms-config";
import { canonicalMemberPhone, checkPhoneOtpRateLimit, maskPhoneE164 } from "./phone-otp";
import {
  resetPasswordForVerifiedPhone,
  validatePasswordStrength,
  type PasswordStrengthError,
} from "./password-reset";

/** A realm of its own, so a recovery challenge cannot collide with a login one. */
export const PASSWORD_RECOVERY_REALM = "password_recovery";

/** Five minutes, the same window as every other SMS code. */
export const PASSWORD_RECOVERY_EXPIRES_SECONDS = 5 * 60;

/**
 * The one active identity whose **canonical global** number this is, or null.
 *
 * Deliberately global-only, unlike the login door's dual-read: a password reset
 * is an account-takeover primitive, and the membership phone is
 * employer-controlled. A business administrator can move an employee's
 * `users.phone_e164` to a number they hold and pass its OTP — #1384's own
 * write-once rule exists for that reason. Letting that membership phone drive
 * the person's *global* password would hand the employer the recovery channel.
 * The global number is written only by the person-side verified doors.
 *
 * More than one identity claiming the number is refused rather than guessed.
 */
async function resolveIdentityForVerifiedPhone(
  phone: string,
): Promise<{ id: string; email: string | null } | null> {
  const { rows } = await withoutTenantScope("identity", () =>
    query<{ id: string; email: string | null }>(
      `SELECT id, email::text AS email
         FROM platform_users
        WHERE phone_e164 = $1
          AND phone_verified_at IS NOT NULL
          AND is_active = true`,
      [phone],
    ),
  );
  return rows.length === 1 ? rows[0] : null;
}

export type PasswordRecoveryRequestResult =
  | { ok: true; maskedPhone: string; expiresInSeconds: number }
  | { ok: false; error: "invalid_phone" }
  | { ok: false; error: "rate_limited"; retryAfterMs: number };

/**
 * Issue a recovery code if — and only if — the number belongs to an active,
 * verified identity. The caller must not distinguish the `ok` shapes beyond
 * "the request was acceptable"; see the module comment.
 */
export async function requestPhonePasswordRecovery(
  rawPhone: unknown,
): Promise<PasswordRecoveryRequestResult> {
  const phone = canonicalMemberPhone(typeof rawPhone === "string" ? rawPhone : null);
  if (!phone) return { ok: false, error: "invalid_phone" };

  /*
   * The limiter runs before the account lookup, for every number. An unknown
   * number therefore gets the same 429 as a known one after the same number of
   * requests, instead of a fast 200 that would distinguish "no account" from
   * "too many requests". The key is namespaced so a recovery request does not
   * consume the login OTP budget for the same phone.
   */
  const limit = await checkPhoneOtpRateLimit(`recovery:${phone}`);
  if (!limit.allowed) {
    return { ok: false, error: "rate_limited", retryAfterMs: limit.retryAfterMs };
  }

  const identity = await resolveIdentityForVerifiedPhone(phone);
  if (!identity) {
    // No challenge, no SMS. The response shape is the caller's contract, not
    // this branch's.
    return {
      ok: true,
      maskedPhone: maskPhoneE164(phone),
      expiresInSeconds: PASSWORD_RECOVERY_EXPIRES_SECONDS,
    };
  }

  const subject = await phoneDerivedSubject(phone);
  const issued = await issueOtpChallenge({
    subjectRealm: PASSWORD_RECOVERY_REALM,
    subjectId: subject,
    purpose: "password_recovery",
    candidatePhoneE164: phone,
  });

  try {
    const provider = await getSmsProvider();
    await provider.sendOtp(phone, issued.code);
  } catch (error) {
    // A code that never arrived must not stay live. Log ids only, never the
    // number or the code.
    await consumeAllChallenges({
      subjectRealm: PASSWORD_RECOVERY_REALM,
      subjectId: subject,
      purpose: "password_recovery",
    }).catch(() => {});
    console.error("Password-recovery SMS dispatch failed", {
      platformUserId: identity.id,
      error: error instanceof Error ? error.message : String(error),
    });
    // Deliberately still `ok`: a 502 here would tell the caller the number has
    // an account. The member can retry; an operator sees the log.
    return {
      ok: true,
      maskedPhone: maskPhoneE164(phone),
      expiresInSeconds: PASSWORD_RECOVERY_EXPIRES_SECONDS,
    };
  }

  await withoutTenantScope("platform", () =>
    query(
      `INSERT INTO auth_login_attempts (realm, identity_key, outcome)
       VALUES ('phone_otp', $1, 'success')`,
      [`recovery:${phone}`],
    ),
  );

  return {
    ok: true,
    maskedPhone: maskPhoneE164(phone),
    expiresInSeconds: PASSWORD_RECOVERY_EXPIRES_SECONDS,
  };
}

export type PasswordRecoveryVerifyResult =
  | { ok: true; tokenVersion: number; revokedSessions: number }
  | {
      ok: false;
      error: "invalid_phone" | "invalid_code" | "invalid_identity" | PasswordStrengthError;
    };

/**
 * Redeem a recovery code and replace the password in one step.
 *
 * The challenge is consumed before the credential write. That ordering is
 * deliberate: a failed write must not leave a live code that could be retried
 * forever, and a successful write must never be replayable. The credential
 * write itself (version bump, session revocation, trust revocation, lockout
 * reset and audit) is atomic inside `resetPasswordForVerifiedPhone`.
 */
export async function verifyPhonePasswordRecovery(params: {
  phone: unknown;
  code: unknown;
  newPassword: unknown;
  confirmPassword?: unknown;
}): Promise<PasswordRecoveryVerifyResult> {
  const phone = canonicalMemberPhone(typeof params.phone === "string" ? params.phone : null);
  if (!phone) return { ok: false, error: "invalid_phone" };

  const code = normalizeOtpCode(params.code);
  if (!code) return { ok: false, error: "invalid_code" };

  const newPassword = typeof params.newPassword === "string" ? params.newPassword : "";
  const confirmPassword =
    typeof params.confirmPassword === "string" ? params.confirmPassword : undefined;
  const strength = validatePasswordStrength(newPassword, undefined, confirmPassword);
  if (!strength.ok) return strength;

  const subject = await phoneDerivedSubject(phone);
  const redeemed = await redeemOtpChallenge({
    subjectRealm: PASSWORD_RECOVERY_REALM,
    subjectId: subject,
    purpose: "password_recovery",
    code,
    expectedPhoneE164: phone,
  });
  if (!redeemed.ok) return { ok: false, error: "invalid_code" };

  const identity = await resolveIdentityForVerifiedPhone(phone);
  if (!identity) return { ok: false, error: "invalid_identity" };

  const result = await resetPasswordForVerifiedPhone({
    platformUserId: identity.id,
    newPassword,
    // The password door counts a phone-only identity under its E.164 number
    // (see /api/auth/login), so clear whichever key that door uses.
    lockoutKey: identity.email ?? phone,
  });
  if (!result.ok) {
    if (result.error === "password_strength") return { ok: false, error: result.detail };
    return { ok: false, error: "invalid_identity" };
  }

  return { ok: true, tokenVersion: result.tokenVersion, revokedSessions: result.revokedSessions };
}
