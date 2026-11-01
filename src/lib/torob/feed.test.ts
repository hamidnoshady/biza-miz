import { describe, expect, it } from "vitest";
import {
  buildTorobFeed,
  isoTimestamp,
  lookupTorobProducts,
  sortTorobProducts,
  summariseFeed,
  torobFeedPage,
  torobPageResponse,
  variantPageUnique,
  type CatalogueProduct,
} from "./feed";

/**
 * Issue #894 Wave 2 — the feed builder, asserted as the Product API v3 sees it.
 *
 * These cases are written from Torob's side: what does a crawler receive for a
 * shop whose catalogue has a variant product, a sold-out product, a withdrawn
 * product and a malformed row? The answers are the contract's, not ours.
 */

const NOW = "2026-01-05T10:00:00.000Z";

function product(overrides: Partial<CatalogueProduct> = {}): CatalogueProduct {
  return {
    id: "6f1a4f6e-0000-4000-8000-000000000001",
    name: "گوشی موبایل",
    url: "https://shop.example.com/product/1/",
    imageUrls: ["https://shop.example.com/images/1.jpg"],
    priceRial: 25_000_000, // ۲٫۵۰۰٫۰۰۰ تومان
    available: true,
    currency: "IRR",
    dateAdded: NOW,
    ...overrides,
  };
}

describe("a sellable product", () => {
  it("becomes one v3 item with integer Toman and a spec dictionary", () => {
    const feed = buildTorobFeed({ products: [product()] });
    expect(feed.skipped).toEqual([]);
    expect(feed.items).toHaveLength(1);
    expect(feed.items[0]).toEqual({
      page_unique: "6f1a4f6e-0000-4000-8000-000000000001",
      page_url: "https://shop.example.com/product/1/",
      title: "گوشی موبایل",
      current_price: 2_500_000,
      availability: true,
      image_links: ["https://shop.example.com/images/1.jpg"],
      spec: {},
      date_added: NOW,
    });
  });

  it("carries the optional fields the catalogue actually has", () => {
    const feed = buildTorobFeed({
      products: [
        product({
          subtitle: "۱۲۸ گیگابایت",
          description: "توضیح کوتاه",
          categoryName: "موبایل",
          guarantee: "۱۸ ماه گارانتی",
          spec: { "حافظه": "۱۲۸ گیگابایت" },
          dateUpdated: "2026-01-06T10:00:00.000Z",
          oldPriceRial: 30_000_000,
        }),
      ],
    });
    expect(feed.items[0]).toMatchObject({
      subtitle: "۱۲۸ گیگابایت",
      short_desc: "توضیح کوتاه",
      category_name: "موبایل",
      guarantee: "۱۸ ماه گارانتی",
      spec: { "حافظه": "۱۲۸ گیگابایت" },
      date_updated: "2026-01-06T10:00:00.000Z",
      old_price: 3_000_000,
    });
  });

  it("drops an old price that is not above the selling price", () => {
    // A strikethrough below the current price is a price rise dressed as a discount.
    const feed = buildTorobFeed({
      products: [product({ oldPriceRial: 20_000_000 })],
    });
    expect(feed.items[0].old_price).toBeUndefined();
  });
});

describe("availability", () => {
  it("sends a sold-out product as available:false at price 0", () => {
    // `availability: true` with `current_price: 0` means FREE to Torob, and a stale
    // price means quoting a number the shop will not honour.
    const feed = buildTorobFeed({ products: [product({ available: false })] });
    expect(feed.items[0]).toMatchObject({ current_price: 0, availability: false });
  });

  it("honours a shop that hides out-of-stock products", () => {
    const feed = buildTorobFeed({ products: [product({ available: false })], includeOutOfStock: false });
    // Excluding these is the shop's choice, so it is not a "skipped" product.
    expect(feed.items).toEqual([]);
    expect(feed.skipped).toEqual([]);
  });
});

describe("a withdrawn product", () => {
  it("is absent from the list, not sent as out of stock", () => {
    const feed = buildTorobFeed({ products: [product({ sellable: false })] });
    expect(feed.items).toEqual([]);
    expect(feed.skipped.map((entry) => entry.reason)).toEqual(["not_sellable"]);
  });

  it("answers a direct page_urls or page_uniques lookup with nothing", () => {
    const live = product({ id: "live-id", url: "https://shop.example.com/product/live/" });
    const withdrawn = product({
      id: "gone-id",
      url: "https://shop.example.com/product/gone/",
      sellable: false,
    });
    const feed = buildTorobFeed({ products: [live, withdrawn] });

    expect(lookupTorobProducts(feed, { mode: "page_urls", pageUrls: [withdrawn.url] })).toEqual([]);
    expect(lookupTorobProducts(feed, { mode: "page_uniques", pageUniques: ["gone-id"] })).toEqual([]);
    expect(lookupTorobProducts(feed, { mode: "page_urls", pageUrls: [live.url] })).toHaveLength(1);
  });
});

describe("variants", () => {
  const parent = product({
    id: "p1",
    url: "https://shop.example.com/product/p1/",
    priceRial: 25_000_000,
    available: true,
    variants: [
      { id: "v-red", attributes: { "رنگ": "قرمز" }, priceRial: 25_000_000, available: true },
      { id: "v-blue", attributes: { "رنگ": "آبی" }, priceRial: 26_000_000, available: false },
    ],
  });

  it("emits one page per variant, sharing a product_group_id", () => {
    const feed = buildTorobFeed({ products: [parent] });
    expect(feed.items).toHaveLength(2);
    expect(feed.items.every((item) => item.product_group_id === "p1")).toBe(true);
    expect(feed.items.map((item) => item.page_unique).sort()).toEqual([
      variantPageUnique("p1", "v-blue"),
      variantPageUnique("p1", "v-red"),
    ]);
  });

  it("prices each variant at its own price, never the parent's", () => {
    const feed = buildTorobFeed({ products: [parent] });
    const blue = feed.items.find((item) => item.page_unique === "p1~v-blue")!;
    const red = feed.items.find((item) => item.page_unique === "p1~v-red")!;
    expect(red).toMatchObject({ current_price: 2_500_000, availability: true });
    expect(blue).toMatchObject({ current_price: 0, availability: false });
  });

  it("puts the variant's attributes in spec, beside the product's own", () => {
    const feed = buildTorobFeed({ products: [{ ...parent, spec: { "حافظه": "۱۲۸" } }] });
    const red = feed.items.find((item) => item.page_unique === "p1~v-red")!;
    expect(red.spec).toEqual({ "حافظه": "۱۲۸", "رنگ": "قرمز" });
  });

  it("gives the variant its own page without losing the product's query", () => {
    const feed = buildTorobFeed({
      products: [{ ...parent, url: "https://shop.example.com/product/p1/?lang=fa" }],
    });
    const red = feed.items.find((item) => item.page_unique === "p1~v-red")!;
    expect(red.page_url).toBe("https://shop.example.com/product/p1/?lang=fa&variant=v-red");
  });
});

describe("what cannot be published", () => {
  const cases: { reason: string; product: CatalogueProduct }[] = [
    { reason: "missing_name", product: product({ name: "  " }) },
    { reason: "missing_url", product: product({ url: "" }) },
    { reason: "unusable_url", product: product({ url: "not-a-url" }) },
    { reason: "missing_image", product: product({ imageUrls: [] }) },
    { reason: "missing_date", product: product({ dateAdded: "not-a-date" }) },
    { reason: "unsupported_currency", product: product({ currency: "USD" }) },
    { reason: "price_not_whole_toman", product: product({ priceRial: 25_000_005 }) },
    { reason: "negative_price", product: product({ priceRial: -1 }) },
    { reason: "price_out_of_range", product: product({ priceRial: 1_000_000_000_010 }) },
  ];

  it.each(cases)("skips a product with reason $reason", ({ reason, product: input }) => {
    const feed = buildTorobFeed({ products: [input] });
    expect(feed.items).toEqual([]);
    expect(feed.skipped).toHaveLength(1);
    expect(feed.skipped[0]).toMatchObject({ reason, productId: input.id, variantId: null });
  });

  it("gives every reason a merchant-facing sentence", () => {
    const feed = buildTorobFeed({ products: cases.map((entry) => entry.product) });
    const summary = summariseFeed(feed);
    expect(summary.skippedTotal).toBe(cases.length);
    for (const entry of summary.skippedByReason) expect(entry.copy.length).toBeGreaterThan(0);
  });
});

describe("duplicates", () => {
  it("publishes one item when two catalogue rows share a page", () => {
    // Imports reproduce themselves; two rows on one URL let Torob pick at random.
    const feed = buildTorobFeed({
      products: [product({ id: "a", url: "https://shop.example.com/p/1/" }), product({ id: "b", url: "https://shop.example.com/p/1/" })],
    });
    expect(feed.items).toHaveLength(1);
    expect(feed.skipped.map((entry) => entry.reason)).toEqual(["duplicate_page"]);
  });
});

describe("order", () => {
  const items = [
    product({ id: "c", dateAdded: "2026-01-01T00:00:00.000Z", dateUpdated: "2026-01-03T00:00:00.000Z" }),
    product({ id: "a", dateAdded: "2026-01-03T00:00:00.000Z" }),
    product({ id: "b", dateAdded: "2026-01-02T00:00:00.000Z", dateUpdated: "2026-01-02T00:00:00.000Z" }),
  ].map((entry) => ({ ...entry, url: `https://shop.example.com/product/${entry.id}/` }));

  it("is canonical before any request ask, so pages are stable", () => {
    const first = buildTorobFeed({ products: items }).items.map((item) => item.page_unique);
    const second = buildTorobFeed({ products: [...items].reverse() }).items.map((item) => item.page_unique);
    expect(first).toEqual(["a", "b", "c"]);
    expect(second).toEqual(first);
  });

  it("sorts by the request's field, newest first", () => {
    const feed = buildTorobFeed({ products: items });
    expect(sortTorobProducts(feed.items, "date_added_desc").map((item) => item.page_unique)).toEqual(["a", "b", "c"]);
    expect(sortTorobProducts(feed.items, "product_id_desc").map((item) => item.page_unique)).toEqual(["c", "b", "a"]);
  });

  it("sorts a missing date_updated last, not as if it were now", () => {
    const feed = buildTorobFeed({ products: items });
    // `a` was never updated; bumping it to the top would make every pass re-fetch it.
    expect(sortTorobProducts(feed.items, "date_updated_desc").map((item) => item.page_unique)).toEqual([
      "c",
      "b",
      "a",
    ]);
  });
});

describe("paging", () => {
  const many = Array.from({ length: 250 }, (_, index) =>
    product({ id: `p-${String(index).padStart(3, "0")}`, url: `https://shop.example.com/p/${index}/` }),
  );

  it("cuts 100 per page and reports the envelope", () => {
    const feed = buildTorobFeed({ products: many });
    const response = torobPageResponse(torobFeedPage(feed, { mode: "page", page: 2, sort: "product_id_desc" }));
    expect(response).toMatchObject({
      api_version: "torob_api_v3",
      current_page: 2,
      total: 250,
      max_pages: 3,
      next_cursor: null,
    });
    expect(response.products).toHaveLength(100);
  });

  it("clamps a stale page number instead of returning an empty page", () => {
    // A 200 with no products reads to Torob as "the shop deleted everything".
    const feed = buildTorobFeed({ products: many });
    const page = torobFeedPage(feed, { mode: "page", page: 99, sort: "product_id_desc" });
    expect(page.currentPage).toBe(3);
    expect(page.products).toHaveLength(50);
  });

  it("walks the whole catalogue by cursor without repeating or losing one", () => {
    const feed = buildTorobFeed({ products: many });
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard += 1) {
      const page = torobFeedPage(feed, { mode: "cursor", cursor, sort: "product_id_desc" });
      seen.push(...page.products.map((item) => item.page_unique));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(seen).toHaveLength(250);
    expect(new Set(seen).size).toBe(250);
  });

  it("answers a cursor past the end with nothing, not with page one", () => {
    const feed = buildTorobFeed({ products: many });
    const page = torobFeedPage(feed, { mode: "cursor", cursor: "p-000", sort: "product_id_desc" });
    expect(page.products).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });

  it("omits the page number in cursor mode", () => {
    const feed = buildTorobFeed({ products: many });
    const response = torobPageResponse(torobFeedPage(feed, { mode: "cursor", cursor: null, sort: "product_id_desc" }));
    expect("current_page" in response).toBe(false);
    expect(response.next_cursor).toBe("p-150");
  });
});

describe("summariseFeed", () => {
  it("counts groups, stock and skips by reason", () => {
    const feed = buildTorobFeed({
      products: [
        product({ id: "p1", variants: [{ id: "v1", attributes: {}, priceRial: 1_000_000, available: true }] }),
        product({ id: "p2", available: false }),
        product({ id: "p3", imageUrls: [] }),
      ],
    });
    const summary = summariseFeed(feed);
    expect(summary).toMatchObject({ total: 2, pageCount: 1, inStock: 1, outOfStock: 1, groups: 2, skippedTotal: 1 });
    expect(summary.skippedByReason).toEqual([
      { reason: "missing_image", count: 1, copy: expect.any(String) },
    ]);
  });

  it("reports at least one page for a shop with nothing to publish", () => {
    expect(summariseFeed(buildTorobFeed({ products: [] }))).toMatchObject({ total: 0, pageCount: 1 });
  });
});

describe("isoTimestamp", () => {
  it("normalises to UTC and refuses what it cannot read", () => {
    expect(isoTimestamp("2026-01-05T10:00:00+03:30")).toBe("2026-01-05T06:30:00.000Z");
    expect(isoTimestamp(null)).toBeNull();
    expect(isoTimestamp("")).toBeNull();
    expect(isoTimestamp("tomorrow")).toBeNull();
  });
});
