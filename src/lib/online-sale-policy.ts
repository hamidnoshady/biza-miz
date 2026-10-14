/**
 * The pure half of an online (WooCommerce / Eshobe CMS) retail sale —
 * dashboard audit F01, F03 and F06. Framework- and database-free so every
 * rule here is asserted directly in `online-sale-policy.test.ts`; the DB half
 * is `retail-online-sale-service.ts` and the two adapters.
 *
 * Three questions are answered here and nowhere else:
 *
 *   1. Did this sale already leave the local shelf? (`decideOnlineStockRelief`)
 *   2. What cost does it carry, and is the profit complete? (`decideOnlineLineCost`)
 *   3. When did it happen, and does the remote document add up?
 *      (`chooseOnlineOccurredAt`, `reconcileOnlineDocument`)
 */
import Decimal from "decimal.js";

/* ------------------------------------------------------------------ *
 * 1. Stock — source-aware quantity ownership
 * ------------------------------------------------------------------ */

export type OnlineStockOutcome = "relieved" | "already_reflected" | "short" | "not_tracked" | "legacy";

export interface OnlineStockReliefInput {
  /** Units sold on the line (decimal string). */
  quantity: string;
  /** Local on-hand quantity, read under the row lock (decimal string). */
  onHand: string;
  /** When an external store last set this row's quantity absolutely; null if never. */
  remoteSnapshotAt: string | null;
  /** When the remote order happened (its own clock); null when the payload gave none. */
  remoteOccurredAt: string | null;
}

export interface OnlineStockRelief {
  outcome: Exclude<OnlineStockOutcome, "not_tracked" | "legacy">;
  /** Units to take off `item_stock.quantity` now. */
  relieve: string;
  /** Units sold that the local shelf did not hold — recorded, never hidden. */
  short: string;
}

/**
 * The quantity-ownership policy for a fungible online sale.
 *
 * WooCommerce reduces its own stock when the order is placed and later pushes
 * an absolute product snapshot that overwrites `item_stock.quantity`. When that
 * snapshot is *newer* than the order, it already contains the sale; relieving
 * the shelf again would count the sale twice. So:
 *
 *   - snapshot taken at/after the order's own instant → `already_reflected`,
 *     nothing is relieved (the snapshot is the authority for the shelf);
 *   - otherwise the sale is relieved locally, up to what is on hand;
 *   - any units beyond that are `short`: the local row cannot go negative
 *     (item_stock's CHECK), and a backorder the store accepted is a fact to
 *     reconcile — it is recorded with its quantity instead of being swallowed
 *     by the old `GREATEST(0, …)` clamp.
 *
 * Missing cost never decides any of this: whether a box left the shelf is a
 * physical question, not a pricing one.
 */
export function decideOnlineStockRelief(input: OnlineStockReliefInput): OnlineStockRelief {
  const quantity = new Decimal(input.quantity);
  if (!quantity.isFinite() || quantity.lte(0)) throw new Error("invalid_quantity");

  if (input.remoteSnapshotAt && input.remoteOccurredAt) {
    const snapshot = Date.parse(input.remoteSnapshotAt);
    const occurred = Date.parse(input.remoteOccurredAt);
    if (Number.isFinite(snapshot) && Number.isFinite(occurred) && snapshot >= occurred) {
      return { outcome: "already_reflected", relieve: "0", short: "0" };
    }
  }

  const onHand = Decimal.max(new Decimal(input.onHand || "0"), 0);
  const relieve = Decimal.min(quantity, onHand);
  const short = quantity.minus(relieve);
  return {
    outcome: short.gt(0) ? "short" : "relieved",
    relieve: relieve.toFixed(),
    short: short.toFixed(),
  };
}

/* ------------------------------------------------------------------ *
 * 2. Cost — completeness per line
 * ------------------------------------------------------------------ */

export type OnlineCostStatus = "known" | "partial" | "missing" | "not_applicable" | "unattributed";

export interface OnlineLineCost {
  costStatus: OnlineCostStatus;
  /** Exact COGS to post, Rial (string). */
  cogsRial: string;
}

/**
 * COGS for a fungible online line.
 *
 * The cost basis is `item_stock.unit_cost` — the purchase cost the shop
 * recorded — and nothing else: a selling price is never used as a stand-in.
 * Units the shelf did not hold (`short`) carry no cost basis, so they make the
 * line `partial`; a line with no unit cost at all is `missing`. Either way the
 * revenue still posts and the gap is recorded, so the profit can be shown as
 * provisional instead of complete.
 */
export function decideOnlineLineCost(input: {
  quantity: string;
  shortQuantity: string;
  unitCost: string | number | bigint | null;
}): OnlineLineCost {
  const unitCost = input.unitCost == null ? null : new Decimal(input.unitCost.toString());
  if (unitCost == null || !unitCost.isFinite() || unitCost.lte(0)) {
    return { costStatus: "missing", cogsRial: "0" };
  }
  const costed = new Decimal(input.quantity).minus(new Decimal(input.shortQuantity || "0"));
  if (costed.lte(0)) return { costStatus: "missing", cogsRial: "0" };
  const cogs = costed.times(unitCost).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
  return {
    costStatus: new Decimal(input.shortQuantity || "0").gt(0) ? "partial" : "known",
    cogsRial: cogs.toFixed(0),
  };
}

/** Whether a set of line cost statuses leaves the profit provisional. */
export function isProvisionalCost(status: OnlineCostStatus): boolean {
  return status === "partial" || status === "missing" || status === "unattributed";
}

/* ------------------------------------------------------------------ *
 * 3. Chronology and the remote document's breakdown
 * ------------------------------------------------------------------ */

/**
 * Parse a WooCommerce `*_gmt` field (`2026-09-01T10:22:03`, no offset, UTC)
 * or any ISO instant with an offset. A store-local field without an offset is
 * *not* accepted here — guessing the store's timezone would invent a date.
 */
export function parseRemoteInstant(value: string | null | undefined, { assumeUtc }: { assumeUtc: boolean }): string | null {
  if (!value || typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const hasOffset = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(trimmed);
  if (!hasOffset && !assumeUtc) return null;
  const time = Date.parse(hasOffset ? trimmed : `${trimmed}Z`);
  if (!Number.isFinite(time)) return null;
  return new Date(time).toISOString();
}

export type OccurredAtSource = "remote_paid" | "remote_completed" | "remote_created" | "import";

/**
 * The instant an online sale belongs to: when it was paid, else completed,
 * else placed, and only as a last resort the moment it was imported — which
 * is then *labelled* as such, so a report can say the date is the import's.
 * A remote instant in the future (a misconfigured store clock) is not trusted
 * either: a sale cannot be dated after it reached us.
 */
export function chooseOnlineOccurredAt(input: {
  createdAt: string | null;
  paidAt: string | null;
  completedAt: string | null;
  importedAt: string;
}): { occurredAt: string; source: OccurredAtSource } {
  const importedTime = Date.parse(input.importedAt);
  const candidates: [string | null, OccurredAtSource][] = [
    [input.paidAt, "remote_paid"],
    [input.completedAt, "remote_completed"],
    [input.createdAt, "remote_created"],
  ];
  for (const [value, source] of candidates) {
    if (!value) continue;
    const time = Date.parse(value);
    if (Number.isFinite(time) && time <= importedTime) return { occurredAt: new Date(time).toISOString(), source };
  }
  return { occurredAt: new Date(importedTime).toISOString(), source: "import" };
}

export type BreakdownStatus = "reconciled" | "explained_difference" | "incomplete";

export interface OnlineDocumentBreakdown {
  linesSubtotalRial: bigint;
  discountRial: bigint;
  shippingRial: bigint;
  feesRial: bigint;
  taxRial: bigint;
  totalRial: bigint;
  unexplainedDifferenceRial: bigint;
  status: BreakdownStatus;
}

/**
 * Reconcile a remote order's components to its total:
 * lines − discount + shipping + fees + tax = total.
 *
 * `incomplete` means the payload omitted a component we would need (the
 * difference is then not attributable); `explained_difference` means every
 * component was present yet the sum still differs (rounding at the store,
 * a fee type we do not model). Either is stored and shown — never folded into
 * revenue or dropped.
 */
export function reconcileOnlineDocument(input: {
  linesSubtotalRial: bigint;
  discountRial: bigint | null;
  shippingRial: bigint | null;
  feesRial: bigint | null;
  taxRial: bigint;
  totalRial: bigint;
}): OnlineDocumentBreakdown {
  const discount = input.discountRial ?? 0n;
  const shipping = input.shippingRial ?? 0n;
  const fees = input.feesRial ?? 0n;
  const difference = input.totalRial - (input.linesSubtotalRial - discount + shipping + fees + input.taxRial);
  const complete = input.discountRial != null && input.shippingRial != null && input.feesRial != null;
  return {
    linesSubtotalRial: input.linesSubtotalRial,
    discountRial: discount,
    shippingRial: shipping,
    feesRial: fees,
    taxRial: input.taxRial,
    totalRial: input.totalRial,
    unexplainedDifferenceRial: difference,
    status: difference === 0n ? "reconciled" : complete ? "explained_difference" : "incomplete",
  };
}

/* ------------------------------------------------------------------ *
 * 4. Returns — restore exactly what the sale took
 * ------------------------------------------------------------------ */

export interface OnlineLineReturnPlan {
  /** Units to add back to `item_stock.quantity`. */
  restock: string;
  /** COGS to reverse, Rial (string). */
  cogsReversalRial: string;
}

/**
 * A refund of `take` units of a recorded online line restores stock only up
 * to what the sale actually relieved locally (an `already_reflected` or
 * `short` unit was never taken off this shelf, so adding it back would invent
 * stock), and reverses COGS only at the per-unit cost that sale posted (a
 * missing-cost line posted none, so it reverses none — the previous code
 * reversed at whatever the cost happened to be on the day of the refund).
 */
export function planOnlineLineReturn(line: {
  quantity: string;
  shortQuantity: string;
  relievedQuantity: string;
  restoredQuantity: string;
  cogsRial: string;
  restoredCogsRial: string;
}, take: string): OnlineLineReturnPlan {
  const units = new Decimal(take);
  if (!units.isFinite() || units.lte(0)) return { restock: "0", cogsReversalRial: "0" };
  const restockable = Decimal.max(new Decimal(line.relievedQuantity).minus(line.restoredQuantity), 0);
  const restock = Decimal.min(units, restockable);

  const costedUnits = new Decimal(line.quantity).minus(line.shortQuantity);
  const cogs = new Decimal(line.cogsRial);
  const remainingCogs = Decimal.max(cogs.minus(line.restoredCogsRial), 0);
  let reversal = new Decimal(0);
  if (costedUnits.gt(0) && cogs.gt(0)) {
    reversal = Decimal.min(
      cogs.div(costedUnits).times(Decimal.min(units, costedUnits)).toDecimalPlaces(0, Decimal.ROUND_HALF_UP),
      remainingCogs,
    );
  }
  return { restock: restock.toFixed(), cogsReversalRial: reversal.toFixed(0) };
}
