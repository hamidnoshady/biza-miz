/**
 * Dashboard audit F13 — explaining a duplicate SKU before anyone merges it.
 *
 * Pure half of `duplicate-items-report.ts` (no database): given the rows that
 * share one SKU inside a business, say *why* they share it. Some groups are
 * legitimate (a variable product's parent and variations, which WooCommerce
 * reports under the parent's SKU when a variation has none of its own); some
 * are the creation race fixed alongside this file (one remote product, two
 * local items, only one of them still mapped); some are two remote records
 * with the same SKU, which only the store owner can resolve. Nothing here
 * decides to merge or delete — the verdict is evidence for a person.
 */

export type DuplicateItemKind = "simple" | "variant_parent" | "variant_child";

export interface DuplicateItemMapping {
  connectionId: string;
  connectionName: string;
  provider: string;
  /** The store this connection points at (plugin site URL, else base URL), normalised; null for Holoo. */
  storeKey: string | null;
  entityType: string;
  remoteId: string;
  remoteParentId: string | null;
}

export interface DuplicateItemMember {
  itemId: string;
  name: string;
  sku: string;
  kind: DuplicateItemKind;
  parentItemId: string | null;
  isActive: boolean;
  locationId: string;
  locationName: string;
  quantity: string | null;
  createdAt: string;
  mappings: DuplicateItemMapping[];
}

export type DuplicateVerdict =
  | "same_remote_mapped_twice"
  | "race_orphan"
  | "unmapped_duplicate"
  | "distinct_remote_records"
  | "per_branch_copies"
  | "variant_family";

export const DUPLICATE_VERDICT_LABEL: Record<DuplicateVerdict, string> = {
  same_remote_mapped_twice: "same remote product mapped twice (re-linked store or second connection)",
  race_orphan: "creation race: one item is mapped, its twin is an unmapped orphan",
  unmapped_duplicate: "unmapped duplicate (no integration owns at least one row)",
  distinct_remote_records: "different remote records share this SKU (fix the SKU at the source)",
  per_branch_copies: "one copy per branch (items are per location)",
  variant_family: "variant family (legitimate)",
};

/** Whether this verdict needs a person to act on it. */
export function verdictNeedsAction(verdict: DuplicateVerdict): boolean {
  return verdict !== "variant_family" && verdict !== "per_branch_copies";
}

/**
 * Two creations this close together, one mapped and one not, are the race's
 * fingerprint: two deliveries of the same product a few seconds apart.
 */
export const RACE_WINDOW_MS = 10 * 60 * 1000;

/** Normalise a SKU the way the duplicate grouping does. */
export function normaliseSku(sku: string | null | undefined): string | null {
  const trimmed = (sku ?? "").trim().toLowerCase();
  return trimmed ? trimmed : null;
}

/** Normalise a store URL so two connections to one store compare equal. */
export function normaliseStoreKey(url: string | null | undefined): string | null {
  if (!url) return null;
  const trimmed = url.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
  return trimmed || null;
}

function remoteKey(m: DuplicateItemMapping): string {
  // One remote record: the same id in the same store (or the same connection
  // when the store is unknown), of the same entity type.
  return `${m.entityType}|${m.storeKey ?? m.connectionId}|${m.remoteId}`;
}

/**
 * Classify one SKU group. Checks run from the most to the least alarming, so
 * a group that is both a variant family and holds a race orphan is reported
 * as the orphan.
 */
export function classifyDuplicateGroup(members: DuplicateItemMember[]): DuplicateVerdict {
  // 1. One remote record behind two local items.
  const seen = new Map<string, string>();
  for (const member of members) {
    for (const mapping of member.mappings) {
      const key = remoteKey(mapping);
      const owner = seen.get(key);
      if (owner && owner !== member.itemId) return "same_remote_mapped_twice";
      seen.set(key, member.itemId);
    }
  }

  const mapped = members.filter((m) => m.mappings.length > 0);
  const unmapped = members.filter((m) => m.mappings.length === 0);

  // 2. An unmapped twin of a mapped row, created moments apart, same kind and
  //    branch: the losing side of the creation race.
  for (const orphan of unmapped) {
    const orphanAt = Date.parse(orphan.createdAt);
    const twin = mapped.find(
      (m) =>
        m.kind === orphan.kind &&
        m.locationId === orphan.locationId &&
        m.parentItemId === orphan.parentItemId &&
        Math.abs(Date.parse(m.createdAt) - orphanAt) <= RACE_WINDOW_MS,
    );
    if (twin) return "race_orphan";
  }

  // 3. A legitimate family: one parent and its own children, each child a
  //    distinct remote record (or none at all, when built in the app).
  const parents = members.filter((m) => m.kind === "variant_parent");
  const children = members.filter((m) => m.kind === "variant_child");
  const simples = members.filter((m) => m.kind === "simple");
  if (simples.length === 0 && parents.length <= 1 && children.length > 0) {
    const parentIds = new Set(children.map((c) => c.parentItemId));
    const sameParent = parentIds.size === 1;
    const parentMatches = parents.length === 0 || parentIds.has(parents[0].itemId);
    if (sameParent && parentMatches) return "variant_family";
  }

  // 4. Rows that no integration owns.
  if (unmapped.length > 0) {
    const branches = new Set(members.map((m) => m.locationId));
    if (branches.size === members.length && mapped.length === 0) return "per_branch_copies";
    return "unmapped_duplicate";
  }

  // 5. Everything is mapped, to different remote records.
  const branches = new Set(members.map((m) => m.locationId));
  if (branches.size === members.length) return "per_branch_copies";
  return "distinct_remote_records";
}

/** A one-line provenance for one row: where it came from, by which remote id. */
export function describeProvenance(member: DuplicateItemMember): string {
  if (member.mappings.length === 0) return "local (no integration mapping)";
  return member.mappings
    .map((m) => {
      const parent = m.remoteParentId ? ` parent #${m.remoteParentId}` : "";
      return `${m.provider} «${m.connectionName}» ${m.entityType} #${m.remoteId}${parent}`;
    })
    .join("; ");
}
