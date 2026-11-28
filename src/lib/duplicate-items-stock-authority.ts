/**
 * Issue #1592 — stock-authority planning for historical duplicate pairs.
 *
 * The archive planner deliberately refuses a row with on-hand quantity
 * (`nonzero_stock`). That is the right default, but it leaves the reported 304
 * pairs with no supported decision at all. In this tenant the WooCommerce store
 * is the configured source of truth (`push_stock` / `push_prices` off), so the
 * mapped twin's `item_stock.quantity` is kept equal to the store by inbound
 * webhooks while the older unmapped row froze at its August value. This module
 * is the missing *evidence*, not a write: it compares the two local snapshots
 * with the newest product payload the store sent and says whether archiving the
 * orphan would change physical stock (it never should) or only remove a
 * duplicated catalogue count.
 *
 * Nothing here archives, adjusts or approves anything. The caller renders the
 * proposal; an owner must approve the exact evidence (the approval token is a
 * hash of it) before any future apply path may act. `needs_store_reconciliation`
 * is an explicit refusal: the store, the canonical row and the orphan disagree,
 * or the store data is missing/negative, so only a person can decide.
 *
 * Pure: no database, no clock, no environment.
 */
import { createHash } from "node:crypto";

/** What the three quantities say about who owns the physical stock. */
export type StockAuthorityEvidence =
  | "both_match_store"
  | "canonical_matches_store"
  | "orphan_matches_store_canonical_differs"
  | "neither_matches_store"
  | "store_stock_missing"
  | "store_stock_negative"
  | "variant_family"
  | "canonical_unusable"
  | "orphan_has_no_stock";

export type StockAuthorityVerdict =
  | "safe_to_archive"
  | "needs_store_reconciliation"
  | "needs_history_disposition"
  | "manual_review";

export type StockAuthorityBlocker =
  | "store_mismatch"
  | "store_stock_missing"
  | "store_stock_negative"
  | "variant_family"
  | "canonical_unusable"
  | "orphan_has_no_stock"
  | "history_references";

export interface StockAuthorityInput {
  /** `item_stock.quantity` of the unmapped, older row. */
  orphanQuantity: string | number | null;
  /** `item_stock.quantity` of the mapped row that stays. */
  canonicalQuantity: string | number | null;
  /** Newest `stock_quantity` the store sent, or null when the payload had none. */
  storeQuantity: number | null;
  /** When that payload arrived; null when there is no payload at all. */
  storeSnapshotAt: string | null;
  /** A variable product's stock lives on its children, not on one orphan row. */
  variantFamily: boolean;
  /** The surviving row must be an active, mapped product. */
  canonicalActive: boolean;
  canonicalMapped: boolean;
  /** Rows (orders, invoices, price history…) that still point at the orphan. */
  historyReferences?: number;
}

export interface StockAuthorityProposal {
  evidence: StockAuthorityEvidence;
  verdict: StockAuthorityVerdict;
  /** Physical units that would change. Only 0 is ever proposed. */
  physicalUnitsDelta: 0 | null;
  /** Units the *active catalogue* would stop double-counting. */
  catalogueUnitsDelta: number;
  /** What the surviving row reports afterwards. */
  canonicalAfter: number;
  blockers: StockAuthorityBlocker[];
  notes: string[];
}

function quantity(value: string | number | null): number | null {
  if (value == null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Plan one pair. Order matters: an unusable canonical row or a variant family
 * is a person's decision even when the numbers happen to agree, and a negative
 * or missing store quantity can never be "authority".
 */
export function planStockAuthority(input: StockAuthorityInput): StockAuthorityProposal {
  const orphan = quantity(input.orphanQuantity);
  const canonical = quantity(input.canonicalQuantity);
  const store = input.storeQuantity;

  const blocked = (
    evidence: StockAuthorityEvidence,
    blocker: StockAuthorityBlocker,
    note: string,
  ): StockAuthorityProposal => ({
    evidence,
    verdict: evidence === "variant_family" ? "manual_review" : "needs_store_reconciliation",
    physicalUnitsDelta: null,
    catalogueUnitsDelta: 0,
    canonicalAfter: canonical ?? 0,
    blockers: [blocker],
    notes: [note],
  });

  if (!input.canonicalActive || !input.canonicalMapped) {
    return blocked("canonical_unusable", "canonical_unusable", "The surviving row is not an active, mapped product.");
  }
  if (input.variantFamily) {
    return blocked("variant_family", "variant_family", "A variable product's stock is per variation; one orphan row cannot be compared to a single number.");
  }
  if (orphan === null) {
    return blocked("orphan_has_no_stock", "orphan_has_no_stock", "The orphan row's stock snapshot could not be read.");
  }
  if (orphan === 0) {
    return blocked("orphan_has_no_stock", "orphan_has_no_stock", "The orphan holds no stock; this is the ordinary zero-stock archive path, not a stock-authority case.");
  }
  if (store === null) {
    return blocked(
      "store_stock_missing",
      "store_stock_missing",
      input.storeSnapshotAt
        ? "The newest store payload has no stock_quantity (the product does not manage stock)."
        : "No product payload from the store is available; the store's quantity cannot be proven.",
    );
  }
  if (store < 0) {
    return blocked("store_stock_negative", "store_stock_negative", "The store reports negative stock (oversold); reconcile the store first.");
  }
  if (canonical === null) {
    return blocked("canonical_unusable", "canonical_unusable", "The surviving row has no stock snapshot to compare.");
  }

  if (canonical === store) {
    const evidence: StockAuthorityEvidence = orphan === store ? "both_match_store" : "canonical_matches_store";
    const historyReferences = input.historyReferences ?? 0;
    return {
      evidence,
      verdict: historyReferences > 0 ? "needs_history_disposition" : "safe_to_archive",
      physicalUnitsDelta: 0,
      catalogueUnitsDelta: -orphan,
      canonicalAfter: canonical,
      blockers: historyReferences > 0 ? (["history_references"] as const).slice() : [],
      notes: [
        orphan === store
          ? "Both local rows hold the store's current quantity: one physical count, two snapshots."
          : "The surviving row equals the store's current quantity; the orphan is a stale snapshot of the same units.",
        ...(historyReferences > 0
          ? ["Historic records still reference this row; decide whether to retain the history or approve the archive explicitly."]
          : []),
      ],
    };
  }
  if (orphan === store) {
    return blocked(
      "orphan_matches_store_canonical_differs",
      "store_mismatch",
      "The store agrees with the orphan but not with the surviving row; the canonical row must be reconciled before anything is archived.",
    );
  }
  return blocked(
    "neither_matches_store",
    "store_mismatch",
    "Neither local snapshot equals the store's current quantity; a domain stock reconciliation is required.",
  );
}

export interface StockAuthorityApprovalEntry {
  itemId: string;
  sku: string;
  orphanQuantity: number;
  canonicalQuantity: number;
  storeQuantity: number | null;
  storeSnapshotAt: string | null;
  evidence: StockAuthorityEvidence;
  verdict: StockAuthorityVerdict;
}

/**
 * The exact, deterministic approval payload an owner signs off.
 *
 * Sorted by item id, numbers normalised, no timestamps of the run itself, so
 * the same evidence always produces the same token and a changed quantity or a
 * new payload changes it. A future apply path must refuse a plan whose token
 * does not match the one that was approved.
 */
export function stockAuthorityApprovalToken(entries: readonly StockAuthorityApprovalEntry[]): string {
  const normalised = [...entries]
    .map((entry) => ({
      itemId: entry.itemId,
      sku: entry.sku,
      orphanQuantity: entry.orphanQuantity,
      canonicalQuantity: entry.canonicalQuantity,
      storeQuantity: entry.storeQuantity,
      storeSnapshotAt: entry.storeSnapshotAt,
      evidence: entry.evidence,
      verdict: entry.verdict,
    }))
    .sort((left, right) => left.itemId.localeCompare(right.itemId));
  return createHash("sha256").update(JSON.stringify(normalised)).digest("hex");
}

/** Aggregate counts and units for the preview header. */
export function summariseStockAuthority(items: readonly StockAuthorityApprovalEntry[]): {
  pairs: number;
  safe: number;
  needsReconciliation: number;
  needsHistoryDisposition: number;
  manual: number;
  orphanUnits: number;
  canonicalUnits: number;
  catalogueUnitsAfterSafeArchives: number;
} {
  const orphanUnits = items.reduce((sum, item) => sum + item.orphanQuantity, 0);
  const canonicalUnits = items.reduce((sum, item) => sum + item.canonicalQuantity, 0);
  const safeUnits = items.filter((item) => item.verdict === "safe_to_archive").reduce((sum, item) => sum + item.orphanQuantity, 0);
  return {
    pairs: items.length,
    safe: items.filter((item) => item.verdict === "safe_to_archive").length,
    needsReconciliation: items.filter((item) => item.verdict === "needs_store_reconciliation").length,
    needsHistoryDisposition: items.filter((item) => item.verdict === "needs_history_disposition").length,
    manual: items.filter((item) => item.verdict === "manual_review").length,
    orphanUnits,
    canonicalUnits,
    catalogueUnitsAfterSafeArchives: orphanUnits + canonicalUnits - safeUnits,
  };
}
