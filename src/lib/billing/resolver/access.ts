/**
 * ESH-193 / #1378 — commercial availability, kept visibly separate from access.
 *
 * #1380 owns the tenant-facing billing UX. This module owns the *server*
 * projection it renders, and it deliberately keeps nine concepts apart instead
 * of collapsing them into one `available` boolean, because every historical
 * gate bug in this area came from two of them sharing an answer:
 *
 *   industryEligible     the trade's modules include this app
 *   deploymentEligible   the deployment profile may run it
 *   platformAvailable    app_availability says it is usable right now
 *   roleEligible         the acting member has the permission (caller-supplied)
 *   effectiveAccess      the existing capability resolver's answer
 *   legacyAccess         no commercial policy enrolment → grandfathered
 *   planEntitlement      the plan includes/discounts the service
 *   activationState      the service was explicitly activated (or not)
 *   purchasable          a published tariff/offer exists to buy
 *
 * plus `restricted`, which is the only axis that can deny a paid capability —
 * and only for a tenant explicitly enrolled in a reviewed policy. A legacy
 * tenant is never restricted by this module: that is the "no-row
 * grandfathering" rule, not a default.
 */
import { query, withTenant } from "../../db";
import { APPS } from "../../apps";
import type { DeploymentProfile } from "../../deployment-mode";
import { readDeploymentProfile } from "../../deployment-mode";
import { getBusinessIndustry } from "../../industry-guard";
import { deploymentSupportsApp, industrySupportsApp } from "../../setup-apps";
import { isAppAvailable } from "../../app-availability-service";
import { resolveBusinessCapability } from "../../entitlement-service";
import { SERVICE_STATE_META, type ServiceIdentity, type ServiceState } from "../../service-activation/catalog";
import { getServiceActivation } from "../../service-activation/activation-service";
import { resolveServiceSetupCharge, setupChargeFromContext, readCommercialPolicy, readServiceTermOffer, readServiceChargeContext } from "./service";

export type ActivationProjection =
  | "not_activated"
  | "pending"
  | "active"
  | "suspended"
  | "disabled_retained"
  | "legal_hold"
  | "purged";

export interface CommercialAvailability {
  identity: ServiceIdentity;
  industryEligible: boolean;
  deploymentEligible: boolean;
  platformAvailable: boolean;
  /** Null when the caller supplied no permission set to check. */
  roleEligible: boolean | null;
  effectiveAccess: boolean;
  accessReason: string | null;
  /** True when no commercial policy enrolment exists (no-row grandfathering). */
  legacyAccess: boolean;
  policyVersion: number;
  planEntitlement: {
    included: boolean;
    discounted: boolean;
    /** The approved gross/net the inclusion produces for setup, if any. */
    setupNetRial: number | null;
  };
  activationState: ActivationProjection;
  /** Activation is an explicit action, never implied by inclusion or funding. */
  activationRequired: boolean;
  suspended: boolean;
  /** Data is readable/exportable while disabled or suspended (retention right). */
  retentionReadable: boolean;
  /** A published tariff (or term offer) exists, so the service can be bought. */
  purchasable: boolean;
  /** Only an explicitly enrolled tenant can be restricted. */
  restricted: boolean;
  restrictionReason: "unpaid_service" | "policy_pending" | null;
  /** Safe preview data stays readable even when restricted. */
  safePreviewAllowed: boolean;
  /** The itemised setup quote, for the UI's price panel. */
  setup: Awaited<ReturnType<typeof resolveServiceSetupCharge>>["charge"] | null;
  hourlyRial: number | null;
  termOffers: { termMonths: 1 | 3 | 12; priceRial: number; offerId: string }[];
}

function activationProjection(state: ServiceState | null | undefined): ActivationProjection {
  switch (state) {
    case "active":
      return "active";
    case "setup_in_progress":
    case "payment_reserved":
      return "pending";
    case "suspended_insufficient_credit":
    case "platform_unavailable":
      return "suspended";
    case "disabled_retained":
    case "eligible_for_purge":
    case "purge_failed":
      return "disabled_retained";
    case "legal_hold":
      return "legal_hold";
    case "purging":
    case "data_purged":
      return "purged";
    default:
      return "not_activated";
  }
}

/**
 * Project one service's commercial availability for one tenant. Reads only; it
 * never activates, charges or provisions anything.
 */
export async function resolveCommercialAvailability(input: {
  businessId: string;
  identity: ServiceIdentity;
  permissions?: readonly string[];
  at?: string;
}): Promise<CommercialAvailability> {
  const at = input.at ?? new Date().toISOString();
  const identity = { ...input.identity, runtimeInstanceId: input.identity.runtimeInstanceId ?? "" };
  const app = identity.kind === "app" ? APPS.find((row) => row.key === identity.key) : undefined;

  const [industry, profileRecord, platformAvailable, policy, activation, context] = await Promise.all([
    getBusinessIndustry(input.businessId),
    readDeploymentProfile(input.businessId),
    app ? isAppAvailable(input.businessId, app.key) : Promise.resolve(true),
    readCommercialPolicy(input.businessId),
    getServiceActivation(input.businessId, identity),
    readServiceChargeContext({ businessId: input.businessId, identity, at }),
  ]);
  const profile = profileRecord.profile;

  // An app's industry/deployment eligibility comes from the same registry the
  // setup gallery uses; workspace capabilities and agents are platform-wide.
  const industryEligible =
    !app || !industry ? true : industrySupportsApp(industry, app);
  const deploymentEligible = !app || deploymentSupportsApp(profile as DeploymentProfile, app);

  const capability = await resolveBusinessCapability(input.businessId, "services.activation", {
    permissions: input.permissions,
  });

  const setupCharge = setupChargeFromContext(context, at);
  const setupLine = setupCharge.lines[0] ?? null;
  const included = setupLine?.explanation.code === "plan_included";
  const discounted = (setupLine?.discountRial ?? 0) > 0;

  const termOffers: CommercialAvailability["termOffers"] = [];
  for (const term of [1, 3, 12] as const) {
    const offer = await readServiceTermOffer(identity, term, at);
    if (offer) termOffers.push({ termMonths: term, priceRial: offer.priceRial, offerId: offer.id });
  }

  const state = activation?.state ?? null;
  const projection = activationProjection(state);
  const paidService =
    (context.tariff != null && (context.tariff.published !== false)) ||
    termOffers.length > 0;
  // Unpaid restriction: an enrolled tenant whose service is not active but was
  // previously provisioned (a pending/suspended row), and whose price is real.
  const restricted =
    policy.enrolled &&
    paidService &&
    (projection === "suspended" || projection === "pending");
  const retentionReadable = state ? SERVICE_STATE_META[state].retainsData : true;

  return {
    identity,
    industryEligible,
    deploymentEligible,
    platformAvailable,
    roleEligible: input.permissions ? capability.reason !== "permission_denied" : null,
    effectiveAccess: capability.allowed,
    accessReason: capability.reason,
    legacyAccess: !policy.enrolled,
    policyVersion: policy.policyVersion,
    planEntitlement: {
      included,
      discounted,
      setupNetRial: setupCharge.ok ? setupCharge.totals.netRial : null,
    },
    activationState: projection,
    activationRequired: projection !== "active",
    suspended: projection === "suspended",
    retentionReadable,
    purchasable: paidService,
    restricted,
    restrictionReason: restricted ? "unpaid_service" : null,
    safePreviewAllowed: true,
    setup: setupCharge,
    hourlyRial: context.tariff ? Number(context.tariff.hourlyRateRial) : null,
    termOffers,
  };
}

export type ServiceAccessDecision =
  | { allowed: true; availability: CommercialAvailability }
  | {
      allowed: false;
      reason: "industry" | "deployment" | "platform_unavailable" | "unpaid_service" | "not_purchasable" | "permission_denied";
      availability: CommercialAvailability;
      /** A fresh quote and exact shortfall, never a stale one. */
      walletShortfallRial: number | null;
    };

/**
 * The server boundary a paid-service capability calls before doing work.
 *
 * It denies only what the projection genuinely denies, and it returns the
 * availability projection with every denial so a route can explain it without
 * re-deriving the answer. Funding the wallet does not flip any of this: only an
 * explicit activation (with a valid quote) does.
 */
export async function enforceCommercialServiceAccess(input: {
  businessId: string;
  identity: ServiceIdentity;
  permissions?: readonly string[];
  /** `activate` is allowed to proceed for a not-yet-active service. */
  intent: "use" | "activate";
  at?: string;
}): Promise<ServiceAccessDecision> {
  const availability = await resolveCommercialAvailability(input);
  if (!availability.industryEligible) {
    return { allowed: false, reason: "industry", availability, walletShortfallRial: null };
  }
  if (!availability.deploymentEligible) {
    return { allowed: false, reason: "deployment", availability, walletShortfallRial: null };
  }
  if (!availability.platformAvailable) {
    return { allowed: false, reason: "platform_unavailable", availability, walletShortfallRial: null };
  }
  if (input.permissions && availability.roleEligible === false) {
    return { allowed: false, reason: "permission_denied", availability, walletShortfallRial: null };
  }
  // A service with no published price cannot be used, but activation keeps its
  // own `not_configured` answer (the existing #1041 contract) for that case.
  if (!availability.purchasable && input.intent === "use") {
    return { allowed: false, reason: "not_purchasable", availability, walletShortfallRial: null };
  }
  if (availability.restricted) {
    const shortfall = await walletShortfall(input.businessId, availability.setup?.totals.netRial ?? 0);
    return { allowed: false, reason: "unpaid_service", availability, walletShortfallRial: shortfall };
  }
  if (input.intent === "use" && availability.activationRequired && !availability.legacyAccess) {
    return { allowed: false, reason: "unpaid_service", availability, walletShortfallRial: null };
  }
  return { allowed: true, availability };
}

async function walletShortfall(businessId: string, requiredRial: number): Promise<number> {
  const { rows } = await withTenant(businessId, () =>
    query<{ balance_rial: string | null }>(
      `SELECT balance_rial FROM business_wallets WHERE business_id = $1`,
      [businessId],
    ),
  );
  const balance = Number(rows[0]?.balance_rial ?? 0);
  return Math.max(0, Math.max(0, Math.floor(requiredRial)) - balance);
}
