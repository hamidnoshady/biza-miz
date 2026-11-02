/**
 * Effective feature access — the pure decision rules, in one place.
 *
 * Whether a business may use a capability used to be decided by two code paths
 * that each knew half of the answer: `features.ts` (the request gate) read the
 * rollout flag and the legacy per-business override and nothing else, while
 * `entitlement-service.ts` (the structured resolver) also knew the audited
 * billing override, the plan row, add-on ownership and subscription lapse. A
 * capability override created in the billing console therefore changed what
 * the resolver said and nothing the gate enforced, and a priced add-on nobody
 * had bought was refused by one and served by the other.
 *
 * Both now call the two functions below, so the precedence is written once:
 *
 *   1. app availability     — the app is released and working (own axis,
 *                             `app-availability.ts`; checked before these two)
 *   2. flag layer           — rollout / emergency switch for the capability:
 *                             audited billing override > legacy business
 *                             override > catalogue default
 *   3. commercial layer     — only for a capability the business's plan prices:
 *                             owned add-on / manual grant / promo / plan
 *                             inclusion, and whether the subscription still
 *                             carries the plan
 *
 * A capability the plan does not price is governed by the flag layer alone —
 * billing is opt-in per capability, exactly as `resolveFeatureAccess` has
 * always documented. Limits, permissions and wallet cover stay with the callers
 * that need a count or an actor.
 *
 * Framework-free on purpose (no `db`, no `next`): unit-tested directly, and
 * importable by the console as well as the server.
 */

export type FlagLayerSource =
  | "billing_override"
  | "business_override"
  | "catalogue_default"
  | "unregistered";

export interface FlagLayerInput {
  /** `feature_flags.default_enabled`; `null` when the key has no catalogue row. */
  catalogueDefault: boolean | null;
  /** `business_features.enabled` — the legacy rollout exception list. */
  businessOverride: boolean | null;
  /**
   * `business_billing_overrides` (kind = 'capability', active, unexpired) —
   * the audited super-admin exception. It carries a reason, an author and an
   * optional expiry, so it outranks the unaudited legacy row when both name
   * the same capability.
   */
  billingOverride: boolean | null;
}

export interface FlagLayerResult {
  enabled: boolean;
  source: FlagLayerSource;
}

/**
 * Whether the rollout layer lets the capability through.
 *
 * A key with no catalogue row is not gated here (`unregistered`, enabled): the
 * flag prefixes in `features.ts` are expected to name real flags, so this only
 * matters if that mapping has a typo — not a business's entitlement to lose.
 * An explicit override of either kind wins over the catalogue default in both
 * directions: it can re-enable a globally-off flag (the rollout exception) and
 * it can switch a default-on one off.
 */
export function resolveFlagLayer(input: FlagLayerInput): FlagLayerResult {
  if (input.billingOverride != null) {
    return { enabled: input.billingOverride, source: "billing_override" };
  }
  if (input.businessOverride != null) {
    return { enabled: input.businessOverride, source: "business_override" };
  }
  if (input.catalogueDefault == null) {
    return { enabled: true, source: "unregistered" };
  }
  return { enabled: input.catalogueDefault, source: "catalogue_default" };
}

export type CommercialDenial = "subscription_expired" | "addon_required";

export interface CommercialAccessInput {
  /** The plan row's resolved access. `null` = the plan does not price this capability. */
  access: {
    entitled: boolean;
    metered: boolean;
    source: "plan" | "addon" | "promo" | "manual" | null;
  } | null;
  /**
   * Whether the subscription still carries the plan. Only used to name the
   * denial: callers that have not read the subscription (the request gate)
   * leave it undefined and get `addon_required` for any commercial refusal.
   */
  subscriptionCarrying?: boolean;
}

export interface CommercialLayerResult {
  allowed: boolean;
  /** Whether the plan prices this capability at all (false → flag layer governs alone). */
  priced: boolean;
  reason: CommercialDenial | null;
}

/**
 * Whether the commercial layer lets a *priced* capability through.
 *
 *  - not priced                → allowed; the flag layer is the whole answer.
 *  - metered (pay-as-you-go)   → allowed even after the subscription lapsed:
 *                                use is paid per use, not rented per period.
 *                                Callers that must not let a use start the
 *                                wallet cannot pay for check cover themselves.
 *  - entitled                  → allowed (included, owned add-on, promo, grant).
 *  - not entitled              → denied: `subscription_expired` when a plan
 *                                inclusion stopped because the subscription
 *                                lapsed, otherwise `addon_required`.
 */
export function resolveCommercialLayer(input: CommercialAccessInput): CommercialLayerResult {
  const access = input.access;
  if (!access) return { allowed: true, priced: false, reason: null };
  if (access.metered) return { allowed: true, priced: true, reason: null };
  if (access.entitled) return { allowed: true, priced: true, reason: null };
  const lapsed =
    access.source === "plan" && input.subscriptionCarrying === false;
  return {
    allowed: false,
    priced: true,
    reason: lapsed ? "subscription_expired" : "addon_required",
  };
}
