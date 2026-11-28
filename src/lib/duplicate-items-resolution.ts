/**
 * Dashboard audit F13 / issue #1592 — what may safely be done about a duplicate
 * product row.
 *
 * Pure half of `duplicate-items-resolve-service.ts` (no database). The report
 * (`duplicate-items.ts`) says *why* two rows share a SKU; this file says which
 * of them a tool may archive without a person's judgement.
 *
 * Two fingerprints are planned, and neither is a merge:
 *
 *  - `race_orphan`: the unmapped losing twin of a live WooCommerce-mapped row,
 *    created moments apart (the original F13 shape);
 *  - `historical_duplicate_candidate`: the same product, same name, same kind
 *    and branch, one mapped and one not, created weeks apart (issue #1592's
 *    August-beside-September pairs).
 *
 * Both are blocked when anything references the row **or when the row still
 * holds inventory**. `item_stock` is deliberately outside the foreign-key scan
 * (the sync owns that snapshot), so its quantity is read explicitly: 304 of the
 * 410 reported pairs hold stock, and archiving one of those would remove real
 * on-hand quantity from the active catalogue. Everything else is reported as
 * blocked, with the reason, and left for a person. Nothing here merges stock or
 * history, and nothing deletes.
 */
import {
  historicalTwinsOf,
  namesMatch,
  raceTwinsOf,
  variantFamilyTwinOf,
  type DuplicateItemMember,
  type DuplicateVerdict,
} from "./duplicate-items";

/** How many rows in one table reference an item. */
export interface ItemReference {
  table: string;
  column: string;
  count: number;
}

/** The on-hand quantity the catalogue would lose if the row were archived. */
export interface ItemInventory {
  /** `item_stock.quantity`, or null when the row has no stock snapshot at all. */
  quantity: string | null;
}

export type OrphanBlocker =
  | "twin_not_woo_product"
  | "twin_inactive"
  | "twin_not_variant_family"
  | "ambiguous_twin"
  | "different_name"
  | "nonzero_stock"
  | "inventory_unchecked"
  | "has_references";

export const ORPHAN_BLOCKER_LABEL: Record<OrphanBlocker, string> = {
  twin_not_woo_product: "its mapped twin is not a WooCommerce product mapping",
  twin_inactive: "its mapped twin is archived",
  twin_not_variant_family: "its mapped twin is no longer a variable product with mapped children",
  ambiguous_twin: "more than one mapped row could be its twin",
  different_name: "the rows do not carry the same product name",
  nonzero_stock: "it still holds on-hand stock",
  inventory_unchecked: "its on-hand stock was not read, so it cannot be proven empty",
  has_references: "other records point at it (history, children, barcodes, …)",
};

export type OrphanStatus = "archive" | "already_archived" | "blocked";

/** The three duplicate shapes this planner can prove. */
export type PlannedDuplicateKind = Extract<
  DuplicateVerdict,
  "race_orphan" | "historical_duplicate_candidate" | "historical_variant_orphan"
>;

export interface OrphanPlan {
  /** Which fingerprint proved the row surplus. */
  kind: PlannedDuplicateKind;
  sku: string;
  orphanItemId: string;
  orphanName: string;
  orphanQuantity: string | null;
  orphanCreatedAt: string;
  twinItemId: string | null;
  twinName: string | null;
  twinQuantity: string | null;
  status: OrphanStatus;
  blockers: OrphanBlocker[];
  /** Tables that still reference the orphan; empty unless `has_references`. */
  references: ItemReference[];
  /** How many days separate the two rows (the evidence for a historical pair). */
  daysApart: number | null;
}

function hasWooProductMapping(member: DuplicateItemMember): boolean {
  return member.mappings.some((m) => m.provider === "woocommerce" && m.entityType === "product");
}

function twinsFor(kind: PlannedDuplicateKind, orphan: DuplicateItemMember, mapped: DuplicateItemMember[]) {
  if (kind === "race_orphan") return raceTwinsOf(orphan, mapped);
  if (kind === "historical_duplicate_candidate") return historicalTwinsOf(orphan, mapped);
  const family = variantFamilyTwinOf(orphan, mapped);
  return family ? [family] : [];
}

function daysBetween(a: string, b: string): number | null {
  const left = Date.parse(a);
  const right = Date.parse(b);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return null;
  return Math.round(Math.abs(left - right) / 86_400_000);
}

/**
 * Plan one orphan of one kind. `referencesByItem` is what the database found
 * pointing at the row (see `countItemReferences`) and `inventoryByItem` its
 * explicit `item_stock` reading. A row missing from either map is treated as
 * unchecked and blocked — the plan fails closed.
 */
function planOne(
  kind: PlannedDuplicateKind,
  orphan: DuplicateItemMember,
  mapped: DuplicateItemMember[],
  referencesByItem: ReadonlyMap<string, ItemReference[]>,
  inventoryByItem: ReadonlyMap<string, ItemInventory>,
): OrphanPlan {
  const twins = twinsFor(kind, orphan, mapped);
  const blockers: OrphanBlocker[] = [];
  const twin = twins.length === 1 ? twins[0] : null;
  if (!twin) blockers.push("ambiguous_twin");
  else {
    if (!hasWooProductMapping(twin)) blockers.push("twin_not_woo_product");
    if (!twin.isActive) blockers.push("twin_inactive");
    if (!namesMatch(orphan, twin)) blockers.push("different_name");
  }

  const inventory = inventoryByItem.get(orphan.itemId);
  if (inventory === undefined) blockers.push("inventory_unchecked");
  else if (Number(inventory.quantity ?? 0) !== 0) blockers.push("nonzero_stock");

  const references = referencesByItem.get(orphan.itemId);
  const live = (references ?? []).filter((r) => r.count > 0);
  if (references === undefined || live.length > 0) blockers.push("has_references");

  let status: OrphanStatus = "archive";
  if (blockers.length > 0) status = "blocked";
  else if (!orphan.isActive) status = "already_archived";

  return {
    kind,
    sku: orphan.sku,
    orphanItemId: orphan.itemId,
    orphanName: orphan.name,
    orphanQuantity: orphan.quantity,
    orphanCreatedAt: orphan.createdAt,
    twinItemId: twin?.itemId ?? null,
    twinName: twin?.name ?? null,
    twinQuantity: twin?.quantity ?? null,
    status,
    blockers,
    references: live,
    daysApart: twin ? daysBetween(orphan.createdAt, twin.createdAt) : null,
  };
}

/** Plan the historical duplicates of one group. */
export function planHistoricalDuplicates(
  members: DuplicateItemMember[],
  referencesByItem: ReadonlyMap<string, ItemReference[]>,
  inventoryByItem: ReadonlyMap<string, ItemInventory>,
): OrphanPlan[] {
  return planUnmapped("historical_duplicate_candidate", members, referencesByItem, inventoryByItem);
}

/**
 * Plan the flat August copies of a September variable product. The surviving
 * row is the mapped parent; its children are the evidence that the family is a
 * real variable product, not a guess.
 */
export function planVariantFamilyOrphans(
  members: DuplicateItemMember[],
  referencesByItem: ReadonlyMap<string, ItemReference[]>,
  inventoryByItem: ReadonlyMap<string, ItemInventory>,
): OrphanPlan[] {
  return planUnmapped("historical_variant_orphan", members, referencesByItem, inventoryByItem);
}

/** Plan the creation-race orphans of one group. */
export function planRaceOrphans(
  members: DuplicateItemMember[],
  referencesByItem: ReadonlyMap<string, ItemReference[]>,
  inventoryByItem: ReadonlyMap<string, ItemInventory>,
): OrphanPlan[] {
  return planUnmapped("race_orphan", members, referencesByItem, inventoryByItem);
}

/** Plan both fingerprints for one group. */
export function planDuplicateArchives(
  members: DuplicateItemMember[],
  referencesByItem: ReadonlyMap<string, ItemReference[]>,
  inventoryByItem: ReadonlyMap<string, ItemInventory>,
): OrphanPlan[] {
  return [
    ...planRaceOrphans(members, referencesByItem, inventoryByItem),
    ...planHistoricalDuplicates(members, referencesByItem, inventoryByItem),
    ...planVariantFamilyOrphans(members, referencesByItem, inventoryByItem),
  ];
}

function planUnmapped(
  kind: PlannedDuplicateKind,
  members: DuplicateItemMember[],
  referencesByItem: ReadonlyMap<string, ItemReference[]>,
  inventoryByItem: ReadonlyMap<string, ItemInventory>,
): OrphanPlan[] {
  const mapped = members.filter((m) => m.mappings.length > 0);
  const unmapped = members.filter((m) => m.mappings.length === 0);
  const plans: OrphanPlan[] = [];

  for (const orphan of unmapped) {
    if (twinsFor(kind, orphan, mapped).length === 0) continue; // not this fingerprint
    plans.push(planOne(kind, orphan, mapped, referencesByItem, inventoryByItem));
  }
  return plans;
}
