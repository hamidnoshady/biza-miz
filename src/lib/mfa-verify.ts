/**
 * Phase 24 Wave 2 — second-factor verification, shared across both realms.
 *
 * The tenant `/api/auth/mfa/verify` and platform `/api/platform/auth/mfa/verify`
 * endpoints only differ in what they do *after* the code checks out (which
 * session cookie to mint, which user table to load). Everything that decides
 * whether the submitted digits or recovery code are genuine is identical and
 * lives here, so the two realms cannot drift on window tolerance, challenge
 * attempt counting, or recovery-code single-use semantics.
 *
 * Issue #854 (P1.11) split the entry point in two, because one function was
 * doing two jobs:
 *
 *  - `verifyAndConfirmPendingMfaEnrolment` is what an **enrolment** confirmation
 *    does: prove the code *and* flip the enrolment from pending to confirmed as
 *    a side effect. That is correct on the enrolment screen — the whole point is
 *    "prove you can generate a code before we switch this on".
 *  - `verifyExistingConfirmedMfaFactor` is what a **step-up / recent-auth**
 *    check does: prove the person still holds a factor they already had. It must
 *    never activate a pending enrolment, because "prove it's you" is not an
 *    enrolment request and a half-finished TOTP setup would otherwise silently
 *    become the second factor on an unrelated session-management action.
 *
 * Step-up, session revocation and any other proof-of-existing-factor path call
 * the second one. The MFA interstitial at login calls whichever the pending
 * token says it is doing.
 */
import { query, withoutTenantScope } from "./db";
import { NobleCryptoPlugin, ScureBase32Plugin, TOTP } from "otplib";
import {
  confirmMfaEnrolment,
  decryptTotpSecret,
  getAccountMfaEnrolments,
  type MfaSubjectRealm,
} from "./mfa-service";
import { activeSmsFactorPhone } from "./mfa";
import type { SecurityAuditAttribution } from "./security-audit";
import { consumeRecoveryCode } from "./mfa-recovery";
import {
  normalizeOtpCode,
  redeemOtpChallenge,
  type OtpPurpose,
} from "./otp-challenge";

const totp = new TOTP({
  crypto: new NobleCryptoPlugin(),
  base32: new ScureBase32Plugin(),
});

/**
 * The three purposes an SMS code may carry when it is being spent as a second
 * factor, kept as documentation rather than as a default.
 *
 * Issue #854 (invariant 4) made the choice per call site: `mfa_login` belongs to
 * the login interstitial, `step_up_sms` to a recent-auth check, and
 * `mfa_enrol_sms` to the enrolment screen. A `login` / `phone-verify` /
 * phone-change challenge is in none of them — those prove possession of a number
 * for a *different* transaction. Nothing may spend "whichever second-factor
 * purpose happens to be live", so this list is never handed to `verifySmsOtp`
 * as a fallback; see `VerifyCommon.smsPurposes`.
 */
export const SECOND_FACTOR_PURPOSES: readonly OtpPurpose[] = [
  "mfa_login",
  "step_up_sms",
  "mfa_enrol_sms",
];

export type MfaVerificationOutcome = "totp" | "sms_otp" | "recovery_code" | "rejected";

export interface MfaVerificationDetail {
  outcome: MfaVerificationOutcome;
  /** True when this verification is what activated a pending enrolment. */
  wasUnconfirmed: boolean;
  recoveryCodes: string[];
}

/**
 * Verify a TOTP code against the stored encrypted secret for `subject`.
 *
 * `epochTolerance: 30` accepts the current 30-second step and the one on
 * either side (±1 step), per the Phase 24 spec.
 */
async function verifyTotp(subjectRealm: MfaSubjectRealm, subjectId: string, code: string): Promise<boolean> {
  const digits = normalizeOtpCode(code);
  if (!digits) return false;

  /**
   * Issue #854 (P1.11): only a *confirmed* TOTP enrolment is a factor. Without
   * this predicate a half-finished enrolment could be verified here, and the
   * caller's `confirmMfaEnrolment` would then activate it — which is exactly
   * the side effect a step-up must not have.
   *
   * `allowPendingConfirm` re-admits the unconfirmed row for the enrolment
   * confirmation path, which is the one caller allowed to activate it.
   */
  const { rows } = await query<{ totp_secret: Buffer | null; confirmed_at: Date | null }>(
    `SELECT totp_secret, confirmed_at FROM mfa_enrolments
      WHERE subject_realm = $1 AND subject_id = $2 AND method = 'totp'`,
    [subjectRealm, subjectId],
  );
  const enrolment = rows[0];
  if (!enrolment?.totp_secret) return false;

  const secret = await decryptTotpSecret(enrolment.totp_secret);
  if (!secret) return false;

  try {
    const result = await totp.verify(digits, { secret, epochTolerance: 30 });
    return result.valid;
  } catch {
    return false;
  }
}

/** Same as `verifyTotp` but refuses an enrolment that has not been confirmed. */
async function verifyConfirmedTotp(
  subjectRealm: MfaSubjectRealm,
  subjectId: string,
  code: string,
): Promise<boolean> {
  const { rows } = await query<{ confirmed_at: Date | null }>(
    `SELECT confirmed_at FROM mfa_enrolments
      WHERE subject_realm = $1 AND subject_id = $2 AND method = 'totp'`,
    [subjectRealm, subjectId],
  );
  if (!rows[0] || rows[0].confirmed_at === null) return false;
  return verifyTotp(subjectRealm, subjectId, code);
}

/**
 * Verify an SMS OTP against a live challenge row, atomically.
 *
 * Issue #854 (P1.17): this used to be `SELECT` → compare → `DELETE`, with the
 * attempt counter incremented in a separate statement. Two concurrent verifies
 * could both read the same live row and both be told "yes", and two racing
 * wrong guesses could each observe `attempts = 4` and push the counter past its
 * ceiling. Both now ride `redeemOtpChallenge`, whose whole job is that one
 * request — and only one — can transition a challenge to consumed.
 *
 * `purpose` narrows which challenge may be spent. `expectedPhoneE164` binds the
 * verification to a number when the caller knows which one it is about (#854
 * P0.8).
 */
async function verifySmsOtp(
  subjectRealm: MfaSubjectRealm,
  subjectId: string,
  code: string,
  options: { purpose?: OtpPurpose; expectedPhoneE164?: string | null; allowedPurposes?: readonly OtpPurpose[] } = {},
): Promise<boolean> {
  const digits = normalizeOtpCode(code);
  if (!digits) return false;

  const purposes = options.purpose ? [options.purpose] : (options.allowedPurposes ?? []);

  // The challenge table has one purpose per row, and the caller is asking
  // "which of these purposes is live right now?". Tried newest-first across the
  // allowed set; each attempt is its own locked transaction, so a wrong purpose
  // cannot burn another purpose's attempts.
  for (const purpose of purposes) {
    const result = await redeemOtpChallenge({
      subjectRealm,
      subjectId,
      purpose,
      code: digits,
      expectedPhoneE164: options.expectedPhoneE164,
    });
    if (result.ok) return true;
    // A challenge exists for this purpose but the guess was wrong: burn the
    // attempt (already done inside redeem) and stop — trying the next purpose
    // would give an attacker several purposes' worth of guesses for one code.
    if (result.reason === "wrong_code" || result.reason === "attempts_exhausted") {
      return false;
    }
    if (result.reason === "wrong_phone") return false;
  }
  return false;
}

/**
 * The two halves of the old `verifyAndConfirmMfaCode`, plus the union the login
 * interstitial needs.
 */
interface VerifyCommon {
  /**
   * Issue #854 (invariant 12) — the audit descriptor for a *confirmation*.
   *
   * Only the enrolment ceremony has anything to record (it is the call that
   * activates a factor), so only its two confirmation paths forward this; the
   * strict path ignores it, because proving an existing factor changes nothing.
   */
  audit?: SecurityAuditAttribution;
  auditRealm?: "tenant" | "platform";
  subjectRealm: MfaSubjectRealm;
  subjectId: string;
  method: "totp" | "sms_otp" | null;
  code: string;
  useRecoveryCode?: boolean;
  /** SMS challenge binding — see `verifySmsOtp`. */
  expectedPhoneE164?: string | null;
  /**
   * Issue #854 (invariant 4) — which SMS challenge purposes this call may spend.
   *
   * A challenge is minted for exactly one purpose and may only be redeemed for
   * that purpose. The two ceremonies that consume SMS as a second factor are
   * not interchangeable: a code the member asked for to *sign in* must not be
   * spendable as a *step-up* proof, and vice versa. Sharing one default set
   * meant either ceremony would happily spend the other's challenge — the same
   * number, the same account, but a different human intent and a different
   * window of trust.
   *
   * Callers must state it. Defaulting it to `null` (nothing allowed) rather
   * than to the permissive union is deliberate: a new caller that forgets the
   * field fails closed, and the failure is a test away instead of a silent
   * widening of what a code is good for.
   */
  smsPurposes?: readonly OtpPurpose[];
}

/**
 * Prove an **already-confirmed** factor. Never activates a pending enrolment.
 *
 * This is the primitive step-up / recent-auth must use (#854 P1.11). A recovery
 * code is accepted because it is itself a confirmed credential.
 */
export async function verifyExistingConfirmedMfaFactor(
  params: VerifyCommon,
): Promise<MfaVerificationDetail> {
  const { subjectRealm, subjectId, method, code, useRecoveryCode } = params;
  if (!code || typeof code !== "string") {
    return { outcome: "rejected", wasUnconfirmed: false, recoveryCodes: [] };
  }

  return withoutTenantScope("platform", async () => {
    if (useRecoveryCode) {
      const ok = await consumeRecoveryCode(subjectRealm, subjectId, code);
      return {
        outcome: ok ? "recovery_code" : "rejected",
        wasUnconfirmed: false,
        recoveryCodes: [],
      };
    }
    if (method === "totp") {
      const ok = await verifyConfirmedTotp(subjectRealm, subjectId, code);
      return {
        outcome: ok ? "totp" : "rejected",
        wasUnconfirmed: false,
        recoveryCodes: [],
      };
    }
    if (method === "sms_otp") {
      /**
       * Issue #854 — the SMS half of "existing confirmed factor" was missing.
       *
       * The TOTP branch above asks the database whether the row is confirmed;
       * this branch asked nothing, so any live `sms_otp` challenge was accepted
       * for any live `sms_otp` row. `issueSmsMfaChallenge` would happily mint a
       * `step_up_sms` code against an **interactive pending** enrolment — one
       * the member had started and never proven — and this function would
       * redeem it, which turned "prove an existing factor" into "prove a factor
       * you are in the middle of inventing".
       *
       * Two bindings, both required:
       *
       *  1. The account must have a live SMS factor (`isActiveMfaEnrolment`:
       *     confirmed, or the owner-activation bootstrap row). No live factor,
       *     no SMS step-up — regardless of what challenge rows exist.
       *  2. The code must have gone to *that* factor's number. This is what
       *     invalidates challenges in flight when the factor is deleted or
       *     moved: the code is bound to the phone as it stands at redemption,
       *     so a number replaced in between no longer matches.
       *
       * `expectedPhoneE164` still wins when a caller names an explicit
       * destination (the enrolment ceremony's staged number); the factor check
       * is skipped there because that call is the one that creates the factor.
       */
      const expectedPhone = params.expectedPhoneE164 ?? (await activeSmsFactorPhoneFor(subjectRealm, subjectId));
      if (!expectedPhone) {
        return { outcome: "rejected", wasUnconfirmed: false, recoveryCodes: [] };
      }
      const ok = await verifySmsOtp(subjectRealm, subjectId, code, {
        allowedPurposes: params.smsPurposes ?? [],
        expectedPhoneE164: expectedPhone,
      });
      return {
        outcome: ok ? "sms_otp" : "rejected",
        wasUnconfirmed: false,
        recoveryCodes: [],
      };
    }
    return { outcome: "rejected", wasUnconfirmed: false, recoveryCodes: [] };
  });
}

/**
 * The number of the account's live SMS factor (#854), read at redemption time.
 *
 * Deliberately a fresh read rather than a value carried from issuance: the
 * factor can be deleted or replaced between the two, and the whole point is that
 * the answer changes with it.
 */
async function activeSmsFactorPhoneFor(
  subjectRealm: MfaSubjectRealm,
  subjectId: string,
): Promise<string | null> {
  const enrolments = await getAccountMfaEnrolments(subjectRealm, subjectId);
  return activeSmsFactorPhone(enrolments);
}

/**
 * Prove a code **and** activate the matching pending enrolment.
 *
 * Only the enrolment-confirmation surface may use this; it is named for that
 * side effect so no caller can reach for it by accident.
 */
export async function verifyAndConfirmPendingMfaEnrolment(
  params: VerifyCommon,
): Promise<MfaVerificationDetail> {
  const { subjectRealm, subjectId, method, code, useRecoveryCode } = params;
  if (!code || typeof code !== "string") {
    return { outcome: "rejected", wasUnconfirmed: false, recoveryCodes: [] };
  }

  return withoutTenantScope("platform", async () => {
    if (useRecoveryCode) {
      const ok = await consumeRecoveryCode(subjectRealm, subjectId, code);
      return {
        outcome: ok ? "recovery_code" : "rejected",
        wasUnconfirmed: false,
        recoveryCodes: [],
      };
    }
    if (method === "totp") {
      const ok = await verifyTotp(subjectRealm, subjectId, code);
      if (!ok) return { outcome: "rejected", wasUnconfirmed: false, recoveryCodes: [] };
      const confirmation = await confirmMfaEnrolment(subjectRealm, subjectId, "totp", {
        audit: params.audit,
        auditRealm: params.auditRealm,
      });
      return {
        outcome: "totp",
        wasUnconfirmed: confirmation.wasUnconfirmed,
        recoveryCodes: confirmation.recoveryCodes,
      };
    }
    if (method === "sms_otp") {
      /*
       * The enrolment ceremony spends `mfa_enrol_sms` first and, when the
       * account is mid-enrolment and has nothing else (the login interstitial's
       * case — see `mayConfirmPendingEnrolmentAtLogin`), a `mfa_login` challenge
       * the member asked for while signing in. Step-up is never accepted here.
       */
      const ok = await verifySmsOtp(subjectRealm, subjectId, code, {
        // The enrolment screen mints `mfa_enrol_sms`; the login interstitial's
        // mid-enrolment branch mints `mfa_login` and states it explicitly.
        allowedPurposes: params.smsPurposes ?? ["mfa_enrol_sms"],
        expectedPhoneE164: params.expectedPhoneE164,
      });
      if (!ok) return { outcome: "rejected", wasUnconfirmed: false, recoveryCodes: [] };
      const confirmation = await confirmMfaEnrolment(subjectRealm, subjectId, "sms_otp", {
        audit: params.audit,
        auditRealm: params.auditRealm,
        /**
         * Issue #854 (P2.21): the challenge the code just redeemed was bound
         * to this number — if the factor was already confirmed on another
         * one, this is a replacement and the swap happens inside the
         * confirmation's own lock.
         */
        provenPhoneE164: params.expectedPhoneE164 ?? null,
      });
      return {
        outcome: "sms_otp",
        wasUnconfirmed: confirmation.wasUnconfirmed,
        recoveryCodes: confirmation.recoveryCodes,
      };
    }
    return { outcome: "rejected", wasUnconfirmed: false, recoveryCodes: [] };
  });
}

/**
 * The login interstitial's entry point: confirm a pending enrolment when the
 * pending token says the account is mid-enrolment, otherwise just prove an
 * existing factor. Kept for the callers that legitimately face both cases.
 */
export async function verifyAndConfirmMfaCode(
  params: VerifyCommon & { confirmPendingEnrolment?: boolean },
): Promise<MfaVerificationDetail> {
  if (params.confirmPendingEnrolment) {
    return verifyAndConfirmPendingMfaEnrolment(params);
  }
  return verifyExistingConfirmedMfaFactor(params);
}
