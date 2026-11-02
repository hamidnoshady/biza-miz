import { describe, expect, it } from "vitest";
import {
  isProductPublishStatus,
  normalizeProductDescription,
  PRODUCT_LONG_DESCRIPTION_MAX,
  PRODUCT_SHORT_DESCRIPTION_MAX,
} from "./product-content";

describe("publish status", () => {
  it("accepts exactly the three storefront statuses", () => {
    for (const status of ["published", "draft", "private"]) expect(isProductPublishStatus(status)).toBe(true);
    for (const status of ["publish", "Published", "", null, undefined, 1]) expect(isProductPublishStatus(status)).toBe(false);
  });
});

describe("normalizeProductDescription", () => {
  it("trims, and stores blank as null so there is one shape for «no description»", () => {
    expect(normalizeProductDescription("  متن  ", 100)).toEqual({ ok: true, value: "متن" });
    expect(normalizeProductDescription("   ", 100)).toEqual({ ok: true, value: null });
    expect(normalizeProductDescription("", 100)).toEqual({ ok: true, value: null });
    expect(normalizeProductDescription(null, 100)).toEqual({ ok: true, value: null });
    expect(normalizeProductDescription(undefined, 100)).toEqual({ ok: true, value: null });
  });

  it("refuses a non-string and an over-long text instead of truncating", () => {
    expect(normalizeProductDescription(12, 100)).toEqual({ ok: false, reason: "invalid_text" });
    expect(normalizeProductDescription("x".repeat(101), 100)).toEqual({ ok: false, reason: "text_too_long" });
    expect(normalizeProductDescription("x".repeat(100), 100)).toEqual({ ok: true, value: "x".repeat(100) });
  });

  it("uses the same limits as migration 0260's CHECK constraints", () => {
    expect(PRODUCT_SHORT_DESCRIPTION_MAX).toBe(1000);
    expect(PRODUCT_LONG_DESCRIPTION_MAX).toBe(20000);
  });
});
