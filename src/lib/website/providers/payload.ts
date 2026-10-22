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
import type { CmsMedia, CmsPost, CmsProduct, PayloadList } from "../../cms/types";
import {
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
    stock: doc.trackInventory ? (doc.inventory ?? 0) : null,
    status: doc._status === "published" ? "published" : "draft",
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

export function buildProductBody(input: RemoteProductInput, currency: SiteCurrency): {
  title: string;
  price: number;
  summary?: string;
  sku?: string;
  trackInventory?: boolean;
  inventory?: number;
} {
  return {
    title: input.title,
    price: rialToSiteAmount(input.priceRial, currency),
    ...(input.summary !== undefined ? { summary: input.summary } : {}),
    ...(input.sku !== undefined ? { sku: input.sku } : {}),
    ...(input.stock !== undefined ? { trackInventory: true, inventory: input.stock } : {}),
  };
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
    const form = new FormData();
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
    const body = buildProductBody(input, this.currency);
    const doc = await this.call(() =>
      input.remoteId ? updateProduct(this.config, input.remoteId, body, this.opts()) : createProduct(this.config, body, this.opts()),
    );
    return mapPayloadProduct(doc, this.ctx);
  }

  async setProductStock(remoteId: string, quantity: number): Promise<void> {
    await this.call(() => updateProduct(this.config, remoteId, { trackInventory: true, inventory: quantity }, this.opts()));
  }

  async setProductPrice(remoteId: string, priceRial: number): Promise<void> {
    const price = rialToSiteAmount(priceRial, this.currency);
    await this.call(() => updateProduct(this.config, remoteId, { price }, this.opts()));
  }
}
