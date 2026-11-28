import { describe, expect, it } from "vitest";
import {
  classifyDuplicateGroup,
  describeProvenance,
  historicalTwinsOf,
  namesMatch,
  normaliseName,
  normaliseSku,
  normaliseStoreKey,
  verdictNeedsAction,
  type DuplicateItemMapping,
  type DuplicateItemMember,
} from "./duplicate-items";

const T0 = "2026-09-01T10:00:00.000Z";

function member(id: string, overrides: Partial<DuplicateItemMember> = {}): DuplicateItemMember {
  return {
    itemId: id,
    name: "رژ لب",
    sku: "zza05023",
    kind: "simple",
    parentItemId: null,
    isActive: true,
    locationId: "loc-1",
    locationName: "شعبه مرکزی",
    quantity: "5",
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

describe("classifyDuplicateGroup", () => {
  it("calls a parent and its own variations a legitimate family", () => {
    expect(
      classifyDuplicateGroup([
        member("p", { kind: "variant_parent", mappings: [woo("10")] }),
        member("c1", { kind: "variant_child", parentItemId: "p", mappings: [woo("11", { remoteParentId: "10" })] }),
        member("c2", { kind: "variant_child", parentItemId: "p", mappings: [woo("12", { remoteParentId: "10" })] }),
      ]),
    ).toBe("variant_family");
  });

  it("calls sibling variations without their parent a family too", () => {
    expect(
      classifyDuplicateGroup([
        member("c1", { kind: "variant_child", parentItemId: "p", mappings: [woo("11")] }),
        member("c2", { kind: "variant_child", parentItemId: "p", mappings: [woo("12")] }),
      ]),
    ).toBe("variant_family");
  });

  it("does not call children of two different parents a family", () => {
    expect(
      classifyDuplicateGroup([
        member("c1", { kind: "variant_child", parentItemId: "p1", mappings: [woo("11")] }),
        member("c2", { kind: "variant_child", parentItemId: "p2", mappings: [woo("12")] }),
      ]),
    ).toBe("distinct_remote_records");
  });

  it("flags an unmapped twin created moments after a mapped row as the race orphan", () => {
    expect(
      classifyDuplicateGroup([
        member("a", { mappings: [woo("501")], quantity: "6" }),
        member("b", { createdAt: "2026-09-01T10:00:02.000Z", quantity: "5" }),
      ]),
    ).toBe("race_orphan");
  });

  it("calls an unmapped twin of the same name created long after a mapped row a historical duplicate", () => {
    expect(
      classifyDuplicateGroup([
        member("a", { mappings: [woo("501")] }),
        member("b", { createdAt: "2026-09-05T10:00:00.000Z" }),
      ]),
    ).toBe("historical_duplicate_candidate");
  });

  it("does not call two different products with one code a historical duplicate", () => {
    expect(
      classifyDuplicateGroup([
        member("a", { mappings: [woo("501")], name: "کرم مرطوب‌کننده" }),
        member("b", { createdAt: "2026-09-05T10:00:00.000Z", name: "کرم ضدآفتاب" }),
      ]),
    ).toBe("unmapped_duplicate");
  });

  it("detects one remote record behind two items across two connections to one store", () => {
    expect(
      classifyDuplicateGroup([
        member("a", { mappings: [woo("900")] }),
        member("b", {
          createdAt: "2026-09-10T10:00:00.000Z",
          mappings: [woo("900", { connectionId: "conn-2", connectionName: "افزونه" })],
        }),
      ]),
    ).toBe("same_remote_mapped_twice");
  });

  it("calls two different remote products with one SKU a source problem", () => {
    expect(
      classifyDuplicateGroup([member("a", { mappings: [woo("700")] }), member("b", { mappings: [woo("701")] })]),
    ).toBe("distinct_remote_records");
  });

  it("calls one copy per branch a per-branch copy", () => {
    expect(
      classifyDuplicateGroup([member("a"), member("b", { locationId: "loc-2", createdAt: "2026-10-01T00:00:00.000Z" })]),
    ).toBe("per_branch_copies");
  });

  it("identifies an unmapped simple row beside a mapped variable family of the same name", () => {
    expect(
      classifyDuplicateGroup([
        member("p", { kind: "variant_parent", mappings: [woo("10")] }),
        member("c1", { kind: "variant_child", parentItemId: "p", mappings: [woo("11", { remoteParentId: "10" })] }),
        member("c2", { kind: "variant_child", parentItemId: "p", mappings: [woo("12", { remoteParentId: "10" })] }),
        member("flat", { createdAt: "2026-08-26T08:00:00.000Z" }),
      ]),
    ).toBe("historical_variant_orphan");
  });

  it("does not call a same-SKU simple row with a different name a family orphan", () => {
    expect(
      classifyDuplicateGroup([
        member("p", { kind: "variant_parent", mappings: [woo("10")] }),
        member("c1", { kind: "variant_child", parentItemId: "p", mappings: [woo("11")] }),
        member("flat", { createdAt: "2026-08-26T08:00:00.000Z", name: "کرم دیگر" }),
      ]),
    ).toBe("unmapped_duplicate");
  });

  it("does not guess between two mapped families with the orphan's name", () => {
    expect(
      classifyDuplicateGroup([
        member("p1", { kind: "variant_parent", mappings: [woo("10")] }),
        member("c1", { kind: "variant_child", parentItemId: "p1", mappings: [woo("11")] }),
        member("p2", { kind: "variant_parent", mappings: [woo("20")] }),
        member("c2", { kind: "variant_child", parentItemId: "p2", mappings: [woo("21")] }),
        member("flat", { createdAt: "2026-08-26T08:00:00.000Z" }),
      ]),
    ).toBe("unmapped_duplicate");
  });

  it("never classifies a variation as the flat family orphan", () => {
    expect(
      classifyDuplicateGroup([
        member("p", { kind: "variant_parent", mappings: [woo("10")] }),
        member("c1", { kind: "variant_child", parentItemId: "p", mappings: [woo("11")] }),
        member("stray", {
          kind: "variant_child",
          parentItemId: "p",
          createdAt: "2026-08-26T08:00:00.000Z",
        }),
      ]),
    ).not.toBe("historical_variant_orphan");
  });

  it("says which verdicts need a person", () => {
    expect(verdictNeedsAction("variant_family")).toBe(false);
    expect(verdictNeedsAction("per_branch_copies")).toBe(false);
    expect(verdictNeedsAction("race_orphan")).toBe(true);
    expect(verdictNeedsAction("historical_duplicate_candidate")).toBe(true);
    expect(verdictNeedsAction("historical_variant_orphan")).toBe(true);
    expect(verdictNeedsAction("same_remote_mapped_twice")).toBe(true);
  });
});

describe("helpers", () => {
  it("normalises SKUs, names and store URLs", () => {
    expect(normaliseSku("  ZZA05023 ")).toBe("zza05023");
    expect(normaliseSku("   ")).toBeNull();
    expect(normaliseName("  کرم   مرطوب‌کننده ")).toBe("کرم مرطوب‌کننده");
    expect(normaliseName("")).toBeNull();
    expect(normaliseStoreKey("https://www.Shop.example.com/")).toBe("shop.example.com");
    expect(normaliseStoreKey("http://shop.example.com")).toBe("shop.example.com");
    expect(normaliseStoreKey(null)).toBeNull();
  });

  it("pairs a historical twin only outside the race window and only on the same name", () => {
    const orphan = member("old", { createdAt: "2026-08-26T08:00:00.000Z" });
    const mapped = member("kept", { mappings: [woo("501")] });
    expect(historicalTwinsOf(orphan, [mapped])).toHaveLength(1);
    expect(historicalTwinsOf(orphan, [member("kept", { mappings: [woo("501")], name: "کرم دیگر" })])).toEqual([]);
    expect(historicalTwinsOf(orphan, [member("kept", { mappings: [woo("501")], createdAt: "2026-08-26T08:02:00.000Z" })])).toEqual([]);
    expect(namesMatch(orphan, mapped)).toBe(true);
  });

  it("describes provenance", () => {
    expect(describeProvenance(member("a"))).toBe("local (no integration mapping)");
    expect(describeProvenance(member("a", { mappings: [woo("11", { remoteParentId: "10" })] }))).toBe(
      "woocommerce «فروشگاه» product #11 parent #10",
    );
  });
});
