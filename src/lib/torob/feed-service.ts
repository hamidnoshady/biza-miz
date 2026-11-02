/**
 * Issue #894 Wave 2 — the database half of the product feed.
 *
 * `feed.ts` decides what a Torob item is; `currency.ts` decides what a price is.
 * This file answers the only question left: **what is in this shop's catalogue
 * right now**, and it records every answer it gives.
 *
 * Three rules, each of which is a way a feed goes wrong:
 *
 *   1. **The shop must be publishable.** A feed is built for an authorized,
 *      enabled shop whose website still exists and is still the one it was
 *      connected to. Anything else is recorded as `blocked` with a reason, never
 *      as an empty feed — an empty feed looks like a shop with no products, and
 *      the merchant would go looking for the wrong problem.
 *   2. **The price is the tenant's own selling price, in the site's currency.**
 *      The catalogue is `menu_items.price` (integer Rial, the canonical column
 *      since issue #844's price service), and the currency is whatever the
 *      *website's* registry says its storefront prices in — WooCommerce's
 *      `currency_unit` or the CMS's `site_currency`. The two vocabularies meet in
 *      `currency.ts` and nowhere else.
 *   3. **Every build is a row.** `torob_feed_runs` records the counts and the
 *      skip reasons, because "why is this product missing from Torob" must be
 *      answerable without re-running anything. The row says the feed was *built*;
 *      it never says Torob accepted it, which is the distinction the whole issue
 *      is about.
 *
 * Wave 2 builds the feed; serving it to a crawler is Wave 3's runtime, which is
 * why nothing here mints a public URL token yet.
 */
import { query } from "../db";
import {
  buildTorobFeed,
  summariseFeed,
  torobFeedPage,
  torobPageResponse,
  type BuiltFeed,
  type CatalogueProduct,
  type FeedSummary,
} from "./feed";
import type { TorobV3Response } from "./contract";
import { isPublishedByRule, type TorobDecision } from "./publication";
import { TorobShopError, type TorobShop } from "./shop-service";
import { DEFAULT_PRODUCT_PATH, type TorobWebsiteKind } from "./eligibility";

/** Why a shop cannot have a feed at all. Closed vocabulary, merchant-readable. */
export type TorobFeedBlockedReason =
  | "shop_not_found"
  | "not_authorized"
  | "channel_disabled"
  | "website_missing"
  | "website_inactive";

export const TOROB_FEED_BLOCKED_COPY: Readonly<Record<TorobFeedBlockedReason, string>> = {
  shop_not_found: "این فروشگاه ترب پیدا نشد.",
  not_authorized: "اجازهٔ انتشار این فروشگاه از سوی ترب صادر نشده است.",
  channel_disabled: "انتشار این فروشگاه خاموش است.",
  website_missing: "وب‌سایت این فروشگاه دیگر در بیزامیز نیست.",
  website_inactive: "اتصال وب‌سایت این فروشگاه فعال نیست.",
};

export interface FeedBuildResult {
  status: "built" | "blocked";
  blockedReason: TorobFeedBlockedReason | null;
  summary: FeedSummary | null;
  /** The first page in Torob's own envelope, so a caller sees what Torob sees. */
  firstPage: TorobV3Response | null;
  /** The skipped pages, capped — the screen shows the first few and the counts. */
  skipped: BuiltFeed["skipped"];
  builtAt: string;
}

/**
 * The shop row this file reads, plus the two publication columns.
 *
 * The approval-flow columns (`approve_url`, the window's start, the last failure)
 * are deliberately *not* selected here: a feed is built from a shop's publication
 * state, and carrying a one-time approval URL into a code path that only answers
 * "what would we send" would invite it into a log.
 */
export interface ShopRow
  extends Omit<TorobShop, "approveUrl" | "authorizationRequestedAt" | "authorizationError"> {
  publicProductPath: string;
  includeOutOfStock: boolean;
}

const SHOP_COLUMNS = `id, business_id, website_kind, source_connection_id, domain,
  authorization_state, auth_mode, token_hint, provider_shop_id, publication_rule,
  enabled, health, health_reason, last_checked_at, created_at,
  public_product_path, include_out_of_stock`;

function iso(value: unknown): string | null {
  return value instanceof Date ? value.toISOString() : value ? new Date(String(value)).toISOString() : null;
}

function toShopRow(row: Record<string, unknown>): ShopRow {
  return {
    id: String(row.id),
    businessId: String(row.business_id),
    kind: row.website_kind as TorobWebsiteKind,
    connectionId: String(row.source_connection_id),
    domain: String(row.domain),
    authorizationState: row.authorization_state as TorobShop["authorizationState"],
    authMode: row.auth_mode as TorobShop["authMode"],
    tokenHint: (row.token_hint as string | null) ?? null,
    providerShopId: (row.provider_shop_id as string | null) ?? null,
    publicationRule: row.publication_rule as TorobShop["publicationRule"],
    enabled: Boolean(row.enabled),
    health: row.health as TorobShop["health"],
    healthReason: (row.health_reason as string | null) ?? null,
    lastCheckedAt: iso(row.last_checked_at),
    createdAt: iso(row.created_at) ?? new Date(0).toISOString(),
    publicProductPath: String(row.public_product_path ?? DEFAULT_PRODUCT_PATH[row.website_kind as TorobWebsiteKind]),
    includeOutOfStock: Boolean(row.include_out_of_stock ?? true),
  };
}

async function findShop(businessId: string, shopId: string): Promise<ShopRow | null> {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT ${SHOP_COLUMNS} FROM torob_shops WHERE id = $1 AND business_id = $2`,
    [shopId, businessId],
  );
  return rows[0] ? toShopRow(rows[0]) : null;
}

/** Whether the website a shop points at is still there and still active. */
async function websiteState(
  businessId: string,
  shop: ShopRow,
): Promise<"ok" | "missing" | "inactive"> {
  if (shop.kind === "woocommerce") {
    const { rows } = await query<{ status: string }>(
      `SELECT status FROM integration_connections
        WHERE id = $1 AND business_id = $2 AND deleted_at IS NULL`,
      [shop.connectionId, businessId],
    );
    if (!rows[0]) return "missing";
    return rows[0].status === "active" ? "ok" : "inactive";
  }
  const { rows } = await query<{ status: string }>(
    `SELECT status FROM eshobe_cms_connections WHERE id = $1 AND business_id = $2`,
    [shop.connectionId, businessId],
  );
  if (!rows[0]) return "missing";
  return rows[0].status === "active" ? "ok" : "inactive";
}

/**
 * The currency the *storefront* prices in.
 *
 * Not the shop's to decide: the website's registry is the authority, because it
 * is what the storefront's own checkout uses. An unsupported value raises
 * `unsupported_currency` per product rather than being coerced to Rial — see
 * `torobCurrencyFromRegistry`.
 */
async function siteCurrency(businessId: string, shop: ShopRow): Promise<string> {
  if (shop.kind === "woocommerce") {
    const { rows } = await query<{ currency_unit: string }>(
      `SELECT currency_unit FROM integration_connections WHERE id = $1 AND business_id = $2`,
      [shop.connectionId, businessId],
    );
    return rows[0]?.currency_unit ?? "";
  }
  const { rows } = await query<{ site_currency: string }>(
    `SELECT site_currency FROM eshobe_cms_connections WHERE id = $1 AND business_id = $2`,
    [shop.connectionId, businessId],
  );
  return rows[0]?.site_currency ?? "";
}

/** `{id}` and `{sku}` are the only placeholders; everything else is literal. */
export function productPageUrl(domain: string, template: string, product: { id: string; sku: string | null }): string {
  const path = template
    .replaceAll("{id}", encodeURIComponent(product.id))
    .replaceAll("{sku}", encodeURIComponent(product.sku ?? ""));
  if (/^https?:\/\//i.test(path)) return path;
  return `https://${domain}${path.startsWith("/") ? "" : "/"}${path}`;
}

/**
 * One row of the tenant's selling catalogue, before any publication rule.
 *
 * Exported because the per-shop screen lists the same rows the feed is built
 * from: a screen with its own query is a screen that can disagree with the feed
 * about which products exist.
 */
export interface CatalogueRow {
  id: string;
  name: string;
  description: string | null;
  sku: string | null;
  /** The canonical price column, integer Rial — `pg` hands a bigint back as a string. */
  priceRial: string | number;
  imageUrl: string | null;
  /** Published by the storefront at all; `false` is a withdrawn product. */
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
  categoryName: string | null;
}

/**
 * `menu_items` is the canonical selling catalogue (issue #844 made its price the
 * one writers go through), joined to its category for Torob's `category_name`.
 */
async function readCatalogueRows(businessId: string): Promise<CatalogueRow[]> {
  const { rows } = await query<{
    id: string;
    name: string;
    description: string | null;
    sku: string | null;
    price: string | number;
    image_url: string | null;
    is_active: boolean;
    created_at: Date;
    updated_at: Date;
    category_name: string | null;
  }>(
    `SELECT m.id, m.name, m.description, m.sku, m.price, m.image_url, m.is_active,
            m.created_at, m.updated_at, c.name AS category_name
       FROM menu_items m
       JOIN locations l ON l.id = m.location_id
       LEFT JOIN menu_categories c ON c.id = m.category_id
      WHERE l.business_id = $1
      ORDER BY m.id`,
    [businessId],
  );

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    sku: row.sku,
    priceRial: row.price,
    imageUrl: row.image_url,
    active: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    categoryName: row.category_name,
  }));
}

/**
 * The merchant's per-product decisions for one shop.
 *
 * Read for every build, not cached: a merchant toggling a product expects the
 * next crawler request to agree with the screen they just looked at.
 */
async function readDecisions(businessId: string, shopId: string): Promise<Map<string, TorobDecision>> {
  const { rows } = await query<{ product_id: string; decision: TorobDecision }>(
    `SELECT product_id, decision FROM torob_shop_products
      WHERE business_id = $1 AND shop_id = $2`,
    [businessId, shopId],
  );
  return new Map(rows.map((row) => [row.product_id, row.decision]));
}

/** A catalogue row as Torob's input, with the site's currency and storefront route. */
export function toCatalogueProduct(row: CatalogueRow, shop: ShopRow, currency: string): CatalogueProduct {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    url: productPageUrl(shop.domain, shop.publicProductPath, { id: row.id, sku: row.sku }),
    categoryName: row.categoryName,
    imageUrls: row.imageUrl ? [row.imageUrl] : [],
    // `date_added` is required by Torob's contract, and `updated_at` is what
    // `date_updated_desc` sorts on.
    dateAdded: row.createdAt.toISOString(),
    dateUpdated: row.updatedAt.toISOString(),
    // The canonical column, integer Rial. `pg` returns bigint as a string, which
    // is exactly what the converter wants — never a float.
    priceRial: row.priceRial,
    // `is_active` is publication, not stock: a withdrawn product is omitted from
    // the feed entirely, which Torob treats as "removed". Stock is a later wave's
    // input; today every published product is offered (`available: true`).
    sellable: row.active,
    available: true,
    currency,
    sku: row.sku,
  };
}

/** Everything one shop's feed is made of, read once. */
export interface ShopCatalogue {
  shop: ShopRow;
  /** Every catalogue row the business owns, before the rule. */
  rows: CatalogueRow[];
  /** `product_id → decision`; a product the merchant never touched is absent. */
  decisions: Map<string, TorobDecision>;
  /** The storefront's currency, as the website's registry declares it. */
  currency: string;
  /** The rows the shop's rule keeps, already shaped for the feed builder. */
  products: CatalogueProduct[];
  built: BuiltFeed;
  summary: FeedSummary;
}

/**
 * Read a shop's catalogue and build its feed — the single path every caller uses.
 *
 * The merchant's rule and per-product decisions are applied **here**, so the
 * crawler endpoint, the «پیش‌نمایش فید» button and the per-shop screen cannot
 * disagree about what the shop publishes. A product the rule excludes is not in
 * `products` at all, and therefore never appears as a "skipped" product: leaving
 * something out on purpose is a decision, not a failure the screen should nag
 * about.
 *
 * Returns `null` for a shop that is not this business's — the caller decides
 * whether that is a 404 or a redirect.
 */
export async function readShopCatalogue(input: {
  businessId: string;
  shopId: string;
}): Promise<ShopCatalogue | null> {
  const shop = await findShop(input.businessId, input.shopId);
  if (!shop) return null;

  const [currency, rows, decisions] = await Promise.all([
    siteCurrency(input.businessId, shop),
    readCatalogueRows(input.businessId),
    readDecisions(input.businessId, shop.id),
  ]);

  const products = rows
    .filter((row) => isPublishedByRule({ rule: shop.publicationRule, decision: decisions.get(row.id) }))
    .map((row) => toCatalogueProduct(row, shop, currency));

  const built = buildTorobFeed({ products, includeOutOfStock: shop.includeOutOfStock });
  return { shop, rows, decisions, currency, products, built, summary: summariseFeed(built) };
}

/** A shop a crawler may be served from: its own host, and nothing else. */

/**
 * Why this shop cannot publish right now, or `null` when it can.
 *
 * The four states are the issue's own list, in its own order: authorized,
 * enabled, and pointed at a website that is still there and still active.
 */
async function publishBlock(
  businessId: string,
  shop: ShopRow,
): Promise<TorobFeedBlockedReason | null> {
  if (shop.authorizationState !== "authorized") return "not_authorized";
  if (!shop.enabled) return "channel_disabled";
  const website = await websiteState(businessId, shop);
  if (website === "missing") return "website_missing";
  if (website === "inactive") return "website_inactive";
  return null;
}

/** A shop a crawler may be served from: its own host, and nothing else. */
export interface ServeableShop {
  businessId: string;
  shopId: string;
  /** The host Torob's `aud` must name. Read from the row, never from a header. */
  domain: string;
}

/**
 * Whether this shop may be served at all — the check that runs **before** any
 * token, and before any catalogue is read.
 *
 * Split from building the feed on purpose: an unauthenticated caller must not be
 * able to make the platform assemble a 4 000-product catalogue just by posting a
 * uuid. And `blocked` is answered as one flat "not found" by the endpoint, so a
 * caller cannot learn which of the four states the shop is in.
 */
export async function resolveServeableShop(input: {
  businessId: string;
  shopId: string;
}): Promise<{ status: "available"; shop: ServeableShop } | { status: "blocked"; reason: TorobFeedBlockedReason }> {
  const shop = await findShop(input.businessId, input.shopId);
  if (!shop) return { status: "blocked", reason: "shop_not_found" };
  const blocked = await publishBlock(input.businessId, shop);
  if (blocked) return { status: "blocked", reason: blocked };
  return {
    status: "available",
    shop: { businessId: input.businessId, shopId: shop.id, domain: shop.domain },
  };
}

/**
 * The catalogue a crawler reads.
 *
 * Deliberately does **not** write a `torob_feed_runs` row: a run records that the
 * merchant's channel was built, while this is Torob asking for page 7 at 3am. The
 * two are different events, and conflating them would bury the merchant's own
 * refresh in crawler traffic — and put a `created_by` on rows nobody triggered.
 */
export async function buildServedFeed(shop: ServeableShop): Promise<BuiltFeed | null> {
  const catalogue = await readShopCatalogue({ businessId: shop.businessId, shopId: shop.shopId });
  return catalogue?.built ?? null;
}

/**
 * Build one shop's feed and record the build.
 *
 * Returns `blocked` rather than throwing for every "this shop cannot publish
 * right now" case, because the caller is a screen and a screen has to render a
 * reason. A genuinely missing shop still throws `shop_not_found` — that is a bad
 * request, not a state of the world.
 */
export async function buildShopFeed(input: {
  businessId: string;
  shopId: string;
  createdBy?: string | null;
}): Promise<FeedBuildResult> {
  const shop = await findShop(input.businessId, input.shopId);
  if (!shop) throw new TorobShopError("shop_not_found");

  const blocked = async (reason: TorobFeedBlockedReason): Promise<FeedBuildResult> => {
    await recordRun(input.businessId, shop.id, {
      status: "blocked",
      blockedReason: reason,
      summary: null,
      createdBy: input.createdBy ?? null,
    });
    return {
      status: "blocked",
      blockedReason: reason,
      summary: null,
      firstPage: null,
      skipped: [],
      builtAt: new Date().toISOString(),
    };
  };

  const block = await publishBlock(input.businessId, shop);
  if (block) return blocked(block);

  const catalogue = await readShopCatalogue({ businessId: input.businessId, shopId: shop.id });
  if (!catalogue) throw new TorobShopError("shop_not_found");
  const { built, summary } = catalogue;

  const run = await recordRun(input.businessId, shop.id, {
    status: "built",
    blockedReason: null,
    summary,
    createdBy: input.createdBy ?? null,
  });

  return {
    status: "built",
    blockedReason: null,
    summary,
    firstPage: torobPageResponse(torobFeedPage(built, { mode: "page", page: 1, sort: "date_added_desc" })),
    // The screen lists reasons, not every row: a 4 000-product shop with one bad
    // import would otherwise send 4 000 rows to a browser to render nine lines.
    skipped: built.skipped.slice(0, 50),
    builtAt: run.builtAt,
  };
}

async function recordRun(
  businessId: string,
  shopId: string,
  input: {
    status: "built" | "blocked";
    blockedReason: TorobFeedBlockedReason | null;
    summary: FeedSummary | null;
    createdBy: string | null;
  },
): Promise<{ builtAt: string }> {
  const { rows } = await query<{ built_at: Date }>(
    `INSERT INTO torob_feed_runs
       (business_id, shop_id, status, blocked_reason, items_total, items_in_stock,
        items_out_of_stock, skipped_total, page_count, skipped_detail, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)
     RETURNING built_at`,
    [
      businessId,
      shopId,
      input.status,
      input.blockedReason,
      input.summary?.total ?? 0,
      input.summary?.inStock ?? 0,
      input.summary?.outOfStock ?? 0,
      input.summary?.skippedTotal ?? 0,
      input.summary?.pageCount ?? 1,
      JSON.stringify(
        (input.summary?.skippedByReason ?? []).map((entry) => ({ reason: entry.reason, count: entry.count })),
      ),
      input.createdBy,
    ],
  );
  return { builtAt: (rows[0]?.built_at ?? new Date()).toISOString() };
}

/** The last build of each shop, for the section's rows. */
export async function latestFeedRuns(
  businessId: string,
): Promise<Map<string, { status: "built" | "blocked"; blockedReason: string | null; itemsTotal: number; builtAt: string }>> {
  const { rows } = await query<{
    shop_id: string;
    status: "built" | "blocked";
    blocked_reason: string | null;
    items_total: number;
    built_at: Date;
  }>(
    `SELECT DISTINCT ON (shop_id) shop_id, status, blocked_reason, items_total, built_at
       FROM torob_feed_runs
      WHERE business_id = $1
      ORDER BY shop_id, built_at DESC`,
    [businessId],
  );
  return new Map(
    rows.map((row) => [
      row.shop_id,
      {
        status: row.status,
        blockedReason: row.blocked_reason,
        itemsTotal: row.items_total,
        builtAt: row.built_at.toISOString(),
      },
    ]),
  );
}
