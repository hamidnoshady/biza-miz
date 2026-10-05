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
 * Zero reorder point = the shop does not track this item, so it is never
 * "low" (a report that flags every unpriced/untracked row is noise).
 */
export function classifyStockLevel(quantity: string | number, reorderPoint: string | number | null | undefined): StockLevel {
  const qty = Number(quantity);
  const point = Number(reorderPoint ?? 0);
  if (!Number.isFinite(qty) || !Number.isFinite(point) || point <= 0) return "ok";
  if (qty <= 0) return "out";
  if (qty <= point) return "low";
  return "ok";
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

/** Validates a unit cost for a purchase line — whole Rial, non-negative. */
export function validateItemUnitCost(unitCost: number): string | null {
  if (!Number.isInteger(unitCost) || unitCost < 0) {
    return "بهای تمام‌شده هر واحد باید یک عدد صحیح غیرمنفی (ریال) باشد.";
  }
  return null;
}
