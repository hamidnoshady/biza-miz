import { describe, expect, it } from "vitest";
import { DEFAULT_FIELD_AUTHORITY_POLICY } from "./field-authority";
import { identityKeysOf, planInventory, planProducts, recordFingerprint } from "./plan";
import type { CanonicalProduct } from "./resolvers";
import type { IncomingInventory, IncomingProduct } from "./types";

function canonical(id: string, sku: string, over: Partial<CanonicalProduct> = {}): CanonicalProduct {
  return {
    id,
    locationId: "loc-1",
    name: `کالا ${id}`,
    sku,
    barcodes: [],
    kind: "simple",
    unit: null,
    tracking: null,
    isActive: true,
    fields: { price: "1000", sku },
    ...over,
  };
}

function base(rows: CanonicalProduct[], mappings: Array<[string, string]> = []) {
  const bySku = new Map<string, CanonicalProduct[]>();
  for (const p of rows) if (p.sku) bySku.set(p.sku, [...(bySku.get(p.sku) ?? []), p]);
  return {
    locationId: "loc-1",
    mappings: new Map(mappings),
    canonicalById: new Map(rows.map((p) => [p.id, p])),
    candidatesBySku: bySku,
    candidatesByBarcode: new Map(),
    candidatesByName: new Map(),
  };
}

const policy = { policy: DEFAULT_FIELD_AUTHORITY_POLICY };

describe("planProducts", () => {
  it("links a Holoo/Woo overlap to one canonical product and creates only the true new ones", () => {
    // 200 Holoo-sourced canonical rows, 150 Woo products of which 50 overlap — the issue's matrix, scaled down.
    const rows = Array.from({ length: 200 }, (_, i) => canonical(`p${i}`, `SKU-${i}`));
    const woo: IncomingProduct[] = Array.from({ length: 150 }, (_, i) => ({
      domain: "product",
      externalId: `woo-${i}`,
      name: `محصول ${i}`,
      sku: i < 50 ? `SKU-${i}` : `WOO-ONLY-${i}`,
    }));
    const planned = planProducts(woo, base(rows), policy);
    const outcomes = planned.map((p) => p.resolution.outcome);
    expect(outcomes.filter((o) => o === "safe_match")).toHaveLength(50);
    expect(outcomes.filter((o) => o === "create_new")).toHaveLength(100);
    // One canonical product per overlapping SKU — no second row proposed for the 50.
    const linkedIds = planned.filter((p) => p.resolution.outcome === "safe_match").map((p) => p.resolution.canonicalId);
    expect(new Set(linkedIds).size).toBe(50);
  });

  it("is idempotent: a second run over the same mapped data proposes nothing new", () => {
    const rows = [canonical("p1", "A"), canonical("p2", "B")];
    const records: IncomingProduct[] = [
      { domain: "product", externalId: "e1", name: "x", sku: "A" },
      { domain: "product", externalId: "e2", name: "y", sku: "B" },
    ];
    const second = planProducts(records, base(rows, [["e1", "p1"], ["e2", "p2"]]), policy);
    expect(second.every((p) => p.resolution.outcome === "already_linked")).toBe(true);
  });

  it("finds duplicates across the whole run, not just the batch it sees", () => {
    const first: IncomingProduct = { domain: "product", externalId: "a", name: "x", sku: "DUP" };
    const second: IncomingProduct = { domain: "product", externalId: "b", name: "y", sku: "dup" };
    const planned = planProducts([first], base([]), policy, [first, second]);
    expect(planned[0].resolution.outcome).toBe("ambiguous");
    expect(planned[0].resolution.reasons).toContain("duplicate_in_source");
  });

  it("turns a protected-field disagreement on a linked product into a field conflict", () => {
    const rows = [canonical("p1", "A", { fields: { price: "1000", sku: "A" } })];
    const [item] = planProducts(
      [{ domain: "product", externalId: "e1", name: "x", sku: "A", fields: { price: "1200", description: "new" } }],
      base(rows),
      { ...policy, readCanonical: (id) => rows.find((r) => r.id === id)?.fields ?? null },
    );
    expect(item.resolution.outcome).toBe("field_conflict");
    expect(item.resolution.canonicalId).toBe("p1");
    expect(item.conflicts.find((c) => c.field === "price")).toMatchObject({ needsReview: true, action: "review" });
  });

  it("keeps a linked product safe when only presentation differs", () => {
    const rows = [canonical("p1", "A", { fields: { description: "mine" } })];
    const [item] = planProducts(
      [{ domain: "product", externalId: "e1", name: "x", sku: "A", fields: { description: "theirs" } }],
      base(rows),
      { ...policy, readCanonical: () => rows[0].fields ?? null },
    );
    expect(item.resolution.outcome).toBe("safe_match");
    expect(item.conflicts[0].action).toBe("keep_canonical");
  });
});

describe("fingerprints and keys", () => {
  it("fingerprints independent of key order", () => {
    const a: IncomingProduct = { domain: "product", externalId: "1", name: "x", sku: "A", fields: { a: 1, b: 2 } };
    const b: IncomingProduct = { fields: { b: 2, a: 1 }, sku: "A", name: "x", externalId: "1", domain: "product" };
    expect(recordFingerprint(a)).toBe(recordFingerprint(b));
    expect(recordFingerprint(a)).not.toBe(recordFingerprint({ ...a, sku: "B" }));
  });

  it("derives identity keys for duplicate sweeps", () => {
    expect(identityKeysOf({ domain: "product", externalId: "1", name: "x", sku: "ab ۱", barcodes: ["6260000000012"] }).sort()).toEqual([
      "barcode:6260000000012",
      "sku:AB 1",
    ]);
    expect(identityKeysOf({ domain: "party", externalId: "1", name: "x", phone: "09121234567" })).toEqual(["phone:+989121234567"]);
    expect(identityKeysOf({ domain: "inventory", externalId: "1", kind: "snapshot", productExternalId: "p", quantity: "1" })).toEqual(["snapshot:p|"]);
    expect(identityKeysOf({ domain: "inventory", externalId: "1", kind: "movement", productExternalId: "p", quantity: "1" })).toEqual([]);
  });
});

describe("planInventory", () => {
  it("counts snapshots across the whole run so two cannot be added", () => {
    const one: IncomingInventory = { domain: "inventory", externalId: "s1", kind: "snapshot", productExternalId: "p", quantity: "5" };
    const two: IncomingInventory = { ...one, externalId: "s2", quantity: "7" };
    const ctx = {
      productLinks: new Map([["p", "c1"]]),
      stockByProduct: new Map([["c1", { productId: "c1", managed: true, quantity: "0", tracking: null }]]),
      appliedMovementIds: new Set<string>(),
    };
    const planned = planInventory([one], ctx, undefined, [one, two]);
    expect(planned[0].resolution.reasons).toContain("duplicate_snapshot");
  });
});
