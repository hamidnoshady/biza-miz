/**
 * Issue #894 Wave 4b — the **Shop API** client: the direction where we ask Torob.
 *
 * Every earlier client in this feature is called by Torob or by the merchant's
 * browser. This one is ours: `https://api.torob.com/shop-api/v1/`, transcribed
 * from `torob/Torob-Sync` → `shop_api.md`, and it exists for one reason — the
 * product API tells Torob what we have, and nothing tells us what Torob *did* with
 * it. `GET /shop/` and `POST /products/` are that answer.
 *
 * Three of the document's rules are load-bearing rather than decorative, and each
 * is a bug this file would otherwise have:
 *
 *   1. **5 requests per second, per shop.** The platform refreshes a shop with at
 *      least two calls and potentially one per 100 products; a burst is a 429 that
 *      looks like an outage. `createShopApiThrottle` spaces the calls, and a 429
 *      that still happens is retried with the provider's own `Retry-After` before
 *      it is reported.
 *   2. **Pagination is a cursor, and the cursor is inside the `next` link.** The
 *      link is an absolute URL Torob chooses. Following it verbatim would send our
 *      bearer token to whatever host the response names; instead this client takes
 *      **only the `cursor` parameter** out of the link and rebuilds the request
 *      against its own configured base. A provider mistake — or a hostile answer —
 *      therefore cannot redirect the credential.
 *   3. **`product_summary` is not live.** The counts are recomputed at least every
 *      two days; the document says so twice. This client returns `calculatedAt`
 *      with the numbers so no caller can present them as current, and the screen
 *      renders that date beside them.
 *
 * The client never decides *which* shop to read, never picks a credential, and
 * never writes anything: those belong to `status-service.ts`.
 */
import {
  TOROB_PRODUCT_STATUSES,
  TOROB_SHOP_STATUSES,
  type TorobObservationError,
  type TorobProductStatus,
  type TorobProductSummary,
  type TorobShopStatus,
} from "./observed-state";

/** Torob's documented base URL. Overridable so tests never reach the network. */
export const TOROB_SHOP_API_URL = "https://api.torob.com/shop-api/v1/";

/** The document's limit, per shop, across every Shop API endpoint. */
export const TOROB_SHOP_API_RATE_LIMIT = 5;

/** `page_size` default is 100; 500 is the provider's ceiling. */
export const TOROB_SHOP_API_PAGE_SIZE = 100;

/**
 * How many pages one refresh reads.
 *
 * Twenty pages is 2 000 products — more than a Bizamiz shop has today — and a
 * bound is what keeps a refresh from being an unbounded loop against a provider
 * that always answers `next`. When the bound is hit the scan reports
 * `truncated: true`, and the caller may not treat the absence of a product as
 * evidence about it.
 */
export const TOROB_SHOP_API_MAX_PAGES = 20;

/** A failure to read Torob, in the closed vocabulary the schema stores. */
export class TorobShopApiError extends Error {
  constructor(
    public readonly code: TorobObservationError,
    /** The provider's own words, for the log — never rendered to a merchant. */
    public readonly detail?: string,
  ) {
    super(code);
    this.name = "TorobShopApiError";
  }
}

export function torobShopApiBaseUrl(env: Record<string, string | undefined> = process.env): string {
  const configured = env.TOROB_SHOP_API_BASE_URL?.trim();
  if (!configured) return TOROB_SHOP_API_URL;
  return configured.endsWith("/") ? configured : `${configured}/`;
}

/**
 * A per-shop request gate.
 *
 * `perSecond` calls, evenly spaced — not a token bucket that allows five calls in
 * one millisecond and then nothing for a second. Torob's limit is about a steady
 * stream, and even spacing is what a crawler-facing provider actually wants.
 */
export interface ShopApiThrottle {
  take(): Promise<void>;
}

export function createShopApiThrottle(options: {
  perSecond?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
} = {}): ShopApiThrottle {
  const perSecond = Math.max(1, options.perSecond ?? TOROB_SHOP_API_RATE_LIMIT);
  const interval = Math.ceil(1000 / perSecond);
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let nextAt = 0;

  return {
    async take() {
      const at = Math.max(now(), nextAt);
      nextAt = at + interval;
      const wait = at - now();
      if (wait > 0) await sleep(wait);
    },
  };
}

/** The no-op gate, for a caller that already spaces its calls (and for tests). */
export const NO_THROTTLE: ShopApiThrottle = { take: async () => {} };

export interface TorobShopApiOptions {
  /** A shop token, or the platform's generator token. Never logged. */
  token: string;
  /**
   * The shop's own domain. Sent on every request: a generator *must* send it, and
   * a shop token may — the document says it must then be the shop's own domain,
   * which is all this platform ever has.
   */
  domain: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  throttle?: ShopApiThrottle;
  /** 429 retries before giving up. */
  maxRetries?: number;
  timeoutMs?: number;
  /** For tests: how long a `Retry-After` wait is capped to. */
  maxRetryDelayMs?: number;
}

/** `GET /shop/`, as a merchant-facing shape. */
export interface TorobShopInfo {
  domain: string;
  name: string;
  shopStatus: TorobShopStatus;
  summary: TorobProductSummary;
}

/** One page of a shop, as Torob sees it. */
export interface TorobShopProduct {
  pageUnique: string;
  statuses: TorobProductStatus[];
  mainStatus: TorobProductStatus | null;
  priceToman: number | null;
  availability: boolean | null;
  errorTitle: string | null;
  torobUpdatedAt: string | null;
  pageUrl: string | null;
}

export interface TorobProductScan {
  products: TorobShopProduct[];
  pages: number;
  /** The scan stopped at `maxPages` while Torob still had a `next` page. */
  truncated: boolean;
  /**
   * Statuses Torob reported that this build does not know. Counted rather than
   * dropped silently: "Torob said something we do not understand" is information,
   * and folding it into a nearby status would be an invented fact.
   */
  unknownStatuses: number;
}

const KNOWN_STATUSES = new Set<string>(TOROB_PRODUCT_STATUSES);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function isoOrNull(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Why this response is not acceptable, mapped from its status. */
function toFailure(status: number, body: unknown): TorobShopApiError {
  const row = asRecord(body);
  const detail = typeof row.detail === "string" ? row.detail : typeof row.error === "string" ? row.error : "";
  if (status === 400) return new TorobShopApiError("invalid_request", detail || "HTTP 400");
  if (status === 401) return new TorobShopApiError("unauthorized", detail);
  if (status === 403) return new TorobShopApiError("forbidden", detail);
  if (status === 404) return new TorobShopApiError("not_found", detail);
  if (status === 429) return new TorobShopApiError("rate_limited", "HTTP 429");
  return new TorobShopApiError("provider_error", `HTTP ${status}`);
}

interface CallOptions {
  method: "GET" | "POST";
  /** Path relative to the base, already carrying its query string. */
  path: string;
  body?: unknown;
}

async function call(options: TorobShopApiOptions, call_: CallOptions): Promise<unknown> {
  const token = options.token.trim();
  const domain = options.domain.trim().toLowerCase();
  // Refused before the network: a request with no credential would come back 401
  // and read like Torob's fault, and a request with no domain is one Torob cannot
  // route for a generator at all.
  if (!token) throw new TorobShopApiError("not_configured", "no token");
  if (!domain) throw new TorobShopApiError("invalid_request", "no domain");

  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const throttle = options.throttle ?? NO_THROTTLE;
  const maxRetries = Math.max(0, options.maxRetries ?? 2);
  const maxRetryDelayMs = Math.max(0, options.maxRetryDelayMs ?? 5_000);
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const url = `${torobShopApiBaseUrl(env)}${call_.path}`;

  for (let attempt = 0; ; attempt += 1) {
    await throttle.take();
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: call_.method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(call_.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(call_.body === undefined ? {} : { body: JSON.stringify(call_.body) }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      });
    } catch (error) {
      const timedOut = (error as { name?: string }).name === "TimeoutError";
      throw new TorobShopApiError(timedOut ? "timeout" : "provider_error", String(error));
    }

    if (response.status === 429 && attempt < maxRetries) {
      // The document's own remedy: back off and retry, since the limit is per
      // second and a retry a moment later is usually fine. A `Retry-After` in
      // seconds is honoured up to a cap, so a provider asking for an hour cannot
      // park a request handler for an hour.
      const header = Number(response.headers.get("retry-after") ?? "");
      const delay = Number.isFinite(header) && header > 0 ? Math.min(header * 1000, maxRetryDelayMs) : 250 * (attempt + 1);
      await sleep(delay);
      continue;
    }

    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!response.ok) throw toFailure(response.status, parsed);
    if (parsed === null) throw new TorobShopApiError("invalid_response", "empty body");
    return parsed;
  }
}

/** A summary in this platform's shape, refusing anything the document does not describe. */
function toSummary(value: unknown): TorobProductSummary {
  const row = asRecord(value);
  const errors = Array.isArray(row.not_accessible_errors) ? row.not_accessible_errors : [];
  return {
    calculatedAt: isoOrNull(row.calculated_at),
    total: numberOrZero(row.total),
    available: numberOrZero(row.available),
    notAvailable: numberOrZero(row.not_available),
    notAccessible: numberOrZero(row.not_accessible),
    notActive: numberOrZero(row.not_active),
    deleted: numberOrZero(row.deleted),
    notAccessibleErrors: errors
      .map((entry) => asRecord(entry))
      .filter((entry) => typeof entry.error_title === "string")
      .map((entry) => ({ errorTitle: String(entry.error_title), count: numberOrZero(entry.count) }))
      .sort((a, b) => b.count - a.count),
  };
}

/**
 * `GET /shop/` — the shop's status on Torob and its product summary.
 *
 * The right way to check a credential: it is the cheapest call, and its answer
 * says whether the token works at all.
 */
export async function readTorobShopInfo(options: TorobShopApiOptions): Promise<TorobShopInfo> {
  const domain = options.domain.trim().toLowerCase();
  const body = asRecord(
    await call(options, { method: "GET", path: `shop/?domain=${encodeURIComponent(domain)}` }),
  );

  const status = String(body.shop_status ?? "");
  if (!(TOROB_SHOP_STATUSES as readonly string[]).includes(status)) {
    throw new TorobShopApiError("invalid_response", `unknown shop_status ${status || "(missing)"}`);
  }
  if (!body.product_summary || typeof body.product_summary !== "object") {
    throw new TorobShopApiError("invalid_response", "missing product_summary");
  }

  return {
    domain: typeof body.domain === "string" && body.domain ? body.domain : domain,
    name: typeof body.name === "string" ? body.name : "",
    shopStatus: status as TorobShopStatus,
    summary: toSummary(body.product_summary),
  };
}

/** The `cursor` out of a `next`/`previous` link, or null. Never the link itself. */
export function cursorFromLink(link: unknown): string | null {
  if (typeof link !== "string" || !link) return null;
  try {
    const url = new URL(link);
    return url.searchParams.get("cursor");
  } catch {
    return null;
  }
}

function toProduct(value: unknown): { product: TorobShopProduct; unknownStatuses: number } {
  const row = asRecord(value);
  const pageUnique = typeof row.product_id === "string" ? row.product_id : "";
  if (!pageUnique) throw new TorobShopApiError("invalid_response", "product without product_id");
  if (!Array.isArray(row.statuses)) throw new TorobShopApiError("invalid_response", "product without statuses");

  const raw = row.statuses.filter((entry): entry is string => typeof entry === "string");
  const statuses = raw.filter((entry) => KNOWN_STATUSES.has(entry)) as TorobProductStatus[];
  const price = typeof row.price === "number" && Number.isFinite(row.price) && row.price >= 0 ? row.price : null;

  return {
    product: {
      pageUnique,
      statuses,
      mainStatus: statuses[0] ?? null,
      priceToman: price,
      availability: typeof row.availability === "boolean" ? row.availability : null,
      errorTitle: typeof row.error_title === "string" && row.error_title ? row.error_title : null,
      torobUpdatedAt: isoOrNull(row.updated_at),
      pageUrl: typeof row.page_url === "string" && row.page_url ? row.page_url : null,
    },
    unknownStatuses: raw.length - statuses.length,
  };
}

/**
 * `POST /products/` — the shop's pages as Torob sees them, cursor by cursor.
 *
 * The same body goes to every page, as the document instructs. `maxPages` bounds
 * the loop; when it is reached with pages remaining the scan is `truncated`, and a
 * caller must not read a missing product as "Torob does not have it".
 */
export async function listTorobProducts(
  options: TorobShopApiOptions & {
    status?: TorobProductStatus | "no_problem";
    updatedSince?: string;
    productIds?: readonly string[];
    pageSize?: number;
    maxPages?: number;
  },
): Promise<TorobProductScan> {
  const domain = options.domain.trim().toLowerCase();
  const pageSize = Math.min(
    Math.max(1, options.pageSize ?? TOROB_SHOP_API_PAGE_SIZE),
    500,
  );
  const maxPages = Math.max(1, options.maxPages ?? TOROB_SHOP_API_MAX_PAGES);
  const filter = {
    ...(options.productIds && options.productIds.length > 0 ? { product_ids: [...options.productIds] } : {}),
    ...(options.status ? { status: options.status } : {}),
    ...(options.updatedSince ? { updated_since: options.updatedSince } : {}),
  };

  const products: TorobShopProduct[] = [];
  let unknownStatuses = 0;
  let pages = 0;
  let cursor: string | null = null;
  let truncated = false;

  for (;;) {
    if (pages >= maxPages) {
      truncated = true;
      break;
    }
    const query = new URLSearchParams({ domain, page_size: String(pageSize) });
    if (cursor) query.set("cursor", cursor);
    const body = asRecord(
      await call(options, { method: "POST", path: `products/?${query.toString()}`, body: filter }),
    );
    const results = Array.isArray(body.results) ? body.results : null;
    if (!results) throw new TorobShopApiError("invalid_response", "missing results");

    for (const entry of results) {
      const parsed = toProduct(entry);
      products.push(parsed.product);
      unknownStatuses += parsed.unknownStatuses;
    }
    pages += 1;

    // The link is never followed — only its cursor is taken (see the file header).
    cursor = cursorFromLink(body.next);
    if (!cursor) break;
  }

  return { products, pages, truncated, unknownStatuses };
}
