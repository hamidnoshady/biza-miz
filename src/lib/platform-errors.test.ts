import { describe, it, expect } from "vitest";
import { platformErrorText, isKnownPlatformError } from "./platform-errors";

describe("platform-errors", () => {
  it("translates known shared codes to Persian text", () => {
    expect(platformErrorText("unauthorized")).toBe("وارد نشده‌اید.");
    expect(platformErrorText("forbidden")).toContain("سطح دسترسی");
    expect(platformErrorText("not_found")).toBe("پیدا نشد.");
  });

  it("translates the client-synthesized transport codes", () => {
    expect(platformErrorText("network_error")).toContain("ارتباط");
    expect(platformErrorText("parse_error")).toContain("پاسخ سرور");
    expect(platformErrorText("request_cancelled")).toContain("لغو");
    expect(platformErrorText("server_error")).toContain("سرور");
  });

  it("never returns the raw code for an unknown error", () => {
    const out = platformErrorText("some_totally_unknown_code");
    expect(out).not.toContain("some_totally_unknown_code");
    expect(out).toBe("خطای غیرمنتظره. دوباره تلاش کنید.");
  });

  it("prefers a caller-supplied domain-specific message", () => {
    expect(
      platformErrorText("domain_specific", { domain_specific: "پیام دامنه‌ای" }),
    ).toBe("پیام دامنه‌ای");
  });

  it("handles null/undefined without throwing", () => {
    expect(platformErrorText(null)).toBe("خطای غیرمنتظره. دوباره تلاش کنید.");
    expect(platformErrorText(undefined)).toBe("خطای غیرمنتظره. دوباره تلاش کنید.");
  });

  it("isKnownPlatformError reflects the shared vocabulary only", () => {
    expect(isKnownPlatformError("unauthorized")).toBe(true);
    expect(isKnownPlatformError("nope")).toBe(false);
    expect(isKnownPlatformError(null)).toBe(false);
  });

  it("maps every console knowledge error to actionable text (issue #938)", () => {
    for (const code of [
      "invalid_category_id",
      "invalid_tag_id",
      "invalid_parent_id",
      "invalid_sort_order",
      "invalid_version",
      "unknown_category",
      "unknown_tag",
      "unknown_reference",
      "too_many_tags",
      "too_many_section_keys",
      "version_conflict",
      "category_cycle",
      "query_too_long",
      "invalid_data",
      "invalid_video_url",
    ] as const) {
      expect(isKnownPlatformError(code), code).toBe(true);
      expect(platformErrorText(code), code).not.toBe("خطای غیرمنتظره. دوباره تلاش کنید.");
    }
    // A concurrent edit and a cycle must not share wording: the operator has to
    // know whether to reload or pick another parent.
    expect(platformErrorText("version_conflict")).toContain("نسخهٔ تازه");
    expect(platformErrorText("category_cycle")).toContain("زیرمجموعهٔ خودش");
  });

  it("maps every danger-zone code to useful Persian text (issue #822)", () => {
    // None of the known safety conditions may fall through to the generic
    // "unexpected error" message — each has its own operator-facing text.
    for (const code of [
      "protected_internal_business",
      "reset_confirmation_required",
      "reset_not_possible",
      "reset_failed",
      "delete_confirmation_required",
      "delete_failed",
      "delete_blocked",
      "not_found",
      "forbidden",
    ] as const) {
      expect(isKnownPlatformError(code), code).toBe(true);
      expect(platformErrorText(code), code).not.toBe("خطای غیرمنتظره. دوباره تلاش کنید.");
    }
    // Reset and delete keep distinguishable wording.
    expect(platformErrorText("reset_confirmation_required")).toContain("بازنشانی");
    expect(platformErrorText("delete_confirmation_required")).toContain("حذف");
    expect(platformErrorText("protected_internal_business")).toContain("داخلی");
  });
});
