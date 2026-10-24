/**
 * Issue #933 — the framework-free half of a shift's cash-up.
 *
 * A shift used to be a start time, an end time and two optional floats. The
 * closing figures — what was taken by each tender, what the drawer should have
 * held, what was actually counted — were recomputed from live `orders` and
 * `payments` rows every time anybody looked, so a refund or a closed-order
 * amendment after the fact silently rewrote a variance that had already been
 * signed off.
 *
 * Two things changed, and this file is where both are decided:
 *
 *   * A cash-up is a *snapshot* taken at closing time and stored (migration
 *     0233). This module builds that snapshot from raw totals, and is the only
 *     place the arithmetic lives — the service reads rows, this decides what
 *     they mean.
 *   * "Expected cash" is not `opening float + cash sales`. Cash arrives in a
 *     drawer by more than one route (a float brought in, a customer paying a
 *     tab at the counter) and leaves by more than one (a paid-out, a safe drop,
 *     a handover). Those are `shift_cash_movements`, and they are part of the
 *     expectation with a reason and an actor attached.
 *
 * Unresolved is a first-class outcome, not a zero: a shift closed without a
 * physical count stores NULL counted cash and NULL variance. Migration 0233's
 * CHECK constraint enforces that, so "nobody counted" can never be mistaken for
 * "the drawer matched".
 */

/** The settlement classes the ledger knows (payment_method enum, migration 0091). */
export const SHIFT_TENDER_CLASSES = [
  "cash",
  "card",
  "cardToCard",
  "online",
  "credit",
  "snappfood",
  "cheque",
  "other",
] as const;

export type ShiftTenderClass = (typeof SHIFT_TENDER_CLASSES)[number];

/**
 * Every tender class, in Rial, plus the total.
 *
 * `cheque` is deliberately its own class and never folded into `cash`: the
 * product does not accept a cheque at the till (see payment-methods.ts), and a
 * cheque that somehow reached `payments` is not money in the drawer. The same
 * is true of `credit` — a tab is revenue, never cash. Only `cash` feeds the
 * expected drawer.
 */
export interface ShiftTenderTotals {
  cash: number;
  card: number;
  cardToCard: number;
  online: number;
  credit: number;
  snappfood: number;
  cheque: number;
  other: number;
  /** Sum of every class above. */
  total: number;
}

export function emptyTenderTotals(): ShiftTenderTotals {
  return {
    cash: 0,
    card: 0,
    cardToCard: 0,
    online: 0,
    credit: 0,
    snappfood: 0,
    cheque: 0,
    other: 0,
    total: 0,
  };
}

/** The database's snake_case method name → this module's camelCase class. */
export function tenderClassForMethod(method: string): ShiftTenderClass {
  switch (method) {
    case "cash":
      return "cash";
    case "card":
      return "card";
    case "card_to_card":
      return "cardToCard";
    case "online":
      return "online";
    case "credit":
      return "credit";
    case "snappfood":
      return "snappfood";
    case "cheque":
      return "cheque";
    default:
      return "other";
  }
}

/**
 * Adds up payment rows by settlement class.
 *
 * Takes the raw `{ method, amount }` shape rather than a pre-aggregated row so
 * the same rule can sum a database result, a sync payload and a test fixture.
 * Non-finite or fractional amounts are ignored — every writer stores integer
 * Rial, and a value that is not one is a bug this must not propagate into a
 * cash-up.
 */
export function tallyTenders(rows: readonly { method: string; amount: number | string }[]): ShiftTenderTotals {
  const totals = emptyTenderTotals();
  for (const row of rows) {
    const amount = typeof row.amount === "string" ? Number(row.amount) : row.amount;
    if (!Number.isSafeInteger(amount) || amount === 0) continue;
    totals[tenderClassForMethod(row.method)] += amount;
    totals.total += amount;
  }
  return totals;
}

/** The cash-only portion — the only class that belongs in a physical drawer. */
export function cashInDrawerFromSales(totals: ShiftTenderTotals): number {
  return totals.cash;
}

export const SHIFT_CLOSE_MODES = ["counted", "unresolved"] as const;
export type ShiftCloseMode = (typeof SHIFT_CLOSE_MODES)[number];

export interface CashDrawerInput {
  /** The float the shift opened with; NULL when the shift never tracked one. */
  openingFloat: number | null;
  /** Cash settled on this shift's orders (not card, credit, cheque or SnapFood). */
  cashSales: number;
  /** Cash brought into this drawer after opening (a float top-up, a tab paid at the counter). */
  cashIn?: number;
  /** Cash taken out with a reason (a paid-out, a safe drop, a handover). */
  cashOut?: number;
  /** What a person physically counted, or NULL when nobody did. */
  countedCash: number | null;
}

export type CashDrawerStatus = "balanced" | "variance" | "unresolved";

export interface CashDrawerReconciliation {
  /** NULL when there is no opening float to compare against. */
  expectedCash: number | null;
  /** NULL when there is no expected figure or no count. */
  variance: number | null;
  status: CashDrawerStatus;
}

/**
 * The drawer arithmetic, with "unknown" kept distinct from zero.
 *
 * `expected = opening float + cash sales + cash in − cash out`. A shift with no
 * opening float has no baseline: it is unresolved whatever was counted, because
 * comparing a count against an assumption of zero is how an uncounted float
 * becomes a fabricated variance.
 */
export function reconcileDrawer(input: CashDrawerInput): CashDrawerReconciliation {
  const cashIn = input.cashIn ?? 0;
  const cashOut = input.cashOut ?? 0;
  const expectedCash =
    input.openingFloat === null
      ? null
      : input.openingFloat + input.cashSales + cashIn - cashOut;
  if (expectedCash === null || input.countedCash === null) {
    return { expectedCash, variance: null, status: "unresolved" };
  }
  const variance = input.countedCash - expectedCash;
  return { expectedCash, variance, status: variance === 0 ? "balanced" : "variance" };
}

/**
 * How the tender buckets relate to the shift's gross sales.
 *
 * A shift's gross is the sum of its completed orders; the tenders are the
 * payment rows that settled them. They should be equal. When they are not, the
 * difference is stated instead of hidden: a credit tab, a SnapFood settlement,
 * a cheque recorded on the order and an amendment's superseded/negative rows are
 * the ordinary reasons, and a reviewer needs to see which applies rather than
 * being told the numbers simply do not add up.
 */
export interface TenderTieOut {
  grossTotal: number;
  tenderedTotal: number;
  /** gross − tendered. Positive means part of the sale has no payment row; negative means payments exceed sales. */
  difference: number;
  explainsGross: boolean;
  /** Classes that actually carry money for this shift, in display order. */
  lines: { method: ShiftTenderClass; amount: number }[];
}

export function tenderTieOut(grossTotal: number, totals: ShiftTenderTotals): TenderTieOut {
  const difference = grossTotal - totals.total;
  return {
    grossTotal,
    tenderedTotal: totals.total,
    difference,
    explainsGross: difference === 0,
    lines: SHIFT_TENDER_CLASSES.filter((method) => totals[method] !== 0).map((method) => ({
      method,
      amount: totals[method],
    })),
  };
}

/** The longest reason an adjustment or an uncounted close may carry. */
export const MAX_SHIFT_REASON_LENGTH = 500;

export interface ShiftCloseInput {
  /** The physically counted drawer, or NULL when this close has no count. */
  countedCash: number | null;
  mode: ShiftCloseMode;
  reason: string | null;
}

export type ShiftCloseParseFailure =
  | "bad_request"
  | "invalid_amount"
  | "count_required"
  | "reason_required";

export type ShiftCloseParseResult =
  | { ok: true; value: ShiftCloseInput }
  | { ok: false; error: ShiftCloseParseFailure };

export interface ShiftCloseParseOptions {
  /**
   * True when this close must carry a physical count. No current caller requires
   * one — a waiter's shift has no drawer — but the admin force-close path uses
   * it to refuse an empty "counted" form while still allowing an explicit
   * unresolved close.
   */
  requireCount?: boolean;
  /**
   * True for an administrative force-close: closing somebody else's forgotten
   * shift without a count is a decision that must be explained and audited.
   * A member ending their own shift is not asked for a reason.
   */
  requireReasonWhenUncounted?: boolean;
}

function asObject(raw: unknown): Record<string, unknown> {
  // Arrays and primitives are refused rather than read through: `[].openingFloat`
  // is undefined, `"x".trim` throws, and a JSON `null` body would otherwise pass
  // every `!== undefined` check and reach the database as a missing value.
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) return {};
  return raw as Record<string, unknown>;
}

/**
 * Reads the body of a close request.
 *
 * `closingFloat` is the original field name and is still accepted, so an older
 * client keeps working; `countedCash` is the same number under the name that
 * says what it is. Sending both with different values is a client bug, not a
 * choice this may make for it.
 *
 * `withoutCount: true` is the explicit "close it, nobody counted" action the
 * history screen offers. It is deliberately distinct from an omitted amount, so
 * a form that lost its input cannot silently close a shift unresolved.
 */
export function parseShiftCloseInput(
  raw: unknown,
  options: ShiftCloseParseOptions = {},
): ShiftCloseParseResult {
  const body = asObject(raw);
  if (raw !== null && raw !== undefined && (typeof raw !== "object" || Array.isArray(raw))) {
    return { ok: false, error: "bad_request" };
  }

  const withoutCount = body.withoutCount === true;
  if (body.withoutCount !== undefined && typeof body.withoutCount !== "boolean") {
    return { ok: false, error: "bad_request" };
  }

  const rawCount = body.countedCash ?? body.closingFloat;
  if (body.countedCash !== undefined && body.closingFloat !== undefined && body.countedCash !== body.closingFloat) {
    return { ok: false, error: "bad_request" };
  }

  let countedCash: number | null = null;
  if (rawCount !== undefined && rawCount !== null) {
    if (typeof rawCount !== "number" || !Number.isSafeInteger(rawCount) || rawCount < 0) {
      return { ok: false, error: "invalid_amount" };
    }
    countedCash = rawCount;
  }

  if (withoutCount && countedCash !== null) {
    return { ok: false, error: "bad_request" };
  }
  if (options.requireCount && countedCash === null) {
    return { ok: false, error: "count_required" };
  }

  let reason: string | null = null;
  if (body.reason !== undefined && body.reason !== null) {
    if (typeof body.reason !== "string") return { ok: false, error: "bad_request" };
    const trimmed = body.reason.trim();
    if (trimmed.length > MAX_SHIFT_REASON_LENGTH) return { ok: false, error: "bad_request" };
    reason = trimmed || null;
  }

  const mode: ShiftCloseMode = countedCash === null ? "unresolved" : "counted";
  if (mode === "unresolved" && options.requireReasonWhenUncounted && !reason) {
    return { ok: false, error: "reason_required" };
  }

  return { ok: true, value: { countedCash, mode, reason } };
}

/**
 * Applies an audited correction to a finalized variance.
 *
 * The snapshot itself is never rewritten (migration 0233's trigger refuses it).
 * An adjustment records the delta, the before/after variance and the reason, so
 * "the drawer was ۲۰۰٬۰۰۰ short" and "a paid-out was found afterwards" are two
 * rows with two authors and two timestamps rather than one number that quietly
 * changed.
 */
export function applyVarianceAdjustment(
  variance: number | null,
  delta: number,
): { beforeVariance: number | null; afterVariance: number | null; delta: number } {
  if (variance === null) {
    // An unresolved cash-up has no variance to adjust; the adjustment is still
    // recorded (it may be the reason the drawer is now explainable) but it
    // cannot manufacture a before/after pair.
    return { beforeVariance: null, afterVariance: null, delta };
  }
  return { beforeVariance: variance, afterVariance: variance + delta, delta };
}
