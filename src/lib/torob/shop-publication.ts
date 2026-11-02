/**
 * Issue #894 Wave 4 — the per-shop screen's data: **what this shop publishes, and why**.
 *
 * `feed-service.ts` answers "what does Torob get"; this file answers "and how does
 * that look, product by product, to the merchant who has to decide". The two must
 * never disagree — a screen that says a product is in the feed while the crawler
 * does not receive it is worse than no screen — so this reads the *same*
 * `readShopCatalogue`, and reuses the feed builder's own skip vocabulary instead of
 * inventing a second reason language.
 *
 * Four states a product can be in, and the merchant can act on each:
 *
 *   `published`   in the feed, priced and complete
 *   `excluded`    the merchant switched it off (a decision, not a failure)
 *   `unselected`  rule is «فقط محصولات انتخابی» and they have not chosen it yet
 *   `blocked`     they want it published, and a catalogue rule stops it — with the
 *                 feed builder's reason, in Persian, and a link to the product
 *
 * The distinction between `excluded`/`unselected` and `blocked` is the one this
 * screen exists to make: the first two are the merchant's own answer, the third is
 * something they have to fix in the catalogue.
 */
import { query } from "../db";
import { TorobPriceError, sellingPriceInToman, type RialAmount } from "./currency";
import { readShopCatalogue, type CatalogueRow, type ShopRow } from "./feed-service";
import {
  PUBLICATION_RULE_COPY,
  PRODUCT_STATE_COPY,
  TOROB_PRODUCT_PAGE_SIZE,
  TOROB_SELECTION_BATCH_LIMIT,
  clampPage,
  type ProductPublicationState,
  type PublicationRule,
  type ShopProductRow,
  type ShopPublication,
  type TorobDecision,
} from "./publication";
import { TOROB_FEED_SKIP_COPY, type TorobFeedSkipReason } from "./feed";
import { TorobShopError } from "./shop-service";

export { PRODUCT_STATE_COPY };
export type { ProductPublicationState, ShopProductRow, ShopPublication };

/** Toman, or `null` — the screen shows "—" rather than a rounded number. */
function tomanOf(row: CatalogueRow, currency: string): number | null {
  try {
    return sellingPriceInToman({ amount: row.priceRial as RialAmount, currency });
  } catch (error) {
    if (error instanceof TorobPriceError) return null;
    throw error;
  }
}

/**
 * Which of the four states this row is in.
 *
 * `inFeed` comes from the built feed rather than from a second guess at the
 * builder's rules: if the item is not in `built.items`, something refused it, and
 * the builder already knows what.
 */
export function productState(input: {
  rule: PublicationRule;
  decision: TorobDecision | null;
  inFeed: boolean;
}): ProductPublicationState {
  if (input.inFeed) return "published";
  if (input.decision === "exclude") return "excluded";
  if (input.rule === "selected" && !input.decision) return "unselected";
  // The merchant wants it published (or the rule publishes it by default) and it
  // still is not there: a catalogue rule stopped it.
  return "blocked";
}

/** Does the built feed carry this product — directly, or as one of its variants? */
function feedHas(built: { items: { page_unique: string }[] }, productId: string): boolean {
  return built.items.some(
    (item) => item.page_unique === productId || item.page_unique.startsWith(`${productId}~`),
  );
}

/**
 * One page of the shop's products, with each product's state and reason.
 *
 * The catalogue is read whole because the feed is built whole — paging a screen is
 * not a reason to build a different feed than the crawler gets. `search` matches
 * the name only: a merchant looking for a product types its name.
 */
export async function readShopPublication(input: {
  businessId: string;
  shopId: string;
  search?: string;
  page?: number;
}): Promise<ShopPublication | null> {
  const catalogue = await readShopCatalogue({ businessId: input.businessId, shopId: input.shopId });
  if (!catalogue) return null;
  const { shop, rows, decisions, currency, built, summary } = catalogue;

  const skipByProduct = new Map<string, TorobFeedSkipReason>();
  // The builder may report several reasons for one product (one per variant); the
  // first is the one the screen shows, because a list of three sentences per row
  // is unreadable and the merchant fixes them in the same place.
  for (const entry of built.skipped) {
    if (!skipByProduct.has(entry.productId)) skipByProduct.set(entry.productId, entry.reason);
  }

  const annotated: ShopProductRow[] = rows.map((row) => {
    const decision = decisions.get(row.id) ?? null;
    const inFeed = feedHas(built, row.id);
    const state = productState({ rule: shop.publicationRule, decision, inFeed });
    const skipReason = state === "blocked" ? (skipByProduct.get(row.id) ?? null) : null;
    return {
      id: row.id,
      name: row.name,
      priceToman: tomanOf(row, currency),
      priceRial: String(row.priceRial),
      categoryName: row.categoryName,
      imageUrl: row.imageUrl,
      active: row.active,
      decision,
      state,
      skipReason,
      reasonCopy: skipReason ? TOROB_FEED_SKIP_COPY[skipReason] : null,
    };
  });

  const counts = {
    total: annotated.length,
    published: annotated.filter((row) => row.state === "published").length,
    excluded: annotated.filter((row) => row.state === "excluded").length,
    unselected: annotated.filter((row) => row.state === "unselected").length,
    blocked: annotated.filter((row) => row.state === "blocked").length,
  };

  const needle = (input.search ?? "").trim().toLowerCase();
  const matching = needle
    ? annotated.filter((row) => row.name.toLowerCase().includes(needle))
    : annotated;
  // Stable order: the merchant's attention goes to what is *not* published, then
  // by name. A list sorted by id would scatter a cafe's menu down the screen.
  const ordered = [...matching].sort(
    (a, b) =>
      Number(a.state === "published") - Number(b.state === "published") ||
      a.name.localeCompare(b.name, "fa"),
  );
  const totalPages = Math.max(1, Math.ceil(ordered.length / TOROB_PRODUCT_PAGE_SIZE));
  const page = clampPage(input.page, totalPages);
  const start = (page - 1) * TOROB_PRODUCT_PAGE_SIZE;

  return {
    shop: {
      id: shop.id,
      businessId: shop.businessId,
      kind: shop.kind,
      domain: shop.domain,
      authorizationState: shop.authorizationState,
      enabled: shop.enabled,
      publicationRule: shop.publicationRule,
      includeOutOfStock: shop.includeOutOfStock,
    },
    // The same summary the feed preview shows, so the two screens agree.
    summary,
    counts,
    page: { page, pageSize: TOROB_PRODUCT_PAGE_SIZE, totalPages, matching: ordered.length },
    products: ordered.slice(start, start + TOROB_PRODUCT_PAGE_SIZE),
    ruleCopy: PUBLICATION_RULE_COPY,
  };
}

/** The shop's rule, written where the feed reads it. */
export async function setPublicationRule(input: {
  businessId: string;
  shopId: string;
  rule: PublicationRule;
  includeOutOfStock?: boolean;
}): Promise<void> {
  const { rows } = await query<{ id: string }>(
    `UPDATE torob_shops
        SET publication_rule = $3,
            include_out_of_stock = COALESCE($4, include_out_of_stock),
            updated_at = now()
      WHERE id = $1 AND business_id = $2
      RETURNING id`,
    [input.shopId, input.businessId, input.rule, input.includeOutOfStock ?? null],
  );
  if (!rows[0]) throw new TorobShopError("shop_not_found");
}

/**
 * Store — or clear — the merchant's decision for one or more products.
 *
 * Three guards, each a way this table goes wrong:
 *
 *   1. **The shop is the caller's**, re-read under the tenant scope.
 *   2. **Every product id is the caller's**, checked against the tenant's own
 *      catalogue. `product_id` is a soft reference (retail `items` are coming), so
 *      this check is what stops a request attaching another business's product to
 *      this shop's feed.
 *   3. **The batch is bounded.** The screen sends one product per click; the limit
 *      is what keeps the endpoint from being a catalogue-wide upload.
 *
 * `null` deletes the row, which is how a product goes back to "whatever the rule
 * says" rather than staying switched off forever.
 */
export async function setProductDecision(input: {
  businessId: string;
  shopId: string;
  productIds: readonly string[];
  decision: TorobDecision | null;
  createdBy?: string | null;
}): Promise<{ applied: number; skipped: number }> {
  const productIds = [...new Set(input.productIds.filter((id) => typeof id === "string" && id))];
  if (productIds.length === 0) return { applied: 0, skipped: 0 };
  if (productIds.length > TOROB_SELECTION_BATCH_LIMIT) {
    throw new TorobShopError("selection_batch_too_large");
  }

  const shop = await query<{ id: string }>(
    `SELECT id FROM torob_shops WHERE id = $1 AND business_id = $2`,
    [input.shopId, input.businessId],
  );
  if (!shop.rows[0]) throw new TorobShopError("shop_not_found");

  // Only products this business actually owns may be decided about.
  const owned = await query<{ id: string }>(
    `SELECT m.id
       FROM menu_items m
       JOIN locations l ON l.id = m.location_id
      WHERE l.business_id = $1 AND m.id = ANY($2::uuid[])`,
    [input.businessId, productIds],
  );
  const ownedIds = owned.rows.map((row) => row.id);
  const skipped = productIds.length - ownedIds.length;
  if (ownedIds.length === 0) return { applied: 0, skipped };

  if (input.decision === null) {
    const deleted = await query(
      `DELETE FROM torob_shop_products
        WHERE business_id = $1 AND shop_id = $2 AND product_id = ANY($3::uuid[])`,
      [input.businessId, input.shopId, ownedIds],
    );
    return { applied: deleted.rowCount ?? 0, skipped };
  }

  const applied = await query(
    `INSERT INTO torob_shop_products (business_id, shop_id, product_id, decision, created_by)
     VALUES ($1, $2, unnest($3::uuid[]), $4, $5)
     ON CONFLICT (business_id, shop_id, product_id)
     DO UPDATE SET decision = EXCLUDED.decision, updated_at = now()`,
    [input.businessId, input.shopId, ownedIds, input.decision, input.createdBy ?? null],
  );
  return { applied: applied.rowCount ?? 0, skipped };
}
