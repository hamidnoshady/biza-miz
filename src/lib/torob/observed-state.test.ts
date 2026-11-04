/**
 * Issue #894 Wave 4b — the vocabulary Torob's own answer is read through.
 *
 * These tests are about the one thing this module can get wrong without a network
 * or a database: saying something Torob did not say. A status without a sentence
 * is a number a merchant cannot act on; a sentence that calls normal out-of-stock
 * an error teaches them to ignore the screen; a total whose parts do not add up is
 * a number nobody should trust.
 */
import { describe, expect, it } from "vitest";
import {
  TOROB_LISTING_STAGE_COPY,
  TOROB_OBSERVATION_ERRORS,
  TOROB_OBSERVATION_ERROR_COPY,
  TOROB_PRODUCT_STATUSES,
  TOROB_PRODUCT_STATUS_COPY,
  TOROB_SHOP_STATUSES,
  TOROB_SHOP_STATUS_COPY,
  productIdFromPageUnique,
  summaryGroups,
  summaryUnaccounted,
  torobStatusTone,
  type TorobProductSummary,
} from "./observed-state";

const productId = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";

function summary(overrides: Partial<TorobProductSummary> = {}): TorobProductSummary {
  return {
    calculatedAt: "2026-10-07T13:00:00.000Z",
    total: 900,
    available: 600,
    notAvailable: 100,
    notAccessible: 100,
    notActive: 50,
    deleted: 50,
    notAccessibleErrors: [],
    ...overrides,
  };
}

describe("the vocabulary", () => {
  it("has a sentence for every Torob shop status, and each says what it is not", () => {
    for (const status of TOROB_SHOP_STATUSES) {
      expect(TOROB_SHOP_STATUS_COPY[status].label.length).toBeGreaterThan(0);
      expect(TOROB_SHOP_STATUS_COPY[status].summary.length).toBeGreaterThan(0);
    }
    // Only `active` may read as success: the other three are Torob's own process.
    expect(TOROB_SHOP_STATUS_COPY.active.tone).toBe("positive");
    expect(TOROB_SHOP_STATUS_COPY.crawler_active.tone).toBe("neutral");
    expect(TOROB_SHOP_STATUS_COPY.crawler_check.tone).toBe("neutral");
    expect(TOROB_SHOP_STATUS_COPY.blocked.tone).toBe("danger");
  });

  it("has a sentence for every product status, and the eleven are distinct", () => {
    const copy = TOROB_PRODUCT_STATUSES.map((status) => TOROB_PRODUCT_STATUS_COPY[status]);
    expect(copy).toHaveLength(11);
    expect(new Set(copy).size).toBe(copy.length);
  });

  it("has a sentence for every way a read can fail", () => {
    for (const error of TOROB_OBSERVATION_ERRORS) {
      expect(TOROB_OBSERVATION_ERROR_COPY[error].length).toBeGreaterThan(0);
    }
    // The three ours-not-Torob's failures are distinguishable from Torob refusals.
    expect(TOROB_OBSERVATION_ERROR_COPY.not_configured).toMatch(/توکن|دسترسی/);
    expect(TOROB_OBSERVATION_ERROR_COPY.channel_disabled).toMatch(/خاموش/);
  });

  it("keeps the three stages separate, and only the last one claims a listing", () => {
    expect(TOROB_LISTING_STAGE_COPY.feed.summary).toMatch(/آماده/);
    expect(TOROB_LISTING_STAGE_COPY.sent.summary).toMatch(/پذیرش به معنای نمایش نیست/);
    expect(TOROB_LISTING_STAGE_COPY.listing.summary).toMatch(/تنها این مرحله/);
  });
});

describe("which statuses are a problem", () => {
  it("calls only the merchant's own fixable failures a problem", () => {
    expect(torobStatusTone("page_not_accessible")).toBe("danger");
    expect(torobStatusTone("price_not_valid")).toBe("danger");
    expect(torobStatusTone("page_deleted_permanent_content")).toBe("danger");
  });

  it("leaves Torob's own process and ordinary out-of-stock unalarming", () => {
    // A sold-out product is an everyday fact, and `in_progress_add` is Torob
    // working; painting either red is how a merchant learns to ignore the colour.
    expect(torobStatusTone("page_not_available")).toBe("neutral");
    expect(torobStatusTone("in_progress_add")).toBe("neutral");
    expect(torobStatusTone("base_not_confirmed")).toBe("neutral");
  });
});

describe("the product summary", () => {
  it("lists the five groups in Torob's order with their counts", () => {
    const groups = summaryGroups(summary());
    expect(groups.map((group) => group.key)).toEqual([
      "available",
      "notAvailable",
      "notAccessible",
      "notActive",
      "deleted",
    ]);
    expect(groups.reduce((sum, group) => sum + group.value, 0)).toBe(900);
  });

  it("reports nothing unaccounted when the groups add up", () => {
    expect(summaryUnaccounted(summary())).toBe(0);
  });

  it("surfaces a total its own groups contradict instead of hiding it", () => {
    expect(summaryUnaccounted(summary({ total: 950 }))).toBe(50);
    expect(summaryUnaccounted(summary({ total: 800 }))).toBe(-100);
  });
});

describe("productIdFromPageUnique", () => {
  it("reads the product out of a plain page", () => {
    expect(productIdFromPageUnique(productId)).toBe(productId);
  });

  it("reads the product out of a variant page", () => {
    expect(productIdFromPageUnique(`${productId}~42`)).toBe(productId);
  });

  it("refuses to invent a product for an id that is not one of ours", () => {
    expect(productIdFromPageUnique("12412_1")).toBeNull();
    expect(productIdFromPageUnique("")).toBeNull();
    expect(productIdFromPageUnique(`${productId}x`)).toBeNull();
  });
});
