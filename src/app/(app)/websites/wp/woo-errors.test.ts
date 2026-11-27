/**
 * GH #1567 A2 — the Woo catalogue never shows the raw `embedded_media` code.
 * The products route answers a refused product text with that stable code;
 * the store host turns it into the owner-approved Persian sentence.
 */
import { describe, expect, it } from "vitest";
import { EMBEDDED_MEDIA_DESCRIPTION_MESSAGE } from "@/lib/embedded-media-guard";
import { describeWooError, WOO_ERROR_LABELS } from "./woo-errors";

describe("Woo error vocabulary — embedded media", () => {
  it("maps embedded_media to the approved Persian sentence", () => {
    expect(describeWooError("embedded_media")).toBe(EMBEDDED_MEDIA_DESCRIPTION_MESSAGE);
    expect(EMBEDDED_MEDIA_DESCRIPTION_MESSAGE).toBe(
      "توضیحات کالا شامل تصویر جاسازی‌شده است. لطفاً تصویر را حذف کنید یا از کتابخانه رسانه استفاده کنید.",
    );
    expect(describeWooError("embedded_media")).not.toContain("embedded_media");
  });

  it("keeps every label a Persian sentence, never a slug", () => {
    for (const [code, label] of Object.entries(WOO_ERROR_LABELS)) {
      expect(label, code).not.toMatch(/^[a-z_]+$/);
    }
  });

  it("leaves unmapped codes to the raw fallback", () => {
    expect(describeWooError("some_new_code")).toBe("");
    expect(describeWooError(undefined)).toBe("");
  });
});
