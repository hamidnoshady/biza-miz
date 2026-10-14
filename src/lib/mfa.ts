/**
 * Phase 24 Wave 2 — the pure part of the two-factor rule.
 *
 * Runtime-import-free apart from `./roles` (itself import-free), so it can be
 * unit-tested directly and reused by both auth realms: `enrolmentRequirement`
 * answers "does this account have to do something about 2FA right now", and
 * nothing else. Everything that touches the database lives in `mfa-service.ts`.
 */
import { PASSWORD_ROLES } from "./roles";

export type MfaMethod = "totp" | "sms_otp";
export type PrimaryAuthMethod = "password" | "phone_otp";
export type MfaRequirement = "not_required" | "grace" | "required";
export type EnrolmentRequirement = MfaRequirement;

export interface AccountMfaState {
  hasPrimary: boolean;
  graceUntil: Date | string | null;
  role: string;
  hasGraceRecord: boolean;
}

export interface MfaEnrolmentLike {
  id?: string;
  method: MfaMethod;
  is_primary?: boolean;
  isPrimary?: boolean;
  confirmed_at?: Date | string | null;
  confirmedAt?: Date | string | null;
  created_at?: Date | string;
  createdAt?: Date | string;
}

/**
 * Grace window lengths, in days.
 *
 * Platform admins get half of what a business Owner does: a small, known set
 * of people holding the most power on the platform, so the window that exists
 * to stop a deploy locking everyone out at once does not need to be long.
 */
export const MFA_GRACE_DAYS_TENANT = 14;
export const MFA_GRACE_DAYS_PLATFORM = 7;

export function enrolmentRequirement(state: AccountMfaState, now: Date = new Date()): MfaRequirement {
  if (state.hasPrimary) {
    return "not_required";
  }

  // Not enrolled. Do they require it?
  // We check if they have grace.
  if (state.hasGraceRecord) {
    const until = state.graceUntil ? new Date(state.graceUntil) : null;
    if (until && !Number.isNaN(until.getTime()) && until.getTime() > now.getTime()) {
      return "grace";
    }
    return "required";
  }

  return "grace";
}

/**
 * Whole days left of a grace window, rounded up and floored at zero.
 *
 * Rounded *up* because the nag reads «۳ روز باقی مانده» and a window that
 * expires in eleven hours must not read «۰ روز» while login still works — the
 * countdown is a warning, and understating it is the failure that matters.
 * Returns null when there is no window to count (already enrolled, or the
 * grace record has not been stamped yet).
 */
export function graceDaysRemaining(
  graceUntil: Date | string | null,
  now: Date = new Date(),
): number | null {
  if (!graceUntil) return null;
  const until = new Date(graceUntil);
  const ms = until.getTime() - now.getTime();
  if (Number.isNaN(ms)) return null;
  return Math.max(0, Math.ceil(ms / 86_400_000));
}

/**
 * Roles that sign in with a password and administer the business.
 *
 * Issue #854 (P1.1): `admin` was missing from the MFA requirement entirely.
 * The role model calls a tenant admin a high-authority tenant administrator —
 * it holds the business-management keys an owner holds, minus the two that are
 * owner-only — yet the requirement logic only ever named `owner` and,
 * optionally, `manager`. An admin could therefore hold `team.manage`,
 * `settings.manage` and the whole ledger with a password alone, which is the
 * exact account the second factor exists for.
 *
 * `accountant` is included in the privileged *set* (it is a password role that
 * reaches the ledger, and the issue asks that it be "supported fully") but is
 * not mandatory by default — see `privilegedMfaBaseline`.
 */
export const PRIVILEGED_MFA_ROLES: readonly string[] = PASSWORD_ROLES;

/** Privileged roles whose second factor is not negotiable per business. */
export const MANDATORY_MFA_ROLES: readonly string[] = ["owner", "admin"];

export function isPrivilegedMfaRole(role: string): boolean {
  return PRIVILEGED_MFA_ROLES.includes(role);
}

/**
 * The baseline requirement for a privileged role, before the business's own
 * policy is consulted.
 *
 *  - `owner`, `admin` — mandatory. Not a setting; the whole point of the rule.
 *  - `manager` — the documented opt-in (`requireForManagers`), off by default,
 *    because on a small café the manager role is worn by whoever is on shift
 *    and a hard 2FA gate there would stop service.
 *  - `accountant` — configurable, off by default, and fully supported when on.
 *    An external accountant is frequently a contractor with no company phone,
 *    so forcing a factor on day one is a support ticket; the business can
 *    require it.
 *
 * Every other role (cashier, waiter, kitchen) signs in by PIN on a shared till
 * and is out of scope for the password policy — they are covered by the phone
 * verification door instead, not by a TOTP app.
 */
export function privilegedMfaBaseline(
  role: string,
  policy: { requireForManagers?: boolean; requireForAccountants?: boolean } = {},
): boolean {
  if (MANDATORY_MFA_ROLES.includes(role)) return true;
  if (role === "manager") return policy.requireForManagers === true;
  if (role === "accountant") return policy.requireForAccountants === true;
  return false;
}

/**
 * Whether a business role has to carry a second factor.
 *
 * Kept as the one predicate every login path calls, now delegating to
 * `privilegedMfaBaseline` so the role vocabulary lives in one place. Issue #854
 * P0.6: the PIN door and the phone-OTP door both call *this*, which is what
 * makes "MFA policy applies consistently across password, phone OTP, PIN,
 * biometric, invitation, Hybrid and Local login paths" true rather than
 * aspirational.
 *
 * Issue #854 (P1.1) — it takes the **whole policy**, not one boolean.
 *
 * It used to be `mfaAppliesToRole(role, extendToManager)`, and every one of the
 * seven login doors therefore passed `policy.requireForManagers` and dropped
 * `requireForAccountants` on the floor. The accountant switch existed, was
 * audited, was rendered — and had no effect on whether an accountant could
 * actually sign in without a factor. A boolean parameter cannot carry a second
 * knob, so the parameter is the policy object and a new knob cannot be added
 * without every caller seeing it.
 */
export function mfaAppliesToRole(
  role: string,
  policy: { requireForManagers?: boolean; requireForAccountants?: boolean } = {},
): boolean {
  return privilegedMfaBaseline(role, policy);
}

/**
 * Whether an enrolment record has completed proof-of-possession confirmation.
 */
export function isMfaEnrolmentConfirmed(enrolment: MfaEnrolmentLike): boolean {
  const confirmed =
    enrolment.confirmed_at !== undefined ? enrolment.confirmed_at : enrolment.confirmedAt;
  return confirmed !== null && confirmed !== undefined;
}

function isPrimaryFlag(enrolment: MfaEnrolmentLike): boolean {
  return Boolean(enrolment.is_primary ?? enrolment.isPrimary);
}

/**
 * Whether an enrolment row is a live **factor** for its account.
 *
 * Issue #854 — one definition, because two doors were disagreeing about it. The
 * SMS branch of the strict verifier accepted any challenge it could find, and
 * the challenge issuer handed out codes against *any* `sms_otp` row, so an
 * interactive pending enrolment — one the member had started and not proven —
 * could receive and redeem a step-up code. Meanwhile the enrolment ceremony
 * needs the opposite answer for the row it is activating, and the selection
 * helpers upstream want only the proven ones. Every one of those questions is
 * this predicate or its negation.
 *
 * Two ways to be active:
 *
 *  - `confirmed_at` is set: the member proved possession of the factor.
 *  - It is the **owner-activation bootstrap** SMS factor: created
 *    `is_primary = true` at business creation, from the number the owner gave
 *    when the business was made, before their first login has had a chance to
 *    confirm it. That row is the business's only second factor at that moment,
 *    so refusing it would lock a brand-new owner out of their own step-up.
 *
 * An *interactive* pending enrolment is `is_primary = false` with no
 * confirmation, and is deliberately neither: it is a setup in progress.
 */
export function isActiveMfaEnrolment(enrolment: MfaEnrolmentLike): boolean {
  if (isMfaEnrolmentConfirmed(enrolment)) return true;
  return enrolment.method === "sms_otp" && isPrimaryFlag(enrolment);
}

/**
 * The phone of the account's live SMS factor, or null when it has none.
 *
 * Used to bind an SMS challenge to the factor that is actually protecting the
 * account (#854): the code must have gone to *this* number, and the factor must
 * still be live when the code comes back. Deleting the factor or moving it to a
 * different number therefore invalidates challenges already in flight, because
 * the answer to this question changes under them.
 */
export function activeSmsFactorPhone<T extends MfaEnrolmentLike & { phone_e164?: string | null }>(
  enrolments: readonly T[],
): string | null {
  const sms = enrolments.find(
    (e) => e.method === "sms_otp" && isActiveMfaEnrolment(e) && Boolean(e.phone_e164),
  );
  return sms?.phone_e164 ?? null;
}

function methodPriority(method: MfaMethod): number {
  // Deterministic tie-breaker when primary flags match: TOTP ahead of SMS OTP.
  return method === "totp" ? 0 : 1;
}

function createdAtEpoch(enrolment: MfaEnrolmentLike): number {
  const raw = enrolment.created_at ?? enrolment.createdAt;
  if (!raw) return 0;
  const ts = new Date(raw).getTime();
  return Number.isFinite(ts) ? ts : 0;
}

/**
 * Deterministic comparator for MFA enrolments:
 *  1. Confirmed (`confirmed_at IS NOT NULL`) before unconfirmed
 *  2. Explicit `is_primary = true` before `false`
 *  3. Method priority (`totp` before `sms_otp`)
 *  4. Earlier `created_at` first
 *  5. Lexical `id` tie-breaker
 */
export function compareMfaEnrolments<T extends MfaEnrolmentLike>(a: T, b: T): number {
  const aConfirmed = isMfaEnrolmentConfirmed(a) ? 0 : 1;
  const bConfirmed = isMfaEnrolmentConfirmed(b) ? 0 : 1;
  if (aConfirmed !== bConfirmed) return aConfirmed - bConfirmed;

  const aPrimary = isPrimaryFlag(a) ? 0 : 1;
  const bPrimary = isPrimaryFlag(b) ? 0 : 1;
  if (aPrimary !== bPrimary) return aPrimary - bPrimary;

  const aMethod = methodPriority(a.method);
  const bMethod = methodPriority(b.method);
  if (aMethod !== bMethod) return aMethod - bMethod;

  const aCreated = createdAtEpoch(a);
  const bCreated = createdAtEpoch(b);
  if (aCreated !== bCreated) return aCreated - bCreated;

  return String(a.id ?? "").localeCompare(String(b.id ?? ""));
}

/**
 * Returns a deterministically ordered copy of `enrolments`.
 */
export function sortMfaEnrolments<T extends MfaEnrolmentLike>(enrolments: readonly T[]): T[] {
  return [...enrolments].sort(compareMfaEnrolments);
}

/**
 * Canonical primary-factor selector (Issue #809 — Finding 9).
 *
 * Only confirmed enrolments are eligible by default; an unconfirmed factor
 * never overrides a confirmed one. When `allowUnconfirmedFallback` is true and
 * no confirmed factor exists yet, falls back to the first deterministic
 * unconfirmed enrolment.
 */
export function selectPrimaryMfaEnrolment<T extends MfaEnrolmentLike>(
  enrolments: readonly T[],
  options: { allowUnconfirmedFallback?: boolean } = {},
): T | null {
  const confirmed = sortMfaEnrolments(enrolments.filter(isMfaEnrolmentConfirmed));
  if (confirmed.length > 0) return confirmed[0];
  if (options.allowUnconfirmedFallback) {
    const all = sortMfaEnrolments(enrolments);
    return all[0] ?? null;
  }
  return null;
}

/**
 * Whether a *login* may confirm a pending enrolment instead of proving an
 * already-confirmed factor.
 *
 * Issue #854 (P1.11) — two ceremonies, one flag, and the flag was wrong in both
 * directions. The rule this encodes:
 *
 *  - An account with **no confirmed factor** that is mid-enrolment must be able
 *    to finish during login. Otherwise the member who scanned the QR code is
 *    locked out of their own account until an administrator intervenes.
 *  - An account that **has** a confirmed factor must never have a pending row
 *    accepted as its second factor. A half-finished enrolment is not a
 *    credential: the attacker who started an enrolment on a stolen session
 *    would otherwise hold a factor they chose.
 *
 * So the pending path opens only when it is the account's only way in, and the
 * caller cannot ask for it by accident — `verifyAndConfirmMfaCode` still
 * defaults to strict, and this predicate is what a login passes explicitly.
 */
export function mayConfirmPendingEnrolmentAtLogin<T extends MfaEnrolmentLike>(
  enrolments: readonly T[],
  method: MfaMethod | null,
): boolean {
  if (!method) return false;
  if (enrolments.some(isMfaEnrolmentConfirmed)) return false;
  return enrolments.some((e) => e.method === method && !isMfaEnrolmentConfirmed(e));
}

/**
 * Returns the confirmed MFA methods that are distinct from `primaryAuth`.
 *
 * When `primaryAuth === "phone_otp"`, SMS OTP was already used as the primary
 * factor and MUST NOT be accepted as the second factor as well (Issue #809 —
 * Finding 1).
 */
export function distinctSecondFactorMethods<T extends MfaEnrolmentLike>(
  enrolments: readonly T[],
  primaryAuth: PrimaryAuthMethod = "password",
): MfaMethod[] {
  const confirmed = sortMfaEnrolments(enrolments.filter(isMfaEnrolmentConfirmed));
  const methods: MfaMethod[] = [];
  for (const e of confirmed) {
    if (primaryAuth === "phone_otp" && e.method === "sms_otp") continue;
    if (!methods.includes(e.method)) methods.push(e.method);
  }
  return methods;
}

/**
 * Whether an account must complete an MFA step during login.
 *
 * Unlike `enrolmentRequirement` (which reports whether the user still needs to
 * *enrol* a factor), login must challenge MFA whenever:
 *  - the account already has at least one confirmed factor (`hasConfirmedEnrolment`), OR
 *  - MFA applies to the role and the grace window has expired (`requirement === "required"`).
 */
export function shouldChallengeMfaOnLogin(params: {
  hasConfirmedEnrolment: boolean;
  appliesToRole: boolean;
  requirement: MfaRequirement;
}): boolean {
  if (params.hasConfirmedEnrolment) return true;
  if (params.appliesToRole && params.requirement === "required") return true;
  return false;
}
