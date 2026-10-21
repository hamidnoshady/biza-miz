import { describe, expect, it } from "vitest";
import {
  TaxonomySnapshotError,
  dedupeTermSnapshot,
  parseSnapshotTerm,
  parseTaxonomySnapshotEvent,
} from "./woo-taxonomy-snapshot";

/**
 * Issue #939 TAX-03/TAX-15 — the payload gate for `catalogue.taxonomy_terms`.
 *
 * This event replaces a whole taxonomy mirror, deletes included, so every
 * shape that used to be coerced into "an empty snapshot" must now be a loud
 * refusal instead. Pure module, so the whole matrix lives here.
 */

const validTerm = { id: 7, name: "پوشاک", slug: "clothing", parent: 0, description: "", count: 12 };

describe("parseTaxonomySnapshotEvent", () => {
  it("accepts a well-formed full snapshot", () => {
    const parsed = parseTaxonomySnapshotEvent({
      taxonomy: "product_cat",
      terms: [validTerm, { id: "8", name: "تی‌شرت" }],
      generated_at: "2026-10-12T08:30:00+00:00",
    });
    expect(parsed.kind).toBe("full");
    if (parsed.kind !== "full") throw new Error("unreachable");
    expect(parsed.taxonomy).toBe("product_cat");
    expect(parsed.terms).toHaveLength(2);
    // A numeric-string id from plugin JSON is normalised, not rejected.
    expect(parsed.terms[1]).toMatchObject({ id: 8, name: "تی‌شرت", slug: "", parent: 0, count: 0 });
    expect(parsed.generatedAt?.toISOString()).toBe("2026-10-12T08:30:00.000Z");
  });

  it("accepts an explicitly empty terms array — a taxonomy can legitimately have zero terms", () => {
    const parsed = parseTaxonomySnapshotEvent({ taxonomy: "brand", terms: [] });
    expect(parsed.kind).toBe("full");
    if (parsed.kind !== "full") throw new Error("unreachable");
    expect(parsed.terms).toEqual([]);
    expect(parsed.generatedAt).toBeNull();
  });

  it("refuses a missing terms field instead of reading it as empty", () => {
    // THE TAX-03 bug: this payload used to become `[]` and wipe the taxonomy.
    expect(() => parseTaxonomySnapshotEvent({ taxonomy: "product_cat" })).toThrow(TaxonomySnapshotError);
    expect(() => parseTaxonomySnapshotEvent({ taxonomy: "product_cat" })).toThrow(/terms_not_array/);
  });

  it.each([
    ["null", null],
    ["a string", "oops"],
    ["an object", { 0: validTerm }],
    ["a number", 42],
  ])("refuses terms given as %s", (_label, terms) => {
    expect(() => parseTaxonomySnapshotEvent({ taxonomy: "product_cat", terms })).toThrow(/terms_not_array/);
  });

  it("refuses the whole snapshot when one term is unreadable — dropping it would let a truncated push masquerade as complete", () => {
    expect(() =>
      parseTaxonomySnapshotEvent({ taxonomy: "product_cat", terms: [validTerm, { name: "بدون شناسه" }] }),
    ).toThrow(/term_1_bad_id/);
    expect(() =>
      parseTaxonomySnapshotEvent({ taxonomy: "product_cat", terms: [validTerm, null] }),
    ).toThrow(/term_1_not_object/);
    expect(() =>
      parseTaxonomySnapshotEvent({ taxonomy: "product_cat", terms: [{ id: 0, name: "صفر" }] }),
    ).toThrow(/term_0_bad_id/);
    expect(() =>
      parseTaxonomySnapshotEvent({ taxonomy: "product_cat", terms: [{ id: -3, name: "منفی" }] }),
    ).toThrow(/term_0_bad_id/);
  });

  it("refuses a missing, blank or oversized taxonomy slug", () => {
    expect(() => parseTaxonomySnapshotEvent({ terms: [] })).toThrow(/taxonomy_missing/);
    expect(() => parseTaxonomySnapshotEvent({ taxonomy: "   ", terms: [] })).toThrow(/taxonomy_empty/);
    expect(() => parseTaxonomySnapshotEvent({ taxonomy: "x".repeat(191), terms: [] })).toThrow(/taxonomy_too_long/);
  });

  it("refuses a payload that is not an object", () => {
    expect(() => parseTaxonomySnapshotEvent(null)).toThrow(/payload_not_object/);
    expect(() => parseTaxonomySnapshotEvent([])).toThrow(/payload_not_object/);
  });

  it("treats an unparseable generated_at as absent rather than malformed — old plugins send none", () => {
    const parsed = parseTaxonomySnapshotEvent({ taxonomy: "brand", terms: [], generated_at: "not-a-date" });
    expect(parsed.kind).toBe("full");
    if (parsed.kind !== "full") throw new Error("unreachable");
    expect(parsed.generatedAt).toBeNull();
  });

  it("accepts a well-formed chunk", () => {
    const parsed = parseTaxonomySnapshotEvent({
      taxonomy: "product_cat",
      terms: [validTerm],
      generated_at: "2026-10-12T08:30:00+00:00",
      snapshot_id: "snap-1",
      chunk_index: 1,
      chunk_count: 3,
    });
    expect(parsed).toMatchObject({ kind: "chunk", snapshotId: "snap-1", chunkIndex: 1, chunkCount: 3 });
  });

  it("refuses half a chunk header — guessing the missing half could apply a part as the whole", () => {
    expect(() =>
      parseTaxonomySnapshotEvent({ taxonomy: "product_cat", terms: [], snapshot_id: "snap-1" }),
    ).toThrow(/bad_chunk_count/);
    expect(() =>
      parseTaxonomySnapshotEvent({ taxonomy: "product_cat", terms: [], chunk_index: 0, chunk_count: 2 }),
    ).toThrow(/bad_snapshot_id/);
    expect(() =>
      parseTaxonomySnapshotEvent({ taxonomy: "product_cat", terms: [], snapshot_id: "", chunk_index: 0, chunk_count: 2 }),
    ).toThrow(/bad_snapshot_id/);
  });

  it("refuses impossible chunk geometry", () => {
    expect(() =>
      parseTaxonomySnapshotEvent({ taxonomy: "t", terms: [], snapshot_id: "s", chunk_index: 0, chunk_count: 1 }),
    ).toThrow(/bad_chunk_count/);
    expect(() =>
      parseTaxonomySnapshotEvent({ taxonomy: "t", terms: [], snapshot_id: "s", chunk_index: 2, chunk_count: 2 }),
    ).toThrow(/bad_chunk_index/);
    expect(() =>
      parseTaxonomySnapshotEvent({ taxonomy: "t", terms: [], snapshot_id: "s", chunk_index: -1, chunk_count: 2 }),
    ).toThrow(/bad_chunk_index/);
  });
});

describe("parseSnapshotTerm", () => {
  it("coerces sparse fields to honest defaults and keeps the numbers non-negative", () => {
    const term = parseSnapshotTerm({ id: 5, count: -3, parent: -1, menu_order: 2 }, 0);
    expect(term).toMatchObject({ id: 5, name: "", slug: "", description: "", count: 0, parent: 0, menu_order: 2 });
  });

  it("carries a term's own taxonomy tag through when present", () => {
    const term = parseSnapshotTerm({ ...validTerm, taxonomy: "product_cat" }, 0);
    expect(term.taxonomy).toBe("product_cat");
  });
});

describe("dedupeTermSnapshot", () => {
  it("keeps the first of a duplicated id and counts the collapse", () => {
    const { terms, duplicates } = dedupeTermSnapshot([
      { ...validTerm, id: 7, name: "اول" },
      { ...validTerm, id: 8, name: "دوم" },
      { ...validTerm, id: 7, name: "سوم" },
    ] as never);
    expect(terms.map((t) => t.name)).toEqual(["اول", "دوم"]);
    expect(duplicates).toBe(1);
  });

  it("is a no-op on a clean snapshot", () => {
    const { terms, duplicates } = dedupeTermSnapshot([{ ...validTerm, id: 1 }, { ...validTerm, id: 2 }] as never);
    expect(terms).toHaveLength(2);
    expect(duplicates).toBe(0);
  });
});
