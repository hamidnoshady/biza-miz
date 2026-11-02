/**
 * Dashboard audit F13 — what may safely be done about a creation-race orphan.
 *
 * Pure half of `duplicate-items-resolve-service.ts` (no database). The report
 * (`duplicate-items.ts`) says *why* two rows share a SKU; this file says which
 * of them a tool may archive without a person's judgement: only the unmapped
 * losing twin of a live WooCommerce-mapped row, and only while nothing points
 * at it. Everything else is reported as blocked, with the reason, and left for
 * a person. Nothing here merges stock or history, and nothing deletes.
 */
import { raceTwinsOf, type DuplicateItemMember } from "./duplicate-items";

/** How many rows in one table reference an item. */
export interface ItemReference {
  table: string;
  column: string;
  count: number;
}

export type OrphanBlocker =
  | "twin_not_woo_product"
  | "twin_inactive"
  | "ambiguous_twin"
  | "has_references";

export const ORPHAN_BLOCKER_LABEL: Record<OrphanBlocker, string> = {
  twin_not_woo_product: "its mapped twin is not a WooCommerce product mapping",
  twin_inactive: "its mapped twin is archived",
  ambiguous_twin: "more than one mapped row could be its twin",
  has_references: "other records point at it (history, children, barcodes, …)",
};

export type OrphanStatus = "archive" | "already_archived" | "blocked";

export interface OrphanPlan {
  sku: string;
  orphanItemId: string;
  orphanName: string;
  orphanQuantity: string | null;
  orphanCreatedAt: string;
  twinItemId: string | null;
  twinQuantity: string | null;
  status: OrphanStatus;
  blockers: OrphanBlocker[];
  /** Tables that still reference the orphan; empty unless `has_references`. */
  references: ItemReference[];
}

function hasWooProductMapping(member: DuplicateItemMember): boolean {
  return member.mappings.some((m) => m.provider === "woocommerce" && m.entityType === "product");
}

/**
 * Plan one SKU group's orphans. `referencesByItem` is what the database found
 * pointing at each unmapped row (see `countItemReferences`); a row missing from
 * it is treated as unchecked and therefore blocked — the plan fails closed.
 */
export function planRaceOrphans(
  members: DuplicateItemMember[],
  referencesByItem: ReadonlyMap<string, ItemReference[]>,
): OrphanPlan[] {
  const mapped = members.filter((m) => m.mappings.length > 0);
  const unmapped = members.filter((m) => m.mappings.length === 0);
  const plans: OrphanPlan[] = [];

  for (const orphan of unmapped) {
    const twins = raceTwinsOf(orphan, mapped);
    if (twins.length === 0) continue; // not a race orphan: nothing to plan

    const blockers: OrphanBlocker[] = [];
    const twin = twins.length === 1 ? twins[0] : null;
    if (!twin) blockers.push("ambiguous_twin");
    else {
      if (!hasWooProductMapping(twin)) blockers.push("twin_not_woo_product");
      if (!twin.isActive) blockers.push("twin_inactive");
    }

    const references = referencesByItem.get(orphan.itemId);
    const live = (references ?? []).filter((r) => r.count > 0);
    if (references === undefined || live.length > 0) blockers.push("has_references");

    let status: OrphanStatus = "archive";
    if (blockers.length > 0) status = "blocked";
    else if (!orphan.isActive) status = "already_archived";

    plans.push({
      sku: orphan.sku,
      orphanItemId: orphan.itemId,
      orphanName: orphan.name,
      orphanQuantity: orphan.quantity,
      orphanCreatedAt: orphan.createdAt,
      twinItemId: twin?.itemId ?? null,
      twinQuantity: twin?.quantity ?? null,
      status,
      blockers,
      references: live,
    });
  }
  return plans;
}
