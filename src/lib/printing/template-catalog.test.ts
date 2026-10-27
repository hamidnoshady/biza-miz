import { describe, expect, it } from "vitest";
import { BUILT_IN_TEMPLATES } from "../print-template";
import {
  availableBuiltInTemplates,
  eligibleIndustryLabel,
  isTradeSpecificTemplate,
  isTemplateAvailable,
  templateMetadata,
  templateUnavailableReason,
  type TemplateAccessContext,
} from "./template-catalog";

const FOOD = { industry: "food_service" as const, wooEnabled: false };
const JEWELRY = { industry: "jewelry" as const, wooEnabled: false };
const COSMETICS = { industry: "cosmetics" as const, wooEnabled: false };
const WOO = { industry: "food_service" as const, wooEnabled: true };

function availableKeys(context: TemplateAccessContext): string[] {
  return availableBuiltInTemplates(context).map((template) => template.key);
}

describe("printing template catalog — business-type policy", () => {
  it("keeps every built-in on a stable, unique v1 catalog key", () => {
    const metadata = BUILT_IN_TEMPLATES.map(templateMetadata);
    expect(new Set(metadata.map((entry) => entry.key)).size).toBe(BUILT_IN_TEMPLATES.length);
    expect(metadata.every((entry) => entry.version === 1)).toBe(true);
    expect(metadata.every((entry) => entry.docType && entry.paper && entry.compatiblePrinterPurposes.length > 0)).toBe(true);
  });

  it("gives food-service businesses only supported receipts, invoices, kitchen tickets and shared Woo layouts", () => {
    const keys = availableKeys(FOOD);
    expect(keys).toContain("thermal80-receipt");
    expect(keys).toContain("a4-invoice");
    expect(keys).toContain("thermal80-kitchen-large");
    expect(keys).toContain("thermal58-receipt-compact");
    expect(keys).not.toContain("label57x40-label");
    expect(keys).not.toContain("label57x40-batch-expiry");
    expect(keys).not.toContain("a4-invoice-jewelry");
    expect(keys).not.toContain("woo-a4-invoice");
    expect(keys).not.toContain("woo-shipping-100x150");

    const withWoo = availableKeys(WOO);
    expect(withWoo).toContain("woo-a4-invoice");
    expect(withWoo).toContain("woo-shipping-100x150");
  });

  it("isolates jewelry templates and barcode labels from restaurant-only designs", () => {
    const keys = availableKeys(JEWELRY);
    expect(keys).toContain("thermal80-receipt");
    expect(keys).toContain("a4-invoice-jewelry");
    expect(keys).toContain("a4-invoice-serialized");
    expect(keys).toContain("label57x40-jewelry-tag");
    expect(keys).toContain("label57x40-shelf-price");
    expect(keys).not.toContain("thermal80-kitchen");
    expect(keys).not.toContain("thermal58-kitchen-compact");
    expect(keys).not.toContain("label57x40-batch-expiry");
  });

  it("exposes the batch/expiry label only when the industry profile grants that capability", () => {
    const keys = availableKeys(COSMETICS);
    expect(keys).toContain("label57x40-batch-expiry");
    expect(keys).toContain("label57x40-shelf-price");
    expect(keys).not.toContain("label57x40-jewelry-tag");
    expect(keys).not.toContain("thermal80-kitchen");
  });

  it("keeps a copied industry-specific layout restricted after it is saved", () => {
    const copy = {
      ...BUILT_IN_TEMPLATES.find((template) => template.key === "a4-invoice-jewelry")!,
      key: "saved-id",
      sourceKey: "a4-invoice-jewelry",
      name: "فاکتور سفارشی طلا",
    };
    expect(isTemplateAvailable(copy, JEWELRY)).toBe(true);
    expect(isTemplateAvailable(copy, FOOD)).toBe(false);
    expect(templateUnavailableReason(copy, FOOD)).toBe("industry_mismatch");
  });

  it("requires an active Woo connection as well as the business module", () => {
    const wooTemplate = BUILT_IN_TEMPLATES.find((template) => template.key === "woo-a4-invoice")!;
    expect(isTemplateAvailable(wooTemplate, FOOD)).toBe(false);
    expect(templateUnavailableReason(wooTemplate, FOOD)).toBe("woo_not_connected");
    expect(isTemplateAvailable(wooTemplate, WOO)).toBe(true);
  });

  it("does not let changing a copied source's document kind carry its old metadata", () => {
    const copiedKitchen = {
      ...BUILT_IN_TEMPLATES.find((template) => template.key === "thermal80-kitchen")!,
      key: "saved-kitchen",
      sourceKey: "thermal80-kitchen",
      docType: "receipt" as const,
    };
    expect(isTemplateAvailable(copiedKitchen, FOOD)).toBe(false);
    expect(templateUnavailableReason(copiedKitchen, FOOD)).toBe("unsupported_document");
  });

  it("names eligible industries from the shared catalog for the gallery", () => {
    const retail = templateMetadata(BUILT_IN_TEMPLATES.find((template) => template.key === "thermal58-receipt-grocery")!);
    const kitchen = templateMetadata(BUILT_IN_TEMPLATES.find((template) => template.key === "thermal80-kitchen")!);
    expect(eligibleIndustryLabel(retail)).toContain("طلا و جواهر");
    expect(eligibleIndustryLabel(kitchen)).toContain("کافه و رستوران");
  });
});

describe("printing template catalog — trade-specific marker", () => {
  it("marks kitchen and batch-expiry templates as trade-specific and plain receipts as general", () => {
    const byKey = (key: string) => BUILT_IN_TEMPLATES.find((template) => template.key === key)!;
    expect(isTradeSpecificTemplate(byKey("label57x40-batch-expiry"))).toBe(true);
    const kitchen = BUILT_IN_TEMPLATES.find((template) => template.docType === "kitchen")!;
    expect(isTradeSpecificTemplate(kitchen)).toBe(true);
    const receipt = BUILT_IN_TEMPLATES.find((template) => template.docType === "receipt")!;
    expect(isTradeSpecificTemplate(receipt)).toBe(false);
  });
});
