/**
 * Issue #894 Wave 2 — the Torob Product API **v3 contract**, as published.
 *
 * Source of truth: `torob/Torob-Sync` → `product_api_v3.md` (fetched 2026-11-01).
 * The names in this file are Torob's, not ours — `current_price`, `image_links`,
 * `spec`, `date_added` — because a translation layer between the contract and the
 * thing that serves it is where a field quietly stops being sent.
 *
 * Four rules the document states that are easy to lose and expensive to get
 * wrong, each enforced below:
 *
 *   1. **Exactly one request mode, no defaults.** `page_urls`, `page_uniques`,
 *      `page` + `sort`, or `cursor` + `sort` — an empty body, an unknown field or
 *      a missing `sort` is a `400` with `{ error }`, never a defaulted page 1.
 *      A crawler that gets a silent page 1 for a malformed request believes it
 *      has synced the shop.
 *   2. **100 per page, except the last.** `max_pages` is `ceil(total / 100)`.
 *   3. **`spec` is required and is a dictionary.** An empty object when a product
 *      has no specifications; `null` is not acceptable.
 *   4. **A removed product is absent, not broken.** In a list it is omitted; in a
 *      `page_urls`/`page_uniques` lookup it produces an empty `products` array
 *      with `total: 0`.
 *
 * And the price trap the document calls out twice: `current_price: 0` with
 * `availability: true` means **FREE** to Torob. An unavailable product is
 * therefore sent as `availability: false` with `current_price: 0`, and a product
 * that is not for sale at all is not sent at all.
 */

/** The only value `api_version` may take. */
export const TOROB_API_VERSION = "torob_api_v3";

/** Products per page. Fixed by the contract. */
export const TOROB_PAGE_SIZE = 100;

/** The three sorts the document defines, and what each is for. */
export const TOROB_SORTS = ["date_added_desc", "date_updated_desc", "product_id_desc"] as const;
export type TorobSort = (typeof TOROB_SORTS)[number];

/** Cursor pagination is defined only over this sort. */
export const TOROB_CURSOR_SORT: TorobSort = "product_id_desc";

/** Field limits from the document's schema appendix. */
export const TOROB_FIELD_LIMITS = {
  page_unique: 200,
  page_url: 1500,
  title: 500,
  subtitle: 500,
  product_group_id: 200,
  category_name: 200,
  image_link: 1000,
  short_desc: 500,
  guarantee: 200,
} as const;

/** One product, exactly as the appendix defines it. */
export interface TorobProductV3 {
  page_unique: string;
  page_url: string;
  title: string;
  subtitle?: string;
  product_group_id?: string;
  /** Integer Toman. `0` when unavailable — never `null`. */
  current_price: number;
  old_price?: number;
  /** `false` + `0` is "unavailable"; `true` + `0` would be **free**. */
  availability: boolean;
  category_name?: string;
  image_links: string[];
  short_desc?: string;
  /** Required by the contract; `{}` when the product has no specifications. */
  spec: Record<string, string | number>;
  guarantee?: string;
  /** Timezone-aware ISO 8601. Required. */
  date_added: string;
  /** Required when the shop implements `date_updated_desc`. */
  date_updated?: string;
  seller_name?: string;
  seller_city?: string;
}

/** The response envelope, exactly as the document defines it. */
export interface TorobV3Response {
  api_version: typeof TOROB_API_VERSION;
  /** Omitted for cursor pages: there is no page number there. */
  current_page?: number;
  total: number;
  max_pages: number | null;
  next_cursor: string | null;
  products: TorobProductV3[];
}

/**
 * A parsed request. `mode` decides what the endpoint may answer, and the four
 * variants exist so a caller cannot "mostly" be in two modes.
 */
export type TorobRequest =
  | { mode: "page_urls"; pageUrls: string[] }
  | { mode: "page_uniques"; pageUniques: string[] }
  | { mode: "page"; page: number; sort: TorobSort }
  | { mode: "cursor"; cursor: string | null; sort: TorobSort };

export type TorobRequestError =
  | "body_not_object"
  | "multiple_modes"
  | "empty_request"
  | "sort_required"
  | "sort_invalid"
  | "page_invalid"
  | "page_urls_invalid"
  | "page_uniques_invalid"
  | "cursor_invalid"
  | "cursor_requires_product_id_desc";

/** The one-line message a shop returns in `{ error }`, in Torob's language. */
export const TOROB_REQUEST_ERROR_MESSAGE: Readonly<Record<TorobRequestError, string>> = {
  body_not_object: "request body must be a JSON object",
  multiple_modes: "request must use exactly one of page_urls, page_uniques, page, or cursor",
  empty_request: "request body is empty: send page_urls, page_uniques, page, or cursor",
  sort_required: "sort parameter is not provided",
  sort_invalid: `sort must be one of ${TOROB_SORTS.join(", ")}`,
  page_invalid: "page must be an integer greater than or equal to 1",
  page_urls_invalid: "page_urls must be a non-empty list of absolute URLs",
  page_uniques_invalid: "page_uniques must be a non-empty list of strings",
  cursor_invalid: "cursor must be a non-empty string",
  cursor_requires_product_id_desc: "cursor pagination requires sort product_id_desc",
};

export type ParsedRequest = { ok: true; request: TorobRequest } | { ok: false; error: TorobRequestError };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbsoluteUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Parse a request body strictly.
 *
 * Unknown keys are ignored rather than refused: Torob's own examples carry
 * `Accept`/`Content-Type` semantics elsewhere and a future optional field must not
 * break every shop. What *is* refused is ambiguity — two modes in one body — and
 * every form of "no mode at all", because the document says not to default.
 */
export function parseTorobRequest(body: unknown): ParsedRequest {
  if (!isPlainObject(body)) return { ok: false, error: "body_not_object" };

  const hasUrls = "page_urls" in body;
  const hasUniques = "page_uniques" in body;
  const hasPage = "page" in body;
  const hasCursor = "cursor" in body;
  const modes = [hasUrls, hasUniques, hasPage, hasCursor].filter(Boolean).length;
  if (modes === 0) return { ok: false, error: "empty_request" };
  if (modes > 1) return { ok: false, error: "multiple_modes" };

  if (hasUrls) {
    const value = body.page_urls;
    if (!Array.isArray(value) || value.length === 0) return { ok: false, error: "page_urls_invalid" };
    if (!value.every((entry) => typeof entry === "string" && isAbsoluteUrl(entry))) {
      return { ok: false, error: "page_urls_invalid" };
    }
    return { ok: true, request: { mode: "page_urls", pageUrls: value as string[] } };
  }

  if (hasUniques) {
    const value = body.page_uniques;
    if (!Array.isArray(value) || value.length === 0) return { ok: false, error: "page_uniques_invalid" };
    if (!value.every((entry) => typeof entry === "string" && entry.trim().length > 0)) {
      return { ok: false, error: "page_uniques_invalid" };
    }
    return { ok: true, request: { mode: "page_uniques", pageUniques: (value as string[]).map((entry) => entry.trim()) } };
  }

  const sort = body.sort;
  if (sort === undefined) return { ok: false, error: "sort_required" };
  if (typeof sort !== "string" || !(TOROB_SORTS as readonly string[]).includes(sort)) {
    return { ok: false, error: "sort_invalid" };
  }
  const typedSort = sort as TorobSort;

  if (hasCursor) {
    // The document is explicit that cursor mode must not carry a page.
    const cursor = body.cursor;
    // `"cursor": null` is the first cursor page — the document's own shape for it.
    if (cursor !== undefined && cursor !== null && (typeof cursor !== "string" || cursor.trim().length === 0)) {
      return { ok: false, error: "cursor_invalid" };
    }
    if (typedSort !== TOROB_CURSOR_SORT) return { ok: false, error: "cursor_requires_product_id_desc" };
    return {
      ok: true,
      request: { mode: "cursor", cursor: typeof cursor === "string" ? cursor.trim() : null, sort: typedSort },
    };
  }

  const page = body.page;
  if (typeof page !== "number" || !Number.isInteger(page) || page < 1) {
    return { ok: false, error: "page_invalid" };
  }
  return { ok: true, request: { mode: "page", page, sort: typedSort } };
}

/** Trim to the document's cap, or drop a field that would exceed it. */
export function clampField(value: string | undefined, limit: number): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > limit ? trimmed.slice(0, limit) : trimmed;
}

/**
 * Whether a product may appear in the feed at all.
 *
 * A product that is not for sale (hidden, unpublished, deleted) is **omitted** —
 * the document's rule for removed products — rather than sent with
 * `availability: false`, which would keep a listing alive for something the
 * merchant has withdrawn.
 */
export function isPublishable(product: { sellable?: boolean }): boolean {
  return product.sellable !== false;
}

/**
 * The price pair Torob reads.
 *
 * The trap the document names: `availability: true` with `current_price: 0` is
 * displayed as **free**. So an unavailable product sends `false` + `0`, never the
 * last known price — a stale price on an unavailable listing is the other half of
 * the same bug (a shopper is quoted a number the shop will not honour).
 */
export function priceForTorob(input: {
  available: boolean;
  /** Integer Toman, already converted. */
  toman: number;
}): { current_price: number; availability: boolean } {
  return input.available
    ? { current_price: input.toman, availability: true }
    : { current_price: 0, availability: false };
}

/** Total pages at the contract's page size. */
export function maxPages(total: number): number {
  return Math.max(1, Math.ceil(total / TOROB_PAGE_SIZE));
}

/** A page-based or lookup response, wrapped in the documented envelope. */
export function pageResponse(input: {
  products: TorobProductV3[];
  page: number;
  total: number;
}): TorobV3Response {
  return {
    api_version: TOROB_API_VERSION,
    current_page: input.page,
    total: input.total,
    max_pages: maxPages(input.total),
    next_cursor: null,
    products: input.products,
  };
}

/** A cursor response: no page number, and `max_pages`/`total` may be null-ish. */
export function cursorResponse(input: {
  products: TorobProductV3[];
  total: number | null;
  nextCursor: string | null;
}): TorobV3Response {
  return {
    api_version: TOROB_API_VERSION,
    total: input.total ?? input.products.length,
    max_pages: input.total === null ? null : maxPages(input.total),
    next_cursor: input.nextCursor,
    products: input.products,
  };
}

/** An `{ error }` body, which is the only shape the document defines for 400. */
export function errorBody(error: TorobRequestError): { error: string } {
  return { error: TOROB_REQUEST_ERROR_MESSAGE[error] };
}
