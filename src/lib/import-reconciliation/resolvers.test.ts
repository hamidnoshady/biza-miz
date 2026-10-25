import { describe, expect, it } from "vitest";
import {
  amountDateKey,
  resolveFinancialDocument,
  resolveInventory,
  resolveParty,
  resolveProduct,
  snapshotKey,
  type CanonicalFinancialDocument,
  type CanonicalParty,
  type CanonicalProduct,
  type FinancialDocumentContext,
  type InventoryContext,
  type PartyContext,
  type ProductContext,
} from "./resolvers";
import type { IncomingFinancialDocument, IncomingInventory, IncomingParty, IncomingProduct } from "./types";

const LOC = "loc-1";

function product(over: Partial<CanonicalProduct> & { id: string }): CanonicalProduct {
  return { locationId: LOC, name: "کالا", sku: null, barcodes: [], kind: "simple", unit: null, tracking: null, isActive: true, ...over };
}

function productCtx(canonical: CanonicalProduct[], extra: Partial<ProductContext> = {}): ProductContext {
  const bySku = new Map<string, CanonicalProduct[]>();
  const byBarcode = new Map<string, CanonicalProduct[]>();
  const byName = new Map<string, CanonicalProduct[]>();
  for (const p of canonical) {
    if (p.sku) bySku.set(p.sku.toUpperCase(), [...(bySku.get(p.sku.toUpperCase()) ?? []), p]);
    for (const b of p.barcodes) byBarcode.set(b, [...(byBarcode.get(b) ?? []), p]);
    byName.set(p.name.toLowerCase(), [...(byName.get(p.name.toLowerCase()) ?? []), p]);
  }
  return {
    locationId: LOC,
    mappings: new Map(),
    canonicalById: new Map(canonical.map((p) => [p.id, p])),
    candidatesBySku: bySku,
    candidatesByBarcode: byBarcode,
    candidatesByName: byName,
    incomingSkuCounts: new Map(),
    incomingBarcodeCounts: new Map(),
    ...extra,
  };
}

function incoming(over: Partial<IncomingProduct> = {}): IncomingProduct {
  return { domain: "product", externalId: "ext-1", name: "قهوه", ...over };
}

describe("resolveProduct", () => {
  it("auto-links on a previously verified mapping and nothing else", () => {
    const target = product({ id: "p1", sku: "OTHER" });
    const r = resolveProduct(incoming({ sku: "SKU-1" }), productCtx([target], { mappings: new Map([["ext-1", "p1"]]) }));
    expect(r.outcome).toBe("already_linked");
    expect(r.canonicalId).toBe("p1");
  });

  it("does not recreate a product whose mapped target was deleted", () => {
    const r = resolveProduct(incoming(), productCtx([], { mappings: new Map([["ext-1", "gone"]]) }));
    expect(r.outcome).toBe("ambiguous");
    expect(r.reasons).toContain("mapped_target_missing");
  });

  it("safe-matches one candidate on a unique SKU", () => {
    const r = resolveProduct(incoming({ sku: "sku-1" }), productCtx([product({ id: "p1", sku: "SKU-1" })]));
    expect(r.outcome).toBe("safe_match");
    expect(r.canonicalId).toBe("p1");
    expect(r.reasons).toContain("unique_sku");
  });

  it("safe-matches on a barcode when the SKU is absent", () => {
    const r = resolveProduct(incoming({ barcodes: ["6260000000012"] }), productCtx([product({ id: "p1", barcodes: ["6260000000012"] })]));
    expect(r.outcome).toBe("safe_match");
    expect(r.reasons).toContain("unique_barcode");
  });

  it("creates a new product when nothing overlaps", () => {
    const r = resolveProduct(incoming({ sku: "NEW-1" }), productCtx([product({ id: "p1", sku: "SKU-1" })]));
    expect(r.outcome).toBe("create_new");
  });

  it("never matches on a name alone — it asks", () => {
    const r = resolveProduct(incoming({ name: "قهوه" }), productCtx([product({ id: "p1", name: "قهوه" })]));
    expect(r.outcome).toBe("ambiguous");
    expect(r.reasons).toEqual(["name_only"]);
    expect(r.canonicalId).toBeNull();
    expect(r.candidates).toHaveLength(1);
  });

  it("ignores a coincidental name when the record carries identifiers that matched nobody", () => {
    const r = resolveProduct(incoming({ sku: "NEW-9", name: "قهوه" }), productCtx([product({ id: "p1", name: "قهوه", sku: "OLD" })]));
    expect(r.outcome).toBe("create_new");
  });

  it("flags a non-unique SKU in the books as ambiguous", () => {
    const r = resolveProduct(
      incoming({ sku: "DUP" }),
      productCtx([product({ id: "p1", sku: "DUP" }), product({ id: "p2", sku: "DUP", name: "دیگر" })]),
    );
    expect(r.outcome).toBe("ambiguous");
    expect(r.reasons).toContain("multiple_candidates");
    expect(r.candidates.map((c) => c.id).sort()).toEqual(["p1", "p2"]);
  });

  it("flags a duplicate SKU inside the source for every row sharing it", () => {
    const ctx = productCtx([], { incomingSkuCounts: new Map([["DUP", 2]]) });
    expect(resolveProduct(incoming({ sku: "dup" }), ctx).reasons).toEqual(["duplicate_in_source"]);
  });

  it("refuses to link when the barcode and the SKU point at different products", () => {
    const r = resolveProduct(
      incoming({ sku: "A", barcodes: ["6260000000012"] }),
      productCtx([product({ id: "p1", sku: "A" }), product({ id: "p2", sku: "B", barcodes: ["6260000000012"] })]),
    );
    expect(r.outcome).toBe("ambiguous");
    expect(r.reasons).toContain("identifier_collision");
  });

  it("refuses to link a parent to a sellable child, or a different unit / tracking / variant / branch", () => {
    const base = { id: "p1", sku: "S1", unit: "kg", tracking: "none" as const };
    const ctxFor = (over: Partial<CanonicalProduct>) => productCtx([product({ ...base, ...over })]);
    expect(resolveProduct(incoming({ sku: "S1", kind: "variant_parent" }), ctxFor({ kind: "variant_child" })).reasons).toContain("type_mismatch");
    expect(resolveProduct(incoming({ sku: "S1", unit: "g" }), ctxFor({})).reasons).toContain("unit_mismatch");
    expect(resolveProduct(incoming({ sku: "S1", tracking: "serial" }), ctxFor({})).reasons).toContain("tracking_mismatch");
    expect(
      resolveProduct(incoming({ sku: "S1", variantOptions: { رنگ: "قرمز" } }), ctxFor({ variantOptions: { رنگ: "آبی" } })).reasons,
    ).toContain("variant_mismatch");
    expect(resolveProduct(incoming({ sku: "S1" }), ctxFor({ locationId: "loc-2" })).reasons).toContain("branch_mismatch");
  });

  it("does not link when the barcode matches but the SKU contradicts", () => {
    const r = resolveProduct(
      incoming({ sku: "NEW", barcodes: ["6260000000012"] }),
      productCtx([product({ id: "p1", sku: "OLD", barcodes: ["6260000000012"] })]),
    );
    expect(r.outcome).toBe("ambiguous");
    expect(r.reasons).toContain("identifier_conflict");
  });

  it("reports a disabled canonical product as an answer, not a miss", () => {
    const r = resolveProduct(incoming({ sku: "S1" }), productCtx([product({ id: "p1", sku: "S1", isActive: false })]));
    expect(r.outcome).toBe("safe_match");
    expect(r.notes).toContain("canonical_inactive");
  });

  it("rejects a record with no identity at all", () => {
    expect(resolveProduct(incoming({ name: null, sku: null }), productCtx([])).outcome).toBe("invalid");
  });
});

function party(over: Partial<CanonicalParty> & { id: string }): CanonicalParty {
  return { name: "علی", phones: [], verifiedPhones: [], emails: [], roles: ["customer"], isGuest: false, isArchived: false, ...over };
}

function partyCtx(canonical: CanonicalParty[], extra: Partial<PartyContext> = {}): PartyContext {
  const byPhone = new Map<string, CanonicalParty[]>();
  const byEmail = new Map<string, CanonicalParty[]>();
  const byName = new Map<string, CanonicalParty[]>();
  for (const p of canonical) {
    for (const ph of p.phones) byPhone.set(ph, [...(byPhone.get(ph) ?? []), p]);
    for (const e of p.emails) byEmail.set(e, [...(byEmail.get(e) ?? []), p]);
    byName.set(p.name.toLowerCase(), [...(byName.get(p.name.toLowerCase()) ?? []), p]);
  }
  return {
    mappings: new Map(),
    canonicalById: new Map(canonical.map((p) => [p.id, p])),
    candidatesByPhone: byPhone,
    candidatesByEmail: byEmail,
    candidatesByName: byName,
    incomingPhoneCounts: new Map(),
    ...extra,
  };
}

function incomingParty(over: Partial<IncomingParty> = {}): IncomingParty {
  return { domain: "party", externalId: "c-1", name: "علی", ...over };
}

describe("resolveParty", () => {
  it("flags the same phone as ambiguous and never merges when it is unverified", () => {
    const r = resolveParty(
      incomingParty({ phone: "09121234567" }),
      partyCtx([party({ id: "a", phones: ["+989121234567"] })]),
    );
    expect(r.outcome).toBe("ambiguous");
    expect(r.reasons).toContain("phone_match_unverified");
    expect(r.canonicalId).toBeNull();
  });

  it("links on a single VERIFIED phone", () => {
    const r = resolveParty(
      incomingParty({ phone: "09121234567" }),
      partyCtx([party({ id: "a", phones: ["+989121234567"], verifiedPhones: ["+989121234567"] })]),
    );
    expect(r.outcome).toBe("safe_match");
    expect(r.canonicalId).toBe("a");
  });

  it("does not take a supplier for the customer who owns the number", () => {
    const r = resolveParty(
      incomingParty({ phone: "09121234567", role: "supplier" }),
      partyCtx([party({ id: "a", phones: ["+989121234567"], verifiedPhones: ["+989121234567"] })]),
    );
    expect(r.outcome).toBe("ambiguous");
    expect(r.reasons).toContain("role_mismatch");
  });

  it("never auto-links onto a guest or archived file", () => {
    const r = resolveParty(
      incomingParty({ phone: "09121234567" }),
      partyCtx([party({ id: "a", phones: ["+989121234567"], verifiedPhones: ["+989121234567"], isGuest: true })]),
    );
    expect(r.reasons).toContain("guest_or_archived");
  });

  it("does not link when the e-mail contradicts the verified phone's owner", () => {
    const r = resolveParty(
      incomingParty({ phone: "09121234567", email: "x@y.com" }),
      partyCtx([party({ id: "a", phones: ["+989121234567"], verifiedPhones: ["+989121234567"], emails: ["a@b.com"] })]),
    );
    expect(r.outcome).toBe("ambiguous");
    expect(r.reasons).toContain("identifier_conflict");
  });

  it("flags a same-name stranger and a new contact for the same name, never silently creating or merging", () => {
    const nameOnly = resolveParty(incomingParty({ name: "علی" }), partyCtx([party({ id: "a", name: "علی" })]));
    expect(nameOnly.outcome).toBe("ambiguous");
    const newPhone = resolveParty(incomingParty({ phone: "09350000000" }), partyCtx([party({ id: "a", name: "علی", phones: ["+989121234567"] })]));
    expect(newPhone.outcome).toBe("ambiguous");
    expect(newPhone.reasons).toEqual(["name_only"]);
  });

  it("creates a new party when nothing overlaps", () => {
    expect(resolveParty(incomingParty({ name: "رضا", phone: "09350000000" }), partyCtx([party({ id: "a" })])).outcome).toBe("create_new");
  });

  it("never transfers marketing consent — it only notes it", () => {
    const r = resolveParty(incomingParty({ name: "رضا", consent: { sms: true } }), partyCtx([]));
    expect(r.notes).toContain("consent_not_transferred");
  });

  it("flags a duplicate phone inside the file", () => {
    const r = resolveParty(incomingParty({ phone: "09121234567" }), partyCtx([], { incomingPhoneCounts: new Map([["+989121234567", 2]]) }));
    expect(r.reasons).toContain("duplicate_in_source");
  });
});

function doc(over: Partial<CanonicalFinancialDocument> & { id: string }): CanonicalFinancialDocument {
  return { kind: "order", totalRial: "1000000", currency: "IRR", date: "2026-10-01", references: ["WOO-1"], origin: "manual", ...over };
}

function docCtx(canonical: CanonicalFinancialDocument[], extra: Partial<FinancialDocumentContext> = {}): FinancialDocumentContext {
  const byRef = new Map<string, CanonicalFinancialDocument[]>();
  const byAmount = new Map<string, CanonicalFinancialDocument[]>();
  for (const d of canonical) {
    for (const r of d.references) byRef.set(r, [...(byRef.get(r) ?? []), d]);
    const k = amountDateKey(d.kind, d.totalRial, d.date);
    byAmount.set(k, [...(byAmount.get(k) ?? []), d]);
  }
  return {
    mappings: new Map(),
    canonicalById: new Map(canonical.map((d) => [d.id, d])),
    candidatesByReference: byRef,
    candidatesByAmountDate: byAmount,
    bookCurrency: "IRR",
    ...extra,
  };
}

function incomingDoc(over: Partial<IncomingFinancialDocument> = {}): IncomingFinancialDocument {
  return { domain: "financial_document", externalId: "woo-order-1", kind: "order", totalRial: "1000000", date: "2026-10-01", references: ["WOO-1"], ...over };
}

describe("resolveFinancialDocument", () => {
  it("matches a past online sale already entered in accounting — no second document", () => {
    const r = resolveFinancialDocument(incomingDoc(), docCtx([doc({ id: "d1" })]));
    expect(r.outcome).toBe("historical_match");
    expect(r.historical).toBe(true);
    expect(r.canonicalId).toBe("d1");
  });

  it("flags a referenced document whose total differs instead of merging or doubling it", () => {
    const r = resolveFinancialDocument(incomingDoc({ totalRial: "1200000" }), docCtx([doc({ id: "d1" })]));
    expect(r.outcome).toBe("field_conflict");
    expect(r.reasons).toContain("reference_total_mismatch");
  });

  it("never merges two invoices on amount and date alone", () => {
    const r = resolveFinancialDocument(incomingDoc({ references: ["OTHER-7"] }), docCtx([doc({ id: "d1" })]));
    expect(r.outcome).toBe("ambiguous");
    expect(r.reasons).toEqual(["amount_date_only"]);
    expect(r.canonicalId).toBeNull();
    expect(r.notes).toContain("possible_manual_entry");
  });

  it("treats a verified mapping as already linked, and a lost target as a question", () => {
    expect(resolveFinancialDocument(incomingDoc(), docCtx([doc({ id: "d1" })], { mappings: new Map([["woo-order-1", "d1"]]) })).outcome).toBe("already_linked");
    expect(resolveFinancialDocument(incomingDoc(), docCtx([], { mappings: new Map([["woo-order-1", "gone"]]) })).outcome).toBe("ambiguous");
  });

  it("creates a historical record only as a reference, never as a posting by itself", () => {
    const r = resolveFinancialDocument(incomingDoc({ references: ["NEW-1"], date: "2026-09-01" }), docCtx([doc({ id: "d1" })]));
    expect(r.outcome).toBe("create_new");
    expect(r.historical).toBe(true);
  });

  it("rejects an unusable amount, a foreign currency and a record with no identity", () => {
    expect(resolveFinancialDocument(incomingDoc({ totalRial: "12.5" }), docCtx([])).reasons).toContain("invalid_amount");
    expect(resolveFinancialDocument(incomingDoc({ totalRial: null }), docCtx([])).reasons).toContain("invalid_amount");
    expect(resolveFinancialDocument(incomingDoc({ currency: "USD" }), docCtx([])).reasons).toContain("currency_mismatch");
    expect(resolveFinancialDocument(incomingDoc({ externalId: null, references: [] }), docCtx([])).reasons).toContain("missing_identity");
  });

  it("compares line items when both sides have them", () => {
    const lines = [{ sku: "A", quantity: "2", amountRial: "1000000" }];
    const same = resolveFinancialDocument(incomingDoc({ lines }), docCtx([doc({ id: "d1", lines })]));
    expect(same.outcome).toBe("historical_match");
    const different = resolveFinancialDocument(
      incomingDoc({ lines }),
      docCtx([doc({ id: "d1", lines: [{ sku: "A", quantity: "3", amountRial: "1000000" }] })]),
    );
    expect(different.outcome).toBe("field_conflict");
  });
});

function invCtx(over: Partial<InventoryContext> = {}): InventoryContext {
  return {
    productLinks: new Map([["sku-1", "p1"]]),
    stockByProduct: new Map([["p1", { productId: "p1", managed: true, quantity: "10", tracking: "none" }]]),
    appliedMovementIds: new Set(),
    incomingSnapshotCounts: new Map(),
    ...over,
  };
}

function incomingInv(over: Partial<IncomingInventory> = {}): IncomingInventory {
  return { domain: "inventory", externalId: "s-1", kind: "snapshot", productExternalId: "sku-1", quantity: "10", ...over };
}

describe("resolveInventory", () => {
  it("is never a safe match: an equal snapshot is already in the books, a different one is a conflict", () => {
    expect(resolveInventory(incomingInv(), invCtx()).outcome).toBe("already_linked");
    const r = resolveInventory(incomingInv({ quantity: "7.5" }), invCtx());
    expect(r.outcome).toBe("field_conflict");
    expect(r.notes).toContain("delta:-2.5");
  });

  it("does not guess a stock figure for a product that is not resolved yet", () => {
    expect(resolveInventory(incomingInv({ productExternalId: "unknown" }), invCtx()).reasons).toContain("product_unresolved");
  });

  it("treats a null quantity as unknown, not zero, and skips unmanaged stock", () => {
    expect(resolveInventory(incomingInv({ quantity: null }), invCtx()).reasons).toContain("null_quantity");
    const unmanaged = invCtx({ stockByProduct: new Map([["p1", { productId: "p1", managed: false, quantity: null, tracking: null }]]) });
    expect(resolveInventory(incomingInv(), unmanaged).reasons).toContain("stock_unmanaged");
  });

  it("proposes an opening-stock set, not an addition, when the books hold nothing yet", () => {
    const ctx = invCtx({ stockByProduct: new Map() });
    const r = resolveInventory(incomingInv({ quantity: "4" }), ctx);
    expect(r.outcome).toBe("create_new");
    expect(r.reasons).toContain("opening_stock");
    expect(r.notes).toContain("snapshot_set");
  });

  it("refuses two snapshots for one product and location — they are never added", () => {
    const ctx = invCtx({ incomingSnapshotCounts: new Map([[snapshotKey("sku-1", null), 2]]) });
    expect(resolveInventory(incomingInv({ quantity: "9" }), ctx).reasons).toContain("duplicate_snapshot");
  });

  it("applies a movement once: a replayed movement id is already applied", () => {
    const ctx = invCtx({ appliedMovementIds: new Set(["m-1"]) });
    expect(resolveInventory(incomingInv({ kind: "movement", externalId: "m-1", quantity: "2" }), ctx).outcome).toBe("already_linked");
    expect(resolveInventory(incomingInv({ kind: "movement", externalId: "m-2", quantity: "2" }), ctx).outcome).toBe("create_new");
  });

  it("leaves an online order's own deduction to the order", () => {
    const r = resolveInventory(incomingInv({ kind: "movement", externalId: "m-3", quantity: "-1", cause: "online_order" }), invCtx());
    expect(r.outcome).toBe("skipped");
    expect(r.reasons).toContain("order_owned_stock");
  });

  it("does not match lot/serial quantities onto untracked stock, and demands one per serial", () => {
    expect(resolveInventory(incomingInv({ lot: "L1" }), invCtx()).reasons).toContain("tracking_mismatch");
    const serial = invCtx({ stockByProduct: new Map([["p1", { productId: "p1", managed: true, quantity: "0", tracking: "serial" }]]) });
    expect(resolveInventory(incomingInv({ serial: "SN1", quantity: "2" }), serial).reasons).toContain("serial_quantity");
  });
});
