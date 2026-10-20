import { describe, expect, it, vi } from "vitest";
import { createWooCommerceClient, wooApiUrl, wooAuthHeader, wpApiUrl, wpAuthHeader, WooCommerceError } from "./woocommerce-client";

const credentials = {
  baseUrl: "https://shop.example.com",
  consumerKey: "ck_123",
  consumerSecret: "cs_456",
};

const wpCredentials = {
  ...credentials,
  wpUsername: "wp_user",
  wpApplicationPassword: "app pass",
};

/** A response with no paging header — what every existing call site assumes. */
function json(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/** A paged response, the way WooCommerce answers a list. */
function paged(items: unknown[], totalPages = 1) {
  return {
    ok: true,
    status: 200,
    json: async () => items,
    headers: { get: (name: string) => (name.toLowerCase() === "x-wp-totalpages" ? String(totalPages) : null) },
  };
}

describe("REST auth headers", () => {
  it("uses Woo consumer credentials only for wc/v3", () => {
    expect(wooAuthHeader(credentials)).toBe(`Basic ${Buffer.from("ck_123:cs_456").toString("base64")}`);
  });

  it("uses separate WordPress Application Password credentials for wp/v2", () => {
    expect(wpAuthHeader(wpCredentials)).toBe(`Basic ${Buffer.from("wp_user:app pass").toString("base64")}`);
  });

  it("refuses wp/v2 calls without WordPress credentials instead of reusing Woo keys", async () => {
    const fetch = vi.fn().mockResolvedValue(json(200, []));
    const client = createWooCommerceClient(credentials, fetch);
    await expect(client.listTaxonomies()).rejects.toMatchObject({ message: "wordpress_credentials_missing", status: 401 });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("wooApiUrl", () => {
  it("builds a v3 endpoint without a query", () => {
    expect(wooApiUrl("https://shop.example.com", "products")).toBe(
      "https://shop.example.com/wp-json/wc/v3/products",
    );
  });

  it("strips trailing slashes from the base and leading slashes from the path", () => {
    expect(wooApiUrl("https://shop.example.com/", "/products/42")).toBe(
      "https://shop.example.com/wp-json/wc/v3/products/42",
    );
  });

  it("serializes a query, dropping null/undefined", () => {
    expect(wooApiUrl("https://shop.example.com", "orders", { after: "2026-01-01", per_page: 100 })).toBe(
      "https://shop.example.com/wp-json/wc/v3/orders?after=2026-01-01&per_page=100",
    );
  });

  it("drops empty values so a blank watermark does not narrow a query to nothing", () => {
    expect(wooApiUrl("https://shop.example.com", "orders", { after: "" })).toBe(
      "https://shop.example.com/wp-json/wc/v3/orders",
    );
  });
});

describe("wpApiUrl", () => {
  it("targets the WordPress core namespace, the only place taxonomies are published", () => {
    expect(wpApiUrl("https://shop.example.com", "taxonomies")).toBe(
      "https://shop.example.com/wp-json/wp/v2/taxonomies",
    );
  });
});

describe("createWooCommerceClient", () => {
  it("sends credentials as a Basic auth header and JSON body", async () => {
    const fetch = vi.fn().mockResolvedValue(json(200, { id: 1 }));
    const client = createWooCommerceClient(credentials, fetch);
    await client.updateProduct(1, { regular_price: "15000" });
    expect(fetch).toHaveBeenCalledWith(
      "https://shop.example.com/wp-json/wc/v3/products/1",
      expect.objectContaining({
        method: "PUT",
        headers: expect.objectContaining({
          Authorization: wooAuthHeader(credentials),
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({ regular_price: "15000" }),
      }),
    );
  });

  it("lists products via GET", async () => {
    const fetch = vi.fn().mockResolvedValue(json(200, []));
    const client = createWooCommerceClient(credentials, fetch);
    await client.listProducts({ per_page: 5 });
    expect(fetch).toHaveBeenCalledWith(
      "https://shop.example.com/wp-json/wc/v3/products?per_page=5",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("wraps a non-2xx response in WooCommerceError with the server's message", async () => {
    const fetch = vi.fn().mockResolvedValue(json(401, { code: "rest_forbidden", message: "Invalid signature" }));
    const client = createWooCommerceClient(credentials, fetch);
    await expect(client.getProduct(1)).rejects.toThrow("Invalid signature");
    await expect(client.getProduct(1)).rejects.toMatchObject({ status: 401 });
  });
});

describe("variations", () => {
  it("reads them from the nested endpoint, because /products never returns one", async () => {
    // The whole reason a REST-connected store had no variations mapped: this
    // call did not exist before Phase 38.
    const fetch = vi.fn().mockResolvedValue(paged([{ id: 42, sku: "TS-RED-L" }], 1));
    const client = createWooCommerceClient(credentials, fetch);
    const variations = await client.listVariations(10);
    expect(fetch).toHaveBeenCalledWith(
      "https://shop.example.com/wp-json/wc/v3/products/10/variations?per_page=100&page=1",
      expect.objectContaining({ method: "GET" }),
    );
    // The endpoint omits `type`; it is filled in from the parent id so the
    // sync can classify the row without special-casing it.
    expect(variations[0]).toMatchObject({ id: 42, type: "variation", parent_id: 10 });
  });

  it("walks every page and stops at the store's own total", async () => {
    const first = paged([{ id: 1 }], 2);
    const second = paged([{ id: 2 }], 2);
    const fetch = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const client = createWooCommerceClient(credentials, fetch);
    const variations = await client.listVariations(10);
    expect(variations.map((v) => v.id)).toEqual([1, 2]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("sends a variation update to the nested path — products/{id} would 404", async () => {
    const fetch = vi.fn().mockResolvedValue(json(200, { id: 42 }));
    const client = createWooCommerceClient(credentials, fetch);
    await client.updateVariation(10, 42, { stock_quantity: 3 });
    expect(fetch).toHaveBeenCalledWith(
      "https://shop.example.com/wp-json/wc/v3/products/10/variations/42",
      expect.objectContaining({ method: "PUT", body: JSON.stringify({ stock_quantity: 3 }) }),
    );
  });

  it("reaches an arbitrary path through updateAt", async () => {
    const fetch = vi.fn().mockResolvedValue(json(200, { id: 42 }));
    const client = createWooCommerceClient(credentials, fetch);
    await client.updateAt("products/10/variations/42", { regular_price: "10" });
    expect(fetch).toHaveBeenCalledWith(
      "https://shop.example.com/wp-json/wc/v3/products/10/variations/42",
      expect.objectContaining({ method: "PUT" }),
    );
  });
});

describe("taxonomies", () => {
  it("pages categories", async () => {
    const fetch = vi.fn().mockResolvedValue(paged([{ id: 9, name: "پوشاک", slug: "clothing", parent: 0, count: 4 }], 1));
    const client = createWooCommerceClient(credentials, fetch);
    const terms = await client.listCategories();
    expect(terms).toHaveLength(1);
    expect(fetch).toHaveBeenCalledWith(
      "https://shop.example.com/wp-json/wc/v3/products/categories?per_page=100&page=1",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("discovers custom taxonomies over wp/v2 and keeps only the product ones", async () => {
    // wc/v3 exposes product_cat, product_tag and its attributes — and nothing
    // else. A shop organised by a `brand` taxonomy was invisible until this.
    const fetch = vi.fn().mockResolvedValue(
      json(200, {
        product_cat: { name: "Product categories", slug: "product_cat", rest_base: "product_cat", types: ["product"] },
        brand: { name: "Brands", slug: "brand", rest_base: "brand", types: ["product"] },
        category: { name: "Categories", slug: "category", rest_base: "categories", types: ["post"] },
      }),
    );
    const client = createWooCommerceClient(wpCredentials, fetch);
    const taxonomies = await client.listTaxonomies();
    expect(taxonomies.map((t) => t.slug)).toEqual(["product_cat", "brand"]);
    expect(fetch).toHaveBeenCalledWith(
      "https://shop.example.com/wp-json/wp/v2/taxonomies",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("lists a custom taxonomy's terms through its own rest_base", async () => {
    const fetch = vi.fn().mockResolvedValue(paged([{ id: 3, name: "نایک", slug: "nike", parent: 0, count: 12 }], 1));
    const client = createWooCommerceClient(wpCredentials, fetch);
    const terms = await client.listTerms("brand");
    expect(terms[0]).toMatchObject({ id: 3, taxonomy: "brand" });
    expect(fetch).toHaveBeenCalledWith(
      "https://shop.example.com/wp-json/wp/v2/brand?per_page=100&page=1",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("reads a global attribute and its terms", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json(200, [{ id: 1, name: "رنگ", slug: "pa_colour", type: "select", order_by: "menu_order", has_archives: false }]))
      .mockResolvedValueOnce(paged([{ id: 5, name: "قرمز", slug: "red", parent: 0, count: 3 }], 1));
    const client = createWooCommerceClient(credentials, fetch);
    const attributes = await client.listAttributes();
    const terms = await client.listAttributeTerms(attributes[0].id);
    expect(terms[0]).toMatchObject({ id: 5, name: "قرمز" });
    expect(fetch).toHaveBeenLastCalledWith(
      "https://shop.example.com/wp-json/wc/v3/products/attributes/1/terms?per_page=100&page=1",
      expect.objectContaining({ method: "GET" }),
    );
  });
});

describe("WordPress core content (wp/v2)", () => {
  it("lists a content type over wp/v2 with a view context by default", async () => {
    const fetch = vi.fn().mockResolvedValue(paged([{ id: 1, title: { rendered: "خانه" } }], 3));
    const client = createWooCommerceClient(wpCredentials, fetch);
    const { items, totalPages } = await client.wpListPage("pages", { page: 2, per_page: 100 });
    expect(items).toHaveLength(1);
    expect(totalPages).toBe(3);
    expect(fetch).toHaveBeenCalledWith(
      "https://shop.example.com/wp-json/wp/v2/pages?context=view&page=2&per_page=100",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("creates a post with POST to the collection when no id is given", async () => {
    const fetch = vi.fn().mockResolvedValue(json(201, { id: 99 }));
    const client = createWooCommerceClient(wpCredentials, fetch);
    await client.wpUpsertPost("posts", { title: "تازه", status: "draft" });
    expect(fetch).toHaveBeenCalledWith(
      "https://shop.example.com/wp-json/wp/v2/posts",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ title: "تازه", status: "draft" }) }),
    );
  });

  it("updates a post with POST to the item path — wp/v2 has no PUT for content", async () => {
    const fetch = vi.fn().mockResolvedValue(json(200, { id: 42 }));
    const client = createWooCommerceClient(wpCredentials, fetch);
    await client.wpUpsertPost("pages", { title: "به‌روز" }, 42);
    expect(fetch).toHaveBeenCalledWith(
      "https://shop.example.com/wp-json/wp/v2/pages/42",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ title: "به‌روز" }) }),
    );
  });
});

describe("orders and refunds", () => {
  it("updates an order's status", async () => {
    const fetch = vi.fn().mockResolvedValue(json(200, { id: 77, status: "completed" }));
    const client = createWooCommerceClient(credentials, fetch);
    await client.updateOrder(77, { status: "completed" });
    expect(fetch).toHaveBeenCalledWith(
      "https://shop.example.com/wp-json/wc/v3/orders/77",
      expect.objectContaining({ method: "PUT", body: JSON.stringify({ status: "completed" }) }),
    );
  });

  it("creates a refund against its order", async () => {
    const fetch = vi.fn().mockResolvedValue(json(201, { id: 5, parent_id: 77 }));
    const client = createWooCommerceClient(credentials, fetch);
    await client.createRefund(77, { amount: "12.5", reason: "خراب بود" });
    expect(fetch).toHaveBeenCalledWith(
      "https://shop.example.com/wp-json/wc/v3/orders/77/refunds",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ amount: "12.5", reason: "خراب بود" }) }),
    );
  });

  it("reads one order's refunds", async () => {
    const fetch = vi.fn().mockResolvedValue(json(200, [{ id: 5, parent_id: 77 }]));
    const client = createWooCommerceClient(credentials, fetch);
    await client.listOrderRefunds(77);
    expect(fetch).toHaveBeenCalledWith(
      "https://shop.example.com/wp-json/wc/v3/orders/77/refunds",
      expect.objectContaining({ method: "GET" }),
    );
  });
});

describe("pagination", () => {
  it("stops after one page when the store withholds X-WP-TotalPages", async () => {
    // A caching proxy or an old WooCommerce. An empty page means the same
    // thing with or without the header: there is nothing more to read.
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => [] });
    const client = createWooCommerceClient(credentials, fetch);
    await expect(client.listProductsPage({ page: 1, per_page: 100 })).resolves.toEqual({
      items: [],
      totalPages: 0,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps paging past a full page when the store withholds X-WP-TotalPages", async () => {
    // The same proxy in front of a store with 250 products. A full page is
    // the only evidence there is more, so it must read as "one more page",
    // not "that was the last one" — otherwise the sync stops at 100 rows
    // and the owner sees a fraction of their catalogue.
    const full = { ok: true, status: 200, json: async () => Array.from({ length: 100 }, (_, i) => ({ id: i + 1 })) };
    const fetch = vi.fn().mockResolvedValue(full);
    const client = createWooCommerceClient(credentials, fetch);
    await expect(client.listProductsPage({ page: 1, per_page: 100 })).resolves.toMatchObject({
      totalPages: 2,
    });
    await expect(client.listProductsPage({ page: 3, per_page: 100 })).resolves.toMatchObject({
      totalPages: 4,
    });
  });

  it("treats a short page without the header as the last one", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => [{ id: 1 }, { id: 2 }] });
    const client = createWooCommerceClient(credentials, fetch);
    await expect(client.listProductsPage({ page: 4, per_page: 100 })).resolves.toMatchObject({
      totalPages: 4,
    });
  });

  it("reads the store's page count when it offers one", async () => {
    const fetch = vi.fn().mockResolvedValue(paged([{ id: 1 }], 7));
    const client = createWooCommerceClient(credentials, fetch);
    await expect(client.listProductsPage({ page: 2, per_page: 100 })).resolves.toEqual({
      items: [{ id: 1 }],
      totalPages: 7,
    });
  });

  it("surfaces an error from a paged read as a WooCommerceError", async () => {
    const fetch = vi.fn().mockResolvedValue(json(500, { message: "boom" }));
    const client = createWooCommerceClient(credentials, fetch);
    await expect(client.listVariations(1)).rejects.toBeInstanceOf(WooCommerceError);
  });

  it("reports an HTML error page as the HTTP status rather than a JSON syntax error", async () => {
    // A WAF interstitial or a cached error page: the body is not JSON, and
    // the old code let JSON.parse's own "Unexpected token" escape — a
    // syntax error with no status, which is how "the sync just doesn't
    // work" reports arrived with nothing to act on.
    const fetch = vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => Promise.reject(new SyntaxError("Unexpected token '<'")) });
    const client = createWooCommerceClient(credentials, fetch);
    await expect(client.listProductsPage({ page: 1, per_page: 100 })).rejects.toMatchObject({
      status: 403,
    });
  });
});

describe("WordPress media collection authentication (#941 / shared #940 client)", () => {
  it.each(["view", "edit"])("uses WP credentials for %s collection pages", async (context) => {
    const fetch = vi.fn().mockResolvedValue(paged([{ id: 7 }], 2));
    const client = createWooCommerceClient(wpCredentials, fetch);
    const result = await client.wpListPage("media", { context, page: 2 });
    expect(result.items).toEqual([{ id: 7 }]);
    expect(fetch.mock.calls[0][0]).toContain("/wp-json/wp/v2/media?");
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe(wpAuthHeader(wpCredentials));
  });

  it("never substitutes Woo keys for missing WP credentials, even for public media", async () => {
    const fetch = vi.fn().mockResolvedValue(paged([]));
    await expect(createWooCommerceClient(credentials, fetch).wpListPage("media", { page: 1 }))
      .rejects.toMatchObject({ status: 401, message: "wordpress_credentials_missing" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([401, 403])("preserves a media collection HTTP %s without fallback", async (status) => {
    const fetch = vi.fn().mockResolvedValue(json(status, { message: "denied" }));
    await expect(createWooCommerceClient(wpCredentials, fetch).wpListPage("media", { context: "edit", page: 1 }))
      .rejects.toMatchObject({ status });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps paged WooCommerce reads on Woo credentials", async () => {
    const fetch = vi.fn().mockResolvedValue(paged([]));
    await createWooCommerceClient(wpCredentials, fetch).listProductsPage({ page: 1 });
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe(wooAuthHeader(wpCredentials));
  });
});
