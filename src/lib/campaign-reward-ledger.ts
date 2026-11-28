/**
 * Issue #901, Wave 2 — the cashback reward position, as pure arithmetic.
 *
 * A customer's reward balance is never a counter somebody increments. It is
 * derived from an append-only set of events (`growth_reward_events`), and this
 * file is the one place that derivation is written down: what "remaining"
 * means, what "spendable right now" means, and how a payout is allocated
 * across the entitlements that hold it.
 *
 * It is framework-free and database-free on purpose. The reward service
 * (`campaign-reward-service.ts`) enforces these rules against Postgres, the
 * Growth screens read the same numbers to show them, and the tests can prove
 * the arithmetic without a database. If a rule about money lived only in SQL,
 * the screen and the till could disagree about a customer's balance.
 *
 * ## Money is integer Rial
 *
 * Every amount here is a non-negative safe integer in Rial. Percentages were
 * already resolved to Rial by `rewardForSale` (`campaign-builder.ts`, BigInt)
 * before a position exists, so nothing in this module multiplies or divides.
 *
 * ## The lifecycle
 *
 *   earned    the position is created; it is `pending` until the return hold
 *             (`available_at`) passes, and its liability is recognised now.
 *   (no event) pending → available: a spendability change, not a posting.
 *   redeemed  a payout consumes part or all of `remaining`.
 *   reversed  a refund/cancellation takes back **only the unspent remainder**;
 *             a reward a customer already spent cannot be clawed back from
 *             their next order, so the shortfall is recorded separately.
 *   expired   the validity window ended with value still unspent.
 *   restored  a till tender was refunded and the value goes back to the
 *             wallet: the mirror of `redeemed`, and its own event because the
 *             amounts are positive and a balance is a SUM over these rows.
 */

/** How long a granted reward stays usable after it becomes available. */
export const CAMPAIGN_REWARD_VALIDITY_DAYS = 180;

/** The maximum a single campaign can grant per order — a sanity ceiling, not a business rule. */
export const MAX_REWARD_RIAL = 2_000_000_000;

export const REWARD_EVENT_TYPES = ["earned", "redeemed", "reversed", "expired", "restored"] as const;
export type RewardEventType = (typeof REWARD_EVENT_TYPES)[number];

export const REWARD_STATUSES = [
  "pending",
  "available",
  "partially_redeemed",
  "redeemed",
  "expired",
  "reversed",
] as const;
export type RewardStatus = (typeof REWARD_STATUSES)[number];

/** The statuses whose value can still be spent. */
export const SPENDABLE_REWARD_STATUSES: readonly RewardStatus[] = ["pending", "available", "partially_redeemed"];

export interface RewardPosition {
  earnedRial: number;
  redeemedRial: number;
  reversedRial: number;
  expiredRial: number;
  /** A refund larger than the unspent reward. Reported, never netted into a negative balance. */
  unrecoveredRial: number;
  /** ISO instant the return hold ends. */
  availableAt: string;
  /** ISO instant the reward stops being spendable. */
  expiresAt: string;
}

function nonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** Value still owed to the customer: earned minus everything that has left the position. */
export function remainingRial(position: RewardPosition): number {
  const remaining =
    nonNegative(position.earnedRial) -
    nonNegative(position.redeemedRial) -
    nonNegative(position.reversedRial) -
    nonNegative(position.expiredRial);
  return remaining > 0 ? remaining : 0;
}

/**
 * Value a customer can spend at `now`: only the remaining value whose hold has
 * ended and whose validity has not. A pending reward is a promise, not money.
 */
export function spendableRial(position: RewardPosition, now: Date): number {
  if (new Date(position.availableAt).getTime() > now.getTime()) return 0;
  if (new Date(position.expiresAt).getTime() <= now.getTime()) return 0;
  return remainingRial(position);
}

/** The status a position's numbers imply at `now` — the projection the list and the till read. */
export function deriveRewardStatus(position: RewardPosition, now: Date): RewardStatus {
  const remaining = remainingRial(position);
  if (remaining === 0) {
    if (nonNegative(position.expiredRial) > 0) return "expired";
    if (nonNegative(position.redeemedRial) >= nonNegative(position.earnedRial)) return "redeemed";
    return "reversed";
  }
  if (new Date(position.expiresAt).getTime() <= now.getTime()) return "expired";
  if (nonNegative(position.redeemedRial) > 0) return "partially_redeemed";
  if (new Date(position.availableAt).getTime() <= now.getTime()) return "available";
  return "pending";
}

/**
 * How much of `amount` the return hold has *not* yet released, used by the
 * report to separate a promise from spendable money.
 */
export function pendingRial(position: RewardPosition, now: Date): number {
  const remaining = remainingRial(position);
  return remaining - spendableRial(position, now);
}

export interface RedemptionAllocation {
  entitlementId: string;
  amountRial: number;
}

export interface RedemptionPlan {
  allocations: RedemptionAllocation[];
  totalRial: number;
  /** Value that was spendable but not needed — the caller shows it as "remaining after this". */
  leftoverRial: number;
}

export type RedemptionPlanResult =
  | { ok: true; plan: RedemptionPlan }
  | { ok: false; reason: "invalid_amount" | "insufficient"; availableRial: number };

/**
 * Allocate one payout across the customer's spendable entitlements, soonest
 * expiry first.
 *
 * Soonest-expiry-first is not a preference: a reward that expires next month
 * is worth less to the customer than one that expires next year, so spending
 * the near-expiry lots first is the only allocation that never wastes value.
 * Ties break on available-at and then entitlement id, so the same inputs always
 * produce the same plan — a retried request cannot pay a different order.
 */
export function planRedemption(
  positions: readonly (RewardPosition & { entitlementId: string })[],
  amountRial: number,
  now: Date,
): RedemptionPlanResult {
  if (!Number.isSafeInteger(amountRial) || amountRial <= 0) {
    return { ok: false, reason: "invalid_amount", availableRial: 0 };
  }

  const spendable = positions
    .map((position) => ({ ...position, spendable: spendableRial(position, now) }))
    .filter((position) => position.spendable > 0)
    .sort((a, b) => {
      const expiry = new Date(a.expiresAt).getTime() - new Date(b.expiresAt).getTime();
      if (expiry !== 0) return expiry;
      const available = new Date(a.availableAt).getTime() - new Date(b.availableAt).getTime();
      if (available !== 0) return available;
      return a.entitlementId < b.entitlementId ? -1 : a.entitlementId > b.entitlementId ? 1 : 0;
    });

  const availableRial = spendable.reduce((total, position) => total + position.spendable, 0);
  if (availableRial < amountRial) return { ok: false, reason: "insufficient", availableRial };
  if (availableRial > MAX_REWARD_RIAL) {
    // Defensive: an implausible balance means the rows are wrong, not that the
    // customer is rich. Refuse rather than pay it out.
    return { ok: false, reason: "insufficient", availableRial: 0 };
  }

  const allocations: RedemptionAllocation[] = [];
  let remaining = amountRial;
  for (const position of spendable) {
    if (remaining === 0) break;
    const take = Math.min(position.spendable, remaining);
    allocations.push({ entitlementId: position.entitlementId, amountRial: take });
    remaining -= take;
  }

  return {
    ok: true,
    plan: { allocations, totalRial: amountRial, leftoverRial: availableRial - amountRial },
  };
}

/**
 * How much of a till tender a cumulative refund has made restorable.
 *
 * `refundedRial` is what the order has been refunded so far (every return and
 * reversal on it), `tenderedRial` what the reward paid for. A refund can never
 * give back more reward than was spent on the bill, so the smaller of the two
 * wins — and because the caller stores how much it has already restored, a
 * repeated pass restores only the difference. That is the whole idempotency
 * argument for a restore: one subtraction, no counters.
 */
export function restorableTenderRial(tenderedRial: number, refundedRial: number): number {
  return Math.min(nonNegative(tenderedRial), nonNegative(refundedRial));
}

/**
 * Split a restore across the lots a tender consumed.
 *
 * The spending order is soonest-expiry-first (`planRedemption`), so a restore
 * walks the other way: value goes back to the longest-lived lots first, which
 * is what keeps a refunded reward from landing on a lot that expires tomorrow.
 * Each lot can only take back what it gave, and the walk stops when the
 * restore is covered — deterministic for the same inputs, like the plan.
 */
export function planTenderRestore(
  consumed: readonly RedemptionAllocation[],
  restoreRial: number,
): RedemptionAllocation[] {
  let remaining = nonNegative(restoreRial);
  const allocations: RedemptionAllocation[] = [];
  for (let index = consumed.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const lot = consumed[index];
    const take = Math.min(nonNegative(lot.amountRial), remaining);
    if (take <= 0) continue;
    allocations.push({ entitlementId: lot.entitlementId, amountRial: take });
    remaining -= take;
  }
  return allocations;
}

/**
 * Whether a new grant may be made: the campaign must be live, the sale inside
 * the campaign's own window, and the reward must fit the remaining budget
 * whole. A reward that does not fit is refused, never granted part-paid — the
 * customer was promised one number.
 */
export function budgetAllows(spentRial: number, budgetRial: number, rewardRial: number): boolean {
  if (rewardRial <= 0) return false;
  const spent = nonNegative(spentRial);
  return spent + rewardRial <= nonNegative(budgetRial);
}

/**
 * The per-customer cap clips rather than blocks: a customer 3 000 Rial short of
 * their cap still earns 3 000. `null` cap = no ceiling.
 */
export function clipToCustomerCap(
  capRial: number | null,
  alreadyEarnedRial: number,
  rewardRial: number,
): number {
  if (capRial === null) return rewardRial;
  const room = nonNegative(capRial) - nonNegative(alreadyEarnedRial);
  if (room <= 0) return 0;
  return Math.min(rewardRial, room);
}

/** True when the value is a plausible Rial amount for a single reward. */
export function isRewardAmount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= MAX_REWARD_RIAL;
}
