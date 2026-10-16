import { describe, expect, it } from "vitest";
import {
  filterPostable,
  mappingRefProblem,
  mergeExplicitDimensions,
  orderChannelRef,
  platformChannelRef,
  resolveTradingDimensions,
  type DimensionMappingRule,
  type TradingDocumentRefs,
} from "./accounting-dimension-mappings";
import type { DimensionKind, LineDimensions } from "./accounting-dimensions";

const CC1 = "11111111-1111-4111-8111-111111111111";
const CC2 = "22222222-2222-4222-8222-222222222222";
const PC1 = "33333333-3333-4333-8333-333333333333";
const ITEM1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ITEM2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CAT1 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SUP1 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const ALL_KINDS = new Set<DimensionKind>(["cost_center", "profit_center", "department", "detail"]);

function rule(partial: Partial<DimensionMappingRule> & Pick<DimensionMappingRule, "scope" | "ref" | "dimensions">): DimensionMappingRule {
  return { isActive: true, effectiveFrom: null, effectiveTo: null, ...partial };
}

const options = { entryDate: "2026-10-15", enabledKinds: ALL_KINDS };

describe("resolveTradingDimensions", () => {
  it("assigns nothing when no rule matches (unassigned, never invented)", () => {
    expect(resolveTradingDimensions([], { itemRefs: [ITEM1] }, options)).toBeNull();
  });

  it("resolves a channel rule when nothing more specific matches", () => {
    const rules = [rule({ scope: "sales_channel", ref: "channel:dine_in", dimensions: { profit_center: PC1 } })];
    const refs: TradingDocumentRefs = { itemRefs: [ITEM1], channelRefs: ["channel:dine_in"] };
    expect(resolveTradingDimensions(rules, refs, options)).toEqual({ profit_center: PC1 });
  });

  it("prefers item over category over supplier over channel", () => {
    const rules = [
      rule({ scope: "sales_channel", ref: "channel:dine_in", dimensions: { cost_center: CC1 } }),
      rule({ scope: "product_category", ref: CAT1, dimensions: { cost_center: CC2 } }),
      rule({ scope: "item", ref: ITEM1, dimensions: { cost_center: CC1, profit_center: PC1 } }),
    ];
    const refs: TradingDocumentRefs = {
      itemRefs: [ITEM1],
      categoryRefs: [CAT1],
      channelRefs: ["channel:dine_in"],
    };
    expect(resolveTradingDimensions(rules, refs, options)).toEqual({ cost_center: CC1, profit_center: PC1 });
  });

  it("resolves per kind: a specific level's absent kind is filled from the next level", () => {
    const rules = [
      rule({ scope: "item", ref: ITEM1, dimensions: { cost_center: CC1 } }),
      rule({ scope: "sales_channel", ref: "channel:delivery", dimensions: { cost_center: CC2, profit_center: PC1 } }),
    ];
    const refs: TradingDocumentRefs = { itemRefs: [ITEM1], channelRefs: ["channel:delivery"] };
    // cost_center from the item rule; profit_center only exists on the channel rule.
    expect(resolveTradingDimensions(rules, refs, options)).toEqual({ cost_center: CC1, profit_center: PC1 });
  });

  it("falls through a level whose rules disagree — never picks a side", () => {
    const rules = [
      rule({ scope: "item", ref: ITEM1, dimensions: { cost_center: CC1 } }),
      rule({ scope: "item", ref: ITEM2, dimensions: { cost_center: CC2 } }),
      rule({ scope: "product_category", ref: CAT1, dimensions: { cost_center: CC2 } }),
    ];
    const refs: TradingDocumentRefs = { itemRefs: [ITEM1, ITEM2], categoryRefs: [CAT1] };
    expect(resolveTradingDimensions(rules, refs, options)).toEqual({ cost_center: CC2 });
  });

  it("leaves a kind unassigned when every level disagrees", () => {
    const rules = [
      rule({ scope: "item", ref: ITEM1, dimensions: { cost_center: CC1 } }),
      rule({ scope: "item", ref: ITEM2, dimensions: { cost_center: CC2 } }),
    ];
    const refs: TradingDocumentRefs = { itemRefs: [ITEM1, ITEM2] };
    expect(resolveTradingDimensions(rules, refs, options)).toBeNull();
  });

  it("ignores inactive rules and rules whose window misses the posting date", () => {
    const rules = [
      rule({ scope: "item", ref: ITEM1, dimensions: { cost_center: CC1 }, isActive: false }),
      rule({ scope: "item", ref: ITEM2, dimensions: { cost_center: CC2 }, effectiveTo: "2026-10-01" }),
      rule({ scope: "item", ref: ITEM1, dimensions: { cost_center: CC1 }, effectiveFrom: "2026-11-01" }),
    ];
    const refs: TradingDocumentRefs = { itemRefs: [ITEM1, ITEM2] };
    expect(resolveTradingDimensions(rules, refs, options)).toBeNull();
  });

  it("never assigns a kind the business has switched off", () => {
    const rules = [rule({ scope: "item", ref: ITEM1, dimensions: { cost_center: CC1, profit_center: PC1 } })];
    const refs: TradingDocumentRefs = { itemRefs: [ITEM1] };
    const resolved = resolveTradingDimensions(rules, refs, { ...options, enabledKinds: new Set<DimensionKind>(["profit_center"]) });
    expect(resolved).toEqual({ profit_center: PC1 });
    expect(resolved?.cost_center).toBeUndefined();
  });

  it("a level silent on a kind abstains — the next level may still speak", () => {
    // Both item rules agree the profit centre and say nothing about the cost
    // centre: the channel rule's cost centre is not vetoed by their silence.
    const rules = [
      rule({ scope: "item", ref: ITEM1, dimensions: { profit_center: PC1 } }),
      rule({ scope: "item", ref: ITEM2, dimensions: { profit_center: PC1 } }),
      rule({ scope: "sales_channel", ref: "channel:dine_in", dimensions: { cost_center: CC1 } }),
    ];
    const refs: TradingDocumentRefs = { itemRefs: [ITEM1, ITEM2], channelRefs: ["channel:dine_in"] };
    expect(resolveTradingDimensions(rules, refs, options)).toEqual({ profit_center: PC1, cost_center: CC1 });
  });

  it("channel refs are consulted in the caller's specificity order", () => {
    const rules = [
      rule({ scope: "sales_channel", ref: "platform:snappfood", dimensions: { profit_center: PC1 } }),
      rule({ scope: "sales_channel", ref: "channel:delivery", dimensions: { cost_center: CC1 } }),
    ];
    const refs: TradingDocumentRefs = { channelRefs: ["platform:snappfood", "channel:delivery"] };
    expect(resolveTradingDimensions(rules, refs, options)).toEqual({ profit_center: PC1 });
    // Without the platform key, the plain channel rule applies.
    expect(resolveTradingDimensions(rules, { channelRefs: ["channel:delivery"] }, options)).toEqual({ cost_center: CC1 });
  });

  it("matching ignores case and surrounding spaces on refs", () => {
    const rules = [rule({ scope: "sales_channel", ref: "Dine_In ", dimensions: { profit_center: PC1 } })];
    expect(resolveTradingDimensions(rules, { channelRefs: [" dine_in"] }, options)).toEqual({ profit_center: PC1 });
  });
});

describe("filterPostable", () => {
  const dims: LineDimensions = { cost_center: CC1, profit_center: PC1 };

  it("keeps only values the posting policy accepts", () => {
    const kept = filterPostable(dims, (kind) => kind === "cost_center");
    expect(kept).toEqual({ cost_center: CC1 });
  });

  it("degrades to null when nothing survives — a stale rule never blocks the document", () => {
    expect(filterPostable(dims, () => false)).toBeNull();
    expect(filterPostable(null, () => true)).toBeNull();
  });
});

describe("mergeExplicitDimensions", () => {
  it("explicit wins per kind; mapping fills only what explicit leaves empty", () => {
    const merged = mergeExplicitDimensions({ cost_center: CC1 }, { cost_center: CC2, profit_center: PC1 });
    expect(merged).toEqual({ cost_center: CC1, profit_center: PC1 });
  });

  it("returns null when neither side carries anything", () => {
    expect(mergeExplicitDimensions(null, null)).toBeNull();
    expect(mergeExplicitDimensions({}, { cost_center: undefined })).toBeNull();
  });
});

describe("mapping refs", () => {
  it("uuid scopes refuse non-uuid refs", () => {
    expect(mappingRefProblem("item", ITEM1)).toBeNull();
    expect(mappingRefProblem("item", "dine_in")).toBe("mapping_ref_invalid");
    expect(mappingRefProblem("supplier", SUP1)).toBeNull();
  });

  it("channel keys are free text within the length and character rules", () => {
    expect(mappingRefProblem("sales_channel", "platform:snappfood")).toBeNull();
    expect(mappingRefProblem("sales_channel", "  ")).toBe("mapping_ref_required");
    expect(mappingRefProblem("sales_channel", "x".repeat(65))).toBe("mapping_ref_too_long");
    expect(mappingRefProblem("sales_channel", "a,b")).toBe("mapping_ref_invalid");
  });

  it("builds the engine's channel keys", () => {
    expect(platformChannelRef("SnappFood")).toBe("platform:snappfood");
    expect(orderChannelRef("dine_in")).toBe("channel:dine_in");
  });
});
