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
 * A unit is dead stock when it has not sold in `days` days.
 *
 * Policy (issue #917 P1): never-sold is NOT automatically dead. A product
 * received today with positive stock must age past the cutoff before it is
 * classified dead. The baseline for never-sold is the first acquisition date:
 * the row's `created_at`/`first_stocked_at` or, for historical imports
 * without that timestamp, the item's own `created_at`. This prevents newly
 * received unsold inventory from being immediately labeled 90-day dead.
 *
 * - If lastSoldAt exists, compare it to cutoff (classic dead-stock).
 * - If lastSoldAt is null, fall back to stockAgeIso (first acquisition);
 *   only dead when that age is at or before cutoff.
 * - If neither timestamp exists, treat as NOT dead (insufficient provenance).
 */
export function isDeadStock(
  lastSoldAt: string | null,
  todayIso: string,
  days: number,
  stockAgeIso?: string | null,
): boolean {
  const cutoff = deadStockCutoff(todayIso, days);
  if (!cutoff) return false;
  if (lastSoldAt) {
    const saleTime = Date.parse(lastSoldAt);
    if (!Number.isFinite(saleTime)) return false;
    return saleTime <= Date.parse(cutoff);
  }
  // Never sold: dead only when stock itself is older than cutoff
  if (!stockAgeIso) return false;
  const ageTime = Date.parse(stockAgeIso);
  if (!Number.isFinite(ageTime)) return false;
  return ageTime <= Date.parse(cutoff);
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

/**
 * Strict validation for the dead-stock `days` parameter (P2).
 * Returns a valid integer in [1, 3650] or an error key.
 */
export function validateDeadStockDays(raw: unknown): { days: number; error?: string } {
  if (raw === null || raw === undefined || raw === "") {
    return { days: 90 };
  }
  const str = String(raw).trim();
  // Persian/Arabic digits should already be normalized before calling, but be defensive
  if (str === "") return { days: 90 };
  const num = Number(str);
  if (!Number.isFinite(num) || Number.isNaN(num)) return { days: 90, error: "invalid_days" };
  if (!Number.isInteger(num)) return { days: 90, error: "invalid_days" };
  if (num < 1 || num > 3650) return { days: 90, error: "days_out_of_range" };
  return { days: num };
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

/**
 * Helper to derive the stock-age baseline for dead-stock classification.
 * Preference order: item_stock.created_at > item_stock.first_stocked_at > items.created_at
 */
export function deadStockAgeSql(stockAlias: string, itemAlias: string): string {
  // COALESCE(s.created_at, s.first_stocked_at, i.created_at)
  return `COALESCE(${stockAlias}.created_at, ${stockAlias}.first_stocked_at, ${itemAlias}.created_at)`;
}
