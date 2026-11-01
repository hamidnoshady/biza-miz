/**
 * Issue #894 Wave 2 — the product feed: catalogue in, **Torob v3 products** out.
 *
 * Torob lists pages, not products. Every item this module emits is one page a
 * shopper can open, identified by a `page_unique` that must not change when
 * something unrelated in the catalogue does — an unstable identity makes Torob
 * treat a renamed product as a new listing and a re-priced one as a duplicate,
 * which is the most common way a marketplace feed "works" while the shop shows
 * nothing.
 *
 * The rules, each of which is a test in `feed.test.ts`:
 *
 *   1. **One item per sellable page.** A simple product is one item. A product
 *      with variants is one item per variant, sharing a `product_group_id` (the
 *      document's own rule) and differing in `page_unique` — never the parent
 *      priced at its cheapest variant, which lists a number nobody sells at.
 *   2. **A product that is not for sale is not sent.** `sellable: false` omits it
 *      entirely; the document says a removed product is excluded from the list and
 *      answers a direct lookup with an empty array. It is *not* sent as
 *      `availability: false`, which would keep a withdrawn listing alive.
 *   3. **Unavailable is `false` + `0`.** `availability: true` with
 *      `current_price: 0` means **free** to Torob, so a sold-out product is sent
 *      as unavailable at zero — never with its last known price, which would
 *      quote a shopper a number the shop will not honour.
 *   4. **Order is the request's, not the catalogue's.** `buildTorobFeed` produces
 *      a canonical order (by identity) so the same catalogue always yields the
 *      same list; `sortTorobProducts` then applies the sort Torob asked for, and
 *      paging cuts that sorted list. A crawler that pages through
 *      `date_updated_desc` twice must see the same page boundaries both times.
 *   5. **Skips are data.** A page that cannot be published comes back with a
 *      reason from a closed vocabulary, so the screen can say «۴ محصول منتشر
 *      نمی‌شود: …» instead of quietly sending fewer products than the catalogue.
 *
 * Field names, limits and the envelope are Torob's and live in `contract.ts`
 * beside the document they come from.
 */
import { TorobPriceError, sellingPriceInToman, type RialAmount, type TorobPriceProblem } from "./currency";
import {
  TOROB_PAGE_SIZE,
  clampField,
  cursorResponse,
  pageResponse,
  priceForTorob,
  type TorobProductV3,
  type TorobSort,
  type TorobV3Response,
} from "./contract";

/**
 * Why a catalogue page is not in the feed.
 *
 * Closed vocabulary: these reach a merchant (translated below) and an operator's
 * log. A free-form string would be a reason nobody can group, count or translate.
 */
export type TorobFeedSkipReason =
  | "not_sellable"
  | "missing_name"
  | "missing_url"
  | "unusable_url"
  | "missing_image"
  | "missing_date"
  | "unsupported_currency"
  | "price_not_whole_toman"
  | "negative_price"
  | "price_out_of_range"
  | "duplicate_page";

/** One sellable variant of a product, as the website's catalogue knows it. */
export interface CatalogueVariant {
  /** Stable within the product. With the product id it is the identity. */
  id: string;
  /** «رنگ: قرمز» — the axis values this variant differs by. Becomes `spec`. */
  attributes: Readonly<Record<string, string>>;
  /** Integer Rial, in the site's currency. */
  priceRial: RialAmount;
  /** Integer Rial; sent only when it is above the current price. */
  oldPriceRial?: RialAmount | null;
  available: boolean;
  sku?: string | null;
  /** The variant's own page, when the storefront has one. */
  url?: string | null;
}

/** One product as the website's catalogue knows it. */
export interface CatalogueProduct {
  /** `menu_items.id` or `items.id` — a stable local identity. */
  id: string;
  name: string;
  subtitle?: string | null;
  description?: string | null;
  /** The public page on the managed website. Required: Torob indexes pages. */
  url: string;
  categoryName?: string | null;
  /** Absolute URLs, main image first. The document rejects thumbnails. */
  imageUrls: readonly string[];
  /** Integer Rial, in the site's currency. */
  priceRial: RialAmount;
  oldPriceRial?: RialAmount | null;
  /** In stock. Sent as `availability`; see rule 3. */
  available: boolean;
  /**
   * Published and offered at all. `false` omits the product from the feed — the
   * difference between "sold out" and "withdrawn", which Torob treats very
   * differently.
   */
  sellable?: boolean;
  /** The site's currency: `IRR`, `IRT`, or something this feed refuses. */
  currency: string;
  sku?: string | null;
  /** Specifications — Torob requires a `spec` dictionary, `{}` when there are none. */
  spec?: Readonly<Record<string, string>>;
  guarantee?: string | null;
  /** Timezone-aware ISO 8601. Required by the contract. */
  dateAdded: string;
  dateUpdated?: string | null;
  variants?: readonly CatalogueVariant[];
}

export interface SkippedProduct {
  /** The local product id (or `product~variant`), so the screen can link to it. */
  productId: string;
  variantId: string | null;
  name: string;
  url: string | null;
  reason: TorobFeedSkipReason;
}

export interface BuiltFeed {
  /** Canonical order (by `page_unique`), independent of any request's sort. */
  items: TorobProductV3[];
  skipped: SkippedProduct[];
}

/** What a merchant reads for each skip reason. */
export const TOROB_FEED_SKIP_COPY: Readonly<Record<TorobFeedSkipReason, string>> = {
  not_sellable: "این محصول منتشر نشده یا از فروش خارج شده است.",
  missing_name: "نام محصول ثبت نشده است.",
  missing_url: "نشانی صفحهٔ محصول روی وب‌سایت ثبت نشده است.",
  unusable_url: "نشانی صفحهٔ محصول قابل استفاده نیست.",
  missing_image: "برای محصول تصویری ثبت نشده است؛ در ترب بدون تصویر دیده نمی‌شود.",
  missing_date: "تاریخ ثبت محصول خوانده نمی‌شود؛ ترب برای هر محصول تاریخ افزودن می‌خواهد.",
  unsupported_currency: "قیمت این محصول به ارزی جز ریال یا تومان ثبت شده است.",
  price_not_whole_toman: "قیمت این محصول به تومان صحیح تبدیل نمی‌شود.",
  negative_price: "قیمت این محصول منفی است.",
  price_out_of_range: "قیمت این محصول از بازهٔ مجاز بیشتر است.",
  duplicate_page: "دو محصول به یک صفحهٔ یکسان اشاره می‌کنند.",
};

/** Stable identity for a variant's page. `~` cannot occur in a uuid. */
export function variantPageUnique(productId: string, variantId: string): string {
  return `${productId}~${variantId}`;
}

/**
 * A variant's page: its own URL when the storefront has one, otherwise the
 * product's URL with a `variant` parameter added — never replacing the product's
 * query, which may be a language or a page parameter the storefront needs.
 */
function variantUrl(product: CatalogueProduct, variant: CatalogueVariant): string | null {
  if (variant.url && variant.url.trim()) return variant.url.trim();
  try {
    const url = new URL(product.url);
    url.searchParams.set("variant", variant.id);
    return url.toString();
  } catch {
    return null;
  }
}

function isUsableUrl(value: string | null | undefined): value is string {
  if (!value) return false;
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** A timezone-aware ISO timestamp, or null when the source value is unusable. */
export function isoTimestamp(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function priceSkipReason(problem: TorobPriceProblem): TorobFeedSkipReason {
  switch (problem) {
    case "unsupported_currency":
      return "unsupported_currency";
    case "negative_price":
      return "negative_price";
    case "price_out_of_range":
      return "price_out_of_range";
    case "rial_not_whole_toman":
    case "not_an_integer":
      // Both are "this price has no exact Toman form".
      return "price_not_whole_toman";
  }
}

function price(
  amount: RialAmount,
  currency: string,
): { ok: true; toman: number } | { ok: false; reason: TorobFeedSkipReason } {
  try {
    return { ok: true, toman: sellingPriceInToman({ amount, currency }) };
  } catch (error) {
    if (error instanceof TorobPriceError) return { ok: false, reason: priceSkipReason(error.problem) };
    throw error;
  }
}

/**
 * An old price is a *strikethrough*, so it is only meaningful above the selling
 * price. A feed that sends one below the current price shows a shopper a discount
 * that is a price rise — so it is dropped rather than sent.
 */
function oldPrice(
  amount: RialAmount | null | undefined,
  currency: string,
  sellingPrice: number,
): number | undefined {
  if (amount === null || amount === undefined) return undefined;
  const converted = price(amount, currency);
  if (!converted.ok) return undefined;
  return converted.toman > sellingPrice ? converted.toman : undefined;
}

/** Drop empty values so the response carries only fields Torob can use. */
function cleanSpec(spec: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(spec ?? {})) {
    const name = key.trim();
    const text = String(value ?? "").trim();
    if (name && text) result[name] = text;
  }
  return result;
}

/**
 * Build a shop's feed.
 *
 * The result is the shop's whole publishable catalogue in canonical order — not a
 * page. Paging and sorting belong to `torobFeedPage`, because the page a caller
 * asks for must be cut from one ordered list every time; cutting while building
 * would make page 2 depend on which products happened to be skipped on page 1.
 */
export function buildTorobFeed(input: {
  products: readonly CatalogueProduct[];
  /** Out-of-stock products are sent with `availability: false` by default. */
  includeOutOfStock?: boolean;
}): BuiltFeed {
  const includeOutOfStock = input.includeOutOfStock ?? true;
  const items: TorobProductV3[] = [];
  const skipped: SkippedProduct[] = [];
  // Two identities are checked, because they can each collide independently.
  const seenUniques = new Set<string>();
  const seenUrls = new Set<string>();

  const skip = (product: CatalogueProduct, variant: CatalogueVariant | null, reason: TorobFeedSkipReason) => {
    skipped.push({
      productId: product.id,
      variantId: variant?.id ?? null,
      name: product.name,
      url: product.url ?? null,
      reason,
    });
  };

  for (const product of input.products) {
    const title = clampField(product.name, 500);
    if (!title) {
      skip(product, null, "missing_name");
      continue;
    }
    if (!product.url || !product.url.trim()) {
      skip(product, null, "missing_url");
      continue;
    }
    // A withdrawn product is absent from the feed entirely — not "out of stock".
    if (product.sellable === false) {
      skip(product, null, "not_sellable");
      continue;
    }

    const dateAdded = isoTimestamp(product.dateAdded);
    if (!dateAdded) {
      // The contract requires `date_added`; a product without one cannot be sent
      // rather than being sent with a fabricated timestamp.
      skip(product, null, "missing_date");
      continue;
    }

    const variants = (product.variants ?? []).filter((variant) => variant.id);
    const pages: { variant: CatalogueVariant | null; url: string | null; unique: string }[] =
      variants.length > 0
        ? variants.map((variant) => ({
            variant,
            url: variantUrl(product, variant),
            unique: variantPageUnique(product.id, variant.id),
          }))
        : [{ variant: null, url: product.url.trim(), unique: product.id }];

    for (const page of pages) {
      const variant = page.variant;
      const amount = variant ? variant.priceRial : product.priceRial;
      const available = (variant ? variant.available : product.available) ?? true;

      if (!includeOutOfStock && !available) {
        // Deliberately not a "skip with a reason": excluding unavailable products
        // is the shop's configured choice, not a product that failed a rule.
        continue;
      }
      if (!isUsableUrl(page.url)) {
        skip(product, variant, product.url ? "unusable_url" : "missing_url");
        continue;
      }
      if (product.imageUrls.length === 0) {
        skip(product, variant, "missing_image");
        continue;
      }
      if (seenUniques.has(page.unique) || seenUrls.has(page.url!)) {
        // Two catalogue rows pointing at one page — `menu_items` can hold a
        // duplicate after an import. Sending both lets Torob pick one at random.
        skip(product, variant, "duplicate_page");
        continue;
      }

      const converted = price(amount, product.currency);
      if (!converted.ok) {
        skip(product, variant, converted.reason);
        continue;
      }

      const priced = priceForTorob({ available, toman: converted.toman });
      const item: TorobProductV3 = {
        page_unique: page.unique,
        page_url: page.url!,
        title,
        ...priced,
        image_links: product.imageUrls
          .map((url) => clampField(url, 1000))
          .filter((url): url is string => Boolean(url)),
        // Required by the contract, empty when there is nothing to say.
        spec: cleanSpec(variant ? { ...product.spec, ...variant.attributes } : product.spec),
        date_added: dateAdded,
      };

      const subtitle = clampField(product.subtitle ?? undefined, 500);
      if (subtitle) item.subtitle = subtitle;
      // Variants of one product share a group id, which is how Torob knows they
      // are the same thing in different colours rather than unrelated listings.
      if (variant) item.product_group_id = clampField(product.id, 200);
      const old = oldPrice(variant ? variant.oldPriceRial : product.oldPriceRial, product.currency, converted.toman);
      if (old !== undefined) item.old_price = old;
      const category = clampField(product.categoryName ?? undefined, 200);
      if (category) item.category_name = category;
      const shortDesc = clampField(product.description ?? undefined, 500);
      if (shortDesc) item.short_desc = shortDesc;
      const guarantee = clampField(product.guarantee ?? undefined, 200);
      if (guarantee) item.guarantee = guarantee;
      const updated = isoTimestamp(product.dateUpdated);
      if (updated) item.date_updated = updated;

      seenUniques.add(page.unique);
      seenUrls.add(item.page_url);
      items.push(item);
    }
  }

  // Canonical order: identity ascending. Every request sorts this list itself.
  items.sort((a, b) => cmp(a.page_unique, b.page_unique));
  skipped.sort((a, b) => cmp(`${a.productId}~${a.variantId ?? ""}`, `${b.productId}~${b.variantId ?? ""}`));

  return { items, skipped };
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Apply the sort Torob asked for.
 *
 * A missing `date_updated` sorts last in `date_updated_desc` rather than being
 * treated as "now": a product the shop never updated did not just change, and
 * bumping it to the top would make every crawler re-fetch it on every pass.
 */
export function sortTorobProducts(items: readonly TorobProductV3[], sort: TorobSort): TorobProductV3[] {
  const byUnique = (a: TorobProductV3, b: TorobProductV3) => cmp(a.page_unique, b.page_unique);
  const copy = [...items];
  switch (sort) {
    case "date_added_desc":
      return copy.sort((a, b) => cmp(b.date_added, a.date_added) || byUnique(a, b));
    case "date_updated_desc":
      return copy.sort((a, b) => {
        if (!a.date_updated && !b.date_updated) return byUnique(a, b);
        if (!a.date_updated) return 1;
        if (!b.date_updated) return -1;
        return cmp(b.date_updated, a.date_updated) || byUnique(a, b);
      });
    case "product_id_desc":
      return copy.sort((a, b) => cmp(b.page_unique, a.page_unique));
  }
}

export interface TorobFeedPage {
  products: TorobProductV3[];
  /** Total products the shop publishes (before paging). */
  total: number;
  currentPage: number | null;
  nextCursor: string | null;
}

/**
 * Cut one page, or one cursor window, out of the shop's feed.
 *
 * Page-based and cursor-based paging both use 100 items — the contract's fixed
 * size — and both are cuts of the same sorted list, so the two modes agree about
 * what page 1 contains for the same `sort`.
 */
export function torobFeedPage(
  feed: BuiltFeed,
  query: { mode: "page"; page: number; sort: TorobSort } | { mode: "cursor"; cursor: string | null; sort: TorobSort },
): TorobFeedPage {
  const sorted = sortTorobProducts(feed.items, query.sort);
  const total = sorted.length;

  if (query.mode === "page") {
    const maxPage = Math.max(1, Math.ceil(total / TOROB_PAGE_SIZE));
    // Clamp rather than return an empty page for a stale page number: a 200 with
    // no products reads to a crawler as "the shop deleted everything".
    const page = Math.max(1, Math.min(maxPage, query.page));
    const start = (page - 1) * TOROB_PAGE_SIZE;
    return {
      products: sorted.slice(start, start + TOROB_PAGE_SIZE),
      total,
      currentPage: page,
      nextCursor: null,
    };
  }

  // Cursor mode: the cursor is the last `page_unique` this shop sent, and it is
  // opaque to Torob — it only has to be stable, which a local uuid is.
  const after = query.cursor;
  const start = after ? sorted.findIndex((product) => cmp(product.page_unique, after) < 0) : 0;
  // A cursor past the end means the caller already has everything. Restarting from
  // the first page would put a crawler in an endless loop, which looks like a shop
  // that keeps growing.
  if (start === -1) return { products: [], total, currentPage: null, nextCursor: null };
  const from = start;
  const products = sorted.slice(from, from + TOROB_PAGE_SIZE);
  const last = products[products.length - 1]?.page_unique ?? null;
  const nextCursor = products.length === TOROB_PAGE_SIZE && from + TOROB_PAGE_SIZE < total ? last : null;
  return { products, total, currentPage: null, nextCursor };
}

/** Wrap a page in the documented response envelope. */
export function torobPageResponse(page: TorobFeedPage): TorobV3Response {
  return page.currentPage === null
    ? cursorResponse({ products: page.products, total: page.total, nextCursor: page.nextCursor })
    : pageResponse({ products: page.products, page: page.currentPage, total: page.total });
}

/** What a shop's feed contains, for the screen and the run record. */
export interface FeedSummary {
  total: number;
  pageCount: number;
  inStock: number;
  outOfStock: number;
  groups: number;
  skippedTotal: number;
  skippedByReason: { reason: TorobFeedSkipReason; count: number; copy: string }[];
}

/**
 * The counts a screen or an operator needs. Reasons with no occurrences are
 * omitted: a list of nine zeros buries the one that matters.
 */
export function summariseFeed(feed: BuiltFeed): FeedSummary {
  const byReason = new Map<TorobFeedSkipReason, number>();
  for (const entry of feed.skipped) byReason.set(entry.reason, (byReason.get(entry.reason) ?? 0) + 1);
  const inStock = feed.items.filter((item) => item.availability).length;
  return {
    total: feed.items.length,
    pageCount: Math.max(1, Math.ceil(feed.items.length / TOROB_PAGE_SIZE)),
    inStock,
    outOfStock: feed.items.length - inStock,
    groups: new Set(feed.items.map((item) => item.product_group_id ?? item.page_unique)).size,
    skippedTotal: feed.skipped.length,
    skippedByReason: [...byReason.entries()]
      .sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))
      .map(([reason, count]) => ({ reason, count, copy: TOROB_FEED_SKIP_COPY[reason] })),
  };
}

/** Products matching a `page_urls` / `page_uniques` lookup, in feed order. */
export function lookupTorobProducts(
  feed: BuiltFeed,
  query: { mode: "page_urls"; pageUrls: string[] } | { mode: "page_uniques"; pageUniques: string[] },
): TorobProductV3[] {
  if (query.mode === "page_uniques") {
    const wanted = new Set(query.pageUniques);
    return feed.items.filter((item) => wanted.has(item.page_unique));
  }
  const wanted = new Set(query.pageUrls.map((url) => url.trim()));
  return feed.items.filter((item) => wanted.has(item.page_url));
}
