import { describe, expect, it } from "vitest";
import { WebsiteAdapterError, isRetryableWebsiteError, slugify, type WebsiteAdapter } from "../adapter";
import { MockWebsiteAdapter } from "./mock";

function fixedClock() {
  let t = Date.parse("2026-09-04T08:00:00.000Z");
  return () => new Date((t += 1000));
}

describe("Phase 38 Wave 1 — the mock adapter implements every method of the interface", () => {
  it("is assignable to WebsiteAdapter and answers testConnection", async () => {
    const adapter: WebsiteAdapter = new MockWebsiteAdapter({ siteName: "کافه نمونه" });
    expect(adapter.key).toBe("mock");
    expect(await adapter.testConnection()).toEqual({ ok: true, siteName: "کافه نمونه" });
  });

  it("uploads a featured image before attaching it to a draft", async () => {
    const adapter = new MockWebsiteAdapter();
    const media = await adapter.uploadMedia({ filename: "hero.webp", mimeType: "image/webp", bytes: new Uint8Array([7]), alt: "کیک" });
    expect(media).toMatchObject({ id: "media_1", url: "https://example.test/media/media_1", filename: "hero.webp" });
    const post = await adapter.draftPost({ title: "کیک", body: "متن", featuredImageId: media.id });
    expect(post.featuredImageUrl).toBe("https://example.test/media/media_1");
  });

  it("drafts a post as a draft regardless of what the caller wants, and publishes only on publishPost", async () => {
    const adapter = new MockWebsiteAdapter({ now: fixedClock() });
    const draft = await adapter.draftPost({ title: "قهوهٔ تازه", body: "متن" });
    expect(draft.status).toBe("draft");
    expect(draft.publishedAt).toBeNull();
    expect(draft.url).toBeNull();
    expect(draft.slug).toBe(slugify("قهوهٔ تازه"));

    const listedDrafts = await adapter.listPosts({ status: "draft", limit: 10 });
    expect(listedDrafts.items.map((p) => p.id)).toEqual([draft.id]);
    expect((await adapter.listPosts({ status: "published", limit: 10 })).items).toEqual([]);

    const updated = await adapter.updatePost(draft.id, { body: "متن تازه", excerpt: "خلاصه" });
    expect(updated.body).toBe("متن تازه");
    expect(updated.excerpt).toBe("خلاصه");
    expect(updated.status).toBe("draft");

    const published = await adapter.publishPost(draft.id);
    expect(published.status).toBe("published");
    expect(published.publishedAt).not.toBeNull();
    expect(published.url).toBe(`https://example.test/blog/${draft.slug}`);
    expect(await adapter.getPost(draft.id)).toMatchObject({ status: "published" });
  });

  it("paginates behind an opaque cursor", async () => {
    const adapter = new MockWebsiteAdapter();
    for (let i = 0; i < 5; i += 1) await adapter.draftPost({ title: `پست ${i}`, body: "" });
    const first = await adapter.listPosts({ limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await adapter.listPosts({ limit: 2, cursor: first.nextCursor! });
    expect(second.items).toHaveLength(2);
    const third = await adapter.listPosts({ limit: 2, cursor: second.nextCursor! });
    expect(third.items).toHaveLength(1);
    expect(third.nextCursor).toBeNull();
    const ids = [...first.items, ...second.items, ...third.items].map((p) => p.id);
    expect(new Set(ids).size).toBe(5);
  });

  it("upserts, re-prices and re-stocks a product in integer Rial", async () => {
    const adapter = new MockWebsiteAdapter();
    const created = await adapter.upsertProduct({ title: "کیک هویج", sku: "CK-1", priceRial: 850_000, stock: 12 });
    expect(created).toMatchObject({ title: "کیک هویج", sku: "CK-1", priceRial: 850_000, stock: 12, status: "draft" });

    const updated = await adapter.upsertProduct({ remoteId: created.id, title: "کیک هویج بزرگ", priceRial: 950_000 });
    expect(updated.id).toBe(created.id);
    expect(updated.title).toBe("کیک هویج بزرگ");
    expect(updated.priceRial).toBe(950_000);
    expect(updated.stock).toBe(12);

    await adapter.setProductStock(created.id, 3);
    await adapter.setProductPrice(created.id, 1_000_000);
    const listed = await adapter.listProducts({ limit: 10 });
    expect(listed.items[0]).toMatchObject({ id: created.id, stock: 3, priceRial: 1_000_000 });
  });

  it("refuses a non-integer or negative price the way a real site would", async () => {
    const adapter = new MockWebsiteAdapter();
    await expect(adapter.upsertProduct({ title: "x", priceRial: 12.5 })).rejects.toMatchObject({ code: "rejected" });
    const product = await adapter.upsertProduct({ title: "x", priceRial: 100 });
    await expect(adapter.setProductPrice(product.id, -1)).rejects.toMatchObject({ code: "rejected" });
  });

  it("answers not_found for a missing remote row", async () => {
    const adapter = new MockWebsiteAdapter();
    expect(await adapter.getPost("nope")).toBeNull();
    await expect(adapter.updatePost("nope", { title: "x" })).rejects.toBeInstanceOf(WebsiteAdapterError);
    await expect(adapter.publishPost("nope")).rejects.toMatchObject({ code: "not_found" });
    await expect(adapter.setProductStock("nope", 1)).rejects.toMatchObject({ code: "not_found" });
  });

  it("can be taken down and brought back, and only 'unreachable' is retryable", async () => {
    const adapter = new MockWebsiteAdapter();
    adapter.failWith("unreachable");
    expect(await adapter.testConnection()).toEqual({ ok: false, error: "unreachable" });
    let caught: unknown;
    try {
      await adapter.listPosts({ limit: 1 });
    } catch (error) {
      caught = error;
    }
    expect(isRetryableWebsiteError(caught)).toBe(true);

    adapter.failWith("unauthorized");
    try {
      await adapter.listPosts({ limit: 1 });
    } catch (error) {
      caught = error;
    }
    expect(isRetryableWebsiteError(caught)).toBe(false);

    adapter.failWith(null);
    expect((await adapter.testConnection()).ok).toBe(true);
    expect(adapter.calls.map((c) => c.method)).toEqual([
      "testConnection",
      "listPosts",
      "listPosts",
      "testConnection",
    ]);
  });
});

describe("slugify", () => {
  it("keeps Persian letters, drops combining marks, replaces spaces and ZWNJ, and never returns empty", () => {
    // The hamza on «قهوهٔ» is a combining mark (\p{M}), not a letter — it is dropped.
    expect(slugify("قهوهٔ تازه‌دم")).toBe("قهوه-تازه-دم");
    expect(slugify("  Hello World!  ")).toBe("hello-world");
    expect(slugify("***")).toBe("post");
  });
});

describe("ESH-145 — mock café-menu contract", () => {
  const input = {
    sourceId: "menu_item:item-1", title: "لاته", summary: "توضیح", sku: "LAT-1",
    priceRial: 1_200_000, stock: 4, imageId: "media-1", categoryTermId: "term-1",
    menuOrder: 2, published: true, available: true,
    modifierGroups: [{
      sourceId: "group-1", label: "شیر", minSelect: 1, maxSelect: 1, isActive: true, sortOrder: 0,
      options: [{ sourceId: "option-1", label: "شیر بادام", priceDeltaRial: 250_000, isActive: true, sortOrder: 0 }],
    }],
  };

  it("updates the same product and embedded option ids, and keeps two sites independent", async () => {
    const a = new MockWebsiteAdapter();
    const b = new MockWebsiteAdapter();
    const first = await a.upsertProduct(input);
    const second = await b.upsertProduct(input);
    expect(second.sourceId).toBe(first.sourceId); // the same source is a distinct remote row per site
    const updated = await a.upsertProduct({ ...input, remoteId: first.id, title: "لاته جدید" });
    expect(updated.id).toBe(first.id);
    expect(updated.modifierGroups?.[0].remoteId).toBe(first.modifierGroups?.[0].remoteId);
    expect(updated.modifierGroups?.[0].options[0].remoteId).toBe(first.modifierGroups?.[0].options[0].remoteId);
    expect(a.products).toHaveLength(1);
    expect(b.products[0].title).toBe("لاته");
  });

  it("recovers a source identity after a lost response and withdraws without deleting", async () => {
    const adapter = new MockWebsiteAdapter();
    const first = await adapter.upsertProduct(input);
    const recovered = await adapter.upsertProduct({ ...input, title: "نام تازه" });
    expect(recovered.id).toBe(first.id);
    await adapter.setProductAvailability(first.id, { published: false, available: false });
    await adapter.setProductStock(first.id, null);
    expect(adapter.products).toHaveLength(1);
    expect(adapter.products[0]).toMatchObject({ status: "draft", available: false, stock: null });
  });

  it("keeps category and media identities stable across retries", async () => {
    const adapter = new MockWebsiteAdapter();
    const taxonomy = await adapter.upsertMenuTaxonomy({});
    const category = { taxonomyId: taxonomy.id, sourceId: "category-1", name: "قهوه", description: "گرم", sortOrder: 1 };
    const first = await adapter.upsertMenuCategory(category);
    expect((await adapter.upsertMenuCategory({ ...category, name: "نوشیدنی" })).id).toBe(first.id);
    const upload = { sourceId: "media:asset-1:hash", filename: "latte.png", mimeType: "image/png", bytes: new Uint8Array([1]) };
    expect((await adapter.uploadMedia(upload)).id).toBe((await adapter.uploadMedia(upload)).id);
  });
});
