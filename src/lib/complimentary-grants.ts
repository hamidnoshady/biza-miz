/**
 * Complimentary app activation grants — the pure domain rules (GitHub #1579 /
 * ESH-226).
 *
 * A Superadmin may offer an app on one of four terms:
 *
 *   standard        — ordinary published tariff and normal paid activation
 *   free_days       — complimentary for a positive number of days
 *   free_indefinite — complimentary until explicitly revoked
 *   not_selectable  — cannot be chosen during signup
 *
 * The policy may be global, scoped to a business type, or scoped to one
 * business. Precedence is deterministic and is written once, here:
 *
 *   business-specific override → business-type policy → global signup default
 *   → ordinary published commercial pricing (no policy row).
 *
 * Technical availability (industry, deployment profile, platform availability)
 * always wins over any commercial grant. Nothing in this module can enable an
 * app the platform will not run, and a grant is never inferred from a missing
 * tariff — absence of a price fails closed exactly as it did before.
 *
 * Framework-free on purpose (no `db`, no `next`): the resolver, the activation
 * path, the settlement engine, the platform API and the tests all import these
 * rules, and money arithmetic stays integer Rial with exact UTC instants.
 */
import type { ServiceKind } from "./service-activation/catalog";

/** The four canonical offer modes. */
export const SIGNUP_POLICY_MODES = [
  "standard",
  "free_days",
  "free_indefinite",
  "not_selectable",
] as const;
export type SignupPolicyMode = (typeof SIGNUP_POLICY_MODES)[number];

export function isSignupPolicyMode(value: unknown): value is SignupPolicyMode {
  return typeof value === "string" && (SIGNUP_POLICY_MODES as readonly string[]).includes(value);
}

export const SIGNUP_POLICY_SCOPES = ["global", "business_type", "business"] as const;
export type SignupPolicyScope = (typeof SIGNUP_POLICY_SCOPES)[number];

export function isSignupPolicyScope(value: unknown): value is SignupPolicyScope {
  return typeof value === "string" && (SIGNUP_POLICY_SCOPES as readonly string[]).includes(value);
}

export const SIGNUP_POLICY_STATUSES = ["draft", "active", "retired"] as const;
export type SignupPolicyStatus = (typeof SIGNUP_POLICY_STATUSES)[number];

export const GRANT_STATUSES = ["pending", "active", "expired", "revoked"] as const;
export type GrantStatus = (typeof GRANT_STATUSES)[number];

export const GRANT_SOURCES = ["signup_policy", "manual"] as const;
export type GrantSource = (typeof GRANT_SOURCES)[number];

/** Upper bound on a configurable duration (ten years), mirroring retention. */
export const MAX_FREE_DAYS = 3650;
export const MIN_FREE_DAYS = 1;

/** A signup offer revision as stored and returned by the console. */
export interface SignupAppPolicy {
  id: string;
  serviceKind: ServiceKind;
  serviceKey: string;
  version: number;
  scope: SignupPolicyScope;
  businessType: string | null;
  businessId: string | null;
  mode: SignupPolicyMode;
  freeDays: number | null;
  waiveSetup: boolean;
  waiveRental: boolean;
  status: SignupPolicyStatus;
  effectiveFrom: string;
  effectiveUntil: string | null;
  reason: string;
  createdAt?: string;
}

/** A tenant-scoped grant. `expiresAt === null` means indefinite. */
export interface ComplimentaryGrant {
  id: string;
  businessId: string;
  serviceKind: ServiceKind;
  serviceKey: string;
  runtimeInstanceId: string;
  policyId: string | null;
  policyVersion: number | null;
  source: GrantSource;
  scope: SignupPolicyScope;
  status: GrantStatus;
  startsAt: string;
  expiresAt: string | null;
  waiveSetup: boolean;
  waiveRental: boolean;
  activationId: string | null;
  revokedAt?: string | null;
}

export class SignupPolicyError extends Error {
  constructor(
    public code:
      | "unknown_mode"
      | "invalid_free_days"
      | "invalid_scope"
      | "scope_target_mismatch"
      | "business_type_required"
      | "business_required"
      | "invalid_effective_window"
      | "unwaivable_mode",
  ) {
    super(code);
  }
}

export interface NormalizedPolicyInput {
  serviceKind: ServiceKind;
  serviceKey: string;
  scope: SignupPolicyScope;
  businessType: string | null;
  businessId: string | null;
  mode: SignupPolicyMode;
  freeDays: number | null;
  waiveSetup: boolean;
  waiveRental: boolean;
  effectiveFrom: string | null;
  effectiveUntil: string | null;
  reason: string;
}

/**
 * Validate a policy write server-side. The API validates too, but this is the
 * single rule set both use, so a direct caller cannot store a shape the
 * database CHECK would only notice later (a zero-day free policy, a business
 * scope with no business, a duration on a non-duration mode).
 */
export function normalizeSignupPolicyInput(input: {
  serviceKind: ServiceKind;
  serviceKey: string;
  scope: SignupPolicyScope;
  businessType?: string | null;
  businessId?: string | null;
  mode: SignupPolicyMode;
  freeDays?: number | null;
  waiveSetup?: boolean | null;
  waiveRental?: boolean | null;
  effectiveFrom?: string | null;
  effectiveUntil?: string | null;
  reason?: string | null;
}): NormalizedPolicyInput {
  const key = String(input.serviceKey ?? "").trim();
  if (!key) throw new SignupPolicyError("invalid_scope");
  if (!isSignupPolicyMode(input.mode)) throw new SignupPolicyError("unknown_mode");
  if (!isSignupPolicyScope(input.scope)) throw new SignupPolicyError("invalid_scope");

  const businessType = (input.businessType ?? "").trim() || null;
  const businessId = (input.businessId ?? "").trim() || null;
  if (input.scope === "global" && (businessType || businessId)) {
    throw new SignupPolicyError("scope_target_mismatch");
  }
  if (input.scope === "business_type" && (!businessType || businessId)) {
    throw new SignupPolicyError("business_type_required");
  }
  if (input.scope === "business" && (!businessId || businessType)) {
    throw new SignupPolicyError("business_required");
  }

  let freeDays: number | null = null;
  if (input.mode === "free_days") {
    const days = Number(input.freeDays);
    // A fractional day is refused rather than silently floored: the operator
    // asked for a duration the grant cannot represent exactly.
    if (
      !Number.isSafeInteger(days) ||
      days < MIN_FREE_DAYS ||
      days > MAX_FREE_DAYS
    ) {
      throw new SignupPolicyError("invalid_free_days");
    }
    freeDays = days;
  } else if (input.freeDays != null) {
    throw new SignupPolicyError("invalid_free_days");
  }

  // A complimentary mode without both waivers would advertise "free" while
  // still charging one of the two charges. Only an explicit partial waiver
  // (setup OR rental) is allowed — never neither.
  const waiveSetup = input.waiveSetup !== false;
  const waiveRental = input.waiveRental !== false;
  if (input.mode === "free_days" || input.mode === "free_indefinite") {
    if (!waiveSetup && !waiveRental) throw new SignupPolicyError("unwaivable_mode");
  }

  const effectiveFrom = input.effectiveFrom ? toInstant(input.effectiveFrom) : null;
  const effectiveUntil = input.effectiveUntil ? toInstant(input.effectiveUntil) : null;
  if (effectiveFrom && effectiveUntil && Date.parse(effectiveUntil) <= Date.parse(effectiveFrom)) {
    throw new SignupPolicyError("invalid_effective_window");
  }

  return {
    serviceKind: input.serviceKind,
    serviceKey: key,
    scope: input.scope,
    businessType,
    businessId,
    mode: input.mode,
    freeDays,
    waiveSetup,
    waiveRental,
    effectiveFrom,
    effectiveUntil,
    reason: String(input.reason ?? "").trim(),
  };
}

function toInstant(value: string): string {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new SignupPolicyError("invalid_effective_window");
  return new Date(ms).toISOString();
}

/** Is the revision in force at this instant? `[effectiveFrom, effectiveUntil)`. */
export function isPolicyInForce(policy: SignupAppPolicy, atIso: string): boolean {
  if (policy.status !== "active") return false;
  const at = Date.parse(atIso);
  const from = Date.parse(policy.effectiveFrom);
  if (!Number.isFinite(at) || !Number.isFinite(from)) return false;
  if (from > at) return false;
  if (policy.effectiveUntil) {
    const until = Date.parse(policy.effectiveUntil);
    if (!Number.isFinite(until) || at >= until) return false;
  }
  return true;
}

/** Does this revision name the target tenant? */
export function policyTargets(
  policy: SignupAppPolicy,
  target: { businessId: string; businessType: string | null },
): boolean {
  if (policy.scope === "global") return true;
  if (policy.scope === "business_type") {
    return Boolean(target.businessType) && policy.businessType === target.businessType;
  }
  return policy.businessId === target.businessId;
}

const SCOPE_RANK: Record<SignupPolicyScope, number> = {
  business: 3,
  business_type: 2,
  global: 1,
};

/**
 * The effective policy for one (business, service) at an instant, or null when
 * ordinary commercial pricing applies.
 *
 * Precedence is scope rank first — so a business override always beats a
 * type-wide policy even if the latter is newer — then the newest applicable
 * revision. `not_selectable` and `standard` are real policies too: hitting one
 * at a higher scope must not fall through to a friendlier lower scope.
 */
export function resolveSignupAppPolicy(
  policies: readonly SignupAppPolicy[],
  target: { businessId: string; businessType: string | null; serviceKind: ServiceKind; serviceKey: string; at: string },
): SignupAppPolicy | null {
  const candidates = policies.filter(
    (policy) =>
      policy.serviceKind === target.serviceKind &&
      policy.serviceKey === target.serviceKey &&
      isPolicyInForce(policy, target.at) &&
      policyTargets(policy, target),
  );
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    const rank = SCOPE_RANK[b.scope] - SCOPE_RANK[a.scope];
    if (rank !== 0) return rank;
    if (b.version !== a.version) return b.version - a.version;
    return Date.parse(b.effectiveFrom) - Date.parse(a.effectiveFrom);
  });
  return candidates[0];
}

/** True when the mode grants complimentary access (either duration). */
export function isComplimentaryMode(mode: SignupPolicyMode): boolean {
  return mode === "free_days" || mode === "free_indefinite";
}

/**
 * The exact expiry instant a grant issued under this policy gets, measured
 * from the successful activation (never from signup, selection or a page view).
 * A 30-day grant starting at 10:00Z ends at 10:00Z on day 30.
 */
export function grantExpiryFor(policy: SignupAppPolicy, startsAtIso: string): string | null {
  if (policy.mode !== "free_days" || policy.freeDays == null) return null;
  const start = Date.parse(startsAtIso);
  if (!Number.isFinite(start)) throw new Error("invalid_instant");
  return new Date(start + policy.freeDays * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * The status a grant has at an instant. Expiry is derived from the window, so
 * a delayed worker or a clock-skewed replica cannot keep coverage alive past
 * its recorded `expires_at`; revocation is an explicit stored fact.
 */
export function grantStatusAt(grant: ComplimentaryGrant, atIso: string): GrantStatus {
  if (grant.status === "revoked") return "revoked";
  const at = Date.parse(atIso);
  const start = Date.parse(grant.startsAt);
  if (!Number.isFinite(at) || !Number.isFinite(start)) return grant.status;
  if (at < start) return "pending";
  if (grant.expiresAt) {
    const end = Date.parse(grant.expiresAt);
    if (!Number.isFinite(end)) return "expired";
    if (at >= end) return "expired";
  }
  return "active";
}

export interface GrantCoverage {
  start: string;
  /** Null for an indefinite grant. */
  end: string | null;
}

/**
 * The coverage interval a grant contributes to the canonical resolver, or null
 * when it is not active at `atIso`. `end === null` is indefinite.
 */
export function grantCoverageAt(grant: ComplimentaryGrant, atIso: string): GrantCoverage | null {
  return grantStatusAt(grant, atIso) === "active"
    ? { start: grant.startsAt, end: grant.expiresAt }
    : null;
}

/** Every active grant's coverage for one identity, without inventing windows. */
export function activeGrantFor(
  grants: readonly ComplimentaryGrant[],
  atIso: string,
): ComplimentaryGrant | null {
  return grants.find((grant) => grantStatusAt(grant, atIso) === "active") ?? null;
}

export interface ComplimentaryQuote {
  /** The published setup amount, retained as reference even when waived. */
  publishedSetupRial: number;
  setupWaivedRial: number;
  netSetupRial: number;
  hourlyRial: number;
  /** Rental is waived for the covered interval, so nothing is reserved. */
  rentalWaived: boolean;
  /** What must be in the wallet before activation: always 0 when fully free. */
  walletDepositRequiredRial: number;
  subscriptionRequired: boolean;
  /** Null when the grant is indefinite. */
  expiresAt: string | null;
  freeDays: number | null;
  additionalCharges: readonly string[];
}

/**
 * The authoritative itemised zero-cost quote for a complimentary activation.
 *
 * It is deliberately a *derived* shape: the caller supplies the published
 * tariff (which may be null) and the concrete grant. A null tariff is only
 * acceptable because an explicit grant authorizes the activation; this
 * function never turns "unpriced" into "free" on its own.
 */
export function quoteComplimentaryActivation(input: {
  publishedSetupRial: number;
  hourlyRial: number;
  grant: Pick<ComplimentaryGrant, "startsAt" | "expiresAt" | "waiveSetup" | "waiveRental">;
  additionalCharges: readonly string[];
}): ComplimentaryQuote {
  const published = Math.max(0, Math.floor(Number(input.publishedSetupRial) || 0));
  const waived = input.grant.waiveSetup ? published : 0;
  const netSetup = published - waived;
  const rentalWaived = input.grant.waiveRental;
  const expiresAt = input.grant.expiresAt;
  const freeDays =
    expiresAt == null
      ? null
      : Math.max(
          0,
          Math.round(
            (Date.parse(expiresAt) - Date.parse(input.grant.startsAt)) / (24 * 60 * 60 * 1000),
          ),
        );
  return {
    publishedSetupRial: published,
    setupWaivedRial: waived,
    netSetupRial: netSetup,
    hourlyRial: Math.max(0, Math.floor(Number(input.hourlyRial) || 0)),
    rentalWaived,
    // Rental is prepaid per hour; a waived first interval needs no deposit.
    walletDepositRequiredRial: rentalWaived ? netSetup : netSetup,
    subscriptionRequired: false,
    expiresAt,
    freeDays,
    additionalCharges: input.additionalCharges,
  };
}

// ---------------------------------------------------------------------------
// Expiry notifications
// ---------------------------------------------------------------------------

/** The thresholds the platform notifies on, in days before expiry. */
export const GRANT_NOTICE_DAYS = [7, 3, 1, 0] as const;
export type GrantNoticeDay = (typeof GRANT_NOTICE_DAYS)[number];

export interface GrantNotice {
  /** Idempotent delivery key: one per grant and threshold, forever. */
  deliveryKey: string;
  thresholdDays: GrantNoticeDay;
  /** The instant the notice should first be deliverable. */
  dueAt: string;
  expiresAt: string;
}

/** The stable delivery key for one grant/threshold pair. */
export function grantNoticeKey(grantId: string, thresholdDays: number): string {
  return `complimentary_grant:${grantId}:expiry_${thresholdDays}d`;
}

/**
 * Which expiry notices are due for a grant at `now`.
 *
 * Only thresholds shorter than the grant's own duration apply: a three-day
 * trial can never receive a seven-day reminder. An indefinite grant has no
 * expiry and therefore no reminders. `alreadySent` is the set of delivery keys
 * the notifier has recorded, which is what makes a retry idempotent.
 */
export function dueGrantNotices(input: {
  grantId: string;
  startsAt: string;
  expiresAt: string | null;
  now: string;
  alreadySent?: ReadonlySet<string>;
}): GrantNotice[] {
  if (!input.expiresAt) return [];
  const start = Date.parse(input.startsAt);
  const end = Date.parse(input.expiresAt);
  const now = Date.parse(input.now);
  if (![start, end, now].every(Number.isFinite) || end <= start) return [];
  const durationDays = (end - start) / (24 * 60 * 60 * 1000);
  const sent = input.alreadySent ?? new Set<string>();
  const notices: GrantNotice[] = [];
  for (const threshold of GRANT_NOTICE_DAYS) {
    // A 3-day grant gets 3/1/0, never 7.
    if (threshold > durationDays) continue;
    const dueAt = end - threshold * 24 * 60 * 60 * 1000;
    if (now < dueAt) continue;
    const deliveryKey = grantNoticeKey(input.grantId, threshold);
    if (sent.has(deliveryKey)) continue;
    notices.push({
      deliveryKey,
      thresholdDays: threshold,
      dueAt: new Date(dueAt).toISOString(),
      expiresAt: new Date(end).toISOString(),
    });
  }
  return notices;
}

/** The precise instant coverage stops, or null for an indefinite grant. */
export function coverageEnd(grant: Pick<ComplimentaryGrant, "startsAt" | "expiresAt">): string | null {
  return grant.expiresAt ?? null;
}

/**
 * Seconds of a settlement segment that a grant covers, exactly.
 *
 * Used by tests and by callers that need the covered part without the
 * prepaid-term helper: `[startsAt, expiresAt)` clipped to the segment, so a
 * segment crossing the expiry instant has its covered tail waived and nothing
 * else. An indefinite grant covers the whole segment.
 */
export function coveredSecondsForGrant(
  grant: Pick<ComplimentaryGrant, "startsAt" | "expiresAt">,
  segment: { start: string; end: string },
): number {
  const segStart = Date.parse(segment.start);
  const segEnd = Date.parse(segment.end);
  const gStart = Date.parse(grant.startsAt);
  const gEnd = grant.expiresAt ? Date.parse(grant.expiresAt) : Number.POSITIVE_INFINITY;
  if (![segStart, segEnd, gStart].every(Number.isFinite) || segEnd <= segStart) return 0;
  const from = Math.max(segStart, gStart);
  const to = Math.min(segEnd, gEnd);
  if (!Number.isFinite(to) || to <= from) return 0;
  return Math.floor((to - from) / 1000);
}

/**
 * Whether a `not_selectable` policy may be bypassed by an explicit manual
 * grant. It may not: selectability is a signup rule, and a manual grant is an
 * authorized per-business decision made through the business's billing page.
 * This helper exists so the two concepts are never conflated.
 */
export function manualGrantAllowedUnder(policy: SignupAppPolicy | null): boolean {
  return policy?.mode !== "not_selectable";
}
