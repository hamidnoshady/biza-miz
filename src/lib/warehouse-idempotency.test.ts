/**
 * The idempotency hashes are the contract between "a retry" and "a different
 * act": a retry of the same request must fingerprint identically, and any
 * semantic change must fingerprint differently. These tests pin that for both
 * the collection and reversal hashes, including the properties that only show
 * up in production — key order, string padding, and numeric formatting.
 */
import { describe, expect, it } from "vitest";
import {
  buildCollectionPayloadHash,
  buildReversalPayloadHash,
  canonicalHash,
  isValidIdempotencyKey,
} from "./warehouse-idempotency";

const base = {
  kind: "receipt" as const,
  locationId: "11111111-1111-4111-8111-111111111111",
  supplierId: "22222222-2222-4222-8222-222222222222",
  recipient: null,
  documentNumber: "DOC-1",
  note: "یادداشت",
  freeGoodsReason: null,
  postingDate: "2026-01-01",
  lines: [
    {
      itemId: "33333333-3333-4333-8333-333333333333",
      quantity: "2",
      unitCost: "100",
      lot: "LOT-1",
      expiryDate: "2027-01-01",
    },
  ],
};

describe("canonicalHash", () => {
  it("ignores key order at every level", () => {
    const a = canonicalHash({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } });
    const b = canonicalHash({ a: { c: [3, { e: 5, f: 4 }], d: 2 }, b: 1 });
    expect(a).toBe(b);
  });

  it("normalises padding and nullish values", () => {
    expect(canonicalHash({ a: "  x  ", b: null })).toBe(canonicalHash({ b: undefined, a: "x" }));
  });
});

describe("buildCollectionPayloadHash", () => {
  it("is stable for the same payload", () => {
    expect(buildCollectionPayloadHash(base)).toBe(buildCollectionPayloadHash({ ...base }));
  });

  it("normalises surrounding whitespace in every text field", () => {
    const padded = {
      ...base,
      note: "  یادداشت ",
      documentNumber: " DOC-1 ",
      lines: [{ ...base.lines[0], lot: " LOT-1 ", quantity: " 2 " }],
    };
    expect(buildCollectionPayloadHash(padded)).toBe(buildCollectionPayloadHash(base));
  });

  it("changes when any header field changes", () => {
    const variants = [
      { ...base, kind: "issue" as const },
      { ...base, locationId: "44444444-4444-4444-8444-444444444444" },
      { ...base, supplierId: null },
      { ...base, recipient: "کسی" },
      { ...base, documentNumber: "DOC-2" },
      { ...base, note: "دیگر" },
      { ...base, freeGoodsReason: "هدیه" },
      { ...base, postingDate: "2026-01-02" },
    ];
    const original = buildCollectionPayloadHash(base);
    for (const variant of variants) {
      expect(buildCollectionPayloadHash(variant)).not.toBe(original);
    }
  });

  it("changes with line content", () => {
    const original = buildCollectionPayloadHash(base);
    expect(
      buildCollectionPayloadHash({ ...base, lines: [{ ...base.lines[0], quantity: "3" }] }),
    ).not.toBe(original);
    expect(
      buildCollectionPayloadHash({ ...base, lines: [{ ...base.lines[0], unitCost: "101" }] }),
    ).not.toBe(original);
    expect(
      buildCollectionPayloadHash({ ...base, lines: [{ ...base.lines[0], lot: "LOT-2" }] }),
    ).not.toBe(original);
    expect(
      buildCollectionPayloadHash({ ...base, lines: [{ ...base.lines[0], expiryDate: "2027-01-02" }] }),
    ).not.toBe(original);

  });

  it("fingerprints the lines as a set, so a reordered retry still replays", () => {
    // `canonicalHash` sorts lines deterministically (item, lot, quantity), and
    // the services sort them again before writing. A retry that arrives in a
    // different order therefore produces the same voucher, so it must be the
    // same fingerprint — otherwise a harmless reorder would 409.
    const twoLines = [
      base.lines[0],
      { ...base.lines[0], itemId: "55555555-5555-4555-8555-555555555555" },
    ];
    expect(buildCollectionPayloadHash({ ...base, lines: twoLines })).toBe(
      buildCollectionPayloadHash({ ...base, lines: [...twoLines].reverse() }),
    );
    // A different multiset is still a different document.
    expect(
      buildCollectionPayloadHash({
        ...base,
        lines: [twoLines[0], { ...twoLines[0], quantity: "3" }],
      }),
    ).not.toBe(buildCollectionPayloadHash({ ...base, lines: twoLines }));
  });
});

describe("buildReversalPayloadHash", () => {
  const originalId = "66666666-6666-4666-8666-666666666666";

  it("is stable for the same reversal", () => {
    expect(buildReversalPayloadHash({ originalId, note: "برگشت", reason: "خطای ثبت" })).toBe(
      buildReversalPayloadHash({ originalId, note: "برگشت", reason: "خطای ثبت" }),
    );
  });

  it("treats absent, null and empty text the same way", () => {
    expect(buildReversalPayloadHash({ originalId })).toBe(
      buildReversalPayloadHash({ originalId, note: null, reason: "" }),
    );
  });

  it("changes when the note or the reason changes", () => {
    const original = buildReversalPayloadHash({ originalId, note: "برگشت", reason: "خطای ثبت" });
    expect(buildReversalPayloadHash({ originalId, note: "دیگر", reason: "خطای ثبت" })).not.toBe(original);
    expect(buildReversalPayloadHash({ originalId, note: "برگشت", reason: "دیگر" })).not.toBe(original);
  });

  it("changes when a different document is reversed", () => {
    expect(
      buildReversalPayloadHash({ originalId: "77777777-7777-4777-8777-777777777777" }),
    ).not.toBe(buildReversalPayloadHash({ originalId }));
  });
});

describe("isValidIdempotencyKey", () => {
  it("accepts a uuid and rejects everything else the routes must 400 on", () => {
    expect(isValidIdempotencyKey("66666666-6666-4666-8666-666666666666")).toBe(true);
    for (const bad of ["", "   ", "not-a-uuid", "12345", null, undefined, 42, {}]) {
      expect(isValidIdempotencyKey(bad)).toBe(false);
    }
  });
});
