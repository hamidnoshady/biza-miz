/**
 * Phase 20 Wave 5 — shift tracking: the framework-free half.
 *
 * A shift's own open/closed state and the cash-reconciliation arithmetic
 * once both a starting and an ending float are known. Everything that
 * touches the database — opening/closing a shift, resolving which session
 * or device it came from, and summing the orders it covers — lives in
 * shift-service.ts.
 */

export type ShiftState = "open" | "closed";

export interface ShiftLike {
  endedAt: string | Date | null;
}

/**
 * A shift is open exactly as long as it has no end time — no separate status
 * column, the same "opened_at/closed_at instead of an enum" shape orders and
 * table_sessions already use.
 */
export function shiftStatus(shift: ShiftLike): ShiftState {
  return shift.endedAt ? "closed" : "open";
}

/**
 * Whole-Rial, non-negative, and inside the range JavaScript can represent
 * exactly (#933 item 13).
 *
 * `Number.isInteger` is true for 1e21, which is not a Rial amount and not a
 * value `bigint`/`Number` round-trips: the sync path already used
 * `Number.isSafeInteger` for exactly this reason, so a float that arrived by
 * one door was accepted and by the other refused. Zero is valid — an empty
 * drawer is a real count.
 */
export function isValidCashFloat(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export interface CashReconciliation {
  expectedCash: number;
  variance: number;
}

/**
 * Only meaningful when a shift tracked a float on both ends — callers
 * (shift-service.ts's closeShift) skip this entirely for a shift with no
 * opening float rather than reconciling against an assumed zero, since a
 * waiter/kitchen shift (or a cashier who chose not to count in) never had a
 * baseline to compare against in the first place.
 */
export function reconcileCash(
  openingFloat: number,
  closingFloat: number,
  cashSalesTotal: number,
): CashReconciliation {
  const expectedCash = openingFloat + cashSalesTotal;
  return { expectedCash, variance: closingFloat - expectedCash };
}
