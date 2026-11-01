/**
 * Issue #894 Wave 2 — the product feed: catalogue in, Torob items out.
 *
 * Torob lists **pages**, not products. Every item this module emits is one page
 * a shopper can open, identified by a `page_unique` that must not change when
 * something unrelated in the catalogue does — an unstable identity makes Torob
 * treat a renamed product as a new listing and a re-priced one as a duplicate,
 * which is the single most common way a marketplace feed "works" while the shop
 * shows nothing.
 *
 * So the rules here are about identity and stability first, and about fields
 * second:
 *
 *   1. **One item per sellable page.** A simple product is one item. A product
 *      with variants is one item per variant, because a variant is what a shopper
 *      can actually buy — sending the parent with the cheapest variant's price is
 *      the lie that makes a listing look available at a price nobody sells at.
 *   2. **Deterministic order.** Items are sorted by URL then identity, so page 1
 *      of a feed is page 1 on the next refresh. Torob pages through the feed; an
 *      order that reshuffles between requests silently drops products off the end
 *      of the crawl.
 *   3. **Skips are data, not exceptions.** A product that cannot be published is
 *      returned with one reason from a closed vocabulary, so the screen can say
 *      «۴ محصول منتشر نمی‌شود: قیمتشان به تومان صحیح تبدیل نمی‌شود» instead of
 *      quietly sending fewer products than the catalogue has.
 *   4. **Nothing here claims a listing.** A built item is what Torob *would*
 *      receive. Whether Torob accepted it, and whether it is indexed, is what the
 *      run record and — later — the Shop API say. The issue is explicit that
 *      those must never be conflated.
 *
 * Pure: no database, no HTTP, no clock. `feed.test.ts` covers every branch, and
 * the price rules live one file over in `currency.ts`.
 */

import {
  TorobPriceError,
  sellingPriceInToman,
  type RialAmount,
  type TorobPriceProblem,
} from "./currency";

/** Torob's documented page size for a product feed. Not tunable. */
export const TOROB_PAGE_SIZE = 100;

/**
 * Why a catalogue page is not in the feed.
 *
 * Closed vocabulary, for the same reason the price problems are: these strings
 * reach a merchant (translated below) and an operator's log. A free-form string
 * would be a reason nobody can group, count or translate.
 */
export type TorobFeedSkipReason =
  | "missing_name"
  | "missing_url"
  | "unusable_url"
  | "missing_image"
  | "unsupported_currency"
  | "price_not_whole_toman"
  | "negative_price"
  | "price_out_of_range"
  | "duplicate_page";

/** One sellable variant of a product, as the website's catalogue knows it. */
export interface CatalogueVariant {
  /** Stable within the product. Together with the product id it is the identity. */
  id: string;
  /** «رنگ: قرمز» — the axis values this variant differs by. */
  attributes: Readonly<Record<string, string>>;
  /** Integer Rial, in the site's currency. */
  priceRial: RialAmount;
  /** Integer Rial; only sent when it is above the current price. */
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
  description?: string | null;
  /** The public page on the managed website. Required: Torob indexes pages. */
  url: string;
  categoryName?: string | null;
  brand?: string | null;
  /** Absolute URLs. The first one is the listing image. */
  imageUrls: readonly string[];
  /** Integer Rial, in the site's currency. */
  priceRial: RialAmount;
  oldPriceRial?: RialAmount | null;
  available: boolean;
  /** The site's currency: `IRR`, `IRT`, or something this feed refuses. */
  currency: string;
  sku?: string | null;
  variants?: readonly CatalogueVariant[];
}

/**
 * One page of the shop, as Torob receives it.
 *
 * The field names are Torob's (`page_unique`, `page_url`), because this object
 * goes over the wire unchanged; translating on the way out would put a rename
 * between the contract and its test.
 */
export interface TorobFeedItem {
  page_unique: string;
  page_url: string;
  name: string;
  /** Whole Toman. */
  price: number;
  old_price?: number;
  availability: "in_stock" | "out_of_stock";
  category_name?: string;
  brand?: string;
  image_urls?: string[];
  description?: string;
  attributes?: Record<string, string>;
  sku?: string;
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
  items: TorobFeedItem[];
  skipped: SkippedProduct[];
}

/** What a merchant reads for each skip reason. */
export const TOROB_FEED_SKIP_COPY: Readonly<Record<TorobFeedSkipReason, string>> = {
  missing_name: "نام محصول ثبت نشده است.",
  missing_url: "نشانی صفحهٔ محصول روی وب‌سایت ثبت نشده است.",
  unusable_url: "نشانی صفحهٔ محصول قابل استفاده نیست.",
  missing_image: "برای محصول تصویری ثبت نشده است؛ در ترب بدون تصویر دیده نمی‌شود.",
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

/** The price problem, mapped to the skip reason the merchant sees. */
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
      // Both are "this price has no exact Toman form": a Rial amount that is not
      // a whole Toman, and an amount that is not an integer at all.
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
 * price. A feed that sends an old price below the current one shows a shopper a
 * discount that is a price rise — so it is dropped rather than sent.
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

/**
 * Build the whole feed for one shop.
 *
 * The result is the shop's full catalogue in feed order — not a page. Paging is
 * `torobFeedPage`'s job, because the page a caller asks for must be cut from the
 * same ordered list every time; cutting while building would make page 2 depend
 * on which products happened to be skipped on page 1.
 */
export function buildTorobFeed(input: {
  products: readonly CatalogueProduct[];
  /** Out-of-stock products are sent with an availability flag by default. */
  includeOutOfStock?: boolean;
}): BuiltFeed {
  const includeOutOfStock = input.includeOutOfStock ?? true;
  const items: TorobFeedItem[] = [];
  const skipped: SkippedProduct[] = [];
  // Two identities are checked, because they can each collide independently: two
  // rows with one local id, and two rows pointing at one page.
  const seenUniques = new Set<string>();
  const seenUrls = new Set<string>();

  const skip = (
    product: CatalogueProduct,
    variant: CatalogueVariant | null,
    reason: TorobFeedSkipReason,
  ) => {
    skipped.push({
      productId: product.id,
      variantId: variant?.id ?? null,
      name: product.name,
      url: product.url ?? null,
      reason,
    });
  };

  for (const product of input.products) {
    const name = product.name?.trim();
    if (!name) {
      skip(product, null, "missing_name");
      continue;
    }
    if (!product.url || !product.url.trim()) {
      skip(product, null, "missing_url");
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
        // duplicate after an import. Sending both makes Torob pick one at random.
        skip(product, variant, "duplicate_page");
        continue;
      }

      const converted = price(amount, product.currency);
      if (!converted.ok) {
        skip(product, variant, converted.reason);
        continue;
      }

      const item: TorobFeedItem = {
        page_unique: page.unique,
        page_url: page.url!,
        name,
        price: converted.toman,
        availability: available ? "in_stock" : "out_of_stock",
        image_urls: [...product.imageUrls],
      };
      const old = oldPrice(variant ? variant.oldPriceRial : product.oldPriceRial, product.currency, converted.toman);
      if (old !== undefined) item.old_price = old;
      if (product.categoryName?.trim()) item.category_name = product.categoryName.trim();
      if (product.brand?.trim()) item.brand = product.brand.trim();
      if (product.description?.trim()) item.description = product.description.trim();
      if (variant && Object.keys(variant.attributes).length > 0) item.attributes = { ...variant.attributes };
      const sku = variant?.sku ?? product.sku;
      if (sku?.trim()) item.sku = sku.trim();

      seenUniques.add(page.unique);
      seenUrls.add(item.page_url);
      items.push(item);
    }
  }

  // One order, every refresh. See rule 2 in the header.
  items.sort((a, b) => (a.page_url === b.page_url ? cmp(a.page_unique, b.page_unique) : cmp(a.page_url, b.page_url)));
  skipped.sort((a, b) => cmp(`${a.productId}~${a.variantId ?? ""}`, `${b.productId}~${b.variantId ?? ""}`));

  return { items, skipped };
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A page of a built feed, plus the envelope Torob reads. */
export interface TorobFeedPage {
  /** 1-based. */
  page: number;
  pageCount: number;
  total: number;
  hasMore: boolean;
  items: TorobFeedItem[];
  /** A cursor that survives a catalogue change: the last identity sent. */
  nextCursor: string | null;
}

/**
 * Cut one page out of a built feed.
 *
 * `pageSize` is capped at Torob's 100 rather than accepted as a caller's choice:
 * a page of 500 is a page Torob's crawler will not read, and a silent cap is
 * better than a feed that looks configured and is not.
 */
export function torobFeedPage(feed: BuiltFeed, page: number, pageSize = TOROB_PAGE_SIZE): TorobFeedPage {
  const size = Math.max(1, Math.min(TOROB_PAGE_SIZE, Math.floor(pageSize)));
  const total = feed.items.length;
  const pageCount = Math.max(1, Math.ceil(total / size));
  const current = Math.max(1, Math.min(pageCount, Math.floor(page) || 1));
  const start = (current - 1) * size;
  const items = feed.items.slice(start, start + size);
  const hasMore = current < pageCount;
  return {
    page: current,
    pageCount,
    total,
    hasMore,
    items,
    nextCursor: hasMore ? items[items.length - 1]!.page_unique : null,
  };
}

/**
 * The response envelope, in the shape a Torob crawler reads.
 *
 * `page_urls` and `page_uniques` are always present: they are how Torob diffs a
 * refresh without fetching every product again, and a feed that only sends full
 * products forces a full re-crawl each time.
 */
export interface TorobFeedEnvelope {
  page: number;
  page_count: number;
  total: number;
  page_urls: string[];
  page_uniques: string[];
  products: TorobFeedItem[];
}

export function torobFeedEnvelope(page: TorobFeedPage): TorobFeedEnvelope {
  return {
    page: page.page,
    page_count: page.pageCount,
    total: page.total,
    page_urls: page.items.map((item) => item.page_url),
    page_uniques: page.items.map((item) => item.page_unique),
    products: page.items,
  };
}

/** What a shop's feed contains, without building every item twice. */
export interface FeedSummary {
  total: number;
  pageCount: number;
  inStock: number;
  outOfStock: number;
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
  const inStock = feed.items.filter((item) => item.availability === "in_stock").length;
  return {
    total: feed.items.length,
    pageCount: Math.max(1, Math.ceil(feed.items.length / TOROB_PAGE_SIZE)),
    inStock,
    outOfStock: feed.items.length - inStock,
    skippedTotal: feed.skipped.length,
    skippedByReason: [...byReason.entries()]
      .sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))
      .map(([reason, count]) => ({ reason, count, copy: TOROB_FEED_SKIP_COPY[reason] })),
  };
}
