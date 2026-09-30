/**
 * Phase 38 Wave 1 (issue #379) — the `WebsiteAdapter` interface.
 *
 * The website app, its API routes, the sync tick and the assistant's tools are
 * written against THIS, never against Payload. Two reasons, both from the
 * phase's decision table: the Payload service was still being built when the
 * app was, and a future owner may well have a WordPress site rather than a
 * Payload one. An adapter is one file under `providers/`; everything above it
 * stays put.
 *
 * Contract rules, load-bearing for every implementation:
 *
 *   - **Money is integer Rial** across the whole interface. A site that keeps
 *     Toman or Euro in its own store converts at the boundary — inside the
 *     adapter — the same rule `woo-money.ts` follows for WooCommerce.
 *   - **Content is Markdown.** The assistant produces Markdown and the app
 *     already renders it; an adapter whose site stores a structured document
 *     (Payload's Lexical) translates in both directions (see
 *     `providers/payload-content.ts`, which is round-trip tested).
 *   - **`draftPost` never publishes.** Publishing is a separate method so it
 *     can be a separate, human-confirmed action all the way up the stack.
 *   - **Never throw a provider's own error type past this boundary.** An
 *     adapter maps its transport failures to `WebsiteAdapterError` with one of
 *     the codes below so the UI can show a Persian message and the queue can
 *     decide whether to retry.
 *
 * Pure: no `db`, no `next`. `providers/mock.ts` is the in-memory reference
 * implementation the tests and the sync tick's tests run against.
 */

export const WEBSITE_ADAPTER_KEYS = ["payload", "mock"] as const;
export type WebsiteAdapterKey = (typeof WEBSITE_ADAPTER_KEYS)[number];

export interface Page<T> {
  items: T[];
  /** Opaque; pass back as `cursor` to fetch the next page. `null` when done. */
  nextCursor: string | null;
  total?: number;
}

export type PostStatus = "draft" | "published";

export interface Post {
  id: string;
  title: string;
  slug: string;
  /** Markdown. */
  body: string;
  excerpt: string | null;
  status: PostStatus;
  /** Absolute URL of the featured image on the site, if any. */
  featuredImageUrl: string | null;
  /** ISO timestamps — Gregorian on the wire, Shamsi only when displayed. */
  publishedAt: string | null;
  updatedAt: string;
  createdAt: string;
  /** Where it can be seen on the site, if the adapter can say. */
  url: string | null;
}

export interface WebsiteMedia {
  id: string;
  /** Absolute, browser-safe URL returned by the site. */
  url: string | null;
  filename: string | null;
  alt: string | null;
}

export interface MediaUpload {
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
  alt?: string;
}

export interface PostDraft {
  title: string;
  /** Markdown. */
  body: string;
  slug?: string;
  excerpt?: string;
  /** The remote media id to attach as the featured image. */
  featuredImageId?: string;
}

export interface RemoteProduct {
  id: string;
  title: string;
  sku: string | null;
  /** Integer Rial — converted by the adapter from the site's own unit. */
  priceRial: number;
  /** `null` when the site does not track stock for this product. */
  stock: number | null;
  status: PostStatus;
  updatedAt: string;
}

export interface RemoteProductInput {
  /** When set, update this remote product; otherwise create one. */
  remoteId?: string;
  title: string;
  sku?: string;
  summary?: string;
  /** Integer Rial. */
  priceRial: number;
  /** Omit to leave the site's stock tracking alone. */
  stock?: number;
}

export interface ConnectionTest {
  ok: boolean;
  siteName?: string;
  /** Adapter-specific diagnostics the UI may show verbatim. */
  error?: string;
}

export interface WebsiteAdapter {
  readonly key: WebsiteAdapterKey;

  testConnection(): Promise<ConnectionTest>;
  /** Upload a media object and return its remote ID for `featuredImageId`. */
  uploadMedia(input: MediaUpload): Promise<WebsiteMedia>;

  listPosts(q: { status?: PostStatus; limit: number; cursor?: string }): Promise<Page<Post>>;
  getPost(id: string): Promise<Post | null>;
  /** Always lands as a draft, whatever the input says. */
  draftPost(input: PostDraft): Promise<Post>;
  updatePost(id: string, input: Partial<PostDraft>): Promise<Post>;
  /** The one call that makes content public. */
  publishPost(id: string): Promise<Post>;

  listProducts(q: { limit: number; cursor?: string }): Promise<Page<RemoteProduct>>;
  upsertProduct(input: RemoteProductInput): Promise<RemoteProduct>;
  setProductStock(remoteId: string, quantity: number): Promise<void>;
  setProductPrice(remoteId: string, priceRial: number): Promise<void>;
}

/**
 * The one error type that crosses the adapter boundary.
 *
 *   - `unreachable` — network/timeout/circuit open. Retryable; the queue backs
 *     off and the UI says «سایت در دسترس نیست».
 *   - `unauthorized` — the credential was refused. Not retryable; the
 *     connection is marked with the error so the owner re-connects.
 *   - `not_found` — the remote row is gone (e.g. deleted in the CMS admin).
 *   - `rejected` — the site refused the write (validation, publish-gate…).
 *   - `unsupported` — this adapter cannot do this at all (e.g. a site whose
 *     API key may never publish).
 */
export type WebsiteAdapterErrorCode = "unreachable" | "unauthorized" | "not_found" | "rejected" | "unsupported";

export class WebsiteAdapterError extends Error {
  readonly code: WebsiteAdapterErrorCode;
  readonly detail: string | null;

  constructor(code: WebsiteAdapterErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "WebsiteAdapterError";
    this.code = code;
    this.detail = detail ?? null;
  }
}

/** Whether the outbox should try this failure again later. */
export function isRetryableWebsiteError(error: unknown): boolean {
  return error instanceof WebsiteAdapterError ? error.code === "unreachable" : false;
}

/** Persian, for the dashboard and the assistant. */
export const WEBSITE_ERROR_LABELS: Record<WebsiteAdapterErrorCode, string> = {
  unreachable: "سایت در دسترس نیست؛ بعداً دوباره تلاش می‌شود.",
  unauthorized: "کلید اتصال سایت پذیرفته نشد؛ اتصال را دوباره برقرار کنید.",
  not_found: "این مورد روی سایت پیدا نشد (شاید از پنل سایت حذف شده باشد).",
  rejected: "سایت این تغییر را نپذیرفت.",
  unsupported: "این کار از راه این اتصال شدنی نیست.",
};

/** A URL-safe slug from a Persian or Latin title; the adapter may still override it. */
export function slugify(title: string): string {
  const cleaned = title
    .trim()
    .toLowerCase()
    .replace(/[\u200c\s_]+/g, "-") // ZWNJ and whitespace → hyphen
    .replace(/[^\p{L}\p{N}-]+/gu, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return cleaned || "post";
}
