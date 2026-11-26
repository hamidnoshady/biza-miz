/**
 * GH #1567 F5 — every pure input layer refuses embedded media the same way:
 * the value is refused with a reason, never stored and never stripped.
 * (DB-backed layers — product create, item meta, Woo inbound sync,
 * publication, the legacy report — are in
 * `integration/embedded-media.integration.test.ts`.)
 */
import { describe, expect, it } from "vitest";
import { coerceValue } from "./data-transfer/mapping";
import { requireEntity } from "./data-transfer/registry";
import type { EntityField } from "./data-transfer/types";
import { remoteText } from "./integrations/sync-service";
import { sanitizeProductPatch, WooOpsError } from "./integrations/woo-ops-service";
import { productContentFromMeta } from "./integrations/woo-product-content";
import { validateCategoryCreate, validateMenuItemCreate, validateMenuItemPatch } from "./menu-validation";
import { normalizeProductDescription, PRODUCT_LONG_DESCRIPTION_MAX } from "./product-content";
import { parseProductDescriptionReply } from "./product-description-ai";
import { parseProductCreateInput } from "./product-input";

const TINY = "data:image/gif;base64,R0lGODlhAQABAAAAACw=";
const ENCODED = "<img src=\"&#100;&#97;&#116;&#97;&#58;image/png;base64,AAAA\">";
const RAW_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

describe("product form + item meta (normalizeProductDescription / parseProductCreateInput)", () => {
  it("refuses a small data: URI (the < 20,000-char repro), encoded variants and raw base64", () => {
    for (const value of [TINY, ENCODED, `<p>${RAW_PNG}</p>`]) {
      expect(normalizeProductDescription(value, PRODUCT_LONG_DESCRIPTION_MAX)).toEqual({ ok: false, reason: "embedded_media" });
    }
    expect(normalizeProductDescription("پیراهن نخی", PRODUCT_LONG_DESCRIPTION_MAX)).toEqual({ ok: true, value: "پیراهن نخی" });
  });

  it("reports the field with the media-library message instead of saving", () => {
    const result = parseProductCreateInput({ name: "پیراهن", kind: "simple", longDescription: `<p>متن</p>${TINY}` });
    expect(result.ok).toBe(false);
    const issue = result.issues.find((entry) => entry.field === "longDescription");
    expect(issue?.code).toBe("embedded_media");
    expect(issue?.message).toContain("کتابخانهٔ رسانه");
  });
});

describe("Woo outbound patch (sanitizeProductPatch)", () => {
  it("refuses the whole patch — no field is queued with the image cut out", () => {
    expect(() => sanitizeProductPatch({ regular_price: "1000", description: `<p>x</p><img src="${TINY}">` })).toThrow(WooOpsError);
    expect(() => sanitizeProductPatch({ short_description: ENCODED })).toThrow("embedded_media");
    expect(() => sanitizeProductPatch({ name: `x ${RAW_PNG}` })).toThrow("embedded_media");
    expect(sanitizeProductPatch({ description: "<p>متن</p>" })).toEqual({ description: "<p>متن</p>" });
  });
});

describe("Woo inbound mirror (remoteText) — held, never truncated", () => {
  it("holds image-carrying or over-long store text with the reason and length, and mirrors clean text whole", () => {
    const carrying = `<p>a</p><img src="${TINY}">`;
    expect(remoteText(carrying, 1000)).toEqual({ text: null, held: "embedded_media", length: carrying.length });
    expect(remoteText("x".repeat(1200), 1000)).toEqual({ text: null, held: "too_long", length: 1200 });
    expect(remoteText("  متن فروشگاه  ", 1000)).toEqual({ text: "متن فروشگاه", held: null, length: 11 });
    const content = productContentFromMeta({ remoteDescriptionHeld: "embedded_media", remoteImageHeld: "embedded_media" });
    expect(content.held).toEqual({ description: "embedded_media", shortDescription: null, image: "embedded_media" });
    expect(content.description).toBeNull();
  });
});

describe("menu API (menu-validation)", () => {
  const categoryId = "3f1c2a9e-7b4d-4c3a-9f21-0a1b2c3d4e5f";
  it("refuses data:/javascript:/relative image links and image-carrying descriptions", () => {
    expect(validateMenuItemCreate({ categoryId, name: "لاته", price: 1000, imageUrl: TINY })).toEqual({ ok: false, error: "embedded_media" });
    expect(validateMenuItemCreate({ categoryId, name: "لاته", price: 1000, imageUrl: "javascript:alert(1)" })).toEqual({ ok: false, error: "invalid_media_url" });
    expect(validateMenuItemPatch({ imageUrl: "/img.png" })).toEqual({ ok: false, error: "invalid_media_url" });
    expect(validateMenuItemPatch({ description: ENCODED })).toEqual({ ok: false, error: "embedded_media" });
    expect(validateCategoryCreate({ name: "قهوه", description: TINY })).toEqual({ ok: false, error: "embedded_media" });
    const ok = validateMenuItemCreate({ categoryId, name: "لاته", price: 1000, imageUrl: "https://cdn.example.com/latte.jpg" });
    expect(ok.ok && ok.value.imageUrl).toBe("https://cdn.example.com/latte.jpg");
    expect(validateMenuItemPatch({ imageUrl: "" })).toEqual({ ok: true, value: { imageUrl: null } });
  });
});

describe("Data Transfer import (coerceValue) — every text cell, every entity", () => {
  const text: EntityField = { key: "description", label: "توضیحات", type: "longtext" };
  it("refuses a cell with inline media and accepts plain text", () => {
    expect(coerceValue(text, TINY, {}).message?.severity).toBe("error");
    expect(coerceValue(text, "%64ata%3Aimage%2Fpng%3Bbase64%2CAAAA", {}).message?.severity).toBe("error");
    expect(coerceValue(text, "پیراهن نخی", {})).toEqual({ value: "پیراهن نخی", message: null });
  });
  it("validates the image link column as a URL", () => {
    const field = requireEntity("pos.products").fields.find((f) => f.key === "imageUrl")!;
    expect(coerceValue(field, "javascript:alert(1)", {}).message?.severity).toBe("error");
    expect(coerceValue(field, TINY, {}).message?.severity).toBe("error");
    expect(coerceValue(field, "https://cdn.example.com/a.jpg", {})).toEqual({ value: "https://cdn.example.com/a.jpg", message: null });
  });
});

describe("AI product description draft", () => {
  it("is not a draft when the model inlines an image", () => {
    expect(parseProductDescriptionReply(JSON.stringify({ short: "کوتاه", long: `متن بلند ${TINY}` }))).toBeNull();
    expect(parseProductDescriptionReply(JSON.stringify({ short: "کوتاه", long: "بلند" }))).toEqual({ shortDescription: "کوتاه", longDescription: "بلند" });
  });
});
