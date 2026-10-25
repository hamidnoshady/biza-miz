/**
 * Credit lease policy (issue #998, Phase 0) — the pure rules a Hybrid or Full
 * Offline site follows while it spends against a pre-authorised lease.
 *
 * The cloud stays the only authority for balance, pricing and debit. This
 * module holds no money of its own: it answers "which of the three states is
 * this meter in" and "how much over-lease debt did that usage add", from facts
 * the caller read. Everything is integer Rial; the one multiplication that can
 * leave the safe-integer range runs in BigInt.
 *
 *   lease -> over_lease_debt -> locked
 *
 *   lease            units are still granted and the lease has not expired.
 *   over_lease_debt  the lease is exhausted or expired; usage continues and is
 *                    recorded as debt, up to the ceiling.
 *   locked           the debt reached the ceiling; the plan's lock policy
 *                    applies until the device reconnects and the debt is settled.
 */

export const OFFLINE_WINDOW_DAYS_DEFAULT = 7;
/** 10,000,000 Rial (1,000,000 Toman) per device. A placeholder until real prices exist. */
export const DEBT_CEILING_RIAL_DEFAULT = 10_000_000;
/** Basis points of the normal unit price charged for over-lease usage. 10_000 = 1.0x. */
export const OVER_LEASE_PRICE_BPS_DEFAULT = 10_000;

export const LOCK_POLICIES = ["block", "read_only"] as const;
export type LockPolicy = (typeof LOCK_POLICIES)[number];

export type CreditLeaseState = "lease" | "over_lease_debt" | "locked";

/** The superadmin settings, set per plan with a global default. */
export interface CreditLeaseSettings {
  offlineWindowDays: number;
  debtCeilingRial: number;
  overLeasePriceBps: number;
  lockPolicy: LockPolicy;
}

export const CREDIT_LEASE_SETTINGS_DEFAULT: Readonly<CreditLeaseSettings> = {
  offlineWindowDays: OFFLINE_WINDOW_DAYS_DEFAULT,
  debtCeilingRial: DEBT_CEILING_RIAL_DEFAULT,
  overLeasePriceBps: OVER_LEASE_PRICE_BPS_DEFAULT,
  lockPolicy: "read_only",
};

/** Bounds shared by the API validation and the CHECK constraints in the migration. */
export const OFFLINE_WINDOW_DAYS_MAX = 30;
export const OVER_LEASE_PRICE_BPS_MAX = 1_000_000;

export type SettingsProblem =
  | "bad_offline_window_days"
  | "bad_debt_ceiling_rial"
  | "bad_over_lease_price_bps"
  | "bad_lock_policy";

export function validateCreditLeaseSettings(s: CreditLeaseSettings): SettingsProblem | null {
  if (!Number.isInteger(s.offlineWindowDays) || s.offlineWindowDays < 1 || s.offlineWindowDays > OFFLINE_WINDOW_DAYS_MAX) {
    return "bad_offline_window_days";
  }
  if (!Number.isSafeInteger(s.debtCeilingRial) || s.debtCeilingRial < 0) return "bad_debt_ceiling_rial";
  if (!Number.isInteger(s.overLeasePriceBps) || s.overLeasePriceBps < 1 || s.overLeasePriceBps > OVER_LEASE_PRICE_BPS_MAX) {
    return "bad_over_lease_price_bps";
  }
  if (!(LOCK_POLICIES as readonly string[]).includes(s.lockPolicy)) return "bad_lock_policy";
  return null;
}

/**
 * A plan overrides the global default field by field; a field it leaves
 * undefined (NULL in the table) falls through. The result is validated, so a
 * bad stored row fails loudly instead of silently granting unlimited debt.
 */
export function resolveCreditLeaseSettings(
  global: CreditLeaseSettings,
  planOverride?: Partial<CreditLeaseSettings> | null,
): CreditLeaseSettings {
  const merged: CreditLeaseSettings = { ...global };
  for (const key of Object.keys(planOverride ?? {}) as (keyof CreditLeaseSettings)[]) {
    const value = planOverride?.[key];
    if (value !== undefined && value !== null) (merged as unknown as Record<string, unknown>)[key] = value;
  }
  const problem = validateCreditLeaseSettings(merged);
  if (problem) throw new Error(problem);
  return merged;
}

/** What a meter has used on one lease, as the site and the cloud both count it. */
export interface MeterPosition {
  unitsGranted: number;
  /** Units spent inside the lease (never above `unitsGranted`). */
  unitsUsed: number;
  leaseExpired: boolean;
  /** Outstanding over-lease debt, integer Rial. */
  debtRial: number;
}

export function leaseIsExhausted(position: MeterPosition): boolean {
  return position.leaseExpired || position.unitsUsed >= position.unitsGranted;
}

export function meterState(position: MeterPosition, settings: CreditLeaseSettings): CreditLeaseState {
  if (!leaseIsExhausted(position)) return "lease";
  // A ceiling of zero means "no debt allowed": the lease running out locks at once.
  return position.debtRial >= settings.debtCeilingRial ? "locked" : "over_lease_debt";
}

/** Integer Rial, rounded up so a fraction of a Rial is never given away. */
export function overLeaseCostRial(overUnits: number, unitPriceRial: number, overLeasePriceBps: number): number {
  assertNonNegativeInteger(overUnits, "over_units");
  assertNonNegativeInteger(unitPriceRial, "unit_price_rial");
  assertNonNegativeInteger(overLeasePriceBps, "over_lease_price_bps");
  const numerator = BigInt(overUnits) * BigInt(unitPriceRial) * BigInt(overLeasePriceBps);
  const bps = 10_000n;
  const cost = (numerator + bps - 1n) / bps;
  if (cost > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("over_lease_cost_overflow");
  return Number(cost);
}

export interface UsageResult {
  /** Units covered by the lease. */
  leaseUnits: number;
  /** Units beyond the lease, recorded as `over_lease` and billed as debt. */
  overLeaseUnits: number;
  debtAddedRial: number;
  next: MeterPosition;
  state: CreditLeaseState;
}

/**
 * Apply one metered use. A use that is already happening is always recorded:
 * the unit that crosses the ceiling is accepted (a sale is never half-closed),
 * and the lock then applies to the next one.
 */
export function recordUsage(
  position: MeterPosition,
  quantity: number,
  unitPriceRial: number,
  settings: CreditLeaseSettings,
): UsageResult {
  if (!Number.isSafeInteger(quantity) || quantity < 1) throw new Error("bad_quantity");
  const remaining = position.leaseExpired ? 0 : Math.max(0, position.unitsGranted - position.unitsUsed);
  const leaseUnits = Math.min(quantity, remaining);
  const overLeaseUnits = quantity - leaseUnits;
  const debtAddedRial = overLeaseCostRial(overLeaseUnits, unitPriceRial, settings.overLeasePriceBps);
  const next: MeterPosition = {
    ...position,
    unitsUsed: position.unitsUsed + leaseUnits,
    debtRial: position.debtRial + debtAddedRial,
  };
  return { leaseUnits, overLeaseUnits, debtAddedRial, next, state: meterState(next, settings) };
}

/** Top-ups and settlements pay debt first; the rest is returned as usable credit. */
export function payDownDebt(debtRial: number, availableRial: number): { paidRial: number; remainingDebtRial: number; leftoverRial: number } {
  assertNonNegativeInteger(debtRial, "debt_rial");
  assertNonNegativeInteger(availableRial, "available_rial");
  const paidRial = Math.min(debtRial, availableRial);
  return { paidRial, remainingDebtRial: debtRial - paidRial, leftoverRial: availableRial - paidRial };
}

/** Whole percent of the ceiling used. A zero ceiling reads as 100% once any debt state is reached. */
export function debtPercent(debtRial: number, ceilingRial: number): number {
  if (ceilingRial <= 0) return 100;
  return Math.min(100, Math.floor((Math.max(0, debtRial) * 100) / ceilingRial));
}

/**
 * Lease units left, as a whole percent, for the 50 / 20 / 5 % warnings.
 * Returns the lowest threshold crossed, or null when above all of them.
 */
export const QUOTA_THRESHOLDS = [50, 20, 5] as const;
export function quotaThreshold(unitsGranted: number, unitsUsed: number): (typeof QUOTA_THRESHOLDS)[number] | null {
  if (unitsGranted <= 0) return null;
  const remainingPercent = Math.max(0, ((unitsGranted - unitsUsed) * 100) / unitsGranted);
  let crossed: (typeof QUOTA_THRESHOLDS)[number] | null = null;
  for (const threshold of QUOTA_THRESHOLDS) if (remainingPercent <= threshold) crossed = threshold;
  return crossed;
}

/** Actions that stay available in every state, locked included. */
export const NEVER_BLOCKED_ACTIONS = [
  "close_open_order",
  "close_shift",
  "print_receipt",
  "export_data",
  "backup",
  "login",
] as const;
export type NeverBlockedAction = (typeof NEVER_BLOCKED_ACTIONS)[number];

export type AccessIntent = NeverBlockedAction | "start_metered" | "other_write" | "read";

export interface AccessDecision {
  allowed: boolean;
  reason: "ok" | "locked_block" | "locked_read_only";
}

/**
 * `block` refuses to start new metered work; `read_only` also refuses every
 * other write. Reads and the never-blocked actions are always allowed. Debt
 * (not yet locked) never refuses anything: that is the point of the debt state.
 */
export function decideAccess(state: CreditLeaseState, lockPolicy: LockPolicy, intent: AccessIntent): AccessDecision {
  if (state !== "locked") return { allowed: true, reason: "ok" };
  if (intent === "read" || (NEVER_BLOCKED_ACTIONS as readonly string[]).includes(intent)) {
    return { allowed: true, reason: "ok" };
  }
  if (intent === "start_metered") {
    return { allowed: false, reason: lockPolicy === "block" ? "locked_block" : "locked_read_only" };
  }
  // other_write
  return lockPolicy === "read_only" ? { allowed: false, reason: "locked_read_only" } : { allowed: true, reason: "ok" };
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`bad_${name}`);
}
