/**
 * ESH-193 / #1378 — plan transitions (upgrade / downgrade) without overlap.
 *
 * Two properties this module makes structural rather than conventional:
 *
 *  - **No overlap.** A new paid interval starts where the old paid interval
 *    ends (the neutral policy) or the old interval is credited for exactly the
 *    unused days it will no longer serve (the daily policy). The two periods
 *    never both cover the same day.
 *  - **No retroactive repricing.** The elapsed part of the current interval is
 *    never touched: the credit is computed only from the remaining days, and
 *    the completed days keep their price.
 *
 * The policy is configuration (`billing_commercial_settings.proration_policy`),
 * never a request parameter. `none` is the default and matches today's
 * behaviour: the change waits for the period boundary.
 */
import { addCalendarMonths, wholeDaysBetween } from "./calendar";

export type ProrationPolicy = "none" | "daily";

export function isProrationPolicy(value: unknown): value is ProrationPolicy {
  return value === "none" || value === "daily";
}

export type TransitionKind = "upgrade" | "downgrade";

export interface TransitionQuoteInput {
  kind: TransitionKind;
  policy: ProrationPolicy;
  /** The instant the customer asked for the change. */
  at: string;
  current: {
    planKey: string;
    termMonths: number;
    periodStart: string;
    periodEnd: string;
    /** What was actually paid for the current period, integer Rial. */
    paidRial: number;
  };
  target: {
    planKey: string;
    /** The target plan's published monthly price, integer Rial. */
    monthlyPriceRial: number;
  };
  taxRate?: number;
}

export type TransitionRefusal =
  | "invalid_instant"
  | "invalid_period"
  | "retroactive_transition"
  | "same_plan"
  | "invalid_amount";

export interface TransitionQuote {
  ok: boolean;
  refusal: TransitionRefusal | null;
  kind: TransitionKind;
  policy: ProrationPolicy;
  /** Configures the explanation shown to the customer. */
  explanation: "immediate_prorated" | "at_period_end";
  /** Unused value of the current paid period, when the policy allows it. */
  creditRial: number;
  /** The prorated or full charge for the target plan. */
  chargeRial: number;
  taxRial: number;
  /** Positive = pay now; negative is impossible (credit is capped at the charge). */
  netRial: number;
  /** The interval the new charge covers; never overlaps the current one. */
  newPeriod: { start: string; end: string };
  /** When the change takes effect. */
  effectiveAt: string;
  /** Days of the current period still unserved at `at`. */
  remainingDays: number;
  /** Days in the current paid period (for the daily rate). */
  periodDays: number;
}

/**
 * Quote a transition. Pure and deterministic so the same facts produce the same
 * number in the tenant UI, the superadmin console and the settlement path.
 */
export function quotePlanTransition(input: TransitionQuoteInput): TransitionQuote {
  const at = Date.parse(input.at);
  const start = Date.parse(input.current.periodStart);
  const end = Date.parse(input.current.periodEnd);
  const paid = Math.max(0, Math.floor(input.current.paidRial));
  const monthly = Math.max(0, Math.floor(input.target.monthlyPriceRial));
  const taxRate = clampRate(input.taxRate ?? 0);

  const invalid = (refusal: TransitionRefusal): TransitionQuote => ({
    ok: false,
    refusal,
    kind: input.kind,
    policy: input.policy,
    explanation: input.policy === "daily" ? "immediate_prorated" : "at_period_end",
    creditRial: 0,
    chargeRial: 0,
    taxRial: 0,
    netRial: 0,
    newPeriod: { start: input.current.periodEnd, end: input.current.periodEnd },
    effectiveAt: input.current.periodEnd,
    remainingDays: 0,
    periodDays: 0,
  });

  if (!Number.isFinite(at) || !Number.isFinite(start) || !Number.isFinite(end)) {
    return invalid("invalid_instant");
  }
  if (end <= start) return invalid("invalid_period");
  if (at < start) return invalid("retroactive_transition");
  if (input.current.planKey === input.target.planKey) return invalid("same_plan");
  if (!Number.isSafeInteger(paid) || !Number.isSafeInteger(monthly)) return invalid("invalid_amount");

  const periodDays = Math.max(1, wholeDaysBetween(input.current.periodStart, input.current.periodEnd));
  const remainingDays = Math.max(0, Math.min(periodDays, wholeDaysBetween(input.at, input.current.periodEnd)));

  // Past the period boundary there is nothing left to credit, and the change is
  // an ordinary renewal-shaped purchase. Keep it simple and explicit.
  if (remainingDays === 0 || at >= end) {
    const newStart = new Date(Math.max(at, end)).toISOString();
    const chargeRial = monthly * Math.max(1, input.current.termMonths);
    const taxRial = Math.round(chargeRial * taxRate);
    return {
      ok: true,
      refusal: null,
      kind: input.kind,
      policy: input.policy,
      explanation: "at_period_end",
      creditRial: 0,
      chargeRial,
      taxRial,
      netRial: chargeRial + taxRial,
      newPeriod: {
        start: newStart,
        end: addCalendarMonths(newStart, Math.max(1, input.current.termMonths)),
      },
      effectiveAt: newStart,
      remainingDays: 0,
      periodDays,
    };
  }

  if (input.policy === "none") {
    // Wait for the boundary: charge a full new term starting at the old end.
    const newStart = new Date(end).toISOString();
    const termMonths = Math.max(1, input.current.termMonths);
    const chargeRial = monthly * termMonths;
    const taxRial = Math.round(chargeRial * taxRate);
    return {
      ok: true,
      refusal: null,
      kind: input.kind,
      policy: "none",
      explanation: "at_period_end",
      creditRial: 0,
      chargeRial,
      taxRial,
      netRial: chargeRial + taxRial,
      newPeriod: { start: newStart, end: addCalendarMonths(newStart, termMonths) },
      effectiveAt: newStart,
      remainingDays,
      periodDays,
    };
  }

  // daily: immediate, credit the unserved days, charge the target for the same
  // unserved days. Both use the same denominator, so a full-period transition
  // is exactly the sum of the two paid intervals.
  const creditRial = Math.min(paid, Math.round((paid * remainingDays) / periodDays));
  const chargeRial = Math.ceil((monthly * remainingDays) / periodDays);
  const taxRial = Math.round(chargeRial * taxRate);
  const netRial = Math.max(0, chargeRial + taxRial - creditRial);
  const effectiveAt = new Date(at).toISOString();
  return {
    ok: true,
    refusal: null,
    kind: input.kind,
    policy: "daily",
    explanation: "immediate_prorated",
    creditRial,
    chargeRial,
    taxRial,
    netRial,
    newPeriod: { start: effectiveAt, end: new Date(end).toISOString() },
    effectiveAt,
    remainingDays,
    periodDays,
  };
}

function clampRate(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
