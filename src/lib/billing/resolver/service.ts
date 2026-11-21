/**
 * ESH-193 / #1378 — the database half of the canonical resolver.
 *
 * Everything here reads *existing* commercial facts and hands them to the pure
 * resolver in `precedence.ts`:
 *
 *   - `billing_plans` / `billing_price_versions` / `billing_plan_features`
 *     (the plan and its add-ons, unchanged);
 *   - `service_price_schedules` (#1041's published setup/hourly tariff);
 *   - `billing_meters` / `billing_plan_meter_allowances` / `priceAt`;
 *   - `billing_plan_benefits` (0309: approved inclusions and discounts);
 *   - `service_term_offers` / `business_service_terms` (0309: prepaid terms);
 *   - `business_commercial_policies` (0309: the opt-in policy version).
 *
 * Nothing here invents a price, activates a service or debits a wallet except
 * `purchaseServiceTerm`, which is the one explicit, authorized action that buys
 * a prepaid service interval.
 */
import { query, withTenant, withTenantTransaction, withoutTenantScope, type PoolClient } from "../../db";
import { BILLING_DECLARATIONS, declarationMeterKeys } from "../catalog/declarations";
import { priceAt } from "../runtime";
import { billingLog } from "../observability";
import { monthWindowAt, addCalendarMonths } from "./calendar";
import { benefitId, type BenefitIdentity } from "./identities";
import {
  monthlyPeriodsIn,
  termsOverlap,
  type PrepaidServiceTerm,
  type ServiceTermMonths,
} from "./prepaid";
import {
  chargeStaleness,
  resolveCommercialCharge,
  snapshotCharge,
  type ChargeSnapshot,
  type PlanBenefit,
  type ResolvedCharge,
} from "./precedence";
import {
  serviceTariffAt,
  type ServicePriceRow,
} from "../../service-activation/pricing-service";
import {
  setupFeeRial,
  type ServiceIdentity,
} from "../../service-activation/catalog";
import { postWalletEntryTx, WalletInsufficientFundsError } from "../../wallet-service";

/** A query executor: the pool, or a transaction client whose snapshot must be used. */
export interface ResolverExecutor {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
}

function clientExec(client: PoolClient): ResolverExecutor {
  return {
    query: <T extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      params?: unknown[],
    ) => client.query<T>(text, params as never),
  };
}

// ---------------------------------------------------------------------------
// The tenant's commercial policy
// ---------------------------------------------------------------------------

export interface TenantCommercialPolicy {
  businessId: string;
  /** 0 = legacy. Never inferred: a higher version requires a stored enrolment. */
  policyVersion: number;
  enrolled: boolean;
  enrolledAt: string | null;
  source: "legacy" | "enrolled";
}

export async function readCommercialPolicy(
  businessId: string,
  exec: ResolverExecutor = { query },
): Promise<TenantCommercialPolicy> {
  const run = exec.query;
  const { rows } = await run<{ policy_version: number; enrolled_at: Date | string }>(
    `SELECT policy_version, enrolled_at
       FROM business_commercial_policies
      WHERE business_id = $1`,
    [businessId],
  );
  const row = rows[0];
  if (!row) {
    return {
      businessId,
      policyVersion: 0,
      enrolled: false,
      enrolledAt: null,
      source: "legacy",
    };
  }
  return {
    businessId,
    policyVersion: Number(row.policy_version),
    enrolled: true,
    enrolledAt: row.enrolled_at instanceof Date ? row.enrolled_at.toISOString() : new Date(row.enrolled_at).toISOString(),
    source: "enrolled",
  };
}

export class CommercialPolicyError extends Error {
  constructor(
    public code:
      | "policy_version_missing"
      | "policy_version_not_active"
      | "platform_actor_required",
  ) {
    super(code);
  }
}

/**
 * Explicit enrolment in a reviewed policy version.
 *
 * This is the only way a tenant ever leaves legacy pricing. It is a deliberate
 * write with an actor and a note, not a side effect of reading a new row.
 */
export async function enrollCommercialPolicy(input: {
  businessId: string;
  policyVersion: number;
  /** The global person performing the enrolment (#1384's actor identity). */
  platformUserId: string | null;
  note?: string;
}): Promise<TenantCommercialPolicy> {
  const version = Math.floor(input.policyVersion);
  if (!Number.isSafeInteger(version) || version <= 0) {
    throw new CommercialPolicyError("policy_version_missing");
  }
  const { rows } = await withTenant(input.businessId, () =>
    query<{ status: string }>(`SELECT status FROM billing_policy_versions WHERE version = $1`, [version]),
  );
  if (!rows[0]) throw new CommercialPolicyError("policy_version_missing");
  if (rows[0].status !== "active") throw new CommercialPolicyError("policy_version_not_active");

  await withTenant(input.businessId, () =>
    query(
      `INSERT INTO business_commercial_policies
         (business_id, policy_version, enrolled_by, note, enrolled_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (business_id) DO UPDATE
          SET policy_version = EXCLUDED.policy_version,
              enrolled_by = EXCLUDED.enrolled_by,
              note = EXCLUDED.note,
              enrolled_at = now()`,
      [input.businessId, version, input.platformUserId, input.note?.trim() ?? ""],
    ),
  );
  billingLog("billing.policy.enrolled", {
    businessId: input.businessId,
    policyVersion: version,
    actor: input.platformUserId ?? null,
  });
  return readCommercialPolicy(input.businessId);
}

// ---------------------------------------------------------------------------
// Plan benefits
// ---------------------------------------------------------------------------

export interface PlanBenefitRow extends PlanBenefit {
  capabilityKey: string;
  serviceKind: string | null;
  serviceKey: string | null;
  meterKey: string | null;
  chargesTariffWhenIncluded: boolean;
  providerCostPolicy: "pass_through" | "absorbed" | null;
}

/**
 * Every approved benefit of a plan that applies at the tenant's policy version.
 *
 * `policyVersion <= tenantVersion` is the opt-in rule: a row written for a new
 * policy is invisible to a legacy tenant (version 0), so a new inclusion can
 * never change an existing customer's bill without the reviewed enrolment.
 */
export async function readPlanBenefits(
  planKey: string,
  policyVersion: number,
  exec: ResolverExecutor = { query },
): Promise<Map<string, PlanBenefitRow>> {
  const run = exec.query;
  const { rows } = await run<{
    benefit_id: string;
    benefit_kind: string;
    capability_key: string;
    service_kind: string | null;
    service_key: string | null;
    meter_key: string | null;
    inclusion: "included" | "discounted" | "uncovered";
    discount_basis_points: number;
    charges_tariff_when_included: boolean;
    provider_cost_policy: "pass_through" | "absorbed" | null;
    approved: boolean;
    policy_version: number;
  }>(
    `SELECT benefit_id, benefit_kind, capability_key, service_kind, service_key,
            meter_key, inclusion, discount_basis_points, charges_tariff_when_included,
            provider_cost_policy, approved, policy_version
       FROM billing_plan_benefits
      WHERE plan_key = $1
        AND policy_version <= $2
        AND approved
      ORDER BY benefit_id`,
    [planKey, Math.max(0, Math.floor(policyVersion))],
  );
  const map = new Map<string, PlanBenefitRow>();
  for (const row of rows) {
    map.set(row.benefit_id, {
      benefitId: row.benefit_id,
      inclusion: row.inclusion,
      discountBasisPoints: Number(row.discount_basis_points),
      chargesTariffWhenIncluded: row.charges_tariff_when_included,
      approved: row.approved,
      policyVersion: Number(row.policy_version),
      capabilityKey: row.capability_key,
      serviceKind: row.service_kind,
      serviceKey: row.service_key,
      meterKey: row.meter_key,
      providerCostPolicy: row.provider_cost_policy,
    });
  }
  return map;
}

// ---------------------------------------------------------------------------
// Service charge context (setup / rental / coverage)
// ---------------------------------------------------------------------------

export interface ServiceChargeContext {
  businessId: string;
  planKey: string;
  policyVersion: number;
  identity: ServiceIdentity;
  tariff: ServicePriceRow | null;
  setupBenefit: PlanBenefitRow | null;
  rentalBenefit: PlanBenefitRow | null;
  activeTerm: PrepaidServiceTerm | null;
  activationState: string | null;
  setupPaid: boolean;
}

function identityKey(identity: ServiceIdentity): BenefitIdentity["service"] {
  return { kind: identity.kind, key: identity.key };
}

export function setupBenefitIdentity(identity: ServiceIdentity): BenefitIdentity {
  return {
    kind: "setup_once",
    capabilityKey: "services.activation",
    service: identityKey(identity),
    unit: "setup",
  };
}

export function rentalBenefitIdentity(identity: ServiceIdentity): BenefitIdentity {
  return {
    kind: "enabled_time",
    capabilityKey: "services.activation",
    service: identityKey(identity),
    unit: "second",
  };
}

/**
 * Read everything one service charge needs. Four small reads, no N+1 per
 * benefit: the plan, the policy, the published tariff and this service's term.
 */
export async function readServiceChargeContext(input: {
  businessId: string;
  identity: ServiceIdentity;
  at?: string;
}): Promise<ServiceChargeContext> {
  const at = input.at ?? new Date().toISOString();
  const identity = { ...input.identity, runtimeInstanceId: input.identity.runtimeInstanceId ?? "" };
  return withTenant(input.businessId, async () => {
    const [biz, policy, activation] = await Promise.all([
      query<{ plan: string }>(`SELECT plan FROM businesses WHERE id = $1`, [input.businessId]),
      readCommercialPolicy(input.businessId),
      query<{ state: string; setup_paid: boolean }>(
        `SELECT state, setup_paid
           FROM business_service_activations
          WHERE business_id = $1 AND service_kind = $2 AND service_key = $3
            AND runtime_instance_id = $4`,
        [input.businessId, identity.kind, identity.key, identity.runtimeInstanceId],
      ),
    ]);
    const planKey = biz.rows[0]?.plan ?? "free";
    const benefits = await readPlanBenefits(planKey, policy.policyVersion);
    const tariff = await serviceTariffAt(identity, at);
    const activeTerm = await readActiveServiceTerm({
      businessId: input.businessId,
      identity,
      at,
    });
    return {
      businessId: input.businessId,
      planKey,
      policyVersion: policy.policyVersion,
      identity,
      tariff,
      setupBenefit: benefits.get(benefitId(setupBenefitIdentity(identity))) ?? null,
      rentalBenefit: benefits.get(benefitId(rentalBenefitIdentity(identity))) ?? null,
      activeTerm,
      activationState: activation.rows[0]?.state ?? null,
      setupPaid: Boolean(activation.rows[0]?.setup_paid),
    };
  });
}

/** The score the term offers are matched against — published and versioned. */
export interface ServiceTermOffer {
  id: string;
  termMonths: ServiceTermMonths;
  priceRial: number;
  priceVersion: number;
  effectiveFrom: string;
}

export async function readServiceTermOffer(
  identity: Pick<ServiceIdentity, "kind" | "key">,
  termMonths: ServiceTermMonths,
  at: string,
): Promise<ServiceTermOffer | null> {
  const { rows } = await query<{
    id: string;
    term_months: number;
    price_rial: string | number;
    version: number;
    effective_from: Date | string;
  }>(
    `SELECT id, term_months, price_rial, version, effective_from
       FROM service_term_offers
      WHERE service_kind = $1 AND service_key = $2 AND term_months = $3
        AND published
        AND effective_from <= $4::timestamptz
        AND (effective_until IS NULL OR effective_until > $4::timestamptz)
      ORDER BY version DESC
      LIMIT 1`,
    [identity.kind, identity.key, termMonths, at],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    termMonths: row.term_months as ServiceTermMonths,
    priceRial: Number(row.price_rial),
    priceVersion: Number(row.version),
    effectiveFrom: row.effective_from instanceof Date ? row.effective_from.toISOString() : new Date(row.effective_from).toISOString(),
  };
}

/** The active prepaid term covering `at` for one service identity, if any. */
export async function readActiveServiceTerm(input: {
  businessId: string;
  identity: Pick<ServiceIdentity, "kind" | "key"> & { runtimeInstanceId?: string };
  at: string;
}): Promise<PrepaidServiceTerm | null> {
  const { rows } = await query<{
    term_months: number;
    period_start: Date | string;
    period_end: Date | string;
    price_rial: string | number;
    price_version: number;
    status: "active" | "expired" | "cancelled";
  }>(
    `SELECT t.term_months, t.period_start, t.period_end, t.price_rial,
            t.price_version, t.status
       FROM business_service_terms t
       JOIN business_service_activations a ON a.id = t.activation_id
      WHERE t.business_id = $1
        AND a.service_kind = $2 AND a.service_key = $3
        AND a.runtime_instance_id = $4
        AND t.status = 'active'
        AND t.period_start <= $5::timestamptz
        AND t.period_end > $5::timestamptz
      ORDER BY t.period_start DESC
      LIMIT 1`,
    [
      input.businessId,
      input.identity.kind,
      input.identity.key,
      input.identity.runtimeInstanceId ?? "",
      input.at,
    ],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    termMonths: Number(row.term_months) as ServiceTermMonths,
    periodStart: row.period_start instanceof Date ? row.period_start.toISOString() : new Date(row.period_start).toISOString(),
    periodEnd: row.period_end instanceof Date ? row.period_end.toISOString() : new Date(row.period_end).toISOString(),
    priceRial: Number(row.price_rial),
    priceVersion: Number(row.price_version),
    status: row.status,
  };
}

/**
 * The settlement-time view: is enabled time for this activation covered by a
 * prepaid term, or included by the plan? Read on the settlement's own client so
 * it observes the same snapshot as the charge.
 */
export async function readRentalSettlementContext(
  client: PoolClient,
  input: { businessId: string; activationId: string; from: string; to: string },
): Promise<{
  coverage: { start: string; end: string } | null;
  rentalIncluded: boolean;
  policyVersion: number;
  planKey: string;
}> {
  const { rows } = await client.query<{
    plan: string;
    term_id: string | null;
    period_start: Date | string | null;
    period_end: Date | string | null;
  }>(
    `SELECT b.plan,
            t.id AS term_id, t.period_start, t.period_end
       FROM business_service_activations a
       JOIN businesses b ON b.id = a.business_id
       LEFT JOIN LATERAL (
         SELECT id, period_start, period_end
           FROM business_service_terms
          WHERE activation_id = a.id
            AND status = 'active'
            AND period_start < $4::timestamptz
            AND period_end > $3::timestamptz
          ORDER BY period_start DESC
          LIMIT 1
       ) t ON true
      WHERE a.id = $1 AND a.business_id = $2`,
    [input.activationId, input.businessId, input.from, input.to],
  );
  const row = rows[0];
  if (!row) return { coverage: null, rentalIncluded: false, policyVersion: 0, planKey: "free" };

  const policy = await readCommercialPolicy(input.businessId, clientExec(client));
  const benefits = await readPlanBenefits(row.plan, policy.policyVersion, clientExec(client));
  const identity = await client.query<{ service_kind: string; service_key: string }>(
    `SELECT service_kind, service_key FROM business_service_activations WHERE id = $1`,
    [input.activationId],
  );
  const serviceKind = identity.rows[0]?.service_kind ?? "app";
  const serviceKey = identity.rows[0]?.service_key ?? "";
  const benefit = benefits.get(
    benefitId({
      kind: "enabled_time",
      capabilityKey: "services.activation",
      service: { kind: serviceKind as ServiceIdentity["kind"], key: serviceKey },
      unit: "second",
    }),
  );

  return {
    coverage:
      row.term_id && row.period_start && row.period_end
        ? {
            start: row.period_start instanceof Date ? row.period_start.toISOString() : new Date(row.period_start).toISOString(),
            end: row.period_end instanceof Date ? row.period_end.toISOString() : new Date(row.period_end).toISOString(),
          }
        : null,
    // An inclusion is charged only when an explicit policy permits the tariff.
    rentalIncluded: benefit?.inclusion === "included" && benefit.chargesTariffWhenIncluded !== true,
    policyVersion: policy.policyVersion,
    planKey: row.plan,
  };
}

/** Setup-once for one service, itemised through the canonical resolver. */
export async function resolveServiceSetupCharge(input: {
  businessId: string;
  identity: ServiceIdentity;
  at?: string;
}): Promise<{ context: ServiceChargeContext; charge: ResolvedCharge }> {
  const context = await readServiceChargeContext(input);
  return { context, charge: setupChargeFromContext(context, input.at) };
}

export function setupChargeFromContext(context: ServiceChargeContext, at?: string): ResolvedCharge {
  const identity = setupBenefitIdentity(context.identity);
  const tariff = context.tariff;
  const price =
    tariff && tariff.published
      ? {
          unitAmountRial: setupFeeRial(tariff),
          unitSize: 1,
          priceVersion: { id: tariff.id, version: tariff.version },
        }
      : null;
  return resolveCommercialCharge({
    model: "hybrid",
    requests: [
      {
        identity,
        quantity: 1,
        price,
        planBenefit: context.setupBenefit,
        at: at ?? new Date().toISOString(),
        policyVersion: context.policyVersion,
      },
    ],
  });
}

/** Enabled-time rental for `seconds`, honouring prepaid coverage and inclusion. */
export async function resolveServiceRentalCharge(input: {
  businessId: string;
  identity: ServiceIdentity;
  seconds: number;
  at?: string;
}): Promise<{ context: ServiceChargeContext; charge: ResolvedCharge }> {
  const at = input.at ?? new Date().toISOString();
  const context = await readServiceChargeContext({ businessId: input.businessId, identity: input.identity, at });
  const tariff = context.tariff;
  const charge = resolveCommercialCharge({
    model: "hybrid",
    requests: [
      {
        identity: rentalBenefitIdentity(context.identity),
        quantity: Math.max(0, Math.floor(input.seconds)),
        price:
          tariff && tariff.published
            ? {
                unitAmountRial: Number(tariff.hourlyRateRial),
                unitSize: 3_600,
                priceVersion: { id: tariff.id, version: tariff.version },
              }
            : null,
        planBenefit: context.rentalBenefit,
        coverage: context.activeTerm
          ? { start: context.activeTerm.periodStart, end: context.activeTerm.periodEnd }
          : null,
        at,
        policyVersion: context.policyVersion,
      },
    ],
  });
  return { context, charge };
}

// ---------------------------------------------------------------------------
// Metered usage + allowance
// ---------------------------------------------------------------------------

/** The capability a meter is declared under; a meter may appear in several. */
export function capabilityForMeter(meterKey: string): string | null {
  for (const declaration of BILLING_DECLARATIONS) {
    if (declarationMeterKeys(declaration).includes(meterKey)) return declaration.capabilityKey;
  }
  return null;
}

export interface MeterChargeContext {
  planKey: string;
  policyVersion: number;
  meterKey: string;
  capabilityKey: string;
  price: Awaited<ReturnType<typeof priceAt>>;
  allowance: {
    includedQuantity: number;
    usedQuantity: number;
    overageEnabled: boolean;
    hardLimit: number | null;
    resetPeriod: "month" | "day" | "none";
  } | null;
  benefit: PlanBenefitRow | null;
  /**
   * What the approved plan says about the provider's underlying cost, when it
   * says anything. Null keeps the existing metering behaviour (`recordVendorCost`
   * stays a non-tenant-visible internal cost); `pass_through` means the
   * published customer tariff is charged, `absorbed` means it is not.
   */
  providerCostPolicy: "pass_through" | "absorbed" | null;
}

export async function readMeterChargeContext(input: {
  businessId: string;
  meterKey: string;
  capabilityKey?: string;
  at: string;
}): Promise<MeterChargeContext> {
  const capabilityKey = input.capabilityKey ?? capabilityForMeter(input.meterKey);
  if (!capabilityKey) throw new Error("unknown_meter_capability");
  const window = monthWindowAt(input.at);
  return withTenant(input.businessId, async () => {
    const [biz, policy, price] = await Promise.all([
      query<{ plan: string }>(`SELECT plan FROM businesses WHERE id = $1`, [input.businessId]),
      readCommercialPolicy(input.businessId),
      priceAt("meter", input.meterKey, input.at),
    ]);
    const planKey = biz.rows[0]?.plan ?? "free";
    const benefits = await readPlanBenefits(planKey, policy.policyVersion);
    const { rows } = await query<{
      included_quantity: string | number | null;
      overage_enabled: boolean | null;
      hard_limit: string | number | null;
      reset_period: "month" | "day" | "none" | null;
      used: string;
    }>(
      `SELECT a.included_quantity, a.overage_enabled, a.hard_limit, a.reset_period,
              COALESCE((
                SELECT SUM(e.quantity) FROM billing_usage_events e
                 WHERE e.business_id = $1 AND e.meter_key = $2
                   AND e.occurred_at >= $3::timestamptz
                   AND e.occurred_at < $4::timestamptz
              ), 0)::text AS used
         FROM businesses b
         LEFT JOIN billing_plan_meter_allowances a
                ON a.plan_key = b.plan AND a.meter_key = $2
        WHERE b.id = $1`,
      [input.businessId, input.meterKey, window.startUtc.toISOString(), window.nextStartUtc.toISOString()],
    );
    const row = rows[0];
    const allowance =
      row?.included_quantity == null
        ? null
        : {
            includedQuantity: Number(row.included_quantity),
            usedQuantity: Number(row.used ?? 0),
            overageEnabled: row.overage_enabled !== false,
            hardLimit: row.hard_limit == null ? null : Number(row.hard_limit),
            resetPeriod: (row.reset_period ?? "month") as "month" | "day" | "none",
          };
    const benefit =
      benefits.get(
        benefitId({
          kind: "metered_usage",
          capabilityKey,
          meterKey: input.meterKey,
        }),
      ) ?? null;
    const providerBenefit =
      benefits.get(
        benefitId({
          kind: "provider_cost",
          capabilityKey,
          meterKey: input.meterKey,
        }),
      ) ?? null;
    return {
      planKey,
      policyVersion: policy.policyVersion,
      meterKey: input.meterKey,
      capabilityKey,
      price,
      allowance,
      benefit,
      providerCostPolicy: providerBenefit?.providerCostPolicy ?? null,
    };
  });
}

export async function resolveMeterCharge(input: {
  businessId: string;
  meterKey: string;
  quantity: number;
  capabilityKey?: string;
  at?: string;
}): Promise<{ context: MeterChargeContext; charge: ResolvedCharge }> {
  const at = input.at ?? new Date().toISOString();
  const context = await readMeterChargeContext({ ...input, at });
  const charge = resolveCommercialCharge({
    model: "payg",
    requests: [
      {
        identity: {
          kind: "metered_usage",
          capabilityKey: context.capabilityKey,
          meterKey: context.meterKey,
        },
        quantity: Math.max(0, Math.floor(input.quantity)),
        price: context.price
          ? {
              unitAmountRial: context.price.unitAmountRial,
              unitSize: context.price.unitSize,
              priceVersion: { id: context.price.id, version: context.price.version },
            }
          : null,
        allowance: context.allowance,
        planBenefit: context.benefit,
        at,
        policyVersion: context.policyVersion,
      },
    ],
  });
  return { context, charge };
}

// ---------------------------------------------------------------------------
// Prepaid service terms: quote, purchase, staleness
// ---------------------------------------------------------------------------

export type ServiceTermRefusal =
  | "invalid_term"
  | "no_activation"
  | "term_not_offered"
  | "term_overlap"
  | "term_stale"
  | "amount_mismatch"
  | "insufficient_credit";

export interface ServiceTermQuote {
  ok: boolean;
  refusal: ServiceTermRefusal | null;
  identity: ServiceIdentity;
  termMonths: ServiceTermMonths;
  offer: (ServiceTermOffer & { periodStart: string; periodEnd: string }) | null;
  /** Setup is charged only when it is still unpaid; included setup is zero. */
  setup: ResolvedCharge | null;
  /** The prepaid term itself, priced from the published offer version. */
  term: ResolvedCharge | null;
  totals: { setupRial: number; termRial: number; netRial: number };
  wallet: { balanceRial: number; shortfallRial: number };
  policyVersion: number;
  /** Monthly allowances keep resetting: this many calendar months are covered. */
  allowancePeriods: number;
  /** The published hourly tariff is suspended until this instant. */
  hourlyRentalSuppressedUntil: string | null;
  snapshot: ChargeSnapshot | null;
}

function emptyTermQuote(
  refusal: ServiceTermRefusal,
  identity: ServiceIdentity,
  termMonths: ServiceTermMonths,
  policyVersion = 0,
): ServiceTermQuote {
  return {
    ok: false,
    refusal,
    identity,
    termMonths,
    offer: null,
    setup: null,
    term: null,
    totals: { setupRial: 0, termRial: 0, netRial: 0 },
    wallet: { balanceRial: 0, shortfallRial: 0 },
    policyVersion,
    allowancePeriods: 0,
    hourlyRentalSuppressedUntil: null,
    snapshot: null,
  };
}

export async function quoteServiceTerm(input: {
  businessId: string;
  identity: ServiceIdentity;
  termMonths: ServiceTermMonths;
  at?: string;
}): Promise<ServiceTermQuote> {
  const at = input.at ?? new Date().toISOString();
  if (![1, 3, 12].includes(input.termMonths)) {
    return emptyTermQuote("invalid_term", input.identity, input.termMonths);
  }
  const context = await readServiceChargeContext({
    businessId: input.businessId,
    identity: input.identity,
    at,
  });
  if (!context.activationState || !context.setupPaid) {
    return emptyTermQuote("no_activation", context.identity, input.termMonths, context.policyVersion);
  }
  const offer = await readServiceTermOffer(context.identity, input.termMonths, at);
  if (!offer) {
    return emptyTermQuote("term_not_offered", context.identity, input.termMonths, context.policyVersion);
  }
  const periodStart = at;
  const periodEnd = addCalendarMonths(periodStart, input.termMonths);

  const overlap = await withTenant(input.businessId, () =>
    query<{ id: string }>(
      `SELECT id FROM business_service_terms
        WHERE business_id = $1 AND activation_id = (
                SELECT id FROM business_service_activations
                 WHERE business_id = $1 AND service_kind = $2 AND service_key = $3
                   AND runtime_instance_id = $4)
          AND status = 'active'
          AND period_start < $6::timestamptz AND period_end > $5::timestamptz
        LIMIT 1`,
      [
        input.businessId,
        context.identity.kind,
        context.identity.key,
        context.identity.runtimeInstanceId ?? "",
        periodStart,
        periodEnd,
      ],
    ),
  );
  if (overlap.rows[0]) {
    return emptyTermQuote("term_overlap", context.identity, input.termMonths, context.policyVersion);
  }

  const termCharge = resolveCommercialCharge({
    model: "subscription",
    requests: [
      {
        identity: rentalBenefitIdentity(context.identity),
        quantity: 1,
        price: {
          unitAmountRial: offer.priceRial,
          unitSize: 1,
          priceVersion: { id: offer.id, version: offer.priceVersion },
        },
        planBenefit: context.rentalBenefit,
        coverage: { start: periodStart, end: periodEnd },
        mode: "prepaid_term",
        at,
        policyVersion: context.policyVersion,
      },
    ],
  });

  const setupRial = 0; // setup is already paid (checked above)
  const termRial = termCharge.ok ? termCharge.totals.netRial : 0;
  const netRial = setupRial + termRial;
  const balance = await withTenant(input.businessId, async () => {
    const { rows } = await query<{ balance_rial: string | null }>(
      `SELECT balance_rial FROM business_wallets WHERE business_id = $1`,
      [input.businessId],
    );
    return Number(rows[0]?.balance_rial ?? 0);
  });
  const snapshot = termCharge.ok ? snapshotCharge(termCharge) : null;

  return {
    ok: termCharge.ok,
    refusal: termCharge.ok ? null : "amount_mismatch",
    identity: context.identity,
    termMonths: input.termMonths,
    offer: { ...offer, periodStart, periodEnd },
    setup: null,
    term: termCharge,
    totals: { setupRial, termRial, netRial },
    wallet: { balanceRial: balance, shortfallRial: Math.max(0, netRial - balance) },
    policyVersion: context.policyVersion,
    allowancePeriods: monthlyPeriodsIn(periodStart, periodEnd).length,
    hourlyRentalSuppressedUntil: periodEnd,
    snapshot,
  };
}

export type PurchaseServiceTermResult =
  | {
      status: "purchased";
      termId: string;
      termMonths: ServiceTermMonths;
      periodStart: string;
      periodEnd: string;
      chargedRial: number;
      balanceRial: number;
      ledgerId: string | null;
    }
  | { status: "refused"; reason: ServiceTermRefusal }
  | { status: "insufficient_credit"; requiredRial: number; balanceRial: number };

/**
 * Buy one published prepaid term. Everything commits together: the debit, the
 * term row and the overlap check. A replayed request is refused by the
 * `(activation_id, period_start)` unique index, so the same interval cannot be
 * paid for twice.
 */
export async function purchaseServiceTerm(input: {
  businessId: string;
  identity: ServiceIdentity;
  termMonths: ServiceTermMonths;
  /** The offer the customer saw; a changed offer is `term_stale`. */
  expectedOfferId: string;
  expectedNetRial: number;
  actorPlatformUserId: string | null;
  /** Explicit opt-in for the next term; never inferred. */
  autoRenew?: boolean;
  at?: string;
}): Promise<PurchaseServiceTermResult> {
  const at = input.at ?? new Date().toISOString();
  if (![1, 3, 12].includes(input.termMonths)) return { status: "refused", reason: "invalid_term" };
  const identity = { ...input.identity, runtimeInstanceId: input.identity.runtimeInstanceId ?? "" };

  try {
    return await withTenantTransaction<TenantTermPurchase>(input.businessId, async (client) => {
      const activation = await client.query<{ id: string; state: string; setup_paid: boolean }>(
        `SELECT id, state, setup_paid
           FROM business_service_activations
          WHERE business_id = $1 AND service_kind = $2 AND service_key = $3
            AND runtime_instance_id = $4
          FOR UPDATE`,
        [input.businessId, identity.kind, identity.key, identity.runtimeInstanceId],
      );
      const row = activation.rows[0];
      if (!row || !row.setup_paid) return { status: "refused", reason: "no_activation" } as const;
      if (row.state !== "active") return { status: "refused", reason: "no_activation" } as const;

      const offer = await readServiceTermOffer(identity, input.termMonths, at);
      if (!offer) return { status: "refused", reason: "term_not_offered" } as const;
      if (offer.id !== input.expectedOfferId) return { status: "refused", reason: "term_stale" } as const;

      const policy = await readCommercialPolicy(input.businessId, clientExec(client));
      const planKey = await planKeyTx(client, input.businessId);
      const benefits = await readPlanBenefits(planKey, policy.policyVersion, clientExec(client));
      const rentalBenefit = benefits.get(benefitId(rentalBenefitIdentity(identity))) ?? null;

      const periodStart = at;
      const periodEnd = addCalendarMonths(periodStart, input.termMonths);
      const overlap = await client.query<{ id: string }>(
        `SELECT id FROM business_service_terms
          WHERE activation_id = $1 AND status = 'active'
            AND period_start < $3::timestamptz AND period_end > $2::timestamptz
          LIMIT 1`,
        [row.id, periodStart, periodEnd],
      );
      if (overlap.rows[0]) return { status: "refused", reason: "term_overlap" } as const;

      // Re-price the term at the boundary. The offer row is immutable, so a changed
      // offer is a changed version — and that is stale, not silently accepted.
      const charge = resolveCommercialCharge({
        model: "subscription",
        requests: [
          {
            identity: rentalBenefitIdentity(identity),
            quantity: 1,
            price: {
              unitAmountRial: offer.priceRial,
              unitSize: 1,
              priceVersion: { id: offer.id, version: offer.priceVersion },
            },
            planBenefit: rentalBenefit,
            coverage: { start: periodStart, end: periodEnd },
            mode: "prepaid_term",
            at,
            policyVersion: policy.policyVersion,
          },
        ],
      });
      if (!charge.ok) return { status: "refused", reason: "term_stale" } as const;
      const netRial = charge.totals.netRial;
      if (netRial !== input.expectedNetRial) {
        return { status: "refused", reason: "amount_mismatch" } as const;
      }

      let ledgerId: string | null = null;
      try {
        if (netRial > 0) {
          const entry = await postWalletEntryTx(client, {
            businessId: input.businessId,
            kind: "service_term",
            direction: "debit",
            amountRial: netRial,
            note: `پیش‌پرداخت ${input.termMonths} ماههٔ سرویس`,
            userId: null,
            metadata: {
              serviceKind: identity.kind,
              serviceKey: identity.key,
              runtimeInstanceId: identity.runtimeInstanceId,
              termMonths: input.termMonths,
              offerId: offer.id,
              priceVersion: offer.priceVersion,
              policyVersion: policy.policyVersion,
              periodStart,
              periodEnd,
            },
          });
          ledgerId = entry.id;
        }
      } catch (error) {
        if (error instanceof WalletInsufficientFundsError) {
          return {
            status: "insufficient_credit",
            requiredRial: netRial,
            balanceRial: error.balanceRial,
          } as const;
        }
        throw error;
      }

      let termId: string;
      try {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO business_service_terms
             (business_id, activation_id, service_kind, service_key, term_months,
              offer_id, price_rial, price_version, policy_version, period_start,
              period_end, purchased_by, wallet_ledger_id, auto_renew)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::timestamptz,$11::timestamptz,$12,$13,$14)
           RETURNING id`,
          [
            input.businessId,
            row.id,
            identity.kind,
            identity.key,
            input.termMonths,
            offer.id,
            netRial,
            offer.priceVersion,
            policy.policyVersion,
            periodStart,
            periodEnd,
            input.actorPlatformUserId,
            ledgerId,
            input.autoRenew === true,
          ],
        );
        termId = rows[0].id;
      } catch (error) {
        // A concurrent purchase of the same start instant: the unique index wins.
        // Throwing rolls the whole settlement back — including the debit — so a
        // lost race never leaves money spent without a paid term.
        if (isUniqueViolation(error)) throw new ServiceTermOverlapError();
        throw error;
      }

      const balance = await client.query<{ balance_rial: string }>(
        `SELECT balance_rial FROM business_wallets WHERE business_id = $1`,
        [input.businessId],
      );
      return {
        status: "purchased",
        termId,
        termMonths: input.termMonths,
        periodStart,
        periodEnd,
        chargedRial: netRial,
        balanceRial: Number(balance.rows[0]?.balance_rial ?? 0),
        ledgerId,
      } as const;
    });
  } catch (error) {
    if (error instanceof ServiceTermOverlapError) {
      return { status: "refused", reason: "term_overlap" };
    }
    throw error;
  }
}

type TenantTermPurchase = PurchaseServiceTermResult;

class ServiceTermOverlapError extends Error {
  constructor() {
    super("term_overlap");
  }
}

async function planKeyTx(client: PoolClient, businessId: string): Promise<string> {
  const { rows } = await client.query<{ plan: string }>(`SELECT plan FROM businesses WHERE id = $1`, [businessId]);
  return rows[0]?.plan ?? "free";
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error != null && (error as { code?: string }).code === "23505";
}

/**
 * Is a stored term quote still purchasable? The purchase path repeats this
 * check inside its transaction; this helper exists for a UI that wants to
 * explain a `term_stale` refusal before the customer submits.
 */
export async function serviceTermQuoteStaleness(input: {
  businessId: string;
  identity: ServiceIdentity;
  quote: ServiceTermQuote;
  at?: string;
}): Promise<"offer_changed" | "policy_changed" | "expired" | "amount_changed" | null> {
  const fresh = await quoteServiceTerm({
    businessId: input.businessId,
    identity: input.identity,
    termMonths: input.quote.termMonths,
    at: input.at,
  });
  if (!fresh.ok || !fresh.term || !input.quote.term || !input.quote.snapshot) return "offer_changed";
  const now = new Date(input.at ?? new Date().toISOString());
  const stale = chargeStaleness(input.quote.snapshot, fresh.term, now);
  if (stale === "price_version_changed" || stale === "benefit_set_changed") return "offer_changed";
  if (stale === "policy_version_changed") return "policy_changed";
  return stale;
}

export interface ServiceTermRenewalRun {
  considered: number;
  renewed: number;
  /** The wallet could not cover the renewal; the term simply ends (no debt). */
  skippedInsufficientCredit: number;
  /** The published offer was withdrawn or the activation is no longer active. */
  skippedUnavailable: number;
}

/**
 * ESH-193 — renew the prepaid service terms that opted in.
 *
 * Auto-renew is an explicit per-term switch (`business_service_terms
 * .auto_renew`, default false), so this pass never touches a customer who did
 * not ask for it. It repeats **the stored term only** — a failed renewal is a
 * skip, never a shorter term and never a partial debit — and the unique
 * `(activation_id, period_start)` index makes a restarted tick unable to buy
 * the same interval twice.
 *
 * The cross-tenant read is deliberate and narrow: the due *ids* are read with
 * the platform bypass, then every purchase runs inside its own tenant
 * transaction (wallet lock, offer re-read, overlap check). A failure for one
 * tenant leaves the others untouched.
 */
export async function renewDueServiceTerms(now: Date = new Date()): Promise<ServiceTermRenewalRun> {
  const nowIso = now.toISOString();
  const { rows } = await withoutTenantScope("commercial-term-renewal", () =>
    query<{
      id: string;
      business_id: string;
      activation_id: string;
      service_kind: string;
      service_key: string;
      runtime_instance_id: string;
      term_months: number;
    }>(
      `SELECT t.id, t.business_id, t.activation_id,
              a.service_kind, a.service_key, a.runtime_instance_id,
              t.term_months
         FROM business_service_terms t
         JOIN business_service_activations a ON a.id = t.activation_id
        WHERE t.status = 'active'
          AND t.auto_renew
          AND t.period_end <= $1::timestamptz
          AND NOT EXISTS (
            SELECT 1 FROM business_service_terms n
             WHERE n.activation_id = t.activation_id
               AND n.period_start >= t.period_end
          )
        ORDER BY t.period_end
        LIMIT 200`,
      [nowIso],
    ),
  );

  const run: ServiceTermRenewalRun = {
    considered: rows.length,
    renewed: 0,
    skippedInsufficientCredit: 0,
    skippedUnavailable: 0,
  };

  for (const row of rows) {
    const termMonths = Number(row.term_months) as ServiceTermMonths;
    const identity: ServiceIdentity = {
      kind: row.service_kind as ServiceIdentity["kind"],
      key: row.service_key,
      runtimeInstanceId: row.runtime_instance_id,
    };
    const offer = await readServiceTermOffer(identity, termMonths, nowIso);
    if (!offer) {
      run.skippedUnavailable += 1;
      continue;
    }
    // Price the renewal exactly as a checkout would (plan inclusion included),
    // then buy those facts. Using the offer's raw price here would skip a
    // renewal that an approved inclusion makes free.
    const quote = await quoteServiceTerm({
      businessId: row.business_id,
      identity,
      termMonths,
      at: nowIso,
    });
    if (!quote.ok || !quote.offer) {
      run.skippedUnavailable += 1;
      continue;
    }
    const purchase = await purchaseServiceTerm({
      businessId: row.business_id,
      identity,
      termMonths,
      expectedOfferId: quote.offer.id,
      expectedNetRial: quote.totals.netRial,
      actorPlatformUserId: null,
      // The renewed interval opts in again; the customer's choice persists.
      autoRenew: true,
      at: nowIso,
    });
    if (purchase.status === "purchased") {
      run.renewed += 1;
    } else if (purchase.status === "insufficient_credit") {
      run.skippedInsufficientCredit += 1;
    } else {
      run.skippedUnavailable += 1;
    }
  }
  return run;
}

/** Explicit opt-in / opt-out for the next term. Never retroactive. */
export async function setServiceTermAutoRenew(input: {
  businessId: string;
  identity: ServiceIdentity;
  termId: string;
  autoRenew: boolean;
}): Promise<boolean> {
  const identity = { ...input.identity, runtimeInstanceId: input.identity.runtimeInstanceId ?? "" };
  const { rows } = await withTenant(input.businessId, () =>
    query<{ id: string }>(
      `UPDATE business_service_terms t
          SET auto_renew = $3
        WHERE t.id = $1
          AND t.business_id = $2
          AND t.activation_id = (
            SELECT id FROM business_service_activations
             WHERE business_id = $2 AND service_kind = $4 AND service_key = $5
               AND runtime_instance_id = $6)
        RETURNING t.id`,
      [input.termId, input.businessId, input.autoRenew, identity.kind, identity.key, identity.runtimeInstanceId],
    ),
  );
  return Boolean(rows[0]);
}

/** Calendars and overlap helpers re-exported for callers that already have terms. */
export { monthlyPeriodsIn, termsOverlap };
