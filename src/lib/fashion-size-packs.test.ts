// GH #1567 Phase 6C — the pure size-pack rules.
import { describe, expect, it } from "vitest";
import {
  canonicalPackRequest,
  expandPack,
  packAvailability,
  packReturnStatus,
  packTotals,
  SizePackRuleError,
  validatePackDefinition,
} from "./fashion-size-packs";

const S = "11111111-1111-4111-8111-111111111111";
const M = "22222222-2222-4222-8222-222222222222";
const L = "33333333-3333-4333-8333-333333333333";

describe("size packs (GH #1567 6C)", () => {
  it("prices a pack as the exact sum of its components", () => {
    expect(packTotals([
      { quantity: 1, unitPriceRial: 800_000 },
      { quantity: 2, unitPriceRial: 800_000 },
      { quantity: 2, unitPriceRial: 850_000 },
    ])).toEqual({ priceRial: 4_100_000, pieces: 5 });
  });

  it("refuses empty, duplicate, fractional and negative compositions", () => {
    const code = (fn: () => void) => { try { fn(); return null; } catch (e) { return (e as SizePackRuleError).code; } };
    expect(code(() => validatePackDefinition({ name: "", components: [{ itemId: S, quantity: 1, unitPriceRial: 1 }] }))).toBe("pack_name_required");
    expect(code(() => validatePackDefinition({ name: "x", components: [] }))).toBe("pack_has_no_components");
    expect(code(() => validatePackDefinition({ name: "x", components: [{ itemId: S, quantity: 1, unitPriceRial: 1 }, { itemId: S, quantity: 2, unitPriceRial: 1 }] }))).toBe("pack_duplicate_component");
    expect(code(() => validatePackDefinition({ name: "x", components: [{ itemId: S, quantity: 1.5, unitPriceRial: 1 }] }))).toBe("pack_invalid_quantity");
    expect(code(() => validatePackDefinition({ name: "x", components: [{ itemId: S, quantity: 1, unitPriceRial: -1 }] }))).toBe("pack_invalid_price");
    expect(code(() => validatePackDefinition({ name: "x", components: [{ itemId: S, quantity: 1, unitPriceRial: 0 }] }))).toBeNull();
  });

  it("derives availability from the scarcest component and names every shortage", () => {
    const comps = [
      { itemId: S, name: "S", quantity: 1, onHand: "5" },
      { itemId: M, name: "M", quantity: 2, onHand: "5" },
      { itemId: L, name: "L", quantity: 2, onHand: "3" },
    ];
    expect(packAvailability(comps).available).toBe(1);
    const { available, shortages } = packAvailability(comps, 3);
    expect(available).toBe(1);
    expect(shortages).toEqual([
      { itemId: M, name: "M", need: 6, onHand: "5", missing: "1" },
      { itemId: L, name: "L", need: 6, onHand: "3", missing: "3" },
    ]);
    expect(packAvailability([{ itemId: S, name: "S", quantity: 1, onHand: "-2" }]).available).toBe(0);
  });

  it("expands N packs into ordinary per-variant lines flagged with the pack", () => {
    const lines = expandPack("pack-1", [
      { itemId: S, name: "S", quantityPerPack: 1, unitPriceRial: 800_000 },
      { itemId: M, name: "M", quantityPerPack: 2, unitPriceRial: 850_000 },
    ], 3, 9);
    expect(lines).toEqual([
      { kind: "stocked", itemId: S, quantity: "3", unitPrice: 800_000, discount: 0, vatPercent: 9, sizePackId: "pack-1" },
      { kind: "stocked", itemId: M, quantity: "6", unitPrice: 850_000, discount: 0, vatPercent: 9, sizePackId: "pack-1" },
    ]);
    expect(() => expandPack("p", [], 0, 9)).toThrow(SizePackRuleError);
  });

  it("canonicalises the pack request so a retry with the same lines compares equal", () => {
    const a = canonicalPackRequest([{ packId: "p", quantity: 2, vatPercent: 9 }]);
    expect(a).toBe(canonicalPackRequest([{ packId: "p", quantity: 2, vatPercent: 9 }]));
    expect(a).not.toBe(canonicalPackRequest([{ packId: "p", quantity: 3, vatPercent: 9 }]));
  });

  it("reports sold / partially returned / returned from the child lines", () => {
    expect(packReturnStatus([{ quantity: "2", returnedQuantity: "0" }])).toBe("sold");
    expect(packReturnStatus([{ quantity: "2", returnedQuantity: "1" }, { quantity: "1", returnedQuantity: "0" }])).toBe("partially_returned");
    expect(packReturnStatus([{ quantity: "2", returnedQuantity: "2" }, { quantity: "1", returnedQuantity: "1" }])).toBe("returned");
  });
});
