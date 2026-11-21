/**
 * ESH-193 / #1378 — the term lifecycle, as rules rather than route branches.
 *
 * These rules are the acceptance list of the issue, written once and testable:
 *
 *  - auto-renew is an **explicit opt-in**; off means the term simply ends;
 *  - a renewal repeats **the selected term only** — a failed renewal never
 *    silently becomes a shorter (or longer) term;
 *  - an insufficient wallet uses the existing grace/`past_due` window and then
 *    lapses; it never creates debt and never reprices the period;
 *  - cancellation keeps access until the paid period ends;
 *  - reactivation after lapse starts a fresh paid period and never double-bills
 *    the period that already lapsed.
 *
 * Pure: the database half (renewal tick, grace columns) already exists in
 * `subscription-service.ts`; this module is the shared decision it and the
 * quote endpoints agree on.
 */
import { isPlanTermMonths, type PlanTermMonths } from "../quote/plan-quote";

export type SubscriptionLifecycleStatus = "trialing" | "active" | "past_due" | "cancelled" | "expired";

export type RenewalDecisionCode =
  | "not_due"
  | "cancel_at_period_end"
  | "auto_renew_disabled"
  | "renew_same_term"
  | "grace_period"
  | "lapse";

export interface RenewalDecision {
  code: RenewalDecisionCode;
  /** The term a paid renewal would buy. Never changes silently. */
  termMonths: PlanTermMonths;
  /** Amount a renewal needs in the wallet (0 when nothing is due). */
  amountRial: number;
  shortfallRial: number;
  /** Access continues until this instant whatever the decision. */
  accessUntil: string;
  /** A `past_due` renewal is retried until this instant. */
  graceUntil: string | null;
}

export interface RenewalInput {
  status: SubscriptionLifecycleStatus;
  termMonths: PlanTermMonths;
  currentPeriodEnd: string;
  autoRenew: boolean;
  cancelAtPeriodEnd: boolean;
  /** The renewal quote for the *same* term (Rial). */
  renewalAmountRial: number;
  walletBalanceRial: number;
  graceEnd: string | null;
  now: string;
  /** How long before the boundary a renewal may be attempted. */
  renewLeadHours?: number;
}

/**
 * Decide what a due renewal should do. `termMonths` in the result is always the
 * subscription's stored term — a caller cannot ask for a different one, which
 * is what makes "never silently switch to a shorter term" structural.
 */
export function decideRenewal(input: RenewalInput): RenewalDecision {
  if (!isPlanTermMonths(input.termMonths)) throw new Error("invalid_renewal_term");
  const amount = Math.max(0, Math.floor(input.renewalAmountRial));
  const balance = Math.max(0, Math.floor(input.walletBalanceRial));
  const shortfallRial = Math.max(0, amount - balance);
  const base = {
    termMonths: input.termMonths,
    amountRial: amount,
    shortfallRial,
    accessUntil: input.currentPeriodEnd,
    graceUntil: input.graceEnd,
  } as const;

  if (input.cancelAtPeriodEnd) {
    return { ...base, code: "cancel_at_period_end" };
  }

  const now = Date.parse(input.now);
  const end = Date.parse(input.currentPeriodEnd);
  if (!Number.isFinite(now) || !Number.isFinite(end)) throw new Error("invalid_renewal_instant");
  const leadMs = Math.max(0, input.renewLeadHours ?? 0) * 3_600_000;
  if (now < end - leadMs) {
    return { ...base, code: "not_due" };
  }

  if (!input.autoRenew) {
    return { ...base, code: "auto_renew_disabled" };
  }

  if (shortfallRial === 0) {
    return { ...base, code: "renew_same_term", shortfallRial: 0 };
  }

  // A grace window survives the boundary; after it, access lapses. This mirrors
  // the existing `grace_end`/`past_due` lifecycle and adds no new money rule.
  const grace = input.graceEnd ? Date.parse(input.graceEnd) : NaN;
  if (Number.isFinite(grace) && now < grace) {
    return { ...base, code: "grace_period" };
  }
  if (now < end && input.status !== "past_due") {
    // Before the boundary with insufficient funds: still due, but the lapse is
    // decided at the boundary, not early.
    return { ...base, code: "grace_period" };
  }
  return { ...base, code: "lapse" };
}

export interface CancellationEffect {
  /** Access the customer already paid for is preserved to this instant. */
  accessUntil: string;
  /** No further debit is made for this term. */
  nextChargeAt: null;
  /** The subscription is marked cancelled only at the boundary. */
  effectiveAt: string;
}

export function cancellationEffect(input: {
  currentPeriodEnd: string;
  now: string;
}): CancellationEffect {
  const end = Date.parse(input.currentPeriodEnd);
  const now = Date.parse(input.now);
  if (!Number.isFinite(end) || !Number.isFinite(now)) throw new Error("invalid_cancellation_instant");
  return {
    accessUntil: input.currentPeriodEnd,
    nextChargeAt: null,
    effectiveAt: new Date(Math.max(now, end)).toISOString(),
  };
}

export interface ReactivationPlan {
  /** A fresh paid period starts here; the lapsed period is never re-billed. */
  periodStart: string;
  /** Always the stored term. */
  termMonths: PlanTermMonths;
  /** True when the old lapse must be settled as expired, not charged. */
  closesLapsedPeriod: boolean;
}

export function reactivationPlan(input: {
  now: string;
  prevPeriodEnd: string | null;
  termMonths: PlanTermMonths;
  /** The subscription had already lapsed (expired/cancelled past its end). */
  lapsed: boolean;
}): ReactivationPlan {
  if (!isPlanTermMonths(input.termMonths)) throw new Error("invalid_reactivation_term");
  const now = Date.parse(input.now);
  if (!Number.isFinite(now)) throw new Error("invalid_reactivation_instant");
  const prevEnd = input.prevPeriodEnd ? Date.parse(input.prevPeriodEnd) : NaN;
  const start = input.lapsed && Number.isFinite(prevEnd) && prevEnd > now
    ? input.prevPeriodEnd!
    : new Date(now).toISOString();
  return {
    periodStart: start,
    termMonths: input.termMonths,
    closesLapsedPeriod: input.lapsed,
  };
}
