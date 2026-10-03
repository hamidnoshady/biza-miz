/**
 * The central entitlement engine — ONE authoritative answer to «may this
 * business use this capability, and if not, why?»
 *
 * Before this service, five different layers each answered a slice of that
 * question independently (features.ts path gating, app_availability,
 * business_features overrides, billing-plans-service.resolveFeatureAccess and
 * the per-caller limit checks), and no single place could explain a denial.
 * This service composes those layers in a fixed, documented precedence and
 * returns a structured reason with every answer:
 *
 *   1. platform_unavailable  — the app is not available platform-wide
 *                              (app_availability: disabled / coming_soon /
 *                              under_repair), or the feature flag is globally
 *                              off (the rollout / emergency kill switch).
 *   2. subscription_expired   — the business's plan subscription no longer
 *                              carries the plan (expired, or cancelled after
 *                              its paid period ended).
 *   3. not_in_plan           — the plan has no pricing row for the capability
 *                              and no grant exists. (An unpriced feature is
 *                              governed by the feature-flag layer alone —
 *                              historical behaviour this resolver preserves:
 *                              it reports `allowed` with source 'flag'.)
 *   4. addon_required        — the plan prices the capability as a one-off
 *                              add-on the business has not purchased.
 *   5. limit_reached         — an operational limit (branch/member/order) is
 *                              exhausted; overrides raise the ceiling.
 *   6. permission_denied     — the acting user lacks the permission (only
 *                              checked when the caller supplies one).
 *   7. insufficient_credit   — a metered use whose price the wallet cannot
 *                              cover (only for `metered` checks).
 *
 * Feature flags stay exactly what they should be — rollout, beta and
 * emergency-availability switches (§13) — while plan packaging (what a plan
 * includes, what costs extra) is answered by the Billing plan domain above.
 */
import { query } from "./db";
import {
  isSubscriptionCarryingPlan,
  resolveFeaturesAccess,
  type FeatureAccess,
} from "./billing-plans-service";
import { planLimitsFor } from "./plan-limits";
import { declarationFor } from "./billing/catalog/declarations";
import { evaluateBusinessSpend } from "./billing/runtime";

export type DenialReason =
  | "platform_unavailable"
  | "subscription_expired"
  | "not_in_plan"
  | "addon_required"
  | "limit_reached"
  | "permission_denied"
  | "insufficient_credit"
  | "spend_limit_reached";

export type EntitlementSource = "plan" | "addon" | "promo" | "manual" | "flag";

export interface CapabilityResolution {
  capability: string;
  allowed: boolean;
  reason: DenialReason | null;
  source: EntitlementSource | null;
  /** Present for metered capabilities: the per-use price right now (Rial). */
  perUsePriceRial?: number;
  /** Present when denied on a limit: which limit and the numbers. */
  limit?: { key: LimitKey; limit: number | null; current: number };
  /** Spend policy status when evaluated. */
  throttled?: boolean;
  throttleDelayMs?: number;
  warned?: boolean;
  crossedThresholds?: number[];
}

export type LimitKey = "branch_limit" | "member_limit" | "monthly_order_limit";

/** A snapshot of everything the resolver needs, so callers can batch it. */
export interface BusinessEntitlementSnapshot {
  businessId: string;
  planKey: string;
  subscriptionStatus: string | null;
  /** The subscription's current period end (null when no row exists). */
  subscriptionPeriodEnd: string | null;
  subscriptionCancelAtPeriodEnd: boolean;
  subscriptionAutoRenew: boolean;
  subscriptionTrialEndsAt: string | null;
  subscriptionGraceEndsAt: string | null;
  /** The plan's per-feature commercial rows, resolved to effective access. */
  featureAccess: Map<string, FeatureAccess>;
  /** Active capability overrides (business_billing_overrides + business_features). */
  capabilityOverrides: Map<string, boolean>;
  /** Active limit overrides: limit key → value (null = unlimited). */
  limitOverrides: Map<LimitKey, number | null>;
}

const LIMIT_OVERRIDE_TARGETS: Record<LimitKey, string> = {
  branch_limit: "branch_limit",
  member_limit: "member_limit",
  monthly_order_limit: "monthly_order_limit",
};

/**
 * Executor contract, exactly plan-limits.ts's: the default (pool `query`) is
 * correctly tenant-scoped for any call made from within an ordinary request.
 * The one caller that must NOT use the default is the session-less invitation
 * accept path, which flips `app.rls_bypass`/`app.business_id` by hand on its
 * own `PoolClient` — its entitlement reads must run on that same client.
 */
export interface EntitlementExecutor {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
}

/**
 * The single batched read behind every entitlement question for a business.
 * One round trip per source table, no N+1 per capability.
 */
export async function getBusinessEntitlements(
  businessId: string,
  exec: EntitlementExecutor = { query },
): Promise<BusinessEntitlementSnapshot> {
  const [bizRow, overrides, flagOverrides] = await Promise.all([
    exec.query<{
      plan: string;
      status: string | null;
      period_end: string | Date | null;
      cancel_at_period_end: boolean | null;
      auto_renew: boolean | null;
      trial_end: string | Date | null;
      grace_end: string | Date | null;
    }>(
      `SELECT b.plan, s.status, s.current_period_end AS period_end,
              s.cancel_at_period_end, s.auto_renew, s.trial_end, s.grace_end
         FROM businesses b
         LEFT JOIN business_subscriptions s ON s.business_id = b.id
        WHERE b.id = $1`,
      [businessId],
    ),
    exec.query<{ kind: string; target: string; value_int: number | null; value_bool: boolean | null }>(
      `SELECT kind, target, value_int, value_bool
         FROM business_billing_overrides
        WHERE business_id = $1 AND active
          AND (expires_at IS NULL OR expires_at > now())`,
      [businessId],
    ),
    exec.query<{ flag_key: string; enabled: boolean }>(
      `SELECT flag_key, enabled FROM business_features WHERE business_id = $1`,
      [businessId],
    ),
  ]);

  const planKey = bizRow.rows[0]?.plan ?? "free";
  const capabilityOverrides = new Map<string, boolean>();
  const limitOverrides = new Map<LimitKey, number | null>();
  for (const row of overrides.rows) {
    if (row.kind === "capability" && row.value_bool != null) {
      capabilityOverrides.set(row.target, row.value_bool);
    } else if (row.kind === "limit") {
      const key = row.target as LimitKey;
      if (key in LIMIT_OVERRIDE_TARGETS) limitOverrides.set(key, row.value_int);
    }
  }
  // The legacy per-business feature-flag overrides remain the rollout-layer
  // exception list; they ride along so the resolver sees one merged view.
  for (const row of flagOverrides.rows) {
    capabilityOverrides.set(row.flag_key, row.enabled);
  }

  // Resolve the plan's commercial rows in one batched call, on the same
  // executor the rest of this snapshot used.
  const { rows: planFeatureKeys } = await exec.query<{ feature_key: string }>(
    `SELECT feature_key FROM billing_plan_features WHERE plan_key = $1`,
    [planKey],
  );
  const access = await resolveFeaturesAccess(
    businessId,
    planFeatureKeys.map((r) => r.feature_key),
    new Date(),
    exec,
  );

  const toIso = (val: string | Date | null | undefined) =>
    val == null ? null : val instanceof Date ? val.toISOString() : new Date(val).toISOString();

  return {
    businessId,
    planKey,
    subscriptionStatus: bizRow.rows[0]?.status ?? null,
    subscriptionPeriodEnd: toIso(bizRow.rows[0]?.period_end),
    subscriptionCancelAtPeriodEnd: Boolean(bizRow.rows[0]?.cancel_at_period_end),
    subscriptionAutoRenew: bizRow.rows[0]?.auto_renew !== false,
    subscriptionTrialEndsAt: toIso(bizRow.rows[0]?.trial_end),
    subscriptionGraceEndsAt: toIso(bizRow.rows[0]?.grace_end),
    featureAccess: new Map(access.map((a) => [a.featureKey, a])),
    capabilityOverrides,
    limitOverrides,
  };
}

/**
 * Is the subscription still carrying the business's plan?
 * Delegates to the single canonical lifecycle rule in billing-plans-service.ts.
 */
function subscriptionCarrying(
  snapshot: BusinessEntitlementSnapshot,
  now: Date,
): boolean {
  if (snapshot.subscriptionStatus == null) return true;
  return isSubscriptionCarryingPlan(
    {
      status: snapshot.subscriptionStatus,
      currentPeriodEnd: snapshot.subscriptionPeriodEnd,
      cancelAtPeriodEnd: snapshot.subscriptionCancelAtPeriodEnd,
      autoRenew: snapshot.subscriptionAutoRenew,
      trialEnd: snapshot.subscriptionTrialEndsAt,
      graceEnd: snapshot.subscriptionGraceEndsAt,
    },
    now.toISOString(),
  );
}

/**
 * Resolve one capability for a business. `permissions` (when supplied) is the
 * acting user's permission set — the resolver reports permission_denied
 * rather than leaving each route to re-derive the whole answer.
 */
export async function resolveBusinessCapability(
  businessId: string,
  capabilityKey: string,
  opts: { permissions?: readonly string[]; walletCheck?: boolean } = {},
): Promise<CapabilityResolution> {
  const now = new Date();
  const snapshot = await getBusinessEntitlements(businessId);

  // 1 — platform availability. The four apps' platform-wide state first: a
  //     disabled app is unavailable to every business regardless of plan.
  const appKey = appForCapability(capabilityKey);
  if (appKey) {
    const { rows } = await query<{ state: string }>(
      `SELECT state FROM app_availability WHERE app_key = $1`,
      [appKey],
    );
    const state = rows[0]?.state;
    if (state && state !== "enabled" && state !== "beta") {
      return deny(capabilityKey, "platform_unavailable");
    }
  }

  // 2 — global rollout / emergency kill switch (feature_flags default).
  //     A flag that is globally off makes the capability unavailable to every
  //     business; a business-level override (the rollout exception list)
  //     may re-enable it.
  const { rows: flagRow } = await query<{ default_enabled: boolean }>(
    `SELECT default_enabled FROM feature_flags WHERE key = $1`,
    [capabilityKey],
  );
  if (flagRow[0] && !flagRow[0].default_enabled) {
    const override = snapshot.capabilityOverrides.get(capabilityKey);
    if (override !== true) return deny(capabilityKey, "platform_unavailable");
  }
  // A business-level override can also switch a capability off explicitly.
  if (snapshot.capabilityOverrides.get(capabilityKey) === false) {
    return deny(capabilityKey, "platform_unavailable");
  }

  // 3 — the commercial layer (plan / addon / promo / manual grant).
  const access = snapshot.featureAccess.get(capabilityKey);
  // 3a — subscription state (§19): an included/monthly plan feature reads
  //      entitled:false precisely when the subscription stopped carrying the
  //      business (resolveFeatureAccess's planEffective). Deny it with the
  //      honest reason instead of falling through to addon_required. Owned
  //      add-ons, promos/manual grants, pay-as-you-go metered use and
  //      unpriced (flag-governed) features all survive the lapse.
  if (
    access &&
    !access.entitled &&
    access.source === "plan" &&
    !access.metered &&
    !subscriptionCarrying(snapshot, now)
  ) {
    return deny(capabilityKey, "subscription_expired");
  }
  if (access) {
    if (access.metered) {
      // Pay-as-you-go is reachable even when the subscription lapsed
      // (entitled:false) — use is paid per use, not rented per period. But
      // guarded call sites must not let a use start the wallet can't pay for,
      // whichever branch reached here.
      if (opts.walletCheck && access.perUsePriceRial > 0) {
        const { getWalletBalanceRial } = await import("./wallet-service");
        const balance = await getWalletBalanceRial(businessId);
        if (balance < access.perUsePriceRial) {
          return {
            capability: capabilityKey,
            allowed: false,
            reason: "insufficient_credit",
            source: access.source,
            perUsePriceRial: access.perUsePriceRial,
          };
        }
      }
      return finishAllowed(allowMetered(capabilityKey, access), businessId, opts.permissions);
    }
    if (!access.entitled) {
      // An addon row without purchase is addon_required.
      return deny(capabilityKey, "addon_required");
    }
    return finishAllowed(
      {
        capability: capabilityKey,
        allowed: true,
        reason: null,
        source: access.source ?? "plan",
      },
      businessId,
      opts.permissions,
    );
  }

  const declaration = declarationFor(capabilityKey);
  // A declared capability with no commercial row is not implicitly free.
  // Keys outside the registry keep the historical flag-governed answer.
  if (declaration && declaration.mode !== "exempt") {
    return deny(capabilityKey, "not_in_plan");
  }
  return { capability: capabilityKey, allowed: true, reason: null, source: "flag" };
}

async function finishAllowed(
  resolution: CapabilityResolution,
  businessId: string,
  permissions?: readonly string[],
): Promise<CapabilityResolution> {
  if (!resolution.allowed) return resolution;
  const declaration = declarationFor(resolution.capability);
  if (declaration?.mode === "exempt") return resolution;
  if (
    declaration &&
    "requiredPermission" in declaration &&
    declaration.requiredPermission &&
    permissions &&
    !permissions.includes(declaration.requiredPermission)
  ) {
    return deny(resolution.capability, "permission_denied");
  }
  const critical = declaration ? declaration.critical : false;
  const spendResult = await evaluateBusinessSpend(businessId, { critical });
  if (spendResult.evaluation.blocked) {
    return {
      ...deny(resolution.capability, "spend_limit_reached"),
      throttled: false,
      warned: spendResult.evaluation.warned,
      crossedThresholds: spendResult.evaluation.crossedThresholds,
    };
  }
  if (spendResult.policy) {
    return {
      ...resolution,
      throttled: spendResult.evaluation.throttled,
      throttleDelayMs: spendResult.evaluation.throttled ? 2000 : 0,
      warned: spendResult.evaluation.warned,
      crossedThresholds: spendResult.evaluation.crossedThresholds,
    };
  }
  return resolution;
}

function deny(capability: string, reason: DenialReason): CapabilityResolution {
  return { capability, allowed: false, reason, source: null };
}

function allowMetered(capability: string, access: FeatureAccess): CapabilityResolution {
  return {
    capability,
    allowed: true,
    reason: null,
    source: access.source ?? "plan",
    perUsePriceRial: access.perUsePriceRial,
  };
}

/** Which of the four apps a capability key belongs to, if any. */
function appForCapability(capabilityKey: string): string | null {
  // The capability registry's plan-capability keys name their app directly
  // (app.accounting / app.crm / app.growth / app.website); feature-flag keys
  // that are owned by an app map through the module registry is overkill
  // here — the four app.* keys plus the growth messaging flag cover the
  // platform-availability axis this resolver checks.
  if (capabilityKey.startsWith("app.")) return capabilityKey.slice(4);
  if (capabilityKey === "cloud.messaging") return "growth";
  return null;
}

// ---------------------------------------------------------------------------
// Operational limits, with overrides
// ---------------------------------------------------------------------------

export interface LimitResolution {
  key: LimitKey;
  limit: number | null; // null = unlimited
  current: number;
  /** The override applied, when one is active for this business. */
  overriddenBy: string | null;
  reached: boolean;
}

/**
 * Resolve one operational limit (branch/member/monthly-order) for a business:
 * the plan's ceiling, raised or lowered by an active override. The plan's own
 * value is what `planLimitsFor` enforced before this service existed; the
 * override layer is the auditable exception path (§25).
 */
export async function resolveBusinessLimit(
  businessId: string,
  key: LimitKey,
  current: number,
  exec?: EntitlementExecutor,
): Promise<LimitResolution> {
  const ceiling = await resolveLimitCeiling(businessId, key, exec);
  return {
    key,
    limit: ceiling.limit,
    current,
    overriddenBy: ceiling.overriddenBy,
    reached: ceiling.limit != null && current >= ceiling.limit,
  };
}

/**
 * The plan's ceiling for one limit with any active business override applied —
 * what the creation paths (branch/member/order) actually enforce. Split from
 * `resolveBusinessLimit` because those paths count inside their own
 * transaction lock and only need the ceiling, not the count.
 */
export async function resolveLimitCeiling(
  businessId: string,
  key: LimitKey,
  exec?: EntitlementExecutor,
): Promise<{ key: LimitKey; limit: number | null; overriddenBy: string | null }> {
  const [snapshot, planLimits] = await Promise.all([
    getBusinessEntitlements(businessId, exec),
    planLimitsFor(businessId, exec),
  ]);
  const planValue =
    key === "branch_limit"
      ? planLimits.branchLimit
      : key === "member_limit"
        ? planLimits.memberLimit
        : planLimits.monthlyOrderLimit;
  const override = snapshot.limitOverrides.get(key);
  return {
    key,
    limit: override !== undefined ? override : planValue,
    overriddenBy: override !== undefined ? "business_billing_overrides" : null,
  };
}
