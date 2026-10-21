import { describe, expect, it } from "vitest";
import { internalBarcodeForPayload } from "./barcode";
import { parseProductCreateInput } from "./product-input";

const validBase = {
  name: "  پیراهن مردانه  ",
  sku: " SH-10 ",
  sellPrice: 1_500_000,
  purchasePrice: 900_000,
  quantity: "2.5",
  unit: "عدد",
  subUnit: "کارتن",
  conversionFactor: "12",
  minOrderQty: 0,
  reorderReminderQty: 3,
  leadTimeDays: 2,
  taxSalePercent: 10,
  taxPurchasePercent: 10,
  variants: [],
};

describe("parseProductCreateInput", () => {
  it("normalises a valid simple product", () => {
    const barcode = internalBarcodeForPayload("00000000001");
    const result = parseProductCreateInput({ ...validBase, barcode: ` ${barcode} ` });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({
      name: "پیراهن مردانه",
      sku: "SH-10",
      barcode,
      sellPrice: 1_500_000,
      purchasePrice: 900_000,
      quantity: "2.5",
      conversionFactor: 12,
      isSellable: true,
    });
  });

  it("rejects malformed request shapes instead of throwing", () => {
    expect(parseProductCreateInput(null)).toMatchObject({ ok: false });
    expect(parseProductCreateInput([])).toMatchObject({ ok: false });
    expect(parseProductCreateInput({ name: "کالا", variants: "not-an-array" })).toMatchObject({
      ok: false,
      issues: [{ code: "invalid_variants", section: "attributes" }],
    });
  });

  it("rejects unknown product, variant, and attribute fields instead of silently ignoring them", () => {
    const result = parseProductCreateInput({
      name: "کالا",
      extra: true,
      variants: [{
        attributes: [{ definitionId: "5b04a6c7-df35-4f35-b26b-1534bce6b391", name: "رنگ", value: "مشکی", custom: "ignored?" }],
        stale: true,
      }],
    });

    expect(result).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "unknown_field", field: "extra" }),
        expect.objectContaining({ code: "unknown_field", field: "variants.0.stale" }),
        expect.objectContaining({ code: "unknown_field", field: "variants.0.attributes.0.custom" }),
      ]),
    });
  });

  it("validates all numeric DB constraints before a write", () => {
    const result = parseProductCreateInput({
      ...validBase,
      sellPrice: 0,
      purchasePrice: -1,
      conversionFactor: 0,
      minOrderQty: -2,
      reorderReminderQty: -3,
      leadTimeDays: 1.5,
      taxSalePercent: 101,
      taxPurchasePercent: -1,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((entry) => entry.field)).toEqual(
      expect.arrayContaining([
        "sellPrice",
        "purchasePrice",
        "conversionFactor",
        "minOrderQty",
        "reorderReminderQty",
        "leadTimeDays",
        "taxSalePercent",
        "taxPurchasePercent",
      ]),
    );
  });

  it("requires a coherent primary/sub-unit conversion", () => {
    const missingFactor = parseProductCreateInput({ name: "کالا", unit: "عدد", subUnit: "کارتن" });
    expect(missingFactor).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ code: "conversion_required", section: "general" })]),
    });

    const factorWithoutUnits = parseProductCreateInput({ name: "کالا", conversionFactor: 12 });
    expect(factorWithoutUnits).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ code: "units_required", section: "general" })]),
    });
  });

  it("refuses empty and duplicate variant rows rather than silently creating a simple item", () => {
    const empty = parseProductCreateInput({ name: "تی‌شرت", variants: [{ sku: "TS-1", attributes: [] }] });
    expect(empty).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ code: "empty_variant", section: "attributes" })]),
    });

    const duplicate = parseProductCreateInput({
      name: "تی‌شرت",
      variants: [
        { attributes: [{ name: "رنگ", value: "مشکی" }] },
        { attributes: [{ name: " رنگ ", value: " مشکی " }] },
      ],
    });
    expect(duplicate).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ code: "duplicate_variant", section: "attributes" })]),
    });
  });

  it("keeps variant pricing and stock overrides and normalises Persian barcodes", () => {
    const barcode = internalBarcodeForPayload("00000000002");
    const persianBarcode = barcode.replace(/\d/g, (digit) => "۰۱۲۳۴۵۶۷۸۹"[Number(digit)]);
    const result = parseProductCreateInput({
      name: "کفش",
      sellPrice: 2_000_000,
      variants: [
        {
          sku: "K-42",
          barcode: persianBarcode,
          sellPrice: 2_200_000,
          purchasePrice: 1_200_000,
          quantity: "3",
          attributes: [
            { name: "رنگ", value: "مشکی" },
            { name: "سایز", value: "۴۲" },
          ],
        },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.variants[0]).toMatchObject({
      barcode,
      sellPrice: 2_200_000,
      purchasePrice: 1_200_000,
      quantity: "3",
    });
  });

  it("puts barcodes on sellable variants, never their container parent", () => {
    const barcode = internalBarcodeForPayload("00000000003");
    const result = parseProductCreateInput({
      name: "کفش",
      barcode,
      variants: [{ attributes: [{ name: "سایز", value: "۴۲" }] }],
    });

    expect(result).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ code: "parent_barcode_with_variants", section: "base" })]),
    });
  });

  it("rejects repeated barcodes in the same request", () => {
    const barcode = internalBarcodeForPayload("00000000004");
    const result = parseProductCreateInput({
      name: "کفش",
      variants: [
        { barcode, attributes: [{ name: "سایز", value: "۴۱" }] },
        { barcode, attributes: [{ name: "سایز", value: "۴۲" }] },
      ],
    });

    expect(result).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ code: "duplicate_barcode", section: "attributes" })]),
    });
  });

  it("accepts optional cover, deduplicated gallery, and per-variant shared media asset UUIDs while keeping images optional", () => {
    const coverId = "11111111-2222-3333-4444-555555555555";
    const g1 = "22222222-3333-4444-5555-666666666666";
    const g2 = "33333333-4444-5555-6666-777777777777";
    const vImg = "44444444-5555-6666-7777-888888888888";

    const parsed = parseProductCreateInput({
      name: "پیراهن کتان",
      coverMediaId: coverId,
      galleryMediaIds: [g1, g2, g1],
      variants: [
        {
          imageMediaId: vImg,
          attributes: [{ name: "سایز", value: "L" }],
        },
      ],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.data.coverMediaId).toBe(coverId);
    expect(parsed.data.galleryMediaIds).toEqual([g1, g2]);
    expect(parsed.data.variants[0].imageMediaId).toBe(vImg);

    const invalid = parseProductCreateInput({
      name: "پیراهن کتان",
      coverMediaId: "not-a-uuid",
    });
    expect(invalid).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ code: "invalid_media_id", field: "coverMediaId" })]),
    });
  });
});


/**
 * Issue #924 review item 3 — the advisor payload is optional provenance. A
 * malformed one is dropped rather than rejecting a valid product, while a
 * well-formed one survives with only scalar inputs.
 */
describe("parseProductCreateInput — price recommendation", () => {
  const recommendation = {
    suggestedPriceRial: 135_000,
    mode: "margin" as const,
    inputs: { referenceCostRial: 100_000, marginPercent: 25.9, rounded: true, note: "x".repeat(300), nested: { a: 1 } },
  };

  it("keeps a well-formed suggestion and its scalar inputs", () => {
    const result = parseProductCreateInput({ ...validBase, priceRecommendation: recommendation });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.priceRecommendation).toMatchObject({
      suggestedPriceRial: 135_000,
      mode: "margin",
    });
    expect(result.data.priceRecommendation?.inputs).toEqual({
      referenceCostRial: 100_000,
      marginPercent: 25.9,
      rounded: true,
    });
  });

  it("drops malformed provenance instead of failing the product", () => {
    for (const malformed of [
      { suggestedPriceRial: -1, mode: "markup" },
      { suggestedPriceRial: 1.5, mode: "markup" },
      { suggestedPriceRial: "135000", mode: "markup" },
      { suggestedPriceRial: 135_000, mode: "guess" },
      "not-an-object",
      null,
    ]) {
      const result = parseProductCreateInput({ ...validBase, priceRecommendation: malformed });
      expect(result.ok, JSON.stringify(malformed)).toBe(true);
      if (result.ok) expect(result.data.priceRecommendation).toBeNull();
    }
  });
});
