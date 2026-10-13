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
import { generateSecret, generateURI } from "otplib";
import { query, withoutTenantScope } from "./db";
import { isMobilePhone, phoneE164 } from "./phone";
import {
  issueOtpChallenge,
  liveChallengePhone,
  type OtpPurpose,
} from "./otp-challenge";
import { totpQrDataUrl } from "./totp-qr";
import {
  getAccountMfaEnrolments,
  provisionMfaEnrolment,
  type MfaSubjectRealm,
} from "./mfa-service";
import { isActiveMfaEnrolment } from "./mfa";
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
 *
 * Issue #854 (P0.8 / P1.17): the challenge is now minted through
 * `issueOtpChallenge`, which binds it to `(subject, purpose, candidate phone)`
 * and consumes any earlier live challenge for the same purpose in the same
 * statement — rather than a `DELETE`-everything-then-`INSERT` that could race a
 * concurrent verify. The `purpose` parameter is required, not defaulted,
 * because "which transaction is this code for" is the whole point of the
 * binding.
 *
 * The masked destination and the candidate phone are returned together so a
 * caller can show «کد به … ارسال شد» without a second read and without ever
 * reconstructing the number from the mask (P2.19).
 */
export async function issueSmsMfaChallenge(input: {
  subjectRealm: MfaSubjectRealm;
  subjectId: string;
  email: string;
  /** Which transaction this code authorises. */
  purpose?: Extract<OtpPurpose, "mfa_login" | "mfa_enrol_sms" | "step_up_sms">;
  /** Explicit destination override (a replacement number being proven). */
  phoneE164?: string | null;
  /**
   * Issue #854 — whether the destination must come from a live factor: a
   * confirmed SMS enrolment, or the owner-activation bootstrap row.
   *
   * The old lookup was "the first `sms_otp` row for this account", whichever one
   * that was. `mfa_enrolments` holds exactly one row per method, and an
   * interactive half-finished enrolment *reuses* that row, so signing in,
   * starting an SMS enrolment and then asking for a step-up code sent the
   * step-up challenge to a number nobody had proven — and the strict verifier
   * accepted it, because its SMS branch never asked whether the row was a factor
   * at all. Only the enrolment ceremony itself may address a row that is not yet
   * a factor, and it does so by naming the number it just staged.
   *
   * **Defaults by purpose**, because the purpose already says which transaction
   * this is and a caller cannot then forget a second flag:
   *
   *  - `step_up_sms` — always a live factor. A recent-auth proof must be a proof
   *    of something the account already had.
   *  - `mfa_login` — any row for the account. The login interstitial's
   *    mid-enrolment branch is exactly the case of "no live factor yet, finish
   *    the one you started" (`mayConfirmPendingEnrolmentAtLogin`), and the
   *    *verifier* is what refuses to treat that pending row as a second factor
   *    when a confirmed one already exists.
   *  - `mfa_enrol_sms` — the ceremony's own staged row; an override names it.
   */
  requireActiveFactor?: boolean;
}): Promise<
  | { ok: true; maskedPhone: string | null; candidatePhoneE164: string; challengeId: string }
  | {
      ok: false;
      error: "sms_not_enrolled" | "rate_limited" | "sms_dispatch_failed";
      retryAfterMs?: number;
    }
> {
  return withoutTenantScope("platform", async () => {
    const enrolments = await getAccountMfaEnrolments(input.subjectRealm, input.subjectId);
    const requireActive =
      input.requireActiveFactor ??
      (input.purpose ?? "mfa_login") === "step_up_sms";
    /**
     * A live factor, not merely a row: see `requireActiveFactor`. The bootstrap
     * SMS row counts (the owner's factor exists before its first confirmation),
     * an interactive pending enrolment does not.
     */
    const smsEnrolment = requireActive
      ? enrolments.find((e) => e.method === "sms_otp" && isActiveMfaEnrolment(e))
      : enrolments.find((e) => e.method === "sms_otp");
    const destination = input.phoneE164 ?? smsEnrolment?.phone_e164 ?? null;
    if (!destination) {
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

    const issued = await issueOtpChallenge({
      subjectRealm: input.subjectRealm,
      subjectId: input.subjectId,
      purpose: input.purpose ?? "mfa_login",
      candidatePhoneE164: destination,
    });

    await recordMfaChallenge(input.email);

    try {
      const sms = await getSmsProvider();
      await sms.sendOtp(destination, issued.code);
    } catch (err) {
      console.error("Failed to send SMS OTP", err);
      // A code that never arrived must not sit live for five minutes.
      await query(`UPDATE mfa_challenges SET consumed_at = now() WHERE id = $1`, [
        issued.challengeId,
      ]);
      return { ok: false, error: "sms_dispatch_failed" };
    }

    return {
      ok: true,
      maskedPhone: maskPhoneNumber(destination),
      candidatePhoneE164: destination,
      challengeId: issued.challengeId,
    };
  });
}

/**
 * The destination a live SMS challenge is waiting on, so a resumed step-up
 * (after a refresh) can say where the code went without the client having to
 * remember it — and without the client being able to redirect it (#854 P2.19).
 */
export async function pendingSmsChallengeDestination(input: {
  subjectRealm: MfaSubjectRealm;
  subjectId: string;
  purpose?: Extract<OtpPurpose, "mfa_login" | "mfa_enrol_sms" | "step_up_sms">;
}): Promise<{ maskedPhone: string | null; expiresAt: string } | null> {
  const live = await liveChallengePhone({
    subjectRealm: input.subjectRealm,
    subjectId: input.subjectId,
    purpose: input.purpose ?? "mfa_login",
  });
  if (!live) return null;
  return {
    maskedPhone: maskPhoneNumber(live.candidatePhoneE164),
    expiresAt: live.expiresAt.toISOString(),
  };
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
  /**
   * Issue #854 (P2.21) — the caller is replacing the phone of an already
   * confirmed SMS factor. Only honoured for `sms_otp`, only when the named
   * number differs from the confirmed one, and only for the confirmation
   * ceremony: the confirmed row is left untouched until the new number proves
   * itself, so the account is never factorless between steps.
   */
  replaceConfirmed?: boolean;
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
    const confirmedSameMethod = enrolments.find(
      (e) => e.method === method && e.confirmed_at !== null,
    );
    /**
     * The replacement door (P2.21): a confirmed SMS factor may be *replaced*
     * by proving a different number, but never silently re-enrolled. Same
     * number, or a TOTP factor, still gets the plain refusal.
     */
    const replacingConfirmedSms = Boolean(
      input.replaceConfirmed &&
        method === "sms_otp" &&
        confirmedSameMethod &&
        normalizedPhone &&
        (confirmedSameMethod.phone_e164 ?? null) !== normalizedPhone,
    );
    // Only block if this method is already CONFIRMED. An unconfirmed pending
    // enrolment can be replaced if the user restarted setup before confirming.
    if (confirmedSameMethod && !replacingConfirmedSms) {
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

    /**
     * A replacement never touches the confirmed row: staging it as pending
     * would un-confirm the account's only factor mid-ceremony. The swap is
     * committed by `confirmMfaEnrolment`, after the new number redeems its
     * own challenge.
     */
    if (!replacingConfirmedSms) {
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
    }

    if (method === "sms_otp" && input.sendSmsChallenge) {
      /**
       * Issue #854 — the purpose the first code carries is the one the *confirm*
       * step will look for.
       *
       * This call used to pass no purpose and inherit `mfa_login`, while
       * `verifyAndConfirmPendingMfaEnrolment` spends `mfa_enrol_sms`. An SMS
       * factor could therefore never be enrolled in one pass: the first code
       * arrived and was rejected, the member pressed «ارسال مجدد» (which does
       * mint `mfa_enrol_sms`) and only then could confirm. Naming it here — and
       * naming the staged number, since the row is by definition not a factor
       * yet — makes the first send and the resend the same transaction type.
       */
      const challenge = await issueSmsMfaChallenge({
        subjectRealm: input.subjectRealm,
        subjectId: input.subjectId,
        email: input.email,
        purpose: "mfa_enrol_sms",
        phoneE164: normalizedPhone,
        requireActiveFactor: false,
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
