import { describe, expect, it } from "vitest";
import {
  TOROB_PAGE_SIZE,
  buildTorobFeed,
  summariseFeed,
  torobFeedEnvelope,
  torobFeedPage,
  variantPageUnique,
  type CatalogueProduct,
} from "./feed";

/**
 * Issue #894 Wave 2 — the feed builder.
 *
 * The cases are grouped by the four rules in the file's header: one item per
 * sellable page, a deterministic order, skips as data, and never claiming more
 * than "this is what Torob would receive".
 */

const product = (over: Partial<CatalogueProduct> = {}): CatalogueProduct => ({
  id: "p1",
  name: "دستبند نقره",
  url: "https://shop.example.com/products/p1",
  imageUrls: ["https://cdn.example.com/p1.jpg"],
  priceRial: 250_000,
  available: true,
  currency: "IRT",
  ...over,
});

describe("one item per sellable page", () => {
  it("emits a simple product as one item, priced in integer Toman", () => {
    const { items, skipped } = buildTorobFeed({ products: [product()] });
    expect(skipped).toEqual([]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      page_unique: "p1",
      page_url: "https://shop.example.com/products/p1",
      name: "دستبند نقره",
      price: 250_000,
      availability: "in_stock",
    });
  });

  it("emits one item per variant, not the parent with the cheapest price", () => {
    // Sending the parent would list «دستبند نقره» at the cheapest variant's price,
    // a price nobody sells at.
    const { items } = buildTorobFeed({
      products: [
        product({
          variants: [
            { id: "v1", attributes: { رنگ: "قرمز" }, priceRial: 250_000, available: true },
            { id: "v2", attributes: { رنگ: "آبی" }, priceRial: 310_000, available: false },
          ],
        }),
      ],
    });
    expect(items.map((item) => item.page_unique)).toEqual([variantPageUnique("p1", "v1"), variantPageUnique("p1", "v2")]);
    expect(items.map((item) => item.price)).toEqual([250_000, 310_000]);
    expect(items.map((item) => item.availability)).toEqual(["in_stock", "out_of_stock"]);
    expect(items[0].attributes).toEqual({ رنگ: "قرمز" });
  });

  it("gives each variant a page of its own", () => {
    const { items } = buildTorobFeed({
      products: [
        product({
          variants: [
            { id: "v1", attributes: { رنگ: "قرمز" }, priceRial: 1, available: true },
            { id: "v2", attributes: { رنگ: "آبی" }, priceRial: 1, available: true },
          ],
        }),
      ],
    });
    const [a, b] = items.map((item) => item.page_url);
    expect(a).not.toBe(b);
    // The product's own query string survives; only `variant` is added.
    expect(a).toContain("variant=v1");
    expect(b).toContain("variant=v2");
  });

  it("keeps a query the storefront already had", () => {
    const { items } = buildTorobFeed({
      products: [
        product({
          url: "https://shop.example.com/p1?lang=fa",
          variants: [{ id: "v1", attributes: {}, priceRial: 1, available: true }],
        }),
      ],
    });
    expect(items[0].page_url).toContain("lang=fa");
    expect(items[0].page_url).toContain("variant=v1");
  });

  it("only sends an old price when it is a real strikethrough", () => {
    const { items } = buildTorobFeed({
      products: [
        product({ priceRial: 200_000, oldPriceRial: 250_000 }),
        product({ id: "p2", priceRial: 250_000, oldPriceRial: 200_000 }),
      ],
    });
    expect(items.find((item) => item.page_unique === "p1")?.old_price).toBe(250_000);
    // An "old price" below the current one is a price rise; sending it would show
    // a shopper a discount that does not exist.
    expect(items.find((item) => item.page_unique === "p2")?.old_price).toBeUndefined();
  });

  it("carries the fields Torob indexes on when the catalogue has them", () => {
    const { items } = buildTorobFeed({
      products: [
        product({
          description: "  دست‌ساز  ",
          categoryName: "دستبند",
          brand: "نقره‌ای",
          sku: " SKU-1 ",
        }),
      ],
    });
    expect(items[0]).toMatchObject({
      description: "دست‌ساز",
      category_name: "دستبند",
      brand: "نقره‌ای",
      sku: "SKU-1",
    });
  });
});

describe("a deterministic order", () => {
  it("sorts by page URL then identity, whatever order the catalogue arrives in", () => {
    const products = [
      product({ id: "c", url: "https://shop.example.com/products/c" }),
      product({ id: "a", url: "https://shop.example.com/products/a" }),
      product({ id: "b", url: "https://shop.example.com/products/b" }),
    ];
    const forward = buildTorobFeed({ products }).items.map((item) => item.page_unique);
    const backward = buildTorobFeed({ products: [...products].reverse() }).items.map((item) => item.page_unique);
    expect(forward).toEqual(["a", "b", "c"]);
    expect(backward).toEqual(forward);
  });

  it("keeps page 1 stable when a skipped product is fixed", () => {
    // Paging cuts the *whole* ordered list, so adding a product must not shuffle
    // which items are on page 1 — only append at its sorted place.
    const products = [product({ id: "a" }), product({ id: "b" }), product({ id: "c" })];
    const before = torobFeedPage(buildTorobFeed({ products }), 1, 2).items.map((item) => item.page_unique);
    const after = torobFeedPage(
      buildTorobFeed({ products: [...products, product({ id: "d", imageUrls: [] })] }),
      1,
      2,
    ).items.map((item) => item.page_unique);
    expect(after).toEqual(before);
  });
});

describe("skips are data", () => {
  const skipOf = (over: Partial<CatalogueProduct>) => {
    const { skipped, items } = buildTorobFeed({ products: [product(over)] });
    return { skipped, items };
  };

  it("names each reason, and keeps the product visible", () => {
    expect(skipOf({ name: "  " }).skipped[0]).toMatchObject({ reason: "missing_name", productId: "p1" });
    expect(skipOf({ url: "" }).skipped[0]).toMatchObject({ reason: "missing_url" });
    expect(skipOf({ url: "not a url" }).skipped[0]).toMatchObject({ reason: "unusable_url" });
    expect(skipOf({ url: "ftp://shop.example.com/p1" }).skipped[0]).toMatchObject({ reason: "unusable_url" });
    expect(skipOf({ imageUrls: [] }).skipped[0]).toMatchObject({ reason: "missing_image" });
    expect(skipOf({ currency: "EUR" }).skipped[0]).toMatchObject({ reason: "unsupported_currency" });
    expect(skipOf({ currency: "IRR", priceRial: 9_995 }).skipped[0]).toMatchObject({
      reason: "price_not_whole_toman",
    });
    expect(skipOf({ priceRial: -5 }).skipped[0]).toMatchObject({ reason: "negative_price" });
    for (const { items } of [
      skipOf({ name: "" }),
      skipOf({ url: "" }),
      skipOf({ imageUrls: [] }),
      skipOf({ currency: "USD" }),
    ]) {
      expect(items).toEqual([]);
    }
  });

  it("refuses two catalogue rows that claim the same page", () => {
    // A duplicated import gives `menu_items` two rows with one URL; sending both
    // lets Torob pick arbitrarily between them.
    const { items, skipped } = buildTorobFeed({
      products: [product({ id: "p1" }), product({ id: "p2", url: "https://shop.example.com/products/p1" })],
    });
    expect(items.map((item) => item.page_unique)).toEqual(["p1"]);
    expect(skipped.map((entry) => entry.reason)).toEqual(["duplicate_page"]);
  });

  it("drops out-of-stock products only when the shop asked", () => {
    const products = [product({ available: false })];
    expect(buildTorobFeed({ products }).items).toHaveLength(1);
    expect(buildTorobFeed({ products, includeOutOfStock: false }).items).toEqual([]);
    // And the exclusion is not a "skip": it is the shop's choice, not a failure.
    expect(buildTorobFeed({ products, includeOutOfStock: false }).skipped).toEqual([]);
  });
});

describe("paging, in Torob's terms", () => {
  const many = (count: number) =>
    Array.from({ length: count }, (_, index) =>
      product({ id: `p${String(index).padStart(3, "0")}`, url: `https://shop.example.com/products/p${index}` }),
    );

  it("caps a page at 100 however large a page the caller asks for", () => {
    const built = buildTorobFeed({ products: many(250) });
    const page = torobFeedPage(built, 1, 500);
    expect(page.items).toHaveLength(TOROB_PAGE_SIZE);
    expect(page.pageCount).toBe(3);
    expect(page.total).toBe(250);
    expect(page.hasMore).toBe(true);
  });

  it("pages through the whole feed without gaps or repeats", () => {
    const built = buildTorobFeed({ products: many(250) });
    const seen: string[] = [];
    for (let page = 1; page <= 3; page += 1) {
      seen.push(...torobFeedPage(built, page).items.map((item) => item.page_unique));
    }
    expect(new Set(seen).size).toBe(250);
    expect(seen).toEqual(built.items.map((item) => item.page_unique));
  });

  it("clamps a page past the end instead of returning nothing", () => {
    // A crawler retrying a stale page number should get the last page, not a
    // 200 with an empty list that reads as "the shop deleted everything".
    const page = torobFeedPage(buildTorobFeed({ products: many(10) }), 99);
    expect(page.page).toBe(1);
    expect(page.items).toHaveLength(10);
    expect(page.nextCursor).toBeNull();
  });

  it("offers a cursor that is the last identity it sent", () => {
    const page = torobFeedPage(buildTorobFeed({ products: many(150) }), 1);
    expect(page.nextCursor).toBe(page.items[99].page_unique);
    expect(torobFeedPage(buildTorobFeed({ products: many(150) }), 2).nextCursor).toBeNull();
  });

  it("sends the page envelope a crawler diffs on", () => {
    const envelope = torobFeedEnvelope(torobFeedPage(buildTorobFeed({ products: many(3) }), 1));
    expect(envelope).toMatchObject({ page: 1, page_count: 1, total: 3 });
    expect(envelope.page_urls).toHaveLength(3);
    expect(envelope.page_uniques).toEqual(["p000", "p001", "p002"]);
  });
});

describe("the summary a screen renders", () => {
  it("counts what is published and groups the reasons, biggest first", () => {
    const at = (id: string) => `https://shop.example.com/products/${id}`;
    const built = buildTorobFeed({
      products: [
        product({ id: "a", url: at("a") }),
        product({ id: "b", url: at("b"), available: false }),
        product({ id: "c", url: at("c"), imageUrls: [] }),
        product({ id: "d", url: at("d"), imageUrls: [] }),
        product({ id: "e", url: at("e"), currency: "USD" }),
      ],
    });
    const summary = summariseFeed(built);
    expect(summary).toMatchObject({ total: 2, inStock: 1, outOfStock: 1, skippedTotal: 3, pageCount: 1 });
    expect(summary.skippedByReason[0]).toMatchObject({ reason: "missing_image", count: 2 });
    // Every reason carries the sentence a merchant reads, from one vocabulary.
    expect(summary.skippedByReason.every((entry) => entry.copy.length > 10)).toBe(true);
  });

  it("says nothing about reasons that did not happen", () => {
    expect(summariseFeed(buildTorobFeed({ products: [product()] })).skippedByReason).toEqual([]);
  });
});
