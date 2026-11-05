import { describe, expect, it } from "vitest";
import type { DuplicateItemMember } from "./duplicate-items";
import {
  DUPLICATE_VERDICT_COPY,
  ORPHAN_BLOCKER_COPY,
  SHARED_SKU_IS_NOT_A_MERGE_KEY,
  duplicateAmbiguityNotes,
  keepSeparateReasons,
  referenceTableLabel,
} from "./duplicate-items-copy";

function member(overrides: Partial<DuplicateItemMember> = {}): DuplicateItemMember {
  return {
    itemId: "item-a",
    name: "گلیس",
    sku: "zza05023",
    kind: "simple",
    parentItemId: null,
    isActive: true,
    locationId: "loc-a",
    locationName: "شعبهٔ اصلی",
    quantity: "3",
    createdAt: "2026-10-31T09:00:00.000Z",
    mappings: [],
    ...overrides,
  };
}

const wooMapping = {
  connectionId: "conn-a",
  connectionName: "فروشگاه الف",
  provider: "woocommerce",
  storeKey: "shop.example.com",
  entityType: "product",
  remoteId: "5023",
  remoteParentId: null,
};

describe("the duplicate review's words", () => {
  it("names every verdict, including the two legitimate ones", () => {
    expect(Object.keys(DUPLICATE_VERDICT_COPY).sort()).toEqual([
      "distinct_remote_records",
      "per_branch_copies",
      "race_orphan",
      "same_remote_mapped_twice",
      "unmapped_duplicate",
      "variant_family",
    ]);
    expect(DUPLICATE_VERDICT_COPY.variant_family.label).toContain("طبیعی");
    expect(DUPLICATE_VERDICT_COPY.per_branch_copies.label).toContain("طبیعی");
  });

  it("names every blocker a plan can raise", () => {
    expect(Object.keys(ORPHAN_BLOCKER_COPY).sort()).toEqual([
      "ambiguous_twin",
      "has_references",
      "twin_inactive",
      "twin_not_woo_product",
    ]);
  });

  it("translates the reference tables, and falls back to the raw name", () => {
    expect(referenceTableLabel("order_items")).toBe("ردیف سفارش");
    expect(referenceTableLabel("some_future_table")).toBe("some_future_table");
  });

  it("says a shared SKU is not a merge key", () => {
    expect(SHARED_SKU_IS_NOT_A_MERGE_KEY).toContain("معیار ادغام نیست");
  });
});

describe("why a candidate is ambiguous", () => {
  it("has nothing to say about the two legitimate verdicts", () => {
    expect(duplicateAmbiguityNotes("variant_family", [member()])).toEqual([]);
    expect(duplicateAmbiguityNotes("per_branch_copies", [member()])).toEqual([]);
  });

  it("notes one mapped row beside an unmapped one", () => {
    const notes = duplicateAmbiguityNotes("race_orphan", [
      member({ itemId: "item-1", mappings: [wooMapping] }),
      member({ itemId: "item-2" }),
    ]);
    expect(notes).toContain("یک ردیف پیوند فروشگاه دارد و دیگری ندارد.");
  });

  it("notes rows in different branches", () => {
    const notes = duplicateAmbiguityNotes("unmapped_duplicate", [
      member({ itemId: "item-1", locationId: "loc-a" }),
      member({ itemId: "item-2", locationId: "loc-b" }),
    ]);
    expect(notes).toContain("ردیف‌ها به شعبه‌های مختلف تعلق دارند.");
  });

  it("separates two remote records from one record mapped twice", () => {
    const twoRecords = duplicateAmbiguityNotes("same_remote_mapped_twice", [
      member({ itemId: "item-1", mappings: [wooMapping] }),
      member({ itemId: "item-2", mappings: [{ ...wooMapping, remoteId: "5024" }] }),
    ]);
    expect(twoRecords).toContain("این ردیف‌ها به رکوردهای متفاوتی در فروشگاه وصل‌اند.");

    const oneRecord = duplicateAmbiguityNotes("same_remote_mapped_twice", [
      member({ itemId: "item-1", mappings: [wooMapping] }),
      member({ itemId: "item-2", mappings: [wooMapping] }),
    ]);
    expect(oneRecord).toContain("بیش از یک ردیف به یک رکورد فروشگاه وصل شده است.");
  });
});

describe("what justifies «نگهداری جداگانه»", () => {
  it("names the distinctions the rows genuinely do not share", () => {
    const reasons = keepSeparateReasons([
      member({ itemId: "item-1", locationId: "loc-a", mappings: [wooMapping] }),
      member({ itemId: "item-2", locationId: "loc-b" }),
    ]);
    expect(reasons).toContain("شعبه‌های متفاوت");
    expect(reasons).toContain("ردیف بدون پیوند (محلی)");
  });

  it("notices different providers and stores", () => {
    const reasons = keepSeparateReasons([
      member({ itemId: "item-1", mappings: [wooMapping] }),
      member({
        itemId: "item-2",
        mappings: [{ ...wooMapping, provider: "holoo", connectionId: "conn-b", entityType: "holoo_goods" }],
      }),
    ]);
    expect(reasons).toContain("منبع‌های متفاوت");
    expect(reasons).toContain("پیوند به فروشگاه‌های متفاوت");
  });

  it("says nothing about a group that shares everything", () => {
    // Same branch, same store, same remote record: nothing distinguishes them,
    // so the screen offers no "they are different" justification.
    expect(
      keepSeparateReasons([
        member({ itemId: "item-1", mappings: [wooMapping] }),
        member({ itemId: "item-2", mappings: [wooMapping] }),
      ]),
    ).toEqual([]);
  });
});
