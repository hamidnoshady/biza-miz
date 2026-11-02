/**
 * Issue #902 §9 item 3 (last part) — comparing a supplier's invoice with our own
 * record of what that supplier charged us.
 *
 * Two independent records of the same money:
 *
 *   * **ours** — `billing_vendor_cost_events`, one row per accepted send, written
 *     by the send path from the provider's own reported cost (§6a);
 *   * **the supplier's** — a statement for a period, with a total.
 *
 * The comparison is arithmetic, and arithmetic is where reconciliation usually
 * goes wrong: a small difference is rounded into "fine", a large one is explained
 * by adjusting the ledger, and a statement that could not be compared at all
 * (`recorded = 0`) is called "matched" because `0 ≈ 0`. This module exists so
 * each of those is a named verdict instead of a judgment call inside a query:
 *
 *   - **`matched`** — the difference is inside the tolerance.
 *   - **`disputed`** — it is outside, and the sign says who owes whom.
 *   - **`unexplained`** — we recorded *nothing* for a period the supplier billed.
 *     That is not a small mismatch; it is a missing half of the books, and it must
 *     never read as a pass just because `|delta| ≤ tolerance` could be arranged.
 *
 * Two rules the callers rely on:
 *
 *   1. **The tolerance is explicit and stored.** An exact match is unrealistic —
 *     a supplier rounds, bundles, and bills a send we recorded a minute later —
 *     so the tolerance is a parameter with a default, written next to the verdict
 *     it produced. It is never a silent fudge factor.
 *   2. **Nothing here writes to the evidence.** Reconciling reads the ledger; it
 *      does not add or correct a cost event to make a statement fit. A ledger
 *      adjusted to match an invoice can no longer test the next invoice.
 *
 * Pure — no database import — so the console can render a verdict and the service
 * can be tested without a pool.
 */

/** How a statement compares with our record. */
export type SupplierInvoiceState = "open" | "matched" | "disputed" | "accepted";

/** The comparison, before any human decision. */
export type SupplierVerdict = "matched" | "disputed" | "unexplained";

export interface SupplierComparisonInput {
  /** What the supplier's statement totals for the period. */
  claimedRial: number;
  /** What our cost events sum to for the same period. */
  recordedRial: number;
  /** How many of our cost events fell in the period. */
  recordedEvents: number;
  /**
   * Rial allowed either way. Defaults to one message at a typical wholesale rate
   * — a supplier's rounding, not a licence to ignore a difference.
   */
  toleranceRial?: number;
}

export interface SupplierComparison {
  verdict: SupplierVerdict;
  /** `claimed − recorded`, sign kept. Positive = the supplier wants more. */
  deltaRial: number;
  /** The tolerance actually applied, so the verdict is reproducible. */
  toleranceRial: number;
  /** A first-party sentence for the console. */
  reason: string;
}

export const DEFAULT_SUPPLIER_TOLERANCE_RIAL = 1_000;

function money(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

/**
 * Compare a statement with our record.
 *
 * `unexplained` is checked **before** the tolerance, and deliberately: if the
 * supplier billed a period we have no events for, the difference is the whole
 * claim — but on a `claimed = 0` statement the arithmetic would say "perfect
 * match" about a period nobody recorded anything in. The state of the books, not
 * the size of the difference, decides this one.
 */
export function compareSupplierStatement(input: SupplierComparisonInput): SupplierComparison {
  const claimed = money(input.claimedRial);
  const recorded = money(input.recordedRial);
  const events = Math.max(0, Math.trunc(input.recordedEvents));
  const tolerance = money(input.toleranceRial ?? DEFAULT_SUPPLIER_TOLERANCE_RIAL);
  const deltaRial = claimed - recorded;

  if (events === 0 && claimed > 0) {
    return {
      verdict: "unexplained",
      deltaRial,
      toleranceRial: tolerance,
      reason: "برای این دوره هیچ هزینه‌ای در دفتر ما ثبت نشده است؛ این اختلاف کوچک نیست، نیمی از دفتر است.",
    };
  }

  if (Math.abs(deltaRial) <= tolerance) {
    return {
      verdict: "matched",
      deltaRial,
      toleranceRial: tolerance,
      reason:
        deltaRial === 0
          ? "مبلغ صورت‌حساب با دفتر ما برابر است."
          : "اختلاف در محدودهٔ تلورانس است و همان‌طور گزارش می‌شود، نه با گرد کردن.",
    };
  }

  return {
    verdict: "disputed",
    deltaRial,
    toleranceRial: tolerance,
    reason:
      deltaRial > 0
        ? "صورت‌حساب بیشتر از دفتر ماست: ارائه‌دهنده چیزی را حساب کرده که ما ثبت نکرده‌ایم."
        : "صورت‌حساب کمتر از دفتر ماست: ما هزینه‌ای را ثبت کرده‌ایم که در صورت‌حساب نیامده.",
  };
}

/** The stored state a fresh verdict maps to, when nothing has been accepted. */
export function stateForVerdict(verdict: SupplierVerdict): SupplierInvoiceState {
  // `unexplained` is a dispute, and the strictest kind: there is no arithmetic to
  // argue about, only a missing half of the books.
  return verdict === "matched" ? "matched" : "disputed";
}

/** Persian labels for the console. First-party words; no supplier vocabulary. */
export const SUPPLIER_STATE_LABELS: Record<SupplierInvoiceState, string> = {
  open: "بررسی‌نشده",
  matched: "منطبق",
  disputed: "اختلاف",
  accepted: "پذیرفته‌شده با توضیح",
};

/**
 * Whether a statement may be reconciled again.
 *
 * An `accepted` one may not: a human has already decided to pay it, with a
 * reason, and a later pass that overwrote the verdict would erase that decision
 * while leaving the money paid. Everything else may — late cost events are normal,
 * and re-checking is the point.
 */
export function canReconcile(state: SupplierInvoiceState): boolean {
  return state !== "accepted";
}

/**
 * Whether accepting a disagreement is allowed, and what it requires.
 *
 * Accepting is only meaningful for a `disputed` statement: accepting a matched
 * one is a no-op that would suggest a decision was needed, and an `open` one has
 * not been compared yet.
 */
export function canAccept(state: SupplierInvoiceState, reason: string): { ok: true } | { ok: false; code: string } {
  if (state !== "disputed") return { ok: false, code: "not_disputed" };
  if (reason.trim().length === 0) return { ok: false, code: "reason_required" };
  return { ok: true };
}
