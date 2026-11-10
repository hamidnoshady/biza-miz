/**
 * Phase 38 Wave 2 (issue #380) — the Payload (eshobe-cms) `WebsiteAdapter`.
 *
 * Shaping and parsing are separated from the network, the way Phase 37's
 * Kavenegar provider was: this file builds request bodies and maps Payload
 * documents to the adapter's `Post`/`RemoteProduct` (all pure, exported for
 * tests), and the only I/O is the `cms/client.ts` functions it calls — which
 * accept a `fetchImpl`, so every test runs against a recorded fixture and
 * none needs a live service.
 *
 * Boundary rules this adapter enforces:
 *
 *   - **Money.** Payload stores an integer in the site's minor unit
 *     (`site_currency`: IRT/IRR/EUR/USD). The interface speaks integer Rial;
 *     `siteAmountToRial`/`rialToSiteAmount` convert here and nowhere else. A
 *     non-Rial/Toman site cannot be converted without an exchange rate, and
 *     the adapter says so (`unsupported`) rather than guessing.
 *   - **Content.** Markdown in, Lexical out (`payload-content.ts`), and back.
 *   - **Draft-only key.** A site key can never publish over the eshobe-cms
 *     API (`writeUnlessPublishing`) — `publishPost` therefore attempts the
 *     `_status` change and maps the CMS's refusal to `unsupported`, which the
 *     UI renders as "publish from the CMS admin". If the CMS later grants a
 *     key that right, this adapter needs no change.
 *   - **Timeout + circuit breaker.** Every call inherits the client's 8 s
 *     timeout; after `BREAKER_FAILURES` consecutive network failures the
 *     breaker opens for `BREAKER_OPEN_MS` and calls fail fast as
 *     `unreachable` — a slow site must never hold the dashboard.
 */
import {
  CmsApiError,
  CmsNetworkError,
  cmsFormRequest,
  cmsRequest,
  createPost,
  createProduct,
  fetchProducts,
  fetchSiteDescriptor,
  updatePost,
  updateProduct,
  type CmsConfig,
  type FetchLike,
} from "../../cms/client";
import type { CmsMedia, CmsPost, CmsProduct, CmsProductWrite, CmsProductModifierGroup, CmsTaxonomyDefinition, CmsTaxonomyTerm, PayloadList } from "../../cms/types";
import {
  WEBSITE_MENU_TAXONOMY_KEY,
  WEBSITE_SOURCE_SYSTEM,
  WebsiteAdapterError,
  slugify,
  type ConnectionTest,
  type Page,
  type Post,
  type PostDraft,
  type PostStatus,
  type RemoteProduct,
  type RemoteProductInput,
  type WebsiteAdapter,
  type WebsiteMedia,
  type MediaUpload,
  type MenuCategoryInput,
  type MenuModifierGroup,
  type ProductAvailability,
  type RemoteMenuCategory,
} from "../adapter";
import { lexicalToMarkdown, markdownToLexical } from "./payload-content";

export type SiteCurrency = "IRT" | "IRR" | "EUR" | "USD";

// ---------------------------------------------------------------------------
// Pure: money
// ---------------------------------------------------------------------------

/** Site minor unit → integer Rial. Throws `unsupported` for a foreign-currency site. */
export function siteAmountToRial(amount: number, currency: SiteCurrency): number {
  if (!Number.isFinite(amount)) return 0;
  switch (currency) {
    case "IRR":
      return Math.round(amount);
    case "IRT":
      return Math.round(amount) * 10;
    default:
      throw new WebsiteAdapterError("unsupported", `currency ${currency} cannot be expressed in Rial`);
  }
}

/** Integer Rial → the site's minor unit. Toman rounds half up; Rial is exact. */
export function rialToSiteAmount(priceRial: number, currency: SiteCurrency): number {
  if (!Number.isInteger(priceRial) || priceRial < 0) {
    throw new WebsiteAdapterError("rejected", "price must be a non-negative integer Rial");
  }
  switch (currency) {
    case "IRR":
      return priceRial;
    case "IRT":
      return Math.round(priceRial / 10);
    default:
      throw new WebsiteAdapterError("unsupported", `currency ${currency} cannot be expressed in Rial`);
  }
}

/** Modifier deltas may be negative; unlike a selling price they are signed. */
export function rialToSiteDelta(deltaRial: number, currency: SiteCurrency): number {
  if (!Number.isSafeInteger(deltaRial)) {
    throw new WebsiteAdapterError("rejected", "modifier delta must be an integer Rial");
  }
  if (currency !== "IRR" && currency !== "IRT") {
    throw new WebsiteAdapterError("unsupported", `currency ${currency} cannot be expressed in Rial`);
  }
  const amount = Math.sign(deltaRial) * Math.round(Math.abs(deltaRial) / (currency === "IRT" ? 10 : 1));
  return amount === 0 ? 0 : amount;
}
export function siteDeltaToRial(amount: number, currency: SiteCurrency): number {
  if (!Number.isFinite(amount)) return 0;
  if (currency !== "IRR" && currency !== "IRT") {
    throw new WebsiteAdapterError("unsupported", `currency ${currency} cannot be expressed in Rial`);
  }
  return Math.sign(amount) * Math.round(Math.abs(amount)) * (currency === "IRT" ? 10 : 1);
}

// ---------------------------------------------------------------------------
// Pure: document mapping
// ---------------------------------------------------------------------------

function mediaUrl(media: string | CmsMedia | null | undefined, mediaOrigin: string | null): string | null {
  if (!media || typeof media === "string") return null;
  const url = media.url ?? null;
  if (!url) return null;
  if (/^https?:\/\//.test(url)) return url;
  return mediaOrigin ? `${mediaOrigin.replace(/\/+$/, "")}${url.startsWith("/") ? "" : "/"}${url}` : url;
}

/** Pure Payload media response → the small media contract the app exposes. */
export function mapPayloadMedia(doc: CmsMedia, mediaOrigin: string | null): WebsiteMedia {
  return { id: doc.id, url: mediaUrl(doc, mediaOrigin), filename: doc.filename ?? null, alt: doc.alt ?? null };
}

export interface PayloadMappingContext {
  /** `https://{siteDomain}` — where a published post can be seen. */
  siteOrigin: string | null;
  mediaOrigin: string | null;
  currency: SiteCurrency;
}

export function mapPayloadPost(doc: CmsPost, ctx: PayloadMappingContext): Post {
  const status: PostStatus = doc._status === "published" ? "published" : "draft";
  const excerpt = (doc as { excerpt?: string | null }).excerpt ?? null;
  return {
    id: doc.id,
    title: doc.title,
    slug: doc.slug,
    body: lexicalToMarkdown(doc.content),
    excerpt,
    status,
    featuredImageUrl: mediaUrl(doc.heroImage, ctx.mediaOrigin),
    publishedAt: doc.publishedAt ?? null,
    updatedAt: doc.updatedAt,
    createdAt: doc.createdAt,
    url: status === "published" && ctx.siteOrigin ? `${ctx.siteOrigin}/blog/${doc.slug}` : null,
  };
}

export function mapPayloadProduct(doc: CmsProduct, ctx: PayloadMappingContext): RemoteProduct {
  return {
    id: doc.id,
    title: doc.title,
    sku: doc.sku ?? null,
    priceRial: siteAmountToRial(doc.price, ctx.currency),
    stock: doc.trackInventory ? (doc.inventory ?? null) : null,
    status: doc._status === "published" ? "published" : "draft",
    sourceId: doc.sourceId ?? null,
    imageId: typeof doc.image === "string" ? doc.image : doc.image?.id ?? null,
    categoryTermId: doc.terms?.[0] ? (typeof doc.terms[0] === "string" ? doc.terms[0] : doc.terms[0].id) : null,
    menuOrder: doc.menuOrder ?? null,
    available: doc.menuAvailable ?? null,
    modifierGroups: (doc.modifierGroups ?? []).map((group) => ({
      remoteId: group.id,
      sourceId: group.sourceId,
      label: group.label,
      minSelect: group.minSelect,
      maxSelect: group.maxSelect,
      isActive: group.isActive,
      sortOrder: group.sortOrder,
      options: group.options.map((option) => ({
        remoteId: option.id,
        sourceId: option.sourceId,
        label: option.label,
        priceDeltaRial: siteDeltaToRial(option.priceDelta, ctx.currency),
        isActive: option.isActive,
        sortOrder: option.sortOrder,
      })),
    })),
    updatedAt: doc.updatedAt,
  };
}

/** The `POST /api/posts` body for a draft. `_status` is always `draft` — the contract. */
export function buildPostBody(input: PostDraft): Record<string, unknown> {
  return {
    title: input.title,
    slug: input.slug ?? slugify(input.title),
    content: markdownToLexical(input.body),
    ...(input.excerpt !== undefined ? { excerpt: input.excerpt } : {}),
    ...(input.featuredImageId ? { heroImage: input.featuredImageId } : {}),
    _status: "draft",
  };
}

export function buildPostPatch(input: Partial<PostDraft>): Record<string, unknown> {
  return {
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.slug !== undefined ? { slug: input.slug } : {}),
    ...(input.body !== undefined ? { content: markdownToLexical(input.body) } : {}),
    ...(input.excerpt !== undefined ? { excerpt: input.excerpt } : {}),
    ...(input.featuredImageId !== undefined ? { heroImage: input.featuredImageId || null } : {}),
  };
}

export function buildProductBody(input: RemoteProductInput, currency: SiteCurrency): CmsProductWrite {
  const modifierGroups: CmsProductModifierGroup[] | undefined = input.modifierGroups?.map((group) => ({
    ...(group.remoteId ? { id: group.remoteId } : {}),
    sourceId: group.sourceId,
    label: group.label,
    minSelect: group.minSelect,
    maxSelect: group.maxSelect,
    isActive: group.isActive,
    sortOrder: group.sortOrder,
    options: group.options.map((option) => ({
      ...(option.remoteId ? { id: option.remoteId } : {}),
      sourceId: option.sourceId,
      label: option.label,
      priceDelta: rialToSiteDelta(option.priceDeltaRial, currency),
      isActive: option.isActive,
      sortOrder: option.sortOrder,
    })),
  }));
  return {
    title: input.title,
    price: rialToSiteAmount(input.priceRial, currency),
    ...(input.summary !== undefined ? { summary: input.summary } : {}),
    ...(input.sku !== undefined ? { sku: input.sku } : {}),
    ...(input.sourceId ? {
      sourceSystem: WEBSITE_SOURCE_SYSTEM,
      sourceId: input.sourceId,
      slug: `biza-${input.sourceId.replace(/[^a-zA-Z0-9-]+/g, "-")}`,
    } : {}),
    ...(input.imageId !== undefined ? { image: input.imageId } : {}),
    ...(input.categoryTermId !== undefined ? { terms: input.categoryTermId ? [input.categoryTermId] : [] } : {}),
    ...(input.menuOrder !== undefined ? { menuOrder: input.menuOrder } : {}),
    ...(input.published !== undefined ? { _status: input.published ? "published" : "draft" } : {}),
    ...(input.available !== undefined ? { menuAvailable: input.available } : {}),
    ...(input.inventoryManagedExternally !== undefined ? { inventoryManagedExternally: input.inventoryManagedExternally } : {}),
    ...(input.stock !== undefined ? { trackInventory: input.stock !== null, inventory: input.stock } : {}),
    ...(modifierGroups !== undefined ? { modifierGroups } : {}),
  } as CmsProductWrite;
}

/** Payload's page number ⇄ the adapter's opaque cursor. */
export function pageFromCursor(cursor?: string): number {
  if (!cursor) return 1;
  const match = /^p:(\d+)$/.exec(Buffer.from(cursor, "base64url").toString("utf8"));
  return match ? Math.max(1, Number(match[1])) : 1;
}
export function cursorFromPage(list: Pick<PayloadList<unknown>, "hasNextPage" | "nextPage">): string | null {
  return list.hasNextPage && list.nextPage ? Buffer.from(`p:${list.nextPage}`, "utf8").toString("base64url") : null;
}

/** Map the client's two error types onto the adapter's one. */
export function mapCmsError(error: unknown): WebsiteAdapterError {
  if (error instanceof WebsiteAdapterError) return error;
  if (error instanceof CmsNetworkError) return new WebsiteAdapterError("unreachable", error.message);
  if (error instanceof CmsApiError) {
    if (error.status === 401 || error.status === 403) {
      // eshobe-cms answers 403 both for a bad key and for a key trying to
      // publish; the message tells them apart.
      const message = String(error.body?.message ?? "").toLowerCase();
      if (error.body.code === "publish_forbidden" || message.includes("publish")) return new WebsiteAdapterError("unsupported", error.message);
      return new WebsiteAdapterError("unauthorized", error.message);
    }
    if (error.status === 404) return new WebsiteAdapterError("not_found", error.message);
    return new WebsiteAdapterError("rejected", error.message);
  }
  return new WebsiteAdapterError("rejected", error instanceof Error ? error.message : String(error));
}

// ---------------------------------------------------------------------------
// Circuit breaker — per base URL + domain, process-wide
// ---------------------------------------------------------------------------

export const BREAKER_FAILURES = 3;
export const BREAKER_OPEN_MS = 60_000;

interface BreakerState {
  failures: number;
  openUntil: number;
}
const breakers = new Map<string, BreakerState>();

export function breakerKey(config: Pick<CmsConfig, "baseUrl" | "siteDomain">): string {
  return `${config.baseUrl}|${config.siteDomain ?? ""}`;
}
export function breakerIsOpen(key: string, now = Date.now()): boolean {
  const state = breakers.get(key);
  return Boolean(state && state.openUntil > now);
}
export function breakerRecord(key: string, ok: boolean, now = Date.now()): void {
  if (ok) {
    breakers.delete(key);
    return;
  }
  const state = breakers.get(key) ?? { failures: 0, openUntil: 0 };
  state.failures += 1;
  if (state.failures >= BREAKER_FAILURES) state.openUntil = now + BREAKER_OPEN_MS;
  breakers.set(key, state);
}
/** Tests only. */
export function resetBreakers(): void {
  breakers.clear();
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export interface PayloadAdapterOptions {
  config: CmsConfig;
  currency: SiteCurrency;
  fetchImpl?: FetchLike;
  /** Injected clock for the breaker in tests. */
  now?: () => number;
}

export class PayloadWebsiteAdapter implements WebsiteAdapter {
  readonly key = "payload" as const;
  private readonly config: CmsConfig;
  private readonly currency: SiteCurrency;
  private readonly fetchImpl?: FetchLike;
  private readonly now: () => number;
  private mediaOrigin: string | null = null;

  constructor(options: PayloadAdapterOptions) {
    this.config = options.config;
    this.currency = options.currency;
    this.fetchImpl = options.fetchImpl;
    this.now = options.now ?? Date.now;
  }

  private get ctx(): PayloadMappingContext {
    return {
      siteOrigin: this.config.siteDomain ? `https://${this.config.siteDomain}` : null,
      mediaOrigin: this.mediaOrigin ?? (this.config.siteDomain ? `https://${this.config.siteDomain}` : null),
      currency: this.currency,
    };
  }

  /** Every network call goes through here: breaker, then error mapping. */
  private async call<T>(fn: () => Promise<T>): Promise<T> {
    const key = breakerKey(this.config);
    if (breakerIsOpen(key, this.now())) throw new WebsiteAdapterError("unreachable", "circuit open");
    try {
      const result = await fn();
      breakerRecord(key, true, this.now());
      return result;
    } catch (error) {
      const mapped = mapCmsError(error);
      // Only transport failures trip the breaker; a 4xx is the site answering.
      breakerRecord(key, mapped.code !== "unreachable", this.now());
      throw mapped;
    }
  }

  /** Recover a lost create response by stable identity, never by title/SKU. */
  private async findBySource<T extends { id: string }>(path: string, sourceId: string, extra: Record<string, string> = {}): Promise<T | null> {
    const list = await cmsRequest<PayloadList<T>>(this.config, {
      path,
      query: {
        limit: 2, depth: 0,
        "where[sourceSystem][equals]": WEBSITE_SOURCE_SYSTEM,
        "where[sourceId][equals]": sourceId,
        ...Object.fromEntries(Object.entries(extra).map(([key, value]) => [`where[${key}][equals]`, value])),
      },
      fetchImpl: this.fetchImpl,
    });
    if (list.totalDocs > 1 || list.docs.length > 1) {
      throw new WebsiteAdapterError("rejected", `ambiguous remote source identity at ${path}`);
    }
    return list.docs[0] ?? null;
  }

  private opts() {
    return { fetchImpl: this.fetchImpl };
  }

  async testConnection(): Promise<ConnectionTest> {
    try {
      const site = await this.call(() => fetchSiteDescriptor(this.config, this.opts()));
      this.mediaOrigin = site.media?.origin ?? null;
      if (!site.id) return { ok: false, error: "cms_old_version" };
      if (this.config.siteDomain && site.domain !== this.config.siteDomain) {
        return { ok: false, error: "domain_mismatch" };
      }
      return { ok: true, siteName: site.name };
    } catch (error) {
      const mapped = mapCmsError(error);
      return { ok: false, error: mapped.code };
    }
  }

  async uploadMedia(input: MediaUpload): Promise<WebsiteMedia> {
    if (!input.filename.trim() || !input.mimeType.startsWith("image/") || input.bytes.byteLength === 0) {
      throw new WebsiteAdapterError("rejected", "invalid image upload");
    }
    if (input.sourceId) {
      const existing = await this.findBySource<CmsMedia>("/api/media", input.sourceId);
      if (existing) return mapPayloadMedia(existing, this.ctx.mediaOrigin);
    }
    const form = new FormData();
    if (input.sourceId) {
      form.set("sourceSystem", WEBSITE_SOURCE_SYSTEM);
      form.set("sourceId", input.sourceId);
    }
    // Copy into a plain ArrayBuffer-backed view: a caller may give us a view of
    // a SharedArrayBuffer, which Blob deliberately refuses in Node's typings.
    const bytes = Uint8Array.from(input.bytes);
    form.set("file", new Blob([bytes.buffer], { type: input.mimeType }), input.filename);
    if (input.alt?.trim()) form.set("alt", input.alt.trim());
    const doc = await this.call(() => cmsFormRequest<CmsMedia>(this.config, {
      path: "/api/media", form, fetchImpl: this.fetchImpl,
    }));
    return mapPayloadMedia(doc, this.ctx.mediaOrigin);
  }

  async listPosts(q: { status?: PostStatus; limit: number; cursor?: string }): Promise<Page<Post>> {
    const list = await this.call(() =>
      cmsRequest<PayloadList<CmsPost>>(this.config, {
        path: "/api/posts",
        query: {
          limit: q.limit,
          page: pageFromCursor(q.cursor),
          depth: 1,
          sort: "-updatedAt",
          ...(q.status ? { "where[_status][equals]": q.status } : {}),
        },
        fetchImpl: this.fetchImpl,
      }),
    );
    return { items: list.docs.map((doc) => mapPayloadPost(doc, this.ctx)), nextCursor: cursorFromPage(list), total: list.totalDocs };
  }

  async getPost(id: string): Promise<Post | null> {
    try {
      const doc = await this.call(() =>
        cmsRequest<CmsPost>(this.config, { path: `/api/posts/${encodeURIComponent(id)}`, query: { depth: 1 }, fetchImpl: this.fetchImpl }),
      );
      return mapPayloadPost(doc, this.ctx);
    } catch (error) {
      if (error instanceof WebsiteAdapterError && error.code === "not_found") return null;
      throw error;
    }
  }

  async draftPost(input: PostDraft): Promise<Post> {
    const doc = await this.call(() =>
      createPost(this.config, buildPostBody(input) as Parameters<typeof createPost>[1], this.opts()),
    );
    return mapPayloadPost(doc, this.ctx);
  }

  async updatePost(id: string, input: Partial<PostDraft>): Promise<Post> {
    const doc = await this.call(() =>
      updatePost(this.config, id, buildPostPatch(input) as Parameters<typeof updatePost>[2], this.opts()),
    );
    return mapPayloadPost(doc, this.ctx);
  }

  async publishPost(id: string): Promise<Post> {
    const doc = await this.call(() =>
      cmsRequest<CmsPost>(this.config, {
        method: "PATCH",
        path: `/api/posts/${encodeURIComponent(id)}`,
        body: { _status: "published" },
        fetchImpl: this.fetchImpl,
      }),
    );
    return mapPayloadPost(doc, this.ctx);
  }

  async listProducts(q: { limit: number; cursor?: string }): Promise<Page<RemoteProduct>> {
    const list = await this.call(() => fetchProducts(this.config, { limit: q.limit, page: pageFromCursor(q.cursor), ...this.opts() }));
    return {
      items: list.docs.map((doc) => mapPayloadProduct(doc, this.ctx)),
      nextCursor: cursorFromPage(list),
      total: list.totalDocs,
    };
  }

  async upsertProduct(input: RemoteProductInput): Promise<RemoteProduct> {
    const doc = await this.call(async () => {
      let remoteId = input.remoteId;
      let existing: RemoteProduct | undefined;
      if (!remoteId && input.sourceId) {
        const found = await this.findBySource<CmsProduct>("/api/products", input.sourceId);
        if (found) {
          remoteId = found.id;
          existing = mapPayloadProduct(found, this.ctx);
        }
      }
      const body = buildProductBody(input, this.currency);
      if (remoteId && input.modifierGroups) {
        if (!existing) {
          const current = await cmsRequest<CmsProduct>(this.config, {
            path: `/api/products/${encodeURIComponent(remoteId)}`,
            query: { depth: 0 },
            fetchImpl: this.fetchImpl,
          });
          existing = mapPayloadProduct(current, this.ctx);
        }
        body.modifierGroups = input.modifierGroups.map((group) => {
          const previous = existing?.modifierGroups?.find((g) => g.sourceId === group.sourceId);
          const groupId = group.remoteId ?? previous?.remoteId;
          return {
            ...(groupId ? { id: groupId } : {}),
            sourceId: group.sourceId,
            label: group.label,
            minSelect: group.minSelect,
            maxSelect: group.maxSelect,
            isActive: group.isActive,
            sortOrder: group.sortOrder,
            options: group.options.map((option) => {
              const optionId = option.remoteId ?? previous?.options.find((o) => o.sourceId === option.sourceId)?.remoteId;
              return {
                ...(optionId ? { id: optionId } : {}),
                sourceId: option.sourceId,
                label: option.label,
                priceDelta: rialToSiteDelta(option.priceDeltaRial, this.currency),
                isActive: option.isActive,
                sortOrder: option.sortOrder,
              };
            }),
          };
        });
      }
      return remoteId
        ? updateProduct(this.config, remoteId, body, this.opts())
        : createProduct(this.config, body, this.opts());
    });
    return mapPayloadProduct(doc, this.ctx);
  }

  async upsertMenuTaxonomy(input: { remoteId?: string }): Promise<{ id: string }> {
    if (input.remoteId) return { id: input.remoteId };
    return this.call(async () => {
      const list = await cmsRequest<PayloadList<CmsTaxonomyDefinition>>(this.config, {
        path: "/api/taxonomy-definitions",
        query: { limit: 2, depth: 0, "where[key][equals]": WEBSITE_MENU_TAXONOMY_KEY },
        fetchImpl: this.fetchImpl,
      });
      if (list.totalDocs > 1 || list.docs.length > 1) {
        throw new WebsiteAdapterError("rejected", "ambiguous menu taxonomy");
      }
      if (list.docs[0]) return { id: list.docs[0].id };
      const doc = await cmsRequest<CmsTaxonomyDefinition>(this.config, {
        method: "POST", path: "/api/taxonomy-definitions",
        body: {
          key: WEBSITE_MENU_TAXONOMY_KEY,
          singularLabel: "دستهٔ منو", pluralLabel: "دسته‌های منو",
          description: "دسته‌های منوی حسابداری بیزامیز", hierarchical: true, hasArchive: false,
        },
        fetchImpl: this.fetchImpl,
      });
      return { id: doc.id };
    });
  }

  async upsertMenuCategory(input: MenuCategoryInput): Promise<RemoteMenuCategory> {
    const body = {
      taxonomy: input.taxonomyId,
      sourceSystem: WEBSITE_SOURCE_SYSTEM,
      sourceId: input.sourceId,
      name: input.name,
      slug: `biza-${input.sourceId.replace(/[^a-zA-Z0-9-]+/g, "-")}`,
      description: input.description ?? "",
      menuOrder: input.sortOrder,
    };
    const doc = await this.call(async () => {
      let remoteId = input.remoteId;
      if (!remoteId) {
        remoteId = (await this.findBySource<CmsTaxonomyTerm>("/api/taxonomy-terms", input.sourceId, { taxonomy: input.taxonomyId }))?.id;
      }
      return cmsRequest<CmsTaxonomyTerm>(this.config, {
        method: remoteId ? "PATCH" : "POST",
        path: remoteId ? `/api/taxonomy-terms/${encodeURIComponent(remoteId)}` : "/api/taxonomy-terms",
        body, fetchImpl: this.fetchImpl,
      });
    });
    return { id: doc.id, sourceId: input.sourceId, name: doc.name, description: doc.description ?? null, sortOrder: doc.menuOrder };
  }

  async setProductAvailability(remoteId: string, input: ProductAvailability): Promise<void> {
    await this.call(() => updateProduct(this.config, remoteId, {
      _status: input.published ? "published" : "draft", menuAvailable: input.available,
    }, this.opts()));
  }

  async setProductStock(remoteId: string, quantity: number | null): Promise<void> {
    if (quantity !== null && (!Number.isSafeInteger(quantity) || quantity < 0)) {
      throw new WebsiteAdapterError("rejected", "stock must be a non-negative integer or unknown");
    }
    await this.call(() => updateProduct(this.config, remoteId, {
      trackInventory: quantity !== null, inventory: quantity, inventoryManagedExternally: true,
    }, this.opts()));
  }

  async setProductPrice(remoteId: string, priceRial: number): Promise<void> {
    const price = rialToSiteAmount(priceRial, this.currency);
    await this.call(() => updateProduct(this.config, remoteId, { price }, this.opts()));
  }
}
