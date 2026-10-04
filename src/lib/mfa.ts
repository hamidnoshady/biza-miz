/**
 * Phase 24 Wave 2 — the pure part of the two-factor rule.
 *
 * Deliberately free of imports so it can be unit-tested directly and reused by
 * both auth realms: `enrolmentRequirement` answers "does this account have to
 * do something about 2FA right now", and nothing else. Everything that touches
 * the database lives in `mfa-service.ts`.
 */

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
 * Whether a business role has to carry a second factor.
 *
 * `owner` always: it is the full permission set by construction. `manager` is
 * the documented opt-in — a business may extend the requirement to its
 * managers, off by default, because on a small café the manager role is worn
 * by whoever is on shift and a hard 2FA gate there would stop service. Every
 * other role (cashier, waiter, kitchen) signs in by PIN on a shared till and is
 * out of scope for this wave entirely.
 */
export function mfaAppliesToRole(role: string, extendToManager = false): boolean {
  if (role === "owner") return true;
  if (role === "manager") return extendToManager;
  return false;
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
