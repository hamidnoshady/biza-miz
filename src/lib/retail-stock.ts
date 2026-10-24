/**
 * Phase 27 Wave 8 — the pure half of retail stock operations (reorder
 * points and low/dead-stock classification).
 *
 * The DB half (retail-stock-service.ts) moves the stock; this decides what
 * "low" and "dead" mean so the reports and the service agree on one
 * definition rather than three inline comparisons.
 */

export type StockLevel = "out" | "low" | "ok";

/**
 * Classify a sellable variant's on-hand quantity against its reorder point.
 *
 * Physical availability comes first: a variant with nothing on hand is
 * "out" whatever its reorder point says. A zero/unset reorder point only
 * switches the *reminder* off — such a row is never "low" (a report that
 * flags every untracked row is noise), but it is not "ok" either when the
 * shelf is empty. Use `isReorderTracked` for the separate reminder state.
 */
export function classifyStockLevel(quantity: string | number, reorderPoint: string | number | null | undefined): StockLevel {
  const qty = Number(quantity);
  if (!Number.isFinite(qty)) return "ok";
  if (qty <= 0) return "out";
  if (!isReorderTracked(reorderPoint)) return "ok";
  if (qty <= Number(reorderPoint)) return "low";
  return "ok";
}

/** Whether the variant has a reorder reminder at all (a positive reorder point). */
export function isReorderTracked(reorderPoint: string | number | null | undefined): boolean {
  const point = Number(reorderPoint ?? 0);
  return Number.isFinite(point) && point > 0;
}

/**
 * SQL twin of `classifyStockLevel`'s "needs attention" half — out of stock, or
 * at/under a positive reorder point. `q`/`r` are the quantity and reorder-point
 * expressions. Every count (warehouse list, low-stock report, stock levels)
 * uses this so the screens reconcile.
 */
export function stockNeedsAttentionSql(q: string, r: string): string {
  return `(${q} <= 0 OR (${r} > 0 AND ${q} <= ${r}))`;
}

/**
 * A unit is dead stock when it has not sold in `days` days. Never sold is
 * the oldest possible date, so a null `lastSoldAt` is always dead once the
 * item is old enough to be considered.
 */
export function isDeadStock(
  lastSoldAt: string | null,
  todayIso: string,
  days: number,
): boolean {
  const cutoff = deadStockCutoff(todayIso, days);
  if (!cutoff) return false;
  return !lastSoldAt || Date.parse(lastSoldAt) <= Date.parse(cutoff);

}

/** Shared UTC threshold for the pure classifier and database report predicate.
 * last_sold_at is a timestamptz, not a date to which another T00:00 can be appended.
 */
export function deadStockCutoff(todayIso: string, days: number): string | null {
  if (!Number.isFinite(days) || days <= 0) return null;
  const time = Date.parse(`${todayIso}T00:00:00Z`) - days * 86_400_000;
  const cutoff = new Date(time);
  return Number.isFinite(cutoff.getTime()) ? cutoff.toISOString() : null;
}

/** Validates a purchase/return/transfer line quantity — positive, parseable. */
export function validateItemQuantity(quantity: string | number): string | null {
  const qty = Number(quantity);
  if (!Number.isFinite(qty) || qty <= 0) return "تعداد باید عددی بزرگ‌تر از صفر باشد.";
  return null;
}

/**
 * Validates a unit cost for a purchase line — whole Rial, non-negative.
 *
 * Issue #915 — the exact-money contract: a cost may arrive as decimal *text*
 * (the wire format for bigint Rial, safe past 2^53) or, from older internal
 * callers, as a plain safe integer. Text must be canonical unsigned digits
 * within the Postgres bigint range; a number must be a safe non-negative
 * integer — a float that merely LOOKS whole past 2^53 is already imprecise.
 */
export function validateItemUnitCost(unitCost: number | string): string | null {
  if (typeof unitCost === "string") {
    if (!/^\d{1,19}$/.test(unitCost) || BigInt(unitCost) > 9223372036854775807n) {
      return "بهای تمام‌شده هر واحد باید یک عدد صحیح غیرمنفی (ریال) باشد.";
    }
    return null;
  }
  if (!Number.isSafeInteger(unitCost) || unitCost < 0) {
    return "بهای تمام‌شده هر واحد باید یک عدد صحیح غیرمنفی (ریال) باشد.";
  }
  return null;
}
