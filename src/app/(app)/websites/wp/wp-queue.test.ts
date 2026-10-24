import { describe, expect, it } from "vitest";
import { describePersianError, KIND_LABELS, STATUS_CONFIG } from "./queue-section";

/**
 * Unit tests for WordPress & WooCommerce Manager Queue and Events
 * logic, Persian diagnostics, kind mapping and status configuration.
 */

describe("WP Queue Kind and Error Diagnostics", () => {
  it("translates timeout and connection refused errors into user-friendly Persian", () => {
    expect(describePersianError("ETIMEDOUT: Connection timed out after 10000ms")).toContain("خطای شبکه");
    expect(describePersianError("ECONNREFUSED 127.0.0.1:443")).toContain("خطای شبکه");
    expect(describePersianError("fetch failed")).toContain("خطای شبکه");
  });

  it("translates 404 not found errors with proper guidance", () => {
    expect(describePersianError("HTTP 404: Product not found")).toContain("یافت نشد");
  });

  it("translates 401 and 403 authentication errors", () => {
    expect(describePersianError("401 Unauthorized: Invalid consumer secret")).toContain("عدم دسترسی");
    expect(describePersianError("403 Forbidden")).toContain("عدم دسترسی");
  });

  it("translates 500 internal server error", () => {
    expect(describePersianError("500 Internal Server Error on /wp-json/wc/v3/orders")).toContain("خطای داخلی سرور");
  });

  it("translates nonce replay protection errors", () => {
    expect(describePersianError("replayed_nonce")).toContain("درخواست تکراری");
  });

  it("translates taxonomy snapshot failures into actionable guidance (issue #939)", () => {
    expect(describePersianError("malformed_taxonomy_snapshot:terms_not_array")).toContain("بدون تغییر داده رد شد");
    expect(describePersianError("malformed_taxonomy_snapshot:taxonomy_missing")).toContain("نام طبقه‌بندی");
    expect(describePersianError("malformed_taxonomy_snapshot:term_2_bad_id")).toContain("شناسهٔ یکی از واژه‌ها");
    expect(describePersianError("malformed_taxonomy_snapshot:bad_chunk_index")).toContain("چانک");
    expect(describePersianError("malformed_taxonomy_snapshot:taxonomy_too_long")).toContain("نامعتبر بود");
    expect(describePersianError("taxonomy_sync_partial:product_tag")).toContain("همگام‌سازی دسته‌بندی‌ها ناقص بود");
    expect(describePersianError("wordpress_credentials_missing")).toContain("Application Password");
  });

  it("labels the taxonomy export job and the inbound taxonomy event (issue #939)", () => {
    expect(KIND_LABELS.taxonomy_export?.link).toBe("/websites/wp/taxonomies");
    expect(KIND_LABELS["catalogue.taxonomy_terms"]?.link).toBe("/websites/wp/taxonomies");
  });

  it("translates missing parent errors", () => {
    expect(describePersianError("parent remote id is required for variation")).toContain("محصول والد");
  });

  it("returns raw error message when no specific pattern matches", () => {
    expect(describePersianError("custom database constraint failure")).toBe("custom database constraint failure");
    expect(describePersianError(null)).toBe("");
  });

  it("verifies all operational event topics are accounted for", () => {
    const kindKeys = Object.keys(KIND_LABELS);
    expect(kindKeys.length).toBeGreaterThan(15);
    for (const [kind, config] of Object.entries(KIND_LABELS)) {
      expect(typeof kind).toBe("string");
      expect(kind.length).toBeGreaterThan(0);
      expect(config.label).toBeDefined();
      expect(config.desc).toBeDefined();
    }
  });

  it("verifies all status configurations have valid tones and labels", () => {
    for (const [status, config] of Object.entries(STATUS_CONFIG)) {
      expect(typeof status).toBe("string");
      expect(config.label).toBeDefined();
      expect(["positive", "active", "danger", "neutral"]).toContain(config.tone);
    }
  });

  // Issue #942 (F15/F10): every raw status the queue API can return has a
  // Persian label — an unlabelled status would render its English code.
  it("labels needs_review and skipped like every other raw status", () => {
    for (const status of [
      "pending",
      "processing",
      "failed",
      "dead",
      "needs_review",
      "skipped",
      "sent",
      "processed",
      "deferred",
      "duplicate",
    ]) {
      expect(STATUS_CONFIG[status], status).toBeDefined();
      expect(STATUS_CONFIG[status].label.length).toBeGreaterThan(0);
    }
    expect(STATUS_CONFIG.needs_review.tone).toBe("danger");
  });
});
