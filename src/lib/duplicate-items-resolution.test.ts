import { describe, expect, it } from "vitest";
import type { DuplicateItemMapping, DuplicateItemMember } from "./duplicate-items";
import {
  planHistoricalDuplicates,
  planRaceOrphans,
  type ItemInventory,
  type ItemReference,
} from "./duplicate-items-resolution";

const T0 = "2026-09-29T01:46:38.000Z";

function member(id: string, overrides: Partial<DuplicateItemMember> = {}): DuplicateItemMember {
  return {
    itemId: id,
    name: "اسپری دوفاز",
    sku: "zza05023",
    kind: "simple",
    parentItemId: null,
    isActive: true,
    locationId: "loc-1",
    locationName: "شعبه مرکزی",
    quantity: "1",
    createdAt: T0,
    mappings: [],
    ...overrides,
  };
}

function woo(remoteId: string, overrides: Partial<DuplicateItemMapping> = {}): DuplicateItemMapping {
  return {
    connectionId: "conn-1",
    connectionName: "فروشگاه",
    provider: "woocommerce",
    storeKey: "shop.example.com",
    entityType: "product",
    remoteId,
    remoteParentId: null,
    ...overrides,
  };
}

const none = (id: string): ReadonlyMap<string, ItemReference[]> => new Map([[id, []]]);
const empty = (id: string): ReadonlyMap<string, ItemInventory> => new Map([[id, { quantity: "0" }]]);

describe("planRaceOrphans", () => {
  it("archives an unreferenced, zero-stock unmapped twin of a live Woo-mapped item", () => {
    const [plan] = planRaceOrphans(
      [member("kept", { mappings: [woo("5023")] }), member("orphan")],
      none("orphan"),
      empty("orphan"),
    );
    expect(plan).toMatchObject({ kind: "race_orphan", orphanItemId: "orphan", twinItemId: "kept", status: "archive", blockers: [] });
  });

  it("plans nothing for an unmapped row that is not a twin of a mapped one", () => {
    const hand = member("hand", { createdAt: "2026-09-01T00:00:00.000Z" });
    expect(
      planRaceOrphans([member("kept", { mappings: [woo("5023")] }), hand], none("hand"), empty("hand")),
    ).toEqual([]);
  });

  it("blocks an orphan that anything references, and names the tables", () => {
    const refs = new Map<string, ItemReference[]>([
      ["orphan", [{ table: "order_items", column: "item_id", count: 2 }]],
    ]);
    const [plan] = planRaceOrphans(
      [member("kept", { mappings: [woo("5023")] }), member("orphan")],
      refs,
      empty("orphan"),
    );
    expect(plan.status).toBe("blocked");
    expect(plan.blockers).toEqual(["has_references"]);
    expect(plan.references).toEqual([{ table: "order_items", column: "item_id", count: 2 }]);
  });

  it("fails closed when the references were never checked", () => {
    const [plan] = planRaceOrphans(
      [member("kept", { mappings: [woo("5023")] }), member("orphan")],
      new Map(),
      empty("orphan"),
    );
    expect(plan.status).toBe("blocked");
  });

  it("blocks an orphan that still holds inventory, even with no foreign-key reference", () => {
    const [plan] = planRaceOrphans(
      [member("kept", { mappings: [woo("5023")] }), member("orphan", { quantity: "5" })],
      none("orphan"),
      new Map([["orphan", { quantity: "5" }]]),
    );
    expect(plan.status).toBe("blocked");
    expect(plan.blockers).toEqual(["nonzero_stock"]);
  });

  it("fails closed when the inventory was not read at all", () => {
    const [plan] = planRaceOrphans(
      [member("kept", { mappings: [woo("5023")] }), member("orphan")],
      none("orphan"),
      new Map(),
    );
    expect(plan.status).toBe("blocked");
    expect(plan.blockers).toEqual(["inventory_unchecked"]);
  });

  it("ignores reference rows with a zero count", () => {
    const refs = new Map<string, ItemReference[]>([["orphan", [{ table: "item_barcodes", column: "item_id", count: 0 }]]]);
    const [plan] = planRaceOrphans(
      [member("kept", { mappings: [woo("5023")] }), member("orphan")],
      refs,
      empty("orphan"),
    );
    expect(plan.status).toBe("archive");
  });

  it("blocks when the twin is archived or is not a Woo product mapping", () => {
    const [inactive] = planRaceOrphans(
      [member("kept", { isActive: false, mappings: [woo("5023")] }), member("orphan")],
      none("orphan"),
      empty("orphan"),
    );
    expect(inactive.blockers).toEqual(["twin_inactive"]);
    const [holoo] = planRaceOrphans(
      [member("kept", { mappings: [woo("G1", { provider: "holoo", entityType: "holoo_goods" })] }), member("orphan")],
      none("orphan"),
      empty("orphan"),
    );
    expect(holoo.blockers).toEqual(["twin_not_woo_product"]);
  });

  it("blocks when two mapped rows could each be the twin", () => {
    const [plan] = planRaceOrphans(
      [member("a", { mappings: [woo("1")] }), member("b", { mappings: [woo("2")] }), member("orphan")],
      none("orphan"),
      empty("orphan"),
    );
    expect(plan.status).toBe("blocked");
    expect(plan.twinItemId).toBeNull();
    expect(plan.blockers).toEqual(["ambiguous_twin"]);
  });

  it("reports an already-archived orphan as done, not as work", () => {
    const [plan] = planRaceOrphans(
      [member("kept", { mappings: [woo("5023")] }), member("orphan", { isActive: false })],
      none("orphan"),
      empty("orphan"),
    );
    expect(plan.status).toBe("already_archived");
  });

  it("plans each orphan of a three-row group", () => {
    const plans = planRaceOrphans(
      [member("kept", { mappings: [woo("5023")] }), member("o1"), member("o2")],
      new Map([["o1", []], ["o2", [{ table: "item_batches", column: "item_id", count: 1 }]]]),
      new Map([["o1", { quantity: "0" }], ["o2", { quantity: "0" }]]),
    );
    expect(plans.map((p) => [p.orphanItemId, p.status])).toEqual([["o1", "archive"], ["o2", "blocked"]]);
  });
});

describe("planHistoricalDuplicates", () => {
  const august = "2026-08-26T08:00:00.000Z";

  it("plans a weeks-apart pair with no stock and no history for archive", () => {
    const [plan] = planHistoricalDuplicates(
      [member("kept", { mappings: [woo("5023")] }), member("old", { createdAt: august })],
      none("old"),
      empty("old"),
    );
    expect(plan).toMatchObject({ kind: "historical_duplicate_candidate", orphanItemId: "old", twinItemId: "kept", status: "archive" });
    expect(plan.daysApart).toBe(34);
  });

  it("never touches a pair created inside the ten-minute race window", () => {
    expect(
      planHistoricalDuplicates(
        [member("kept", { mappings: [woo("5023")] }), member("old", { createdAt: "2026-09-29T01:50:00.000Z" })],
        none("old"),
        empty("old"),
      ),
    ).toEqual([]);
  });

  it("blocks a historical twin that still holds stock, even when item_stock is its only row", () => {
    const [plan] = planHistoricalDuplicates(
      [member("kept", { mappings: [woo("5023")], quantity: "6" }), member("old", { createdAt: august, quantity: "5" })],
      none("old"),
      new Map([["old", { quantity: "5" }]]),
    );
    expect(plan.status).toBe("blocked");
    expect(plan.blockers).toEqual(["nonzero_stock"]);
    expect(plan.orphanQuantity).toBe("5");
  });

  it("does not pair two rows that only share a SKU", () => {
    const plans = planHistoricalDuplicates(
      [member("kept", { mappings: [woo("5023")] }), member("old", { createdAt: august, name: "کرم دیگر" })],
      none("old"),
      empty("old"),
    );
    expect(plans).toEqual([]);
  });

  it("blocks a race pair whose names differ, instead of treating the SKU as proof", () => {
    // The race fingerprint does not compare names; the archive plan must, so a
    // shared SKU alone can never archive an unrelated row.
    const [plan] = planRaceOrphans(
      [member("kept", { mappings: [woo("5023")], name: "کرم مرطوب‌کننده" }), member("old", { name: "کرم دیگر" })],
      none("old"),
      empty("old"),
    );
    expect(plan.status).toBe("blocked");
    expect(plan.blockers).toEqual(["different_name"]);
  });
});
