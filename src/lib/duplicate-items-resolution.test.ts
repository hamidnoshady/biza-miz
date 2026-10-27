import { describe, expect, it } from "vitest";
import type { DuplicateItemMapping, DuplicateItemMember } from "./duplicate-items";
import { planRaceOrphans, type ItemReference } from "./duplicate-items-resolution";

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

describe("planRaceOrphans", () => {
  it("archives an unreferenced unmapped twin of a live Woo-mapped item", () => {
    const [plan] = planRaceOrphans([member("kept", { mappings: [woo("5023")] }), member("orphan")], none("orphan"));
    expect(plan).toMatchObject({ orphanItemId: "orphan", twinItemId: "kept", status: "archive", blockers: [] });
  });

  it("plans nothing for an unmapped row that is not a twin of a mapped one", () => {
    const hand = member("hand", { createdAt: "2026-09-01T00:00:00.000Z" });
    expect(planRaceOrphans([member("kept", { mappings: [woo("5023")] }), hand], none("hand"))).toEqual([]);
  });

  it("blocks an orphan that anything references, and names the tables", () => {
    const refs = new Map<string, ItemReference[]>([
      ["orphan", [{ table: "retail_invoice_lines", column: "item_id", count: 2 }]],
    ]);
    const [plan] = planRaceOrphans([member("kept", { mappings: [woo("5023")] }), member("orphan")], refs);
    expect(plan.status).toBe("blocked");
    expect(plan.blockers).toEqual(["has_references"]);
    expect(plan.references).toEqual([{ table: "retail_invoice_lines", column: "item_id", count: 2 }]);
  });

  it("fails closed when the references were never checked", () => {
    const [plan] = planRaceOrphans([member("kept", { mappings: [woo("5023")] }), member("orphan")], new Map());
    expect(plan.status).toBe("blocked");
  });

  it("ignores reference rows with a zero count", () => {
    const refs = new Map<string, ItemReference[]>([["orphan", [{ table: "item_barcodes", column: "item_id", count: 0 }]]]);
    const [plan] = planRaceOrphans([member("kept", { mappings: [woo("5023")] }), member("orphan")], refs);
    expect(plan.status).toBe("archive");
  });

  it("blocks when the twin is archived or is not a Woo product mapping", () => {
    const [inactive] = planRaceOrphans(
      [member("kept", { isActive: false, mappings: [woo("5023")] }), member("orphan")],
      none("orphan"),
    );
    expect(inactive.blockers).toEqual(["twin_inactive"]);
    const [holoo] = planRaceOrphans(
      [member("kept", { mappings: [woo("G1", { provider: "holoo", entityType: "holoo_goods" })] }), member("orphan")],
      none("orphan"),
    );
    expect(holoo.blockers).toEqual(["twin_not_woo_product"]);
  });

  it("blocks when two mapped rows could each be the twin", () => {
    const [plan] = planRaceOrphans(
      [member("a", { mappings: [woo("1")] }), member("b", { mappings: [woo("2")] }), member("orphan")],
      none("orphan"),
    );
    expect(plan.status).toBe("blocked");
    expect(plan.twinItemId).toBeNull();
    expect(plan.blockers).toEqual(["ambiguous_twin"]);
  });

  it("reports an already-archived orphan as done, not as work", () => {
    const [plan] = planRaceOrphans(
      [member("kept", { mappings: [woo("5023")] }), member("orphan", { isActive: false })],
      none("orphan"),
    );
    expect(plan.status).toBe("already_archived");
  });

  it("plans each orphan of a three-row group", () => {
    const plans = planRaceOrphans(
      [member("kept", { mappings: [woo("5023")] }), member("o1"), member("o2")],
      new Map([["o1", []], ["o2", [{ table: "item_batches", column: "item_id", count: 1 }]]]),
    );
    expect(plans.map((p) => [p.orphanItemId, p.status])).toEqual([["o1", "archive"], ["o2", "blocked"]]);
  });
});
