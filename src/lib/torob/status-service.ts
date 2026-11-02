/**
 * Issue #894 Wave 4b — reading a shop back from Torob, and storing what it said.
 *
 * `shop-api-client.ts` is the wire; this file is the decision around it: whether a
 * shop may be read at all, which credential reads it, what a failure does to the
 * stored snapshot, and how a scan becomes the `torob_product_states` table. Four
 * rules, each one a way an "observed state" surface lies:
 *
 *   1. **A read never changes Torob.** Every call here is `GET /shop/` or
 *      `POST /products/` (a read, despite the verb). So the endpoint that
 *      triggers it is `torob.view`, exactly like «پیش‌نمایش فید», and nothing in
 *      this file may be called from the crawler's request path.
 *   2. **A failure does not erase the last answer.** `observed_at` moves only on
 *      success, and the failure is written beside it: a screen then says "this is
 *      what Torob said on Tuesday, and today's read failed" — which is true —
 *      instead of showing an empty panel that looks like a shop with no products.
 *   3. **Absence only means something after a complete scan.** Torob does not
 *      return removed pages, so a complete scan replaces the shop's rows; a
 *      truncated one (more pages than one refresh reads) writes nothing away,
 *      because a product missing from page 21 of 40 has not been deleted.
 *   4. **Disconnected means stop.** A shop that is not authorized, or whose
 *      channel is off, is not read at all — the issue's "disconnect stops
 *      background operations" applies to reads as much as to sends, and a channel
 *      switch that still talks to Torob every hour is not off.
 *
 * The credential follows the shop's own mode: a merchant token is decrypted for
 * the length of one request, and the partner token is used only when the shop was
 * authorized through the Shop Generator flow. A shop with neither is a readable
 * failure (`not_configured`), not an exception.
 */
import { query, withTenantTransaction } from "../db";
import { productIdFromPageUnique } from "./observed-state";
import {
  createShopApiThrottle,
  listTorobProducts,
  readTorobShopInfo,
  TorobShopApiError,
  type ShopApiThrottle,
  type TorobProductScan,
} from "./shop-api-client";
import { torobPartnerToken } from "./shop-generator";
import { webhookCapability } from "./webhook-service";
import { readTorobShop, readTorobShopToken, TorobShopError } from "./shop-service";
import type {
  TorobObservation,
  TorobObservationBrief,
  TorobObservationError,
  TorobProductState,
  TorobProductStatus,
  TorobProductSummary,
  TorobShopStatus,
  TorobShopStatusView,
  TorobStatusCount,
  TorobStatusRun,
} from "./observed-state";
import { TOROB_PRODUCT_STATUSES } from "./observed-state";

/** What one refresh did. */
export type ObserveResult =
  | {
      status: "observed";
      observation: TorobObservation;
      productsSeen: number;
      productsWithProblem: number;
      truncated: boolean;
      unknownStatuses: number;
    }
  | { status: "failed"; error: TorobObservationError };

interface ObservationRow extends Record<string, unknown> {
  id: string;
  domain: string;
  website_kind: "woocommerce" | "eshobe_cms";
  authorization_state: TorobShopStatusView["shop"]["authorizationState"];
  auth_mode: "partner" | "manual_token";
  enabled: boolean;
  observed_status: TorobShopStatus | null;
  observed_summary: unknown;
  observed_at: Date | null;
  observed_error: TorobObservationError | null;
}

async function readObservationRow(businessId: string, shopId: string): Promise<ObservationRow | null> {
  const { rows } = await query<ObservationRow>(
    `SELECT id, domain, website_kind, authorization_state, auth_mode, enabled,
            observed_status, observed_summary, observed_at, observed_error
       FROM torob_shops WHERE id = $1 AND business_id = $2`,
    [shopId, businessId],
  );
  return rows[0] ?? null;
}

const iso = (value: unknown): string | null =>
  value instanceof Date ? value.toISOString() : value ? new Date(String(value)).toISOString() : null;

/** The stored summary, as our own shape. Never trusted blindly: it is JSON we wrote. */
function toStoredSummary(value: unknown): TorobProductSummary {
  const row = (value ?? {}) as Record<string, unknown>;
  const count = (key: string) => (typeof row[key] === "number" ? (row[key] as number) : 0);
  const errors = Array.isArray(row.notAccessibleErrors) ? row.notAccessibleErrors : [];
  return {
    calculatedAt: typeof row.calculatedAt === "string" ? row.calculatedAt : null,
    total: count("total"),
    available: count("available"),
    notAvailable: count("notAvailable"),
    notAccessible: count("notAccessible"),
    notActive: count("notActive"),
    deleted: count("deleted"),
    notAccessibleErrors: errors
      .map((entry) => entry as Record<string, unknown>)
      .filter((entry) => typeof entry.errorTitle === "string")
      .map((entry) => ({
        errorTitle: String(entry.errorTitle),
        count: typeof entry.count === "number" ? entry.count : 0,
      })),
  };
}

/** The stored observation, or `null` when Torob has never answered for this shop. */
function toObservation(row: ObservationRow): TorobObservation | null {
  if (!row.observed_status || !row.observed_at) return null;
  return {
    shopStatus: row.observed_status,
    summary: toStoredSummary(row.observed_summary),
    observedAt: row.observed_at.toISOString(),
    error: row.observed_error,
  };
}

/** Status counts for one shop, in Torob's own priority order. */
async function readStatusCounts(
  businessId: string,
  shopId: string,
): Promise<{ total: number; withProblem: number; byStatus: TorobStatusCount[] }> {
  const { rows } = await query<{ main_status: string | null; count: string }>(
    `SELECT main_status, count(*)::text AS count
       FROM torob_product_states
      WHERE business_id = $1 AND shop_id = $2
      GROUP BY main_status`,
    [businessId, shopId],
  );
  const counts = new Map<string, number>();
  let total = 0;
  for (const row of rows) {
    const count = Number(row.count);
    total += count;
    if (row.main_status) counts.set(row.main_status, count);
  }
  const byStatus = TOROB_PRODUCT_STATUSES.filter((status) => counts.has(status)).map((status) => ({
    status,
    count: counts.get(status) ?? 0,
  }));
  return {
    total,
    withProblem: byStatus.reduce((sum, entry) => sum + entry.count, 0),
    byStatus,
  };
}

async function readLatestRun(businessId: string, shopId: string): Promise<TorobStatusRun | null> {
  const { rows } = await query<{
    outcome: "observed" | "failed";
    shop_status: TorobShopStatus | null;
    products_seen: number;
    products_with_problem: number;
    truncated: boolean;
    error: TorobObservationError | null;
    finished_at: Date;
  }>(
    `SELECT outcome, shop_status, products_seen, products_with_problem, truncated, error, finished_at
       FROM torob_status_runs
      WHERE business_id = $1 AND shop_id = $2
      ORDER BY finished_at DESC
      LIMIT 1`,
    [businessId, shopId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    outcome: row.outcome,
    shopStatus: row.shop_status,
    productsSeen: row.products_seen,
    productsWithProblem: row.products_with_problem,
    truncated: row.truncated,
    error: row.error,
    finishedAt: row.finished_at.toISOString(),
  };
}

/**
 * The panel's read — **no network**.
 *
 * Opening the page must not call Torob: the provider's limit is per shop and the
 * numbers are not live anyway. A refresh is the merchant's explicit button, which
 * is why it is a `POST`.
 */
export async function readShopObservation(input: {
  businessId: string;
  shopId: string;
}): Promise<TorobShopStatusView | null> {
  const row = await readObservationRow(input.businessId, input.shopId);
  if (!row) return null;
  const [states, latestRun, webhook] = await Promise.all([
    readStatusCounts(input.businessId, input.shopId),
    readLatestRun(input.businessId, input.shopId),
    webhookCapability({ businessId: input.businessId, shopId: input.shopId }),
  ]);
  const observation = toObservation(row);
  return {
    shop: {
      id: row.id,
      domain: row.domain,
      kind: row.website_kind,
      authorizationState: row.authorization_state,
      authMode: row.auth_mode,
      enabled: row.enabled,
    },
    observation,
    states,
    latestRun,
    // The three stages, each answered by the thing that can prove it: `sent` is a
    // webhook batch Torob accepted into its queue (§6f), and `listing` is Torob's
    // own observation — never the queue, which says nothing about being displayed.
    webhook,
    capabilities: { feed: true, sent: webhook.sent, listing: observation !== null },
  };
}

/**
 * Every shop's observation in one read, for the multi-shop section.
 *
 * One query rather than one per shop: the section renders while a merchant is
 * looking at it, and a dozen round trips to draw a dozen lines is how a page
 * becomes slow for a reason nobody can see. It reads only our own tables — the
 * overview never calls Torob either.
 */
export async function readObservationOverview(businessId: string): Promise<TorobObservationBrief[]> {
  const { rows } = await query<{
    id: string;
    observed_status: TorobShopStatus | null;
    observed_at: Date | null;
    observed_error: TorobObservationError | null;
    total: string | null;
    pages: string;
    with_problem: string;
  }>(
    `SELECT s.id,
            s.observed_status,
            s.observed_at,
            s.observed_error,
            s.observed_summary->>'total' AS total,
            COALESCE(p.pages, 0)::text AS pages,
            COALESCE(p.with_problem, 0)::text AS with_problem
       FROM torob_shops s
       LEFT JOIN (
         SELECT shop_id,
                count(*) AS pages,
                count(*) FILTER (WHERE main_status IS NOT NULL) AS with_problem
           FROM torob_product_states
          WHERE business_id = $1
          GROUP BY shop_id
       ) p ON p.shop_id = s.id
      WHERE s.business_id = $1
      ORDER BY s.created_at`,
    [businessId],
  );

  return rows.map((row) => ({
    shopId: row.id,
    shopStatus: row.observed_status,
    pages: Number(row.pages),
    withProblem: Number(row.with_problem),
    total: row.total === null ? 0 : Number(row.total),
    observedAt: iso(row.observed_at),
    error: row.observed_error,
  }));
}

/**
 * Every page's Torob status for one shop, keyed by catalogue product id.
 *
 * Keyed by product rather than page because the per-shop screen has one row per
 * catalogue product; a product whose variants Torob splits into several pages
 * takes the first of them in Torob's own priority order, and the row also carries
 * how many pages it has so a screen can say «۳ صفحه» rather than pretending one.
 */
export async function readProductTorobStates(input: {
  businessId: string;
  shopId: string;
}): Promise<Map<string, { mainStatus: TorobProductStatus | null; pages: number }>> {
  const { rows } = await query<{ product_id: string; main_status: TorobProductStatus | null; count: string }>(
    `SELECT product_id, main_status, count(*)::text AS count
       FROM torob_product_states
      WHERE business_id = $1 AND shop_id = $2 AND product_id IS NOT NULL
      GROUP BY product_id, main_status`,
    [input.businessId, input.shopId],
  );

  const rank = new Map<string, number>(TOROB_PRODUCT_STATUSES.map((status, index) => [status, index]));
  const states = new Map<string, { mainStatus: TorobProductStatus | null; pages: number }>();
  for (const row of rows) {
    const pages = Number(row.count);
    const current = states.get(row.product_id);
    const candidate = row.main_status;
    const better =
      !current ||
      (candidate !== null &&
        (current.mainStatus === null || (rank.get(candidate) ?? 0) < (rank.get(current.mainStatus) ?? 0)));
    states.set(row.product_id, {
      mainStatus: better ? candidate : current.mainStatus,
      pages: (current?.pages ?? 0) + pages,
    });
  }
  return states;
}

/** One page's stored statuses, for the diagnostics list. */
export async function readProblemStates(input: {
  businessId: string;
  shopId: string;
  limit?: number;
}): Promise<TorobProductState[]> {
  const { rows } = await query<{
    page_unique: string;
    product_id: string | null;
    statuses: string[];
    main_status: TorobProductStatus;
    price_toman: string | null;
    availability: boolean | null;
    error_title: string | null;
    torob_updated_at: Date | null;
    observed_at: Date;
  }>(
    `SELECT page_unique, product_id, statuses, main_status, price_toman, availability,
            error_title, torob_updated_at, observed_at
       FROM torob_product_states
      WHERE business_id = $1 AND shop_id = $2 AND main_status IS NOT NULL
      ORDER BY error_title NULLS LAST, page_unique
      LIMIT $3`,
    [input.businessId, input.shopId, Math.min(Math.max(1, input.limit ?? 20), 100)],
  );
  return rows.map((row) => ({
    pageUnique: row.page_unique,
    productId: row.product_id,
    statuses: row.statuses as TorobProductStatus[],
    mainStatus: row.main_status,
    priceToman: row.price_toman === null ? null : Number(row.price_toman),
    availability: row.availability,
    errorTitle: row.error_title,
    torobUpdatedAt: iso(row.torob_updated_at),
    observedAt: row.observed_at.toISOString(),
  }));
}

/**
 * Read one shop from Torob and store what it said.
 *
 * Blocked cases are recorded as failed runs rather than thrown: the merchant
 * pressed a button and deserves a reason on the page they are looking at.
 */
export async function observeTorobShop(input: {
  businessId: string;
  shopId: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  throttle?: ShopApiThrottle;
  maxPages?: number;
}): Promise<ObserveResult> {
  const shop = await readTorobShop({ businessId: input.businessId, shopId: input.shopId });
  if (!shop) throw new TorobShopError("shop_not_found");

  const startedAt = new Date();
  const fail = async (error: TorobObservationError): Promise<ObserveResult> => {
    await recordFailure(input.businessId, input.shopId, error, startedAt);
    return { status: "failed", error };
  };

  // Rule 4: a channel that is off is not read, and an unauthorized shop has
  // nothing to read with. Both are answered before any network call.
  if (shop.authorizationState !== "authorized") return fail("not_authorized");
  if (!shop.enabled) return fail("channel_disabled");

  const credential = await readTorobShopToken({ businessId: input.businessId, shopId: input.shopId });
  const env = input.env ?? process.env;
  // Manual mode carries the merchant's own token; partner mode authenticates with
  // the platform's generator token and names the shop by `domain`.
  const token = credential?.token?.trim() ? credential.token.trim() : (torobPartnerToken(env) ?? "");
  if (!token) return fail("not_configured");

  const options = {
    token,
    domain: shop.domain,
    env,
    fetchImpl: input.fetchImpl,
    // One gate for the whole refresh: the limit is per shop across every Shop API
    // endpoint, so a fresh throttle per call would be a burst by construction.
    throttle: input.throttle ?? createShopApiThrottle(),
  };

  try {
    const info = await readTorobShopInfo(options);
    const scan = await listTorobProducts({ ...options, maxPages: input.maxPages });

    const observedAt = new Date();
    const observation: TorobObservation = {
      shopStatus: info.shopStatus,
      summary: info.summary,
      observedAt: observedAt.toISOString(),
      error: null,
    };

    await storeObservation({
      businessId: input.businessId,
      shopId: input.shopId,
      observation,
      observedAt,
      scan,
    });

    return {
      status: "observed",
      observation,
      productsSeen: scan.products.length,
      productsWithProblem: scan.products.filter((product) => product.mainStatus !== null).length,
      truncated: scan.truncated,
      unknownStatuses: scan.unknownStatuses,
    };
  } catch (caught) {
    if (caught instanceof TorobShopApiError) return fail(caught.code);
    return fail("provider_error");
  }
}

/**
 * Write one successful read.
 *
 * The shop's columns, the page rows and the run row move together: a summary that
 * claims 900 products beside 12 page rows would be a screen contradicting itself,
 * so the three writes happen in one transaction on the caller's tenant scope.
 */
async function storeObservation(input: {
  businessId: string;
  shopId: string;
  observation: TorobObservation;
  observedAt: Date;
  scan: TorobProductScan;
}): Promise<void> {
  const { products, truncated } = input.scan;

  // Page rows: one per page Torob reports, with the catalogue link derived from
  // `page_unique` (the uuid prefix; `null` when the id is not one of ours).
  const rows = products.map((product) => ({
    page_unique: product.pageUnique,
    product_id: productIdFromPageUnique(product.pageUnique),
    statuses: product.statuses,
    main_status: product.mainStatus,
    price_toman: product.priceToman,
    availability: product.availability,
    error_title: product.errorTitle,
    torob_updated_at: product.torobUpdatedAt,
  }));
  const withProblem = products.filter((product) => product.mainStatus !== null).length;

  await withTenantTransaction(input.businessId, async () => {
    await query(
      `UPDATE torob_shops
          SET observed_status = $3,
              observed_summary = $4::jsonb,
              observed_at = $5,
              observed_error = NULL,
              last_checked_at = now(),
              health = 'healthy',
              health_reason = NULL,
              updated_at = now()
        WHERE id = $1 AND business_id = $2`,
      [
        input.shopId,
        input.businessId,
        input.observation.shopStatus,
        JSON.stringify(input.observation.summary),
        input.observedAt,
      ],
    );

    if (rows.length > 0) {
      await query(
        `INSERT INTO torob_product_states
           (business_id, shop_id, page_unique, product_id, statuses, main_status,
            price_toman, availability, error_title, torob_updated_at, observed_at)
         SELECT $1, $2, s.page_unique, s.product_id, COALESCE(s.statuses, '{}'), s.main_status,
                s.price_toman, s.availability, s.error_title, s.torob_updated_at, $4
           FROM jsonb_to_recordset($3::jsonb) AS s(
             page_unique text, product_id uuid, statuses text[], main_status text,
             price_toman bigint, availability boolean, error_title text, torob_updated_at timestamptz
           )
         ON CONFLICT (business_id, shop_id, page_unique) DO UPDATE
            SET product_id = EXCLUDED.product_id,
                statuses = EXCLUDED.statuses,
                main_status = EXCLUDED.main_status,
                price_toman = EXCLUDED.price_toman,
                availability = EXCLUDED.availability,
                error_title = EXCLUDED.error_title,
                torob_updated_at = EXCLUDED.torob_updated_at,
                observed_at = EXCLUDED.observed_at`,
        [input.businessId, input.shopId, JSON.stringify(rows), input.observedAt],
      );
    }

    // Rule 3: only a complete scan may conclude that a page is gone. A full scan of
    // an empty shop deletes every row, which is exactly right.
    if (!truncated) {
      await query(
        `DELETE FROM torob_product_states
          WHERE business_id = $1 AND shop_id = $2
            AND NOT (page_unique = ANY($3::text[]))`,
        [input.businessId, input.shopId, products.map((product) => product.pageUnique)],
      );
    }

    await query(
      `INSERT INTO torob_status_runs
         (business_id, shop_id, outcome, shop_status, products_seen, products_with_problem,
          truncated, error, started_at, finished_at)
       VALUES ($1, $2, 'observed', $3, $4, $5, $6, NULL, $7, $8)`,
      [
        input.businessId,
        input.shopId,
        input.observation.shopStatus,
        products.length,
        withProblem,
        truncated,
        input.observedAt,
        input.observedAt,
      ],
    );
  });
}

/**
 * Record a failed attempt and move the shop's health with it.
 *
 * `observed_at` deliberately does **not** move: the summary it belongs to is still
 * the last thing Torob said, and the screen shows that date beside the failure.
 */
async function recordFailure(
  businessId: string,
  shopId: string,
  error: TorobObservationError,
  startedAt: Date,
): Promise<void> {
  await withTenantTransaction(businessId, async () => {
    await query(
      `UPDATE torob_shops
          SET observed_error = $3,
              last_checked_at = now(),
              health = 'attention',
              health_reason = $3,
              updated_at = now()
        WHERE id = $1 AND business_id = $2`,
      [shopId, businessId, error],
    );
    await query(
      `INSERT INTO torob_status_runs
         (business_id, shop_id, outcome, shop_status, products_seen, products_with_problem,
          truncated, error, started_at, finished_at)
       VALUES ($1, $2, 'failed', NULL, 0, 0, false, $3, $4, now())`,
      [businessId, shopId, error, startedAt],
    );
  });
}
