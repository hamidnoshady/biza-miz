/**
 * ESH-193 / #1378 — canonical benefit identities.
 *
 * A benefit is the unit of *commercial* identity: one thing the platform can
 * charge for, include, discount or refuse. It is never inferred from a display
 * label, a route name or a feature name — a price row, a plan inclusion, a
 * usage meter and an invoice line all point at the same stable `benefitId`
 * string, and a mismatch is a refusal rather than a silent fallback.
 *
 * The six kinds are deliberately distinct because they are charged by different
 * rules and at different times:
 *
 *   access            — the right to use a capability. Never a charge by itself.
 *   setup_once        — a one-time provisioning charge per stable service.
 *   enabled_time      — rental for as long as a service is deliberately enabled.
 *   metered_usage     — actual consumption (tokens, segments, bytes, runs).
 *   allowance_overage — the part of a metered quantity beyond an included quota.
 *   provider_cost     — a managed provider's cost, passed through or absorbed.
 *
 * Same-kind identity matching is what makes "no benefit is charged twice"
 * checkable: two charges with the same `benefitId` in the same period are an
 * ambiguous overlap, and the resolver refuses them instead of summing them.
 *
 * Pure: no db, no next, no labels.
 */

export const BENEFIT_KINDS = [
  "access",
  "setup_once",
  "enabled_time",
  "metered_usage",
  "allowance_overage",
  "provider_cost",
] as const;

export type BenefitKind = (typeof BENEFIT_KINDS)[number];

export function isBenefitKind(value: unknown): value is BenefitKind {
  return typeof value === "string" && (BENEFIT_KINDS as readonly string[]).includes(value);
}

/** The service identity a service-kind benefit belongs to (mirrors #1041). */
export interface ServiceRef {
  /** `app`, `workspace` or `agent` — the closed world of billable services. */
  kind: "app" | "workspace" | "agent";
  key: string;
}

export interface BenefitIdentity {
  kind: BenefitKind;
  /**
   * The capability registry key (`billing/catalog/declarations`). Required for
   * every benefit so a charge can always name the commercial capability it
   * belongs to, even when the service layer is only half configured.
   */
  capabilityKey: string;
  /** Present for `setup_once` and `enabled_time`. */
  service?: ServiceRef;
  /** Present for `metered_usage`, `allowance_overage` and `provider_cost`. */
  meterKey?: string;
  /** The unit the quantity is expressed in (`second`, `token`, `segment`, …). */
  unit?: string;
}

/** Stable, parseable identity. Sorting these gives a deterministic order. */
export function benefitId(identity: BenefitIdentity): string {
  const capability = capabilityKeyOf(identity);
  if (identity.service) {
    return `service:${identity.service.kind}:${identity.service.key}/${identity.kind}@${capability}`;
  }
  if (identity.meterKey) {
    return `meter:${identity.meterKey}/${identity.kind}@${capability}`;
  }
  return `capability:${capability}/${identity.kind}`;
}

function capabilityKeyOf(identity: BenefitIdentity): string {
  return identity.capabilityKey.trim();
}

export interface ParsedBenefitId {
  kind: BenefitKind;
  capabilityKey: string;
  service?: ServiceRef;
  meterKey?: string;
}

/**
 * Parse a stored `benefitId`. Used to validate plan-benefit rows written by an
 * operator: a row that does not round-trip is rejected, so a typo cannot create
 * a phantom inclusion that matches nothing.
 */
export function parseBenefitId(value: string): ParsedBenefitId | null {
  if (typeof value !== "string" || value.length > 300) return null;
  // A capability-only identity carries its key once; the `@capability` suffix
  // exists to disambiguate service/meter ids that would otherwise be identical
  // across two capabilities sharing a service or meter.
  if (value.startsWith("capability:")) {
    const [target, benefit] = value.slice("capability:".length).split("/");
    if (!isSafeKey(target ?? "") || !isBenefitKind(benefit)) return null;
    return { kind: benefit, capabilityKey: target! };
  }
  const at = value.lastIndexOf("@");
  if (at <= 0 || at === value.length - 1) return null;
  const head = value.slice(0, at);
  const capabilityKey = value.slice(at + 1);
  if (!isSafeKey(capabilityKey)) return null;

  if (head.startsWith("service:")) {
    const [target, benefit] = head.slice("service:".length).split("/");
    const [svcKind, svcKey] = (target ?? "").split(":");
    if (!isServiceKind(svcKind) || !isSafeKey(svcKey ?? "")) return null;
    if (!isBenefitKind(benefit) || (benefit !== "setup_once" && benefit !== "enabled_time" && benefit !== "access")) {
      return null;
    }
    return {
      kind: benefit,
      capabilityKey,
      service: { kind: svcKind, key: svcKey! },
    };
  }
  if (head.startsWith("meter:")) {
    const [meterKey, benefit] = head.slice("meter:".length).split("/");
    if (!isSafeKey(meterKey ?? "") || !isBenefitKind(benefit)) return null;
    if (benefit !== "metered_usage" && benefit !== "allowance_overage" && benefit !== "provider_cost") {
      return null;
    }
    return { kind: benefit, capabilityKey, meterKey: meterKey! };
  }
  return null;
}

function isServiceKind(value: unknown): value is ServiceRef["kind"] {
  return value === "app" || value === "workspace" || value === "agent";
}

function isSafeKey(value: string): boolean {
  return /^[a-z0-9][a-z0-9_.:#-]{0,199}$/i.test(value);
}

/**
 * Validate an identity before it is priced. A malformed identity is a coded
 * refusal, never a zero-amount charge: an identity that cannot be matched is
 * exactly the case in which billing must fail closed.
 */
export type BenefitIdentityError =
  | "missing_capability"
  | "missing_target"
  | "ambiguous_target"
  | "invalid_service"
  | "invalid_meter";

export function validateBenefitIdentity(identity: BenefitIdentity): BenefitIdentityError | null {
  if (!identity || typeof identity !== "object") return "missing_target";
  if (!isBenefitKind(identity.kind)) return "missing_target";
  if (!identity.capabilityKey || !isSafeKey(identity.capabilityKey)) return "missing_capability";

  const isServiceBenefit =
    identity.kind === "setup_once" || identity.kind === "enabled_time";
  const isMeterBenefit =
    identity.kind === "metered_usage" ||
    identity.kind === "allowance_overage" ||
    identity.kind === "provider_cost";

  if (isServiceBenefit) {
    if (!identity.service) return "missing_target";
    if (!isServiceKind(identity.service.kind)) return "invalid_service";
    if (!isSafeKey(identity.service.key)) return "invalid_service";
    return null;
  }
  if (isMeterBenefit) {
    if (!identity.meterKey) return "missing_target";
    if (!isSafeKey(identity.meterKey)) return "invalid_meter";
    return null;
  }
  // `access` may name a service or stand alone as a capability. Naming both a
  // service and a meter is always ambiguous.
  if (identity.service && identity.meterKey) return "ambiguous_target";
  if (identity.service) {
    if (!isServiceKind(identity.service.kind)) return "invalid_service";
    if (!isSafeKey(identity.service.key)) return "invalid_service";
  }
  return null;
}

/**
 * The period a charge covers, for duplicate detection.
 *
 * `setup_once` is `once` because the whole point is one charge per stable
 * identity. Everything metered or rented is a calendar month in the billing
 * calendar, so the same charge replayed in the same month is caught while a
 * genuinely new month is not.
 */
export type BenefitPeriodKey = string;

export function benefitPeriodKey(kind: BenefitKind, atIso: string, monthKey: string): BenefitPeriodKey {
  if (kind === "setup_once") return "once";
  if (kind === "access") return "access";
  return monthKey;
}
