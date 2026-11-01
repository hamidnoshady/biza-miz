/**
 * Issue #894 Wave 3 — the publicly reachable **Product API v3** endpoint.
 *
 * Torob pulls; it does not push. Every active, authorized, enabled shop therefore
 * needs an address Torob can `POST` to, and this is the platform-hosted one — the
 * "explicitly supported hosted endpoint" the issue allows, and the same contract
 * the WordPress plugin and the CMS runtime serve from their own deployments.
 *
 * The order of operations is the security model, so it is worth stating:
 *
 *   1. **Rate limit by shop, before any work.** The key is the path's opaque id,
 *      so one shop's crawl cannot spend another shop's budget, and a flood is
 *      refused before a database round trip.
 *   2. **Resolve the shop before any tenant scope exists.** The id in the path is
 *      not a slug and does not name a domain. The lookup runs under one documented
 *      bypass reason and returns the row's `business_id`, which is the only way to
 *      know whose catalogue this request is about. Everything after it runs inside
 *      that tenant's scope.
 *   3. **Refuse anything not publishable at all** — missing, unauthorized, switched
 *      off, or whose website is gone — with a plain 404. An unauthorized shop must
 *      not be discoverable through this endpoint, so it answers exactly like an
 *      unknown id.
 *   4. **Verify Torob's JWT against *this shop's* stored domain.** The audience is
 *      read from the shop record, never from the request's `Host` header: that is
 *      the difference between "the token names this shop" and "the caller says it
 *      does".
 *   5. **Only then parse the body**, strictly, and answer in Torob's envelope.
 *
 * Nothing here decides what a product is: `feed-service` reads the catalogue and
 * `feed.ts` decides what may be published, so this file cannot invent a listing.
 */
import { query, withTenant, withoutTenantScope } from "../db";
import { torobAuthHeaders, verifyTorobToken, type TorobAuthResult } from "./auth";
import {
  TOROB_API_VERSION,
  TOROB_REQUEST_ERROR_MESSAGE,
  maxPages,
  parseTorobRequest,
  type TorobRequest,
  type TorobRequestError,
  type TorobV3Response,
} from "./contract";
import { lookupTorobProducts, torobFeedPage, torobPageResponse } from "./feed";
import { buildServedFeed, resolveServeableShop } from "./feed-service";

/**
 * The bypass reason recorded for the shop lookup.
 *
 * Same shape as `woocommerce-webhook-auth`: the request arrives with no session and
 * the URL id is the only thing that names the tenant, so the lookup has to happen
 * before a tenant scope exists. Every statement after it runs inside that tenant.
 */
const AUTH_BYPASS_REASON = "torob-product-api-auth";

/** How many requests one shop may receive per second. */
export const TOROB_SHOP_LIMIT = 5;
export const TOROB_SHOP_WINDOW_MS = 1_000;

/**
 * A fixed window of `{ count, windowStart }` per shop.
 *
 * Per-process, like the middleware's other buckets: the point is to stop one
 * crawler stampeding the database, not to account for the traffic. A crawler that
 * spreads across instances still cannot exceed the shop's rate by more than the
 * instance count, and Torob's own fetcher is single-sourced.
 */
const shopWindows = new Map<string, { count: number; windowStart: number }>();

/** Whether this shop may be served one more request now. Exported for tests. */
export function allowTorobShopRequest(shopId: string, now: number = Date.now()): boolean {
  const current = shopWindows.get(shopId);
  if (!current || now - current.windowStart >= TOROB_SHOP_WINDOW_MS) {
    shopWindows.set(shopId, { count: 1, windowStart: now });
    // Bound the map: a hundred thousand dead shops must not be a leak.
    if (shopWindows.size > 1_000) {
      for (const [key, entry] of shopWindows) {
        if (now - entry.windowStart >= TOROB_SHOP_WINDOW_MS) shopWindows.delete(key);
      }
    }
    return true;
  }
  if (current.count >= TOROB_SHOP_LIMIT) return false;
  current.count += 1;
  return true;
}

/** Forget all windows (tests, and the desktop's long-lived process). */
export function resetTorobShopWindows(): void {
  shopWindows.clear();
}

export type ProductApiOutcome =
  | { status: 200; body: TorobV3Response }
  | { status: 400 | 401 | 404 | 413 | 429 | 500; body: { error: string } };

const NOT_FOUND: ProductApiOutcome = { status: 404, body: { error: "not_found" } };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The `business_id` this shop belongs to, read with no tenant scope yet. */
async function shopOwner(shopId: string): Promise<string | null> {
  if (!UUID.test(shopId)) return null;
  return withoutTenantScope(AUTH_BYPASS_REASON, async () => {
    const { rows } = await query<{ business_id: string }>(
      `SELECT business_id FROM torob_shops WHERE id = $1`,
      [shopId],
    );
    return rows[0]?.business_id ?? null;
  });
}

/** The auth failure, as Torob reads it: a 401 and a reason code. */
function unauthorized(result: Extract<TorobAuthResult, { ok: false }>): ProductApiOutcome {
  return { status: 401, body: { error: `unauthorized: ${result.reason}` } };
}

function badRequest(error: TorobRequestError): ProductApiOutcome {
  // The message comes from the contract's own table, because Torob's examples show
  // `{ error: "sort parameter is not provided" }` — a sentence, not a code.
  return { status: 400, body: { error: TOROB_REQUEST_ERROR_MESSAGE[error] } };
}

/**
 * Answer one Product API v3 request.
 *
 * Takes the raw headers and an already-read body so the route stays a thin adapter
 * — and so this whole flow is testable without a request object or a server.
 */
export async function handleTorobProductRequest(input: {
  shopId: string;
  headers: Headers;
  rawBody: string;
  now?: number;
}): Promise<ProductApiOutcome> {
  if (!allowTorobShopRequest(input.shopId, input.now)) {
    return { status: 429, body: { error: "too_many_requests" } };
  }

  const businessId = await shopOwner(input.shopId);
  if (!businessId) return NOT_FOUND;

  return withTenant(businessId, async () => {
    const resolved = await resolveServeableShop({ businessId, shopId: input.shopId });
    // Not authorized, switched off, website gone: indistinguishable from an id that
    // does not exist, because a shop that may not be served must not be
    // discoverable.
    if (resolved.status === "blocked") return NOT_FOUND;

    // Authenticate before reading the catalogue, so an unauthenticated caller
    // cannot make the platform assemble one.
    const auth = await verifyTorobToken({
      ...torobAuthHeaders(input.headers),
      // The audience is the shop's own domain from the database — never `Host`.
      expectedHost: resolved.shop.domain,
      ...(input.now === undefined ? {} : { now: new Date(input.now) }),
    });
    if (!auth.ok) return unauthorized(auth);

    let body: unknown;
    try {
      body = JSON.parse(input.rawBody);
    } catch {
      return { status: 400, body: { error: "request body must be JSON" } };
    }

    const parsed = parseTorobRequest(body);
    if (!parsed.ok) return badRequest(parsed.error);

    const built = await buildServedFeed(resolved.shop);
    if (!built) return NOT_FOUND;
    return serve(built, parsed.request);
  });
}

/** The answer to an authenticated, well-formed request. */
function serve(built: Parameters<typeof lookupTorobProducts>[0], request: TorobRequest): ProductApiOutcome {
  if (request.mode === "page_urls" || request.mode === "page_uniques") {
    const found = lookupTorobProducts(built, request);
    // A withdrawn product is *absent*: the document answers a direct lookup of a
    // removed product with an empty list, not a 404 and not a stub.
    return {
      status: 200,
      body: {
        api_version: TOROB_API_VERSION,
        current_page: 1,
        total: found.length,
        max_pages: maxPages(found.length),
        next_cursor: null,
        products: found,
      },
    };
  }

  return { status: 200, body: torobPageResponse(torobFeedPage(built, request)) };
}

/**
 * The largest body Torob can legitimately send.
 *
 * 100 `page_urls`, each up to the document's 1 500-character field limit, is
 * 150 KB of URLs alone; 256 KB leaves room for the JSON around them without being
 * an amount of memory a stranger can ask the process to hold.
 */
export const TOROB_MAX_BODY_BYTES = 256 * 1024;

/** Refuse an oversized body before reading it into memory. */
export function bodyTooLarge(contentLength: string | null): boolean {
  if (!contentLength) return false;
  const length = Number(contentLength);
  return Number.isFinite(length) && length > TOROB_MAX_BODY_BYTES;
}
