/**
 * #1386 — the approved login-assurance policy, in one pure place.
 *
 * ## Why this module exists
 *
 * Before #1386 both login doors used `shouldChallengeMfaOnLogin(...)` to decide
 * whether a second factor was due. That rule is correct for the **password**
 * door: a password is one factor, so an enrolled factor (or a mandatory role
 * after the grace window) must be presented too.
 *
 * It is wrong for the **phone-OTP** door. The SMS code *is* the primary
 * credential there, and the owner-approved policy for #1386 says a routine OTP
 * sign-in must not be followed by a second, routine SMS challenge. Because the
 * old rule keyed off "has any confirmed enrolment", an account whose only
 * enrolled factor was SMS was still challenged — with no distinct method left
 * to offer, so the step was either a dead end or a duplicate of the factor that
 * had just been proved.
 *
 * The policy deliberately does **not** weaken stronger factors:
 *
 *  - password + TOTP/WebAuthn stays exactly as it was;
 *  - a privileged role (`owner`/`admin`, or manager/accountant when the
 *    business opts in) still has to complete a **distinct** factor on the OTP
 *    path, and enrolling one when it has none;
 *  - a new/untrusted device still gets a risk-based step-up when the account
 *    holds a stronger factor;
 *  - an explicitly trusted device keeps the existing exemption, and trust is
 *    never minted by a login that was itself exempted.
 *
 * The one intentional change from #854 is that a routine OTP sign-in on an
 * account whose only factor is SMS is not asked for a second SMS code. That
 * code would be the same factor twice, not a second factor.
 *
 * Threat model and the full decision table are in
 * `docs/auth/login-assurance-policy.md`.
 */
import { mfaAppliesToRole, type MfaMethod } from "./mfa";

/** Which credential opened this login. */
export type LoginPrimaryMethod = "password" | "phone_otp";

/** Why an OTP login still has to complete a distinct step. */
export type OtpChallengeReason = "privileged_role" | "untrusted_device" | null;

export interface OtpAssuranceInput {
  /** The membership's role for the business being entered. */
  role: string;
  /** That business's MFA policy (`requireForManagers` / `requireForAccountants`). */
  policy: { requireForManagers?: boolean; requireForAccountants?: boolean };
  /**
   * Confirmed factors that are **distinct** from the OTP just redeemed.
   * `distinctSecondFactorMethods(..., "phone_otp")` produces this list; SMS is
   * excluded by definition because it is the credential that opened the door.
   */
  distinctFactors: readonly MfaMethod[];
  /**
   * Whether *any* confirmed factor exists (including SMS). This is what the
   * pre-#1386 rule used, and the privileged-role arm keeps it: an account that
   * already has an SMS factor is not in its initial grace window, so a
   * mandatory role must complete a distinct factor.
   */
  hasConfirmedEnrolment: boolean;
  /** `enrolmentRequirement(...)` for this identity at this moment. */
  requirement: "not_required" | "grace" | "required";
  /** Whether this browser presented a live, in-scope trusted-device cookie. */
  deviceTrusted: boolean;
}

export interface OtpAssuranceDecision {
  /** Must the ceremony continue to a distinct factor before a session exists? */
  challengeRequired: boolean;
  /**
   * When true, the account has to *enrol* a distinct factor (TOTP) because the
   * role is mandatory but no stronger factor exists. The MFA step renders its
   * enrollment chooser for this case.
   */
  enrolmentRequired: boolean;
  /** `null` when routine OTP is enough. */
  reason: OtpChallengeReason;
}

/**
 * Decide whether a phone-OTP login needs a distinct second step.
 *
 * Order matters:
 *
 *  1. **Trusted device** — the existing explicit exemption. It waives the
 *     *routine* challenge only; every credential was already proved when the
 *     trust was earned, and the caller never re-mints trust from an exempted
 *     login (see `completePhoneLogin`).
 *  2. **Mandatory role** — privileged accounts are not made weaker by choosing
 *     the passwordless door. If they hold TOTP, it is required; if they hold
 *     only SMS, a distinct factor must be enrolled before the session exists.
 *  3. **New/untrusted device with a stronger factor** — risk-based step-up.
 *  4. Otherwise routine OTP is the whole ceremony: never ask for the same SMS
 *     factor twice.
 */
export function decideOtpAssurance(input: OtpAssuranceInput): OtpAssuranceDecision {
  if (input.deviceTrusted) {
    return { challengeRequired: false, enrolmentRequired: false, reason: null };
  }

  if (mfaAppliesToRole(input.role, input.policy)) {
    /*
     * `hasConfirmedEnrolment` is the pre-#1386 "must challenge" half: a factor
     * already exists, so this account is not in its first-run grace window.
     * `requirement === "required"` is the other half: no factor exists and the
     * grace window has closed. Both mean the privileged account owes a
     * *distinct* factor before a session is minted.
     */
    if (input.hasConfirmedEnrolment || input.requirement === "required") {
      return {
        challengeRequired: true,
        enrolmentRequired: input.distinctFactors.length === 0,
        reason: "privileged_role",
      };
    }
  }

  if (input.distinctFactors.length > 0) {
    return {
      challengeRequired: true,
      enrolmentRequired: false,
      reason: "untrusted_device",
    };
  }

  return { challengeRequired: false, enrolmentRequired: false, reason: null };
}

/**
 * The password door keeps the pre-#1386 rule unchanged.
 *
 * Kept as a named function so a future edit cannot accidentally route the
 * password path through the OTP policy (which would remove mandatory 2FA).
 */
export function decidePasswordAssurance(params: {
  hasConfirmedEnrolment: boolean;
  appliesToRole: boolean;
  requirement: "not_required" | "grace" | "required";
}): boolean {
  if (params.hasConfirmedEnrolment) return true;
  return params.appliesToRole && params.requirement === "required";
}
