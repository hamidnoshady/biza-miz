import { describe, expect, it } from "vitest";
import {
  TOROB_API_VERSION,
  TOROB_PAGE_SIZE,
  cursorResponse,
  errorBody,
  isPublishable,
  maxPages,
  pageResponse,
  parseTorobRequest,
  priceForTorob,
  type TorobProductV3,
} from "./contract";

/**
 * Issue #894 Wave 2 — the Product API v3 contract, asserted against the document.
 *
 * Every case below is a sentence from `torob/Torob-Sync`'s `product_api_v3.md`
 * turned into an assertion, because the expensive failures here are not crashes:
 * they are a shop that answers page 1 to a malformed request, or a sold-out
 * product that Torob displays as free.
 */

describe("the request modes", () => {
  it("accepts exactly the four documented shapes", () => {
    expect(parseTorobRequest({ page_urls: ["https://shop.example.com/product/34/"] })).toEqual({
      ok: true,
      request: { mode: "page_urls", pageUrls: ["https://shop.example.com/product/34/"] },
    });
    expect(parseTorobRequest({ page_uniques: ["12412_1"] })).toEqual({
      ok: true,
      request: { mode: "page_uniques", pageUniques: ["12412_1"] },
    });
    expect(parseTorobRequest({ page: 2, sort: "date_added_desc" })).toEqual({
      ok: true,
      request: { mode: "page", page: 2, sort: "date_added_desc" },
    });
    // Cursor mode is named by the key, even on the first page — `"cursor": null`.
    expect(parseTorobRequest({ cursor: null, sort: "product_id_desc" })).toEqual({
      ok: true,
      request: { mode: "cursor", cursor: null, sort: "product_id_desc" },
    });
    expect(parseTorobRequest({ cursor: "12345", sort: "product_id_desc" })).toEqual({
      ok: true,
      request: { mode: "cursor", cursor: "12345", sort: "product_id_desc" },
    });
  });

  it("refuses a request with no mode instead of defaulting to page 1", () => {
    // The document: "Do not set default values for parameters. If the request body
    // is empty or has invalid parameters, return a 400 error."
    expect(parseTorobRequest({})).toEqual({ ok: false, error: "empty_request" });
    expect(parseTorobRequest({ sort: "date_added_desc" } as never)).toEqual({
      ok: false,
      error: "empty_request",
    });
  });

  it("refuses a missing or unknown sort, in the document's own words", () => {
    expect(parseTorobRequest({ page: 1 })).toEqual({ ok: false, error: "sort_required" });
    expect(errorBody("sort_required")).toEqual({ error: "sort parameter is not provided" });
    expect(parseTorobRequest({ page: 1, sort: "title_asc" })).toEqual({ ok: false, error: "sort_invalid" });
    expect(parseTorobRequest({ page: 1, sort: 42 })).toEqual({ ok: false, error: "sort_invalid" });
  });

  it("refuses two modes in one body", () => {
    expect(parseTorobRequest({ page: 1, sort: "date_added_desc", page_uniques: ["a"] })).toEqual({
      ok: false,
      error: "multiple_modes",
    });
  });

  it("refuses empty or malformed lookups", () => {
    expect(parseTorobRequest({ page_urls: [] })).toEqual({ ok: false, error: "page_urls_invalid" });
    expect(parseTorobRequest({ page_urls: ["/product/1/"] })).toEqual({ ok: false, error: "page_urls_invalid" });
    expect(parseTorobRequest({ page_uniques: [] })).toEqual({ ok: false, error: "page_uniques_invalid" });
    expect(parseTorobRequest({ page_uniques: ["  "] })).toEqual({ ok: false, error: "page_uniques_invalid" });
  });

  it("refuses a page that is not a page", () => {
    for (const page of [0, -1, 1.5, "1", null]) {
      expect(parseTorobRequest({ page, sort: "date_added_desc" }), String(page)).toEqual({
        ok: false,
        error: "page_invalid",
      });
    }
  });

  it("keeps cursor mode to its one sort and refuses an empty cursor", () => {
    // "Cursor pagination uses a fixed page size of 100 and must not include page,
    // limit or size" — and it is defined only over product_id_desc.
    expect(parseTorobRequest({ cursor: "abc", sort: "date_added_desc" })).toEqual({
      ok: false,
      error: "cursor_requires_product_id_desc",
    });
    expect(parseTorobRequest({ cursor: "", sort: "product_id_desc" })).toEqual({
      ok: false,
      error: "cursor_invalid",
    });
  });

  it("refuses a body that is not an object at all", () => {
    expect(parseTorobRequest([])).toEqual({ ok: false, error: "body_not_object" });
    expect(parseTorobRequest("page=1")).toEqual({ ok: false, error: "body_not_object" });
    expect(parseTorobRequest(null)).toEqual({ ok: false, error: "body_not_object" });
  });
});

describe("the price pair", () => {
  it("never sends availability:true with a zero price, which Torob shows as free", () => {
    expect(priceForTorob({ available: true, toman: 250_000 })).toEqual({ current_price: 250_000, availability: true });
    // The document: "Use 0 for unavailable products" — paired with false.
    expect(priceForTorob({ available: false, toman: 250_000 })).toEqual({ current_price: 0, availability: false });
  });

  it("lets a shop publish a genuinely free product deliberately", () => {
    expect(priceForTorob({ available: true, toman: 0 })).toEqual({ current_price: 0, availability: true });
  });
});

describe("removed products", () => {
  it("treats an unpublished product as absent, not as out of stock", () => {
    expect(isPublishable({ sellable: true })).toBe(true);
    expect(isPublishable({ sellable: false })).toBe(false);
    // Absent means "the catalogue did not say", which is publishable.
    expect(isPublishable({})).toBe(true);
  });
});

describe("the response envelope", () => {
  const product: TorobProductV3 = {
    page_unique: "12412_1",
    page_url: "https://domain.com/product/34/",
    title: "Xiaomi Mi Note 10 Pro",
    current_price: 5_000_000,
    availability: true,
    image_links: ["https://domain.com/images/main.jpg"],
    spec: {},
    date_added: "2024-11-22T01:15:12+03:30",
  };

  it("names the API version the document requires", () => {
    expect(pageResponse({ products: [], page: 1, total: 0 }).api_version).toBe("torob_api_v3");
    expect(TOROB_API_VERSION).toBe("torob_api_v3");
  });

  it("counts pages at 100 per page, always at least one", () => {
    expect(TOROB_PAGE_SIZE).toBe(100);
    expect(maxPages(0)).toBe(1);
    expect(maxPages(100)).toBe(1);
    expect(maxPages(101)).toBe(2);
    expect(maxPages(150)).toBe(2);
  });

  it("wraps a page with the document's field names", () => {
    expect(pageResponse({ products: [product], page: 2, total: 150 })).toEqual({
      api_version: "torob_api_v3",
      current_page: 2,
      total: 150,
      max_pages: 2,
      next_cursor: null,
      products: [product],
    });
  });

  it("omits the page number in cursor mode and may report no total", () => {
    const cursor = cursorResponse({ products: [product], total: null, nextCursor: "12345" });
    expect(cursor).toEqual({
      api_version: "torob_api_v3",
      total: 1,
      max_pages: null,
      next_cursor: "12345",
      products: [product],
    });
    expect("current_page" in cursor).toBe(false);
  });

  it("answers a removed product with an empty list, as the document shows", () => {
    expect(pageResponse({ products: [], page: 1, total: 0 })).toMatchObject({
      total: 0,
      max_pages: 1,
      products: [],
    });
  });
});
