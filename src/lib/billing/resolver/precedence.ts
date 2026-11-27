/**
 * ESH-193 / #1378 — the canonical charge resolver.
 *
 * One pure function answers "what does this benefit cost this business, right
 * now, and why?" for every commercial path: subscription checkout, service
 * setup, enabled-time rental, usage settlement, allowance overage and managed
 * provider cost. Callers pass facts; they never invent a rate.
 *
 * ## Deterministic precedence
 *
 * The commercial model only decides which facts are *available*; the order in
 * which they are applied is fixed and identical in all three models:
 *
 *   1. **Prepaid service coverage wins over rental.** While a published,
 *      purchased prepaid service term covers the instant, enabled-time rental
 *      for that service is zero — the same time is never rented twice.
 *   2. **An applicable, approved plan inclusion or discount** applies to the
 *      published tariff, or to the included part of a metered quantity. An
 *      unapproved row is ignored (the published tariff is charged) rather than
 *      applied: fail closed is the money-safe direction.
 *   3. **Usage and allowance rates** are applied under their own benefit
 *      identity: included quantity first, then overage. Overage disabled or a
 *      hard limit is a refusal, never a silent zero.
 *   4. **Ambiguous or incompatible overlaps are rejected**, not summed.
 *   5. **A published zero price is free; a missing or unpublished price is a
 *      refusal.** The difference is explicit in `priceState` and in the
 *      `no_published_price` refusal.
 *   6. **Inclusion never activates anything.** A line says `grantsAccess` and
 *      `activatesService: false`; activation is a separate authorized action.
 *
 * Pure: no db, no next, no display labels. Money is integer Rial; Toman is a
 * rendering concern elsewhere.
 */
import { monthWindowAt, periodMonthFor } from "./calendar";
import {
  benefitId,
  benefitPeriodKey,
  validateBenefitIdentity,
  type BenefitIdentity,
  type BenefitKind,
} from "./identities";

export type CommercialModel = "subscription" | "payg" | "hybrid";

/**
 * The precedence, as data, so a UI can explain it and a test can assert it
 * cannot silently reorder.
 */
export const COMMERCIAL_MODEL_PRECEDENCE = [
  "complimentary_grant_waiver",
  "prepaid_term_coverage",
  "approved_plan_inclusion_or_discount",
  "usage_allowance_then_overage",
  "reject_ambiguous_or_incompatible_overlap",
  "reject_missing_or_unpublished_price",
  "no_implicit_activation",
] as const;

export type PriceState = "published" | "free" | "unpublished";
export type InclusionKind = "included" | "discounted" | "uncovered";

export type RefusalCode =
  | "invalid_quantity"
  | "missing_benefit_identity"
  | "invalid_benefit_identity"
  | "no_published_price"
  | "ambiguous_overlap"
  | "incompatible_overlap"
  | "allowance_hard_limit"
  | "overage_disabled";

export interface PublishedPrice {
  /** Integer Rial per `unitSize` units. Zero is a legitimate published value. */
  unitAmountRial: number;
  unitSize: number;
  /** Null when the price came from a plain column, not a published version. */
  priceVersion: { id: string; version: number } | null;
}

export interface PlanBenefit {
  /** Must equal `benefitId(request.identity)`; a mismatch is ignored. */
  benefitId: string;
  inclusion: InclusionKind;
  /** For `discounted`: basis points off the gross (500 = 5%). */
  discountBasisPoints?: number;
  /**
   * `true` only when an explicit written policy permits the tariff to be
   * charged *in addition to* an inclusion. Default false — an included service
   * is not charged again as a service tariff.
   */
  chargesTariffWhenIncluded?: boolean;
  /** An unapproved row is never applied. */
  approved: boolean;
  policyVersion: number;
}

export interface MeterAllowance {
  includedQuantity: number;
  usedQuantity: number;
  overageEnabled: boolean;
  /** Absolute quantity cap for the period, including the allowance. */
  hardLimit: number | null;
  resetPeriod: "month" | "day" | "none";
}

export interface PrepaidCoverage {
  start: string;
  end: string;
}

export type ProviderCostPolicy = "pass_through" | "absorbed";

export interface ChargeRequest {
  identity: BenefitIdentity;
  /** Whole units. 1 for setup/access, seconds for enabled time, units for usage. */
  quantity: number;
  /** Null when nothing is published for this identity at `at`. */
  price: PublishedPrice | null;
  planBenefit?: PlanBenefit | null;
  allowance?: MeterAllowance | null;
  providerCostRial?: number | null;
  providerCostPolicy?: ProviderCostPolicy | null;
  /** A purchased prepaid service term or active grant covering `at`, if any. */
  coverage?: PrepaidCoverage | null;
  /**
   * An active, authorized complimentary grant waives this charge for its
   * covered interval (GitHub #1579). It is supplied only by the canonical
   * resolver from a stored grant — never from a client — and it can zero a
   * setup charge even when no tariff is published, because the grant is the
   * explicit commercial authority to do so.
   */
  waivedByGrant?: boolean;
  /**
   * `tariff` (the default) prices one period of use. `prepaid_term` prices the
   * purchase of a whole published prepaid term — it is not "coverage", it is
   * the thing that creates coverage.
   */
  mode?: "tariff" | "prepaid_term";
  at: string;
  policyVersion: number;
}

export type ChargeExplanationCode =
  | "published_tariff"
  | "published_free"
  | "complimentary_grant"
  | "plan_included"
  | "plan_included_tariff_permitted"
  | "plan_discounted"
  | "allowance_included"
  | "allowance_overage"
  | "prepaid_term_coverage"
  | "prepaid_term_purchase"
  | "provider_cost_passed_through"
  | "provider_cost_absorbed"
  | "unapproved_benefit_ignored"
  | "benefit_identity_mismatch";

export interface ChargeExplanation {
  code: ChargeExplanationCode;
  /** Machine-readable supporting facts only; never a display label. */
  data?: Record<string, string | number | boolean>;
}

export interface ChargeLine {
  benefitId: string;
  kind: BenefitKind;
  capabilityKey: string;
  quantity: number;
  /** Quantity actually priced after the allowance. */
  chargeableQuantity: number;
  includedQuantity: number;
  unit: string | null;
  unitAmountRial: number;
  unitSize: number;
  priceState: PriceState;
  priceVersion: { id: string; version: number } | null;
  policyVersion: number;
  /** Calendar month (billing calendar) the line's period key uses, or null. */
  periodKey: string;
  effectivePeriod: { start: string; end: string };
  grossRial: number;
  allowanceRial: number;
  inclusionRial: number;
  discountRial: number;
  netRial: number;
  coveredByPrepaidTerm: boolean;
  /**
   * A configuration fact worth surfacing without changing the charge: an
   * unapproved plan row ignored, or a row that names another benefit.
   */
  explanationNote: ChargeExplanation | null;
  /** Access lines only: the inclusion grants use. */
  grantsAccess: boolean;
  /**
   * Always false. No commercial line activates a service; activation is an
   * explicit, authorized action after a valid quote.
   */
  activatesService: false;
  explanation: ChargeExplanation;
}

export interface ChargeRefusal {
  benefitId: string;
  kind: BenefitKind;
  code: RefusalCode;
}

export interface ResolvedCharge {
  ok: boolean;
  model: CommercialModel;
  lines: ChargeLine[];
  refusals: ChargeRefusal[];
  totals: {
    grossRial: number;
    allowanceRial: number;
    inclusionRial: number;
    discountRial: number;
    netRial: number;
  };
  /** What the wallet must cover for this charge. */
  walletRequirementRial: number;
  walletBalanceRial: number | null;
  shortfallRial: number;
}

const ZERO_TOTALS: ResolvedCharge["totals"] = {
  grossRial: 0,
  allowanceRial: 0,
  inclusionRial: 0,
  discountRial: 0,
  netRial: 0,
};

function emptyResult(model: CommercialModel): ResolvedCharge {
  return {
    ok: true,
    model,
    lines: [],
    refusals: [],
    totals: { ...ZERO_TOTALS },
    walletRequirementRial: 0,
    walletBalanceRial: null,
    shortfallRial: 0,
  };
}

function priceStateOf(price: PublishedPrice | null): PriceState {
  if (!price) return "unpublished";
  return price.unitAmountRial === 0 ? "free" : "published";
}

/** Exact integer Rial for `quantity` units, rounded up per pricing unit. */
export function pricedRial(quantity: number, price: PublishedPrice, rounding: "ceil" | "floor" = "ceil"): number {
  if (!Number.isSafeInteger(quantity) || quantity < 0) throw new Error("invalid_quantity");
  if (!Number.isSafeInteger(price.unitAmountRial) || price.unitAmountRial < 0) {
    throw new Error("invalid_price");
  }
  if (!Number.isSafeInteger(price.unitSize) || price.unitSize <= 0) throw new Error("invalid_price");
  if (quantity === 0 || price.unitAmountRial === 0) return 0;
  const numerator = BigInt(quantity) * BigInt(price.unitAmountRial);
  const denominator = BigInt(price.unitSize);
  const rounded = rounding === "floor" ? numerator / denominator : (numerator + denominator - 1n) / denominator;
  const value = Number(rounded);
  if (!Number.isSafeInteger(value)) throw new Error("amount_overflow");
  return value;
}

function resolveOne(
  request: ChargeRequest,
  monthKey: string,
): { line: ChargeLine | null; refusal: ChargeRefusal | null } {
  const identityError = validateBenefitIdentity(request.identity);
  if (identityError) {
    return {
      line: null,
      refusal: {
        benefitId: safeBenefitId(request.identity),
        kind: request.identity?.kind ?? "access",
        code: identityError === "missing_capability" ? "missing_benefit_identity" : "invalid_benefit_identity",
      },
    };
  }
  const id = benefitId(request.identity);
  if (!Number.isSafeInteger(request.quantity) || request.quantity < 0) {
    return { line: null, refusal: { benefitId: id, kind: request.identity.kind, code: "invalid_quantity" } };
  }
  if (request.identity.kind === "setup_once" && request.quantity !== 1) {
    return { line: null, refusal: { benefitId: id, kind: request.identity.kind, code: "invalid_quantity" } };
  }

  const price = request.price;
  const priceState = priceStateOf(price);
  const unitAmountRial = price?.unitAmountRial ?? 0;
  const unitSize = price?.unitSize ?? 1;

  // A matching, approved plan row. A row naming another benefit is a
  // configuration error; it is ignored and reported, never applied.
  let benefit: PlanBenefit | null = null;
  let mismatch = false;
  if (request.planBenefit) {
    if (request.planBenefit.benefitId !== id) mismatch = true;
    else if (request.planBenefit.approved) benefit = request.planBenefit;
  }

  const explanation: ChargeExplanation = { code: "published_tariff" };
  let explanationNote: ChargeExplanation | null = null;

  // 1 — prepaid service coverage. Enabled time inside a purchased term is not
  //     rented again. Access inside a term is granted by the term, not charged.
  //     Buying a term is not coverage: `mode: "prepaid_term"` prices the offer.
  const isTermPurchase = request.mode === "prepaid_term";
  const covered =
    !isTermPurchase &&
    request.identity.kind === "enabled_time" &&
    request.coverage != null &&
    coversInstant(request.coverage, request.at);

  // 2 — allowance (usage and overage benefits only).
  let includedQuantity = 0;
  let chargeableQuantity = request.quantity;
  let allowanceRial = 0;
  if (
    (request.identity.kind === "metered_usage" || request.identity.kind === "allowance_overage") &&
    request.allowance
  ) {
    const allowance = request.allowance;
    const remaining = Math.max(0, allowance.includedQuantity - allowance.usedQuantity);
    if (allowance.hardLimit != null && allowance.usedQuantity + request.quantity > allowance.hardLimit) {
      return { line: null, refusal: { benefitId: id, kind: request.identity.kind, code: "allowance_hard_limit" } };
    }
    includedQuantity = Math.min(request.quantity, remaining);
    chargeableQuantity = request.quantity - includedQuantity;
    if (chargeableQuantity > 0 && !allowance.overageEnabled) {
      return { line: null, refusal: { benefitId: id, kind: request.identity.kind, code: "overage_disabled" } };
    }
  }

  const grossRial =
    price && chargeableQuantity > 0 && request.identity.kind !== "access"
      ? pricedRial(chargeableQuantity, price)
      : request.identity.kind === "provider_cost"
        ? Math.max(0, Math.floor(request.providerCostRial ?? 0))
        : 0;
  allowanceRial =
    includedQuantity > 0 && price ? pricedRial(includedQuantity, price) : 0;

  // 3 — provider cost policy is applied before any plan inclusion, because it
  //     decides whether there is a chargeable amount at all.
  let inclusionRial = 0;
  let discountRial = 0;
  let netRial = grossRial;
  let coveredByPrepaidTerm = false;
  const grantsAccess = request.identity.kind === "access";

  if (request.identity.kind === "access") {
    netRial = 0;
    explanation.code = "plan_included";
  } else if (request.waivedByGrant === true) {
    // A stored, active complimentary grant covers this charge. It is explicit
    // commercial authority, so it may zero the line even with no published
    // tariff — unlike a missing tariff, which still fails closed below.
    inclusionRial = grossRial;
    netRial = 0;
    explanation.code = "complimentary_grant";
  } else if (covered) {
    coveredByPrepaidTerm = true;
    netRial = 0;
    explanation.code = "prepaid_term_coverage";
  } else if (request.identity.kind === "provider_cost" && request.providerCostPolicy === "absorbed") {
    netRial = 0;
    explanation.code = "provider_cost_absorbed";
  } else if (request.identity.kind === "provider_cost" && request.providerCostPolicy === "pass_through") {
    // A published customer tariff wins; otherwise the provider's cost is the
    // amount — never a silent zero.
    if (priceState === "unpublished" && (request.providerCostRial ?? 0) <= 0) {
      return { line: null, refusal: { benefitId: id, kind: request.identity.kind, code: "no_published_price" } };
    }
    netRial = grossRial;
    explanation.code =
      priceState === "unpublished" ? "published_tariff" : "provider_cost_passed_through";
  } else if (priceState === "unpublished") {
    // Last chance: an approved `included` plan row makes it free; anything
    // else is refused. An unpriced benefit is never free by accident.
    if (benefit?.inclusion === "included") {
      netRial = 0;
      explanation.code = "plan_included";
    } else {
      return { line: null, refusal: { benefitId: id, kind: request.identity.kind, code: "no_published_price" } };
    }
  } else if (benefit?.inclusion === "included") {
    if (benefit.chargesTariffWhenIncluded === true) {
      netRial = grossRial;
      explanation.code = "plan_included_tariff_permitted";
    } else {
      inclusionRial = grossRial;
      netRial = 0;
      explanation.code = "plan_included";
    }
  } else if (benefit?.inclusion === "discounted") {
    const bps = clampBasisPoints(benefit.discountBasisPoints ?? 0);
    discountRial = Math.min(grossRial, Math.round((grossRial * bps) / 10_000));
    netRial = grossRial - discountRial;
    explanation.code = "plan_discounted";
    explanation.data = { discountBasisPoints: bps };
  } else if (isTermPurchase) {
    // A prepaid term is its own purchase: the published offer price is charged
    // once, unless an approved inclusion/discount already covered it above.
    netRial = grossRial;
    explanation.code = "prepaid_term_purchase";
    explanation.data = { termOffer: true };
  } else if (priceState === "free") {
    explanation.code = "published_free";
  } else if (includedQuantity > 0) {
    explanation.code = chargeableQuantity > 0 ? "allowance_overage" : "allowance_included";
    explanation.data = {
      includedQuantity,
      chargedQuantity: chargeableQuantity,
    };
  } else if (mismatch) {
    explanationNote = { code: "benefit_identity_mismatch" };
  } else if (request.planBenefit && !request.planBenefit.approved) {
    explanationNote = { code: "unapproved_benefit_ignored" };
  }

  return {
    line: {
      benefitId: id,
      kind: request.identity.kind,
      capabilityKey: request.identity.capabilityKey,
      quantity: request.quantity,
      chargeableQuantity,
      includedQuantity,
      unit: request.identity.unit ?? null,
      unitAmountRial,
      unitSize,
      priceState,
      priceVersion: price?.priceVersion ?? null,
      policyVersion: request.policyVersion,
      periodKey: benefitPeriodKey(request.identity.kind, request.at, monthKey),
      effectivePeriod: effectivePeriodFor(request),
      grossRial,
      allowanceRial,
      inclusionRial,
      discountRial,
      netRial,
      coveredByPrepaidTerm,
      explanationNote,
      grantsAccess,
      activatesService: false,
      explanation,
    },
    refusal: null,
  };
}

function coversInstant(coverage: PrepaidCoverage, atIso: string): boolean {
  const at = Date.parse(atIso);
  const start = Date.parse(coverage.start);
  const end = Date.parse(coverage.end);
  if (!Number.isFinite(at) || !Number.isFinite(start) || !Number.isFinite(end)) return false;
  return start <= at && at < end;
}

function effectivePeriodFor(request: ChargeRequest): { start: string; end: string } {
  if (request.identity.kind === "setup_once") {
    return { start: request.at, end: request.at };
  }
  if (request.coverage && request.identity.kind === "enabled_time") {
    return { start: request.coverage.start, end: request.coverage.end };
  }  const window = monthWindowAt(request.at);
  return { start: window.startUtc.toISOString(), end: window.nextStartUtc.toISOString() };
}

function safeBenefitId(identity: BenefitIdentity | null | undefined): string {
  if (!identity) return "unknown";
  try {
    return benefitId(identity);
  } catch {
    return "unknown";
  }
}

function clampBasisPoints(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(10_000, Math.floor(value)));
}

/**
 * Resolve one or more benefits as a single charge.
 *
 * Overlap rules (step 4 of the precedence):
 *  - the same benefit identity for the same period, twice, with a quantity, is
 *    `ambiguous_overlap`;
 *  - a `metered_usage` line and an `allowance_overage` line on the same meter
 *    in the same period is `incompatible_overlap` (the overage view already
 *    includes the metered quantity);
 *  - an enabled-time line inside prepaid coverage is *not* an overlap: coverage
 *    takes precedence and the rental line is zero.
 */
export function resolveCommercialCharge(input: {
  model?: CommercialModel;
  requests: readonly ChargeRequest[];
  walletBalanceRial?: number | null;
  /** Override for deterministic tests; defaults to the billing calendar. */
  periodMonth?: string;
}): ResolvedCharge {
  const model = input.model ?? "hybrid";
  const result = emptyResult(model);

  const seen = new Map<string, BenefitKind>();
  const meterUsage = new Set<string>();
  const meterOverage = new Set<string>();

  for (const request of input.requests) {
    const monthKey = input.periodMonth ?? periodMonthFor(new Date(request.at));
    const resolved = resolveOne(request, monthKey);

    if (resolved.refusal) {
      result.refusals.push(resolved.refusal);
      continue;
    }
    const line = resolved.line!;

    if (line.quantity > 0) {
      const key = `${line.benefitId}|${line.periodKey}`;
      if (seen.has(key)) {
        result.refusals.push({ benefitId: line.benefitId, kind: line.kind, code: "ambiguous_overlap" });
        continue;
      }
      seen.set(key, line.kind);
    }

    if (line.kind === "metered_usage" && request.identity.meterKey) {
      meterUsage.add(request.identity.meterKey);
    }
    if (line.kind === "allowance_overage" && request.identity.meterKey) {
      meterOverage.add(request.identity.meterKey);
    }

    result.lines.push(line);
  }

  for (const meterKey of meterUsage) {
    if (meterOverage.has(meterKey)) {
      result.refusals.push({ benefitId: `meter:${meterKey}`, kind: "metered_usage", code: "incompatible_overlap" });
    }
  }

  result.totals = result.lines.reduce(
    (totals, line) => ({
      grossRial: totals.grossRial + line.grossRial,
      allowanceRial: totals.allowanceRial + line.allowanceRial,
      inclusionRial: totals.inclusionRial + line.inclusionRial,
      discountRial: totals.discountRial + line.discountRial,
      netRial: totals.netRial + line.netRial,
    }),
    { ...ZERO_TOTALS },
  );
  result.walletRequirementRial = result.totals.netRial;
  if (input.walletBalanceRial != null && Number.isFinite(input.walletBalanceRial)) {
    const balance = Math.max(0, Math.floor(input.walletBalanceRial));
    result.walletBalanceRial = balance;
    result.shortfallRial = Math.max(0, result.walletRequirementRial - balance);
  }
  result.ok = result.refusals.length === 0;
  return result;
}

export interface ChargeSnapshotLine {
  benefitId: string;
  priceVersionId: string | null;
  priceVersion: number | null;
  netRial: number;
  policyVersion: number;
}

export interface ChargeSnapshot {
  policyVersion: number;
  totalsNetRial: number;
  lines: ChargeSnapshotLine[];
}

/** The versioned facts a stored charge is compared against at the posting boundary. */
export function snapshotCharge(resolved: ResolvedCharge): ChargeSnapshot {
  return {
    policyVersion: resolved.lines[0]?.policyVersion ?? 0,
    totalsNetRial: resolved.totals.netRial,
    lines: resolved.lines.map((line) => ({
      benefitId: line.benefitId,
      priceVersionId: line.priceVersion?.id ?? null,
      priceVersion: line.priceVersion?.version ?? null,
      netRial: line.netRial,
      policyVersion: line.policyVersion,
    })),
  };
}

export type StaleReason =
  | "expired"
  | "price_version_changed"
  | "policy_version_changed"
  | "amount_changed"
  | "benefit_set_changed";

/**
 * Is a stored charge still payable?
 *
 * Called at the final debit/posting boundary with freshly read facts, not only
 * in the UI. Any changed price version, changed policy version, changed amount
 * or a different set of benefit lines means the customer must be re-quoted.
 */
export function chargeStaleness(
  stored: ChargeSnapshot,
  fresh: ResolvedCharge,
  now: Date = new Date(),
  expiresAt?: string | null,
): StaleReason | null {
  if (expiresAt) {
    const expiry = Date.parse(expiresAt);
    if (Number.isFinite(expiry) && expiry <= now.getTime()) return "expired";
  }
  const current = snapshotCharge(fresh);
  if (fresh.refusals.length > 0) return "benefit_set_changed";
  if (current.policyVersion !== stored.policyVersion) return "policy_version_changed";
  if (current.lines.length !== stored.lines.length) return "benefit_set_changed";
  const byId = new Map(current.lines.map((line) => [line.benefitId, line]));
  for (const line of stored.lines) {
    const live = byId.get(line.benefitId);
    if (!live) return "benefit_set_changed";
    if (line.priceVersionId !== live.priceVersionId || line.priceVersion !== live.priceVersion) {
      return "price_version_changed";
    }
    if (line.netRial !== live.netRial) return "amount_changed";
  }
  if (current.totalsNetRial !== stored.totalsNetRial) return "amount_changed";
  return null;
}
