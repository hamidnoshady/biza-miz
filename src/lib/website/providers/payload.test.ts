import { beforeEach, describe, expect, it } from "vitest";
import type { FetchLike } from "../../cms/client";
import type { CmsPost, CmsProduct } from "../../cms/types";
import { WebsiteAdapterError } from "../adapter";
import {
  BREAKER_FAILURES,
  PayloadWebsiteAdapter,
  buildPostBody,
  buildPostPatch,
  buildProductBody,
  cursorFromPage,
  mapPayloadMedia,
  mapPayloadPost,
  mapPayloadProduct,
  pageFromCursor,
  resetBreakers,
  rialToSiteAmount,
  siteAmountToRial,
} from "./payload";
import { markdownToLexical } from "./payload-content";

const config = { baseUrl: "https://cms.example.test", siteDomain: "cafe.example.test", apiKey: "eshobe_live_x" };
const ctx = { siteOrigin: "https://cafe.example.test", mediaOrigin: "https://cafe.example.test", currency: "IRT" as const };

/** A recorded-fixture fetch: route → response. Records every request it saw. */
function fakeFetch(routes: Record<string, { status?: number; body: unknown } | ((init: RequestInit) => { status?: number; body: unknown })>) {
  const seen: { url: string; method: string; body: unknown; headers: Headers }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const path = new URL(url).pathname + new URL(url).search;
    const key = Object.keys(routes).find((route) => path.startsWith(route));
    seen.push({
      url,
      method: init.method ?? "GET",
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
      headers: new Headers(init.headers),
    });
    if (!key) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    const entry = routes[key];
    const resolved = typeof entry === "function" ? entry(init) : entry;
    return new Response(JSON.stringify(resolved.body), { status: resolved.status ?? 200 });
  };
  return { fetchImpl, seen };
}

const postDoc: CmsPost = {
  id: "p1",
  title: "قهوهٔ تازه",
  slug: "قهوه-تازه",
  content: markdownToLexical("# قهوه\n\nمتن **مهم**"),
  heroImage: { id: "m1", url: "/media/hero.jpg" },
  publishedAt: null,
  updatedAt: "2026-09-04T08:00:00.000Z",
  createdAt: "2026-09-04T07:00:00.000Z",
  _status: "draft",
};

const productDoc: CmsProduct = {
  id: "pr1",
  title: "کیک هویج",
  sku: "CK-1",
  price: 85_000, // Toman on an IRT site
  trackInventory: true,
  inventory: 4,
  updatedAt: "2026-09-04T08:00:00.000Z",
  createdAt: "2026-09-04T07:00:00.000Z",
  _status: "published",
};

beforeEach(() => resetBreakers());

describe("Phase 38 Wave 2 — Payload adapter, the pure half", () => {
  it("converts the site's unit to integer Rial and back", () => {
    expect(siteAmountToRial(85_000, "IRT")).toBe(850_000);
    expect(siteAmountToRial(850_000, "IRR")).toBe(850_000);
    expect(rialToSiteAmount(850_000, "IRT")).toBe(85_000);
    expect(rialToSiteAmount(850_005, "IRT")).toBe(85_001);
    expect(rialToSiteAmount(850_000, "IRR")).toBe(850_000);
    expect(() => siteAmountToRial(10, "EUR")).toThrow(WebsiteAdapterError);
    expect(() => rialToSiteAmount(12.5, "IRT")).toThrow(WebsiteAdapterError);
  });

  it("maps a Payload post to the adapter's Post with Markdown and an absolute image URL", () => {
    const post = mapPayloadPost(postDoc, ctx);
    expect(post).toMatchObject({
      id: "p1",
      status: "draft",
      body: "# قهوه\n\nمتن **مهم**",
      featuredImageUrl: "https://cafe.example.test/media/hero.jpg",
      url: null,
    });
    const published = mapPayloadPost({ ...postDoc, _status: "published", publishedAt: "2026-09-04T09:00:00.000Z" }, ctx);
    expect(published.url).toBe("https://cafe.example.test/blog/قهوه-تازه");
  });

  it("maps a Payload media response to a safe absolute URL", () => {
    expect(mapPayloadMedia({ id: "m1", filename: "hero.webp", alt: "قهوه", url: "/media/hero.webp" }, "https://cdn.example.test")).toEqual({
      id: "m1", filename: "hero.webp", alt: "قهوه", url: "https://cdn.example.test/media/hero.webp",
    });
  });

  it("maps a Payload product with the price in Rial and stock only when tracked", () => {
    expect(mapPayloadProduct(productDoc, ctx)).toMatchObject({ priceRial: 850_000, stock: 4, status: "published" });
    expect(mapPayloadProduct({ ...productDoc, trackInventory: false }, ctx).stock).toBeNull();
  });

  it("always builds a draft body, whatever the caller passes", () => {
    const body = buildPostBody({ title: "عنوان", body: "متن", excerpt: "خلاصه" });
    expect(body._status).toBe("draft");
    expect(body.slug).toBe("عنوان");
    expect(body.excerpt).toBe("خلاصه");
    expect((body.content as { root: unknown }).root).toBeDefined();
    expect(buildPostPatch({ body: "x" })).toHaveProperty("content");
    expect(buildPostPatch({ title: "t" })).toEqual({ title: "t" });
    expect(buildPostPatch({ featuredImageId: "" })).toEqual({ heroImage: null });
  });

  it("builds a product body in the site's unit and turns tracking on only when stock is given", () => {
    expect(buildProductBody({ title: "x", priceRial: 850_000 }, "IRT")).toEqual({ title: "x", price: 85_000 });
    expect(buildProductBody({ title: "x", priceRial: 850_000, stock: 3 }, "IRR")).toEqual({
      title: "x",
      price: 850_000,
      trackInventory: true,
      inventory: 3,
    });
  });

  it("hides Payload's page number behind an opaque cursor", () => {
    expect(pageFromCursor(undefined)).toBe(1);
    const cursor = cursorFromPage({ hasNextPage: true, nextPage: 3 });
    expect(cursor).not.toBeNull();
    expect(pageFromCursor(cursor!)).toBe(3);
    expect(cursorFromPage({ hasNextPage: false, nextPage: null })).toBeNull();
  });
});

describe("Phase 38 Wave 2 — Payload adapter against recorded fixtures (no live service)", () => {
  it("tests the connection and reports the site name; forwards Host and the bearer key", async () => {
    const { fetchImpl, seen } = fakeFetch({
      "/api/site": { body: { id: "s1", name: "کافه نمونه", domain: "cafe.example.test", media: { origin: "https://cdn.example.test" } } },
    });
    const adapter = new PayloadWebsiteAdapter({ config, currency: "IRT", fetchImpl });
    expect(await adapter.testConnection()).toEqual({ ok: true, siteName: "کافه نمونه" });
    expect(seen[0].headers.get("host")).toBe("cafe.example.test");
    expect(seen[0].headers.get("authorization")).toBe("Bearer eshobe_live_x");
  });

  it("reports a domain mismatch rather than connecting to the wrong site", async () => {
    const { fetchImpl } = fakeFetch({ "/api/site": { body: { id: "s1", name: "x", domain: "other.example.test" } } });
    const adapter = new PayloadWebsiteAdapter({ config, currency: "IRT", fetchImpl });
    expect(await adapter.testConnection()).toEqual({ ok: false, error: "domain_mismatch" });
  });

  it("drafts a post with _status=draft and maps the answer back to Markdown", async () => {
    const { fetchImpl, seen } = fakeFetch({
      "/api/posts": (init) => ({ body: { ...postDoc, ...(JSON.parse(String(init.body)) as object) } }),
    });
    const adapter = new PayloadWebsiteAdapter({ config, currency: "IRT", fetchImpl });
    const post = await adapter.draftPost({ title: "قهوهٔ تازه", body: "# قهوه\n\nمتن **مهم**" });
    expect(seen[0].method).toBe("POST");
    expect((seen[0].body as { _status: string })._status).toBe("draft");
    expect(post.status).toBe("draft");
    expect(post.body).toBe("# قهوه\n\nمتن **مهم**");
  });

  it("uploads a featured image as multipart data and maps its returned media", async () => {
    let form: FormData | null = null;
    const { fetchImpl, seen } = fakeFetch({
      "/api/media": (init) => { form = init.body as FormData; return { body: { id: "m2", filename: "hero.png", alt: "قهوه", url: "/media/hero.png" } }; },
    });
    const adapter = new PayloadWebsiteAdapter({ config, currency: "IRT", fetchImpl });
    const media = await adapter.uploadMedia({ filename: "hero.png", mimeType: "image/png", bytes: new Uint8Array([1, 2, 3]), alt: "قهوه" });
    expect(seen[0].method).toBe("POST");
    expect(form).not.toBeNull();
    expect(form!.get("file")).toBeInstanceOf(File);
    expect(form!.get("alt")).toBe("قهوه");
    expect(media).toMatchObject({ id: "m2", url: "https://cafe.example.test/media/hero.png" });
  });

  it("lists posts newest first with a status filter", async () => {
    const { fetchImpl, seen } = fakeFetch({
      "/api/posts": { body: { docs: [postDoc], totalDocs: 1, hasNextPage: false, nextPage: null } },
    });
    const adapter = new PayloadWebsiteAdapter({ config, currency: "IRT", fetchImpl });
    const page = await adapter.listPosts({ status: "draft", limit: 20 });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeNull();
    const url = new URL(seen[0].url);
    expect(url.searchParams.get("sort")).toBe("-updatedAt");
    expect(url.searchParams.get("where[_status][equals]")).toBe("draft");
  });

  it("maps the CMS's publish refusal to `unsupported`, not to a generic failure", async () => {
    const { fetchImpl } = fakeFetch({
      "/api/posts/p1": { status: 403, body: { message: "You are not allowed to publish with this key" } },
    });
    const adapter = new PayloadWebsiteAdapter({ config, currency: "IRT", fetchImpl });
    await expect(adapter.publishPost("p1")).rejects.toMatchObject({ code: "unsupported" });
  });

  it("maps 401/403/404/5xx onto the adapter's error codes", async () => {
    const make = (status: number, message = "nope") =>
      new PayloadWebsiteAdapter({ config, currency: "IRT", fetchImpl: fakeFetch({ "/api/posts/p1": { status, body: { message } } }).fetchImpl });
    await expect(make(401).getPost("p1")).rejects.toMatchObject({ code: "unauthorized" });
    await expect(make(403).getPost("p1")).rejects.toMatchObject({ code: "unauthorized" });
    expect(await make(404).getPost("p1")).toBeNull();
    await expect(make(500).getPost("p1")).rejects.toMatchObject({ code: "rejected" });
  });

  it("sends a price change in the site's unit", async () => {
    const { fetchImpl, seen } = fakeFetch({ "/api/products/pr1": { body: productDoc } });
    const adapter = new PayloadWebsiteAdapter({ config, currency: "IRT", fetchImpl });
    await adapter.setProductPrice("pr1", 950_000);
    expect(seen[0].method).toBe("PATCH");
    expect(seen[0].body).toEqual({ price: 95_000 });
    await adapter.setProductStock("pr1", 7);
    expect(seen[1].body).toEqual({ trackInventory: true, inventory: 7, inventoryManagedExternally: true });
  });

  it("opens the circuit after repeated network failures and fails fast until it half-closes", async () => {
    let now = 1_000_000;
    let attempts = 0;
    const fetchImpl: FetchLike = async () => {
      attempts += 1;
      throw new Error("ECONNREFUSED");
    };
    const adapter = new PayloadWebsiteAdapter({ config, currency: "IRT", fetchImpl, now: () => now });
    for (let i = 0; i < BREAKER_FAILURES; i += 1) {
      await expect(adapter.listProducts({ limit: 1 })).rejects.toMatchObject({ code: "unreachable" });
    }
    expect(attempts).toBe(BREAKER_FAILURES);
    // Open: no network call is made at all.
    await expect(adapter.listProducts({ limit: 1 })).rejects.toMatchObject({ code: "unreachable" });
    expect(attempts).toBe(BREAKER_FAILURES);
    // After the window it tries again.
    now += 61_000;
    await expect(adapter.listProducts({ limit: 1 })).rejects.toMatchObject({ code: "unreachable" });
    expect(attempts).toBe(BREAKER_FAILURES + 1);
  });

  it("does not trip the breaker on a 4xx — the site is answering", async () => {
    let attempts = 0;
    const fetchImpl: FetchLike = async () => {
      attempts += 1;
      return new Response(JSON.stringify({ message: "bad" }), { status: 400 });
    };
    const adapter = new PayloadWebsiteAdapter({ config, currency: "IRT", fetchImpl });
    for (let i = 0; i < BREAKER_FAILURES + 2; i += 1) {
      await expect(adapter.listProducts({ limit: 1 })).rejects.toMatchObject({ code: "rejected" });
    }
    expect(attempts).toBe(BREAKER_FAILURES + 2);
  });
});

describe("ESH-145 — Payload café-menu contract", () => {
  const menuInput = {
    sourceId: "menu_item:item-1",
    title: "لاته",
    summary: "با شیر تازه",
    sku: "LAT-1",
    priceRial: 1_200_000,
    stock: null,
    imageId: "media-1",
    categoryTermId: "term-1",
    menuOrder: 4,
    published: true,
    available: false,
    inventoryManagedExternally: true,
    modifierGroups: [{
      sourceId: "group-1", label: "افزودنی", minSelect: 0, maxSelect: 1,
      isActive: true, sortOrder: 2,
      options: [{ sourceId: "option-1", label: "شات اضافه", priceDeltaRial: -15_000, isActive: true, sortOrder: 1 }],
    }],
  };

  it("projects add-ons separately from variations, with signed minor-unit deltas and explicit availability", () => {
    const body = buildProductBody(menuInput, "IRT");
    expect(body).toMatchObject({
      sourceSystem: "biza_miz", sourceId: "menu_item:item-1", terms: ["term-1"],
      menuOrder: 4, menuAvailable: false, _status: "published",
      trackInventory: false, inventory: null, inventoryManagedExternally: true,
    });
    expect(body.modifierGroups?.[0].options[0].priceDelta).toBe(-1_500);
    expect(body).not.toHaveProperty("variations");
    const mapped = mapPayloadProduct({ ...productDoc, ...body, id: "remote-1" } as CmsProduct, ctx);
    expect(mapped.modifierGroups?.[0].options[0].priceDeltaRial).toBe(-15_000);
    expect(mapped).toMatchObject({ available: false, stock: null, categoryTermId: "term-1", imageId: "media-1" });
  });

  it("recovers a product after a lost create response by source identity, never by name or SKU", async () => {
    let stored: CmsProduct | null = null;
    const seen: { method: string; url: string }[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      const method = init.method ?? "GET";
      seen.push({ method, url });
      if (method === "POST") {
        stored = { ...productDoc, ...(JSON.parse(String(init.body)) as object), id: "remote-1" } as CmsProduct;
        throw new Error("response lost after commit");
      }
      if (method === "GET") {
        expect(new URL(url).searchParams.get("where[sourceId][equals]")).toBe("menu_item:item-1");
        return new Response(JSON.stringify({ docs: stored ? [stored] : [], totalDocs: stored ? 1 : 0, hasNextPage: false, nextPage: null }));
      }
      stored = { ...stored!, ...(JSON.parse(String(init.body)) as object) } as CmsProduct;
      return new Response(JSON.stringify(stored));
    };
    const adapter = new PayloadWebsiteAdapter({ config, currency: "IRT", fetchImpl });
    await expect(adapter.upsertProduct(menuInput)).rejects.toMatchObject({ code: "unreachable" });
    resetBreakers();
    const recovered = await adapter.upsertProduct({ ...menuInput, title: "لاته جدید" });
    expect(recovered.id).toBe("remote-1");
    expect(seen.filter((call) => call.method === "POST")).toHaveLength(1);
    expect(seen.filter((call) => call.method === "PATCH")).toHaveLength(1);
  });

  it("recovers unchanged media by source identity instead of uploading it twice", async () => {
    let stored: { id: string; filename: string; sourceId: string } | null = null;
    let posts = 0;
    const fetchImpl: FetchLike = async (url, init) => {
      const method = init.method ?? "GET";
      if (method === "POST") {
        posts += 1;
        stored = { id: "media-1", filename: "latte.png", sourceId: "media:asset-1:hash" };
        throw new Error("response lost after upload");
      }
      expect(new URL(url).searchParams.get("where[sourceId][equals]")).toBe("media:asset-1:hash");
      return new Response(JSON.stringify({ docs: stored ? [stored] : [], totalDocs: stored ? 1 : 0 }));
    };
    const adapter = new PayloadWebsiteAdapter({ config, currency: "IRT", fetchImpl });
    const upload = { sourceId: "media:asset-1:hash", filename: "latte.png", mimeType: "image/png", bytes: new Uint8Array([1]) };
    await expect(adapter.uploadMedia(upload)).rejects.toMatchObject({ code: "unreachable" });
    resetBreakers();
    expect((await adapter.uploadMedia(upload)).id).toBe("media-1");
    expect(posts).toBe(1);
  });

  it("uses taxonomy definitions/terms and the dedicated menu taxonomy key", async () => {
    const seen: { url: string; method: string; body: unknown }[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      const method = init.method ?? "GET";
      const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
      seen.push({ url, method, body });
      if (new URL(url).pathname === "/api/taxonomy-definitions") {
        return new Response(JSON.stringify(method === "GET"
          ? { docs: [], totalDocs: 0 }
          : { id: "taxonomy-1", key: "biza_menu_categories" }));
      }
      if (method === "GET") return new Response(JSON.stringify({ docs: [], totalDocs: 0 }));
      return new Response(JSON.stringify({ id: "term-1", name: body.name, description: body.description, menuOrder: body.menuOrder }));
    };
    const adapter = new PayloadWebsiteAdapter({ config, currency: "IRT", fetchImpl });
    expect((await adapter.upsertMenuTaxonomy({})).id).toBe("taxonomy-1");
    const term = await adapter.upsertMenuCategory({ taxonomyId: "taxonomy-1", sourceId: "category-1", name: "قهوه", description: "گرم", sortOrder: 2 });
    expect(term.id).toBe("term-1");
    expect(seen[0].url).toContain("where%5Bkey%5D%5Bequals%5D=biza_menu_categories");
    expect(seen[3].body).toMatchObject({ taxonomy: "taxonomy-1", sourceSystem: "biza_miz", sourceId: "category-1", menuOrder: 2 });
  });

  it("withdraws without deleting, and clears unknown stock without fabricating a count", async () => {
    const { fetchImpl, seen } = fakeFetch({ "/api/products/pr1": { body: productDoc } });
    const adapter = new PayloadWebsiteAdapter({ config, currency: "IRT", fetchImpl });
    await adapter.setProductAvailability("pr1", { published: false, available: false });
    await adapter.setProductStock("pr1", null);
    expect(seen[0].body).toEqual({ _status: "draft", menuAvailable: false });
    expect(seen[1].body).toEqual({ trackInventory: false, inventory: null, inventoryManagedExternally: true });
    expect(seen.every((call) => call.method === "PATCH")).toBe(true);
  });
});
