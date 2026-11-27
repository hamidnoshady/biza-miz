import { describe, expect, it } from "vitest";
import {
  planStockAuthority,
  stockAuthorityApprovalToken,
  summariseStockAuthority,
  type StockAuthorityApprovalEntry,
  type StockAuthorityInput,
} from "./duplicate-items-stock-authority";

function input(overrides: Partial<StockAuthorityInput> = {}): StockAuthorityInput {
  return {
    orphanQuantity: "2",
    canonicalQuantity: "2",
    storeQuantity: 2,
    storeSnapshotAt: "2026-11-25T18:10:15.886Z",
    variantFamily: false,
    canonicalActive: true,
    canonicalMapped: true,
    ...overrides,
  };
}

describe("planStockAuthority", () => {
  it("calls an equal snapshot safe: one physical count, two rows", () => {
    expect(planStockAuthority(input())).toMatchObject({
      evidence: "both_match_store",
      verdict: "safe_to_archive",
      physicalUnitsDelta: 0,
      catalogueUnitsDelta: -2,
      canonicalAfter: 2,
      blockers: [],
    });
  });

  it("calls a stale orphan safe when the surviving row equals the store", () => {
    expect(planStockAuthority(input({ orphanQuantity: "5" }))).toMatchObject({
      evidence: "canonical_matches_store",
      verdict: "safe_to_archive",
      physicalUnitsDelta: 0,
      catalogueUnitsDelta: -5,
    });
  });

  it("refuses when the store agrees with the orphan but not the surviving row", () => {
    const proposal = planStockAuthority(input({ orphanQuantity: 2, canonicalQuantity: 0, storeQuantity: 2 }));
    expect(proposal.verdict).toBe("needs_store_reconciliation");
    expect(proposal.evidence).toBe("orphan_matches_store_canonical_differs");
    expect(proposal.physicalUnitsDelta).toBeNull();
    expect(proposal.catalogueUnitsDelta).toBe(0);
  });

  it("refuses when neither row equals the store", () => {
    expect(planStockAuthority(input({ orphanQuantity: 7, canonicalQuantity: 3, storeQuantity: 5 }))).toMatchObject({
      evidence: "neither_matches_store",
      verdict: "needs_store_reconciliation",
      blockers: ["store_mismatch"],
    });
  });

  it("refuses a missing store quantity, with and without a payload", () => {
    expect(planStockAuthority(input({ storeQuantity: null }))).toMatchObject({
      evidence: "store_stock_missing",
      verdict: "needs_store_reconciliation",
    });
    expect(planStockAuthority(input({ storeQuantity: null, storeSnapshotAt: null })).notes[0]).toMatch(/No product payload/);
  });

  it("refuses negative store stock instead of clamping it", () => {
    expect(planStockAuthority(input({ storeQuantity: -1 }))).toMatchObject({
      evidence: "store_stock_negative",
      blockers: ["store_stock_negative"],
    });
  });

  it("sends a variable family to a person, even when the numbers agree", () => {
    expect(planStockAuthority(input({ variantFamily: true }))).toMatchObject({
      evidence: "variant_family",
      verdict: "manual_review",
    });
  });

  it("refuses an inactive or unmapped surviving row", () => {
    expect(planStockAuthority(input({ canonicalActive: false })).evidence).toBe("canonical_unusable");
    expect(planStockAuthority(input({ canonicalMapped: false })).evidence).toBe("canonical_unusable");
  });

  it("is not a stock-authority case when the orphan holds nothing", () => {
    expect(planStockAuthority(input({ orphanQuantity: 0, storeQuantity: 0 })).evidence).toBe("orphan_has_no_stock");
  });
});

function entry(overrides: Partial<StockAuthorityApprovalEntry> = {}): StockAuthorityApprovalEntry {
  return {
    itemId: "item-1",
    sku: "zza1",
    orphanQuantity: 2,
    canonicalQuantity: 2,
    storeQuantity: 2,
    storeSnapshotAt: "2026-11-25T18:10:15.886Z",
    evidence: "both_match_store",
    verdict: "safe_to_archive",
    ...overrides,
  };
}

describe("stockAuthorityApprovalToken", () => {
  it("is deterministic and independent of input order", () => {
    const first = entry({ itemId: "a" });
    const second = entry({ itemId: "b", orphanQuantity: 1, canonicalQuantity: 1, storeQuantity: 1 });
    expect(stockAuthorityApprovalToken([first, second])).toBe(stockAuthorityApprovalToken([second, first]));
  });

  it("changes when a quantity or the evidence changes", () => {
    const base = stockAuthorityApprovalToken([entry()]);
    expect(stockAuthorityApprovalToken([entry({ orphanQuantity: 3 })])).not.toBe(base);
    expect(stockAuthorityApprovalToken([entry({ storeQuantity: 3 })])).not.toBe(base);
    expect(stockAuthorityApprovalToken([entry({ storeSnapshotAt: "2026-11-26T00:00:00.000Z" })])).not.toBe(base);
    expect(stockAuthorityApprovalToken([entry({ evidence: "canonical_matches_store" })])).not.toBe(base);
  });
});

describe("summariseStockAuthority", () => {
  it("counts safe rows and the catalogue units they would stop double-counting", () => {
    const summary = summariseStockAuthority([
      entry({ itemId: "a", orphanQuantity: 5, canonicalQuantity: 2, storeQuantity: 2 }),
      entry({ itemId: "b", verdict: "needs_store_reconciliation", evidence: "neither_matches_store", orphanQuantity: 1, canonicalQuantity: 0, storeQuantity: 0 }),
    ]);
    expect(summary).toEqual({
      pairs: 2,
      safe: 1,
      needsReconciliation: 1,
      manual: 0,
      orphanUnits: 6,
      canonicalUnits: 2,
      catalogueUnitsAfterSafeArchives: 3,
    });
  });
});
