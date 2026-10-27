/**
 * Phase 38 — WooCommerce's product model, as rules rather than as `if`s
 * scattered through the sync.
 *
 * Why this file exists: WooCommerce has never had one kind of product, and
 * "the product" is not always "the thing you can sell". A `variable` product
 * is a shell whose variations carry the SKU, the price and the stock; a
 * `grouped` product is a shelf of other people's products; an `external`
 * product has a price and a link and no stock at all. Every one of the three
 * ways a product reaches this app — the REST pull, the webhook, the plugin
 * push — used to make its own ad-hoc decision about that, and they did not
 * agree:
 *
 *   - the REST pull never saw a variation (they are not in `/products`), so
 *     nothing was ever mapped;
 *   - an order line's `variation_id` was ignored, so a variation line
 *     resolved to its parent — which is deliberately created as a
 *     non-sellable `variant_parent` with no stock row, so the sale recorded
 *     revenue and dropped the COGS;
 *   - the plugin sent `product_id` = the variation (because
 *     `WC_Order_Item_Product::get_product()` returns the variation when there
 *     is one) while a webhook sends `product_id` = parent plus
 *     `variation_id` = child, so the same order resolved to two different
 *     items depending on how the store was connected.
 *
 * Everything here is pure: no database, no `fetch`, no `Date.now()`. That is
 * what lets the rules be tested against a whole matrix of product shapes
 * instead of against whichever one a live store happened to have.
 */

import type { WooOrderLineItem, WooProduct, WooVariationAttribute } from "./woocommerce-client";

/** WooCommerce product types this app has an answer for. */
export type WooProductFamily =
  | "simple"
  | "variable"
  | "variation"
  | "grouped"
  | "external"
  | "bundle"
  | "composite"
  | "subscription"
  | "unknown";

/**
 * What one product type means for us.
 *
 * `sellable` is the question the order import actually asks: may a line item
 * point at this remote id and expect stock relief and COGS? It is false for
 * `variable` and `grouped` for *different* reasons — a variable product's
 * children are its own rows, a grouped product's children are ordinary
 * products that stand alone — and the difference shows up in `container`.
 */
export interface WooProductShape {
  family: WooProductFamily;
  /** A line item may resolve to this remote id and relieve stock. */
  sellable: boolean;
  /** This product exists to hold others (`variable`, `grouped`). */
  container: boolean;
  /** The store tracks stock for it. False for `external` — sold elsewhere. */
  stockTracked: boolean;
  /** The retail `items.kind` this becomes. F&B has no parent/child model. */
  itemKind: "simple" | "variant_parent" | "variant_child";
}

const SIMPLE: WooProductShape = {
  family: "simple",
  sellable: true,
  container: false,
  stockTracked: true,
  itemKind: "simple",
};

const SHAPES: Record<WooProductFamily, WooProductShape> = {
  simple: SIMPLE,
  variable: {
    family: "variable",
    sellable: false,
    container: true,
    stockTracked: false,
    itemKind: "variant_parent",
  },
  variation: {
    family: "variation",
    sellable: true,
    container: false,
    stockTracked: true,
    itemKind: "variant_child",
  },
  grouped: {
    // A grouped product is a display shelf: it has no price of its own and
    // its children are ordinary products that are also sold on their own.
    // So it is a container, but unlike `variable` its children are NOT
    // re-parented — a product can sit on two shelves at once.
    family: "grouped",
    sellable: false,
    container: true,
    stockTracked: false,
    itemKind: "variant_parent",
  },
  external: {
    // An affiliate listing: a price and a URL, sold on someone else's site.
    // Recording it keeps the catalogue complete and the revenue honest;
    // pretending it has stock would invent inventory that does not exist.
    family: "external",
    sellable: true,
    container: false,
    stockTracked: false,
    itemKind: "simple",
  },
  // Bundles and composites are sold as a unit at the parent's price. Woo
  // relieves their children's stock itself when configured to, and there is
  // no way to know from the REST payload which of the two strategies a given
  // store picked — so they are treated as ordinary sellable products here and
  // the store stays authoritative about its own stock.
  bundle: { ...SIMPLE, family: "bundle" },
  composite: { ...SIMPLE, family: "composite" },
  subscription: { ...SIMPLE, family: "subscription" },
  // An unrecognised type is a type we have not caught up with, not a product
  // to skip. Defaulting to `simple` means a shop running a product type from
  // an extension still gets a sellable item with a price, which is closer to
  // right than silently dropping it from the catalogue.
  unknown: { ...SIMPLE, family: "unknown" },
};

/**
 * WooCommerce's own type strings, including the ones the popular extensions
 * add. Lower-cased before lookup, because WooCommerce is not consistent
 * about case across REST versions.
 */
const TYPE_ALIASES: Record<string, WooProductFamily> = {
  simple: "simple",
  variable: "variable",
  variation: "variation",
  grouped: "grouped",
  external: "external",
  affiliate: "external",
  bundle: "bundle",
  yith_bundle: "bundle",
  composite: "composite",
  subscription: "subscription",
  "variable-subscription": "variable",
  "subscription_variation": "variation",
  simple_subscription: "subscription",
};

export function classifyWooProductType(type: string | undefined | null): WooProductFamily {
  if (!type) return "unknown";
  const key = type.trim().toLowerCase();
  if (key in TYPE_ALIASES) return TYPE_ALIASES[key];
  // `woosb`, `pw-gift-card`, `job_package` … — anything unrecognised.
  return "unknown";
}

export function wooProductShape(type: string | undefined | null): WooProductShape {
  return SHAPES[classifyWooProductType(type)];
}

/**
 * A product's type, inferred from its shape when the type is missing.
 *
 * The REST API always sends `type`, but a webhook payload for a variation
 * sometimes does not, and a plugin-built payload cannot always be trusted to
 * have it. A product with a `parent_id` is a variation — that is the one
 * inference that is always safe.
 */
export function inferWooProductType(product: {
  type?: string;
  parent_id?: number | null;
}): WooProductFamily {
  const declared = classifyWooProductType(product.type);
  if (declared !== "unknown") return declared;
  if (product.parent_id) return "variation";
  return "unknown";
}

export function isSellableWooProduct(product: { type?: string; parent_id?: number | null }): boolean {
  return wooProductShape(inferWooProductType(product)).sellable;
}

/**
 * The type strings for one shape predicate: every alias in `TYPE_ALIASES`
 * whose family answers `predicate`, plus nothing else.
 *
 * The catalogue page is read in SQL (issue #943), and SQL cannot call
 * `wooProductShape` — so the shape rules cross into the query as explicit
 * string lists *derived from the same tables* the in-memory classifier uses.
 * A new alias added to `TYPE_ALIASES` lands in these lists automatically;
 * the two readings cannot drift.
 */
function wooTypeStringsWhere(predicate: (shape: WooProductShape) => boolean): string[] {
  const out: string[] = [];
  for (const [alias, family] of Object.entries(TYPE_ALIASES)) {
    if (predicate(SHAPES[family])) out.push(alias);
  }
  return out.sort();
}

/**
 * Type strings that are NOT sellable — the `variable` and `grouped`
 * containers. Everything else, including a type this app has never seen, is
 * sellable (the `unknown → simple` default), which is why the SQL reads
 * `NOT (woo_type = ANY(this list))` and never an allowlist of sellables.
 * Match case-insensitively: `classifyWooProductType` lower-cases first.
 */
export const NON_SELLABLE_WOO_TYPE_STRINGS: readonly string[] = wooTypeStringsWhere((s) => !s.sellable);

/**
 * Type strings whose products the store does not stock-manage: the two
 * containers plus `external`/`affiliate` (sold on someone else's site).
 * A quantity shown for one of these would be a tracked figure this app
 * fabricated — the catalogue SQL nulls it out with this list (issue #943).
 */
export const UNTRACKED_WOO_TYPE_STRINGS: readonly string[] = wooTypeStringsWhere((s) => !s.stockTracked);

/** Type strings that classify as a `variation` — a variable product's sellable child. */
export const VARIATION_WOO_TYPE_STRINGS: readonly string[] = wooTypeStringsWhere((s) => s.family === "variation");

// ---------------------------------------------------------------------------
// Order statuses
// ---------------------------------------------------------------------------

/**
 * The WooCommerce order statuses that mean "no money has moved" (or never
 * will).
 *
 * `pending`/`on-hold` are a cart that has not been paid for yet — BACS and
 * offline gateways park orders there until a human confirms the transfer.
 * `cancelled`/`failed` are abandoned. `draft`/`checkout-draft` are not even
 * orders yet, and `trash` is the store's bin.
 *
 * Everything else — `processing`, `completed`, `refunded` (which *was* paid,
 * and its refund arrives as its own event), and any status an extension
 * added — is imported. An unknown status is a state this app has not caught
 * up with, not a reason to drop revenue: the repo's own rule is that a sale
 * is never silently missed.
 *
 * This is the same default the mature WooCommerce accounting connectors ship
 * (WooCommerce's own Xero extension creates the invoice at Processing or
 * Completed; QuickBooks Connector asks which statuses to sync): a POS that
 * records a pending cart as a completed, paid sale with a journal entry is
 * recording money that does not exist yet.
 */
const WOO_UNPAID_ORDER_STATUSES = new Set([
  "pending",
  "on-hold",
  "cancelled",
  "failed",
  "draft",
  "checkout-draft",
  "trash",
]);

/**
 * True when an order's status means it should become a local sale.
 *
 * Pure so the matrix (every core status + a custom one) is unit-tested rather
 * than discovered on a live store.
 */
export function shouldImportWooOrder(status: string | undefined | null): boolean {
  if (!status) return true;
  return !WOO_UNPAID_ORDER_STATUSES.has(status.trim().toLowerCase());
}

// ---------------------------------------------------------------------------
// Order lines
// ---------------------------------------------------------------------------

/**
 * How one order line resolved to a remote product id.
 *
 * Returned rather than just the id because the caller's behaviour differs:
 * a `variation` line that resolves is stock-relieved, a `parent_fallback`
 * line is recorded without stock (the variation was never synced), and an
 * `unmapped` line is recorded with nothing at all. Collapsing those into one
 * nullable id is how the old code lost the difference.
 */
export type WooLineResolution =
  | { remoteId: string; via: "variation"; variationId: number; productId: number }
  | { remoteId: string; via: "product"; productId: number }
  /** A variation line whose variation is not mapped — fall back to its parent. */
  | { remoteId: string; via: "parent_fallback"; variationId: number; productId: number }
  | { remoteId: null; via: "none" };

/**
 * Which remote id an order line is really about.
 *
 * `variation_id` wins whenever WooCommerce sent a non-zero one — that is the
 * sellable unit, and it is the only id whose `integration_mappings` row
 * points at a row with stock. `product_id` is the fallback for simple
 * products and for the plugin's older payloads.
 *
 * A zero/absent variation id on a line whose product_id is a *variable*
 * parent is deliberately not turned into an error: it means the store sold
 * something this app cannot narrow down, and the honest outcome is a recorded
 * line with no stock movement, not a failed import.
 */
export function resolveWooOrderLine(line: WooOrderLineItem): WooLineResolution {
  const productId = Number(line.product_id ?? 0) || 0;
  const variationId = Number(line.variation_id ?? 0) || 0;
  // A store that repeats the product id in variation_id is not pointing at a
  // variation; treating it as one would make the caller look for a child
  // mapping that cannot exist.
  if (variationId > 0 && variationId !== productId) {
    return { remoteId: String(variationId), via: "variation", variationId, productId };
  }
  if (productId > 0) return { remoteId: String(productId), via: "product", productId };
  return { remoteId: null, via: "none" };
}

/** The ids a line could resolve to, in priority order, deduped. */
export function wooLineCandidateIds(line: WooOrderLineItem): string[] {
  const productId = Number(line.product_id ?? 0) || 0;
  const variationId = Number(line.variation_id ?? 0) || 0;
  const ids: string[] = [];
  if (variationId > 0) ids.push(String(variationId));
  if (productId > 0 && productId !== variationId) ids.push(String(productId));
  return ids;
}

/**
 * The id to fall back to when a variation line's variation is not mapped:
 * the variation's parent, if the line carries one.
 */
export function wooLineParentFallback(line: WooOrderLineItem): string | null {
  const productId = Number(line.product_id ?? 0) || 0;
  const variationId = Number(line.variation_id ?? 0) || 0;
  if (variationId > 0 && productId > 0 && productId !== variationId) return String(productId);
  return null;
}

// ---------------------------------------------------------------------------
// Names — "T-shirt" is not enough when the store sells twelve of them
// ---------------------------------------------------------------------------

/**
 * `[{name:'رنگ', option:'قرمز'}]` → «رنگ: قرمز».
 *
 * Empty when either half is missing: an attribute with a name and no value
 * renders as a bare «رنگ» hanging off the end of a product name, which reads
 * like a truncated string rather than like a variation.
 */
export function formatWooVariationAttribute(attribute: WooVariationAttribute): string {
  const name = attribute.name?.trim() ?? "";
  const value = attribute.option?.trim() ?? "";
  if (!name || !value) return "";
  return `${name}: ${value}`;
}

/**
 * A variation's display name: the parent's name plus its attributes.
 *
 * WooCommerce's own REST payload already puts this in `name` for
 * order lines but not for the variation resource, and the app's item list
 * shows rows with no parent beside them — «تی‌شرت» three times, with nothing
 * to tell them apart.
 */
export function wooVariationDisplayName(
  parentName: string,
  attributes: WooVariationAttribute[] | undefined,
): string {
  const base = parentName.trim();
  const parts = (attributes ?? []).map(formatWooVariationAttribute).filter(Boolean);
  if (parts.length === 0) return base;
  return `${base} • ${parts.join("، ")}`;
}

/** The `attribute_pa_colour` / `attribute_size` keys WooCommerce uses internally. */
const ATTRIBUTE_PREFIX = /^attribute_/i;

/** `attribute_pa_colour` → «pa_colour»; anything else unchanged. */
export function wooAttributeSlug(key: string): string {
  return key.replace(ATTRIBUTE_PREFIX, "");
}

/**
 * A variation's attributes as `{name, option}` pairs, from either shape.
 *
 * The REST resource sends `attributes: [{id, name, option}]`. A raw
 * WooCommerce webhook for an order line sends `meta_data`. The plugin
 * normalises to the first form, but a payload built by anything else must
 * still work, so both are read here.
 */
export function wooVariationAttributes(product: {
  variation_attributes?: WooVariationAttribute[];
  attributes?: { name?: string; option?: string }[];
  meta_data?: { key?: string; value?: unknown }[];
}): WooVariationAttribute[] {
  if (product.variation_attributes?.length) {
    return product.variation_attributes
      .map((a) => ({ name: a.name, option: a.option }))
      .filter((a) => a.name && a.option);
  }
  const fromAttributes = (product.attributes ?? [])
    .map((a) => ({ name: a.name?.trim() ?? "", option: a.option?.trim() ?? "" }))
    .filter((a) => a.name && a.option);
  if (fromAttributes.length) return fromAttributes;

  return (product.meta_data ?? [])
    .filter((m) => typeof m.key === "string" && ATTRIBUTE_PREFIX.test(m.key))
    .map((m) => ({
      name: wooAttributeSlug(m.key as string),
      option: String(m.value ?? "").trim(),
    }))
    .filter((a) => a.name && a.option);
}

// ---------------------------------------------------------------------------
// Taxonomies
// ---------------------------------------------------------------------------

/** The taxonomies every WooCommerce store has, in the order worth showing. */
export const WOO_CORE_TAXONOMIES = ["product_cat", "product_tag"] as const;

/** Persian labels for the taxonomy slugs an owner will actually see. */
export const WOO_TAXONOMY_LABELS: Record<string, string> = {
  product_cat: "دسته‌بندی‌ها",
  product_tag: "برچسب‌ها",
};

/**
 * `pa_colour` → «ویژگی: colour»; a custom taxonomy falls back to its slug.
 *
 * Matched case-insensitively, the same way `isWooAttributeTaxonomy` does it:
 * a store that registered `PA_Colour` used to be *badged* as an attribute by
 * one helper and *labelled* with its raw slug by the other, so the same
 * taxonomy read as two different things in one row. The remaining slug is
 * humanised (`pa_shoe-size` → «ویژگی: shoe size») because a hyphenated slug
 * is a URL fragment, not a name anyone chose to display.
 */
export function wooTaxonomyLabel(taxonomy: string): string {
  if (WOO_TAXONOMY_LABELS[taxonomy]) return WOO_TAXONOMY_LABELS[taxonomy];
  if (isWooAttributeTaxonomy(taxonomy)) {
    return `ویژگی: ${taxonomy.slice(3).replace(/[-_]+/g, " ").trim() || taxonomy}`;
  }
  return taxonomy;
}

/** True for `pa_*`: an attribute taxonomy whose terms make variations distinct. */
export function isWooAttributeTaxonomy(taxonomy: string): boolean {
  return /^pa_/i.test(taxonomy);
}

export interface WooTermLike {
  remoteId: string;
  parentRemoteId?: string | null;
  name: string;
  slug?: string;
}

/**
 * «men › shirts › tees» — a term's path through its tree.
 *
 * Cycle-guarded: a store that has managed to make a term its own
 * grandparent (it happens after a bad import) would otherwise hang the
 * renderer that draws the tree.
 */
export function wooTermPath(term: WooTermLike, byId: Map<string, WooTermLike>): string {
  const names: string[] = [term.name];
  const seen = new Set<string>([term.remoteId]);
  let cursor = term.parentRemoteId ?? null;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const parent = byId.get(cursor);
    if (!parent) break;
    names.unshift(parent.name);
    cursor = parent.parentRemoteId ?? null;
  }
  return names.filter(Boolean).join(" › ");
}

/**
 * How deep a term sits in its tree — 0 for a root, 1 for its children, …
 *
 * Cycle- and orphan-guarded, like `wooTermPath`: a term whose parent is not
 * in the list (the store paginated it away, or it was filtered out) counts as
 * a root rather than as a child of nothing.
 */
export function wooTermDepth<T extends WooTermLike>(term: T, byId: Map<string, T>): number {
  let depth = 0;
  const seen = new Set<string>([term.remoteId]);
  let cursor = term.parentRemoteId ?? null;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const parent = byId.get(cursor);
    if (!parent) break;
    depth += 1;
    cursor = parent.parentRemoteId ?? null;
  }
  return depth;
}

/**
 * Sort terms into tree order — each parent immediately followed by its own
 * subtree, siblings by `menu_order` then name — so a flat list renders as a
 * tree without a recursive component.
 *
 * This is a depth-first walk rather than a sort by depth. Sorting by depth
 * put *every* root first and *every* grandchild last, so «پوشاک» and «کفش»
 * were followed by «کتانی» under the wrong parent and the browser's «└»
 * markers pointed at whatever row happened to precede them. With two
 * categories of two children each the reading was simply wrong, which is the
 * one thing a category tree must not be.
 *
 * Orphans (a parent id that is not in this list) are treated as roots and
 * kept, and a cycle is broken by emitting the untouched remainder in sibling
 * order at the end: a bad import must not make terms disappear from the
 * screen, which is what a naive `while (queue)` recursion would do.
 */
export function sortWooTerms<T extends WooTermLike & { menuOrder?: number }>(terms: T[]): T[] {
  const byId = new Map(terms.map((t) => [t.remoteId, t]));
  const siblingOrder = (a: T, b: T) =>
    (a.menuOrder ?? 0) - (b.menuOrder ?? 0) || a.name.localeCompare(b.name, "fa");

  const children = new Map<string, T[]>();
  const roots: T[] = [];
  for (const term of terms) {
    const parentId = term.parentRemoteId ?? null;
    // A term that claims itself as its parent is its own root, not a child.
    if (parentId && parentId !== term.remoteId && byId.has(parentId)) {
      const list = children.get(parentId) ?? [];
      list.push(term);
      children.set(parentId, list);
    } else {
      roots.push(term);
    }
  }
  for (const list of children.values()) list.sort(siblingOrder);
  roots.sort(siblingOrder);

  const out: T[] = [];
  const emitted = new Set<string>();
  const walk = (term: T) => {
    if (emitted.has(term.remoteId)) return;
    emitted.add(term.remoteId);
    out.push(term);
    for (const child of children.get(term.remoteId) ?? []) walk(child);
  };
  for (const root of roots) walk(root);
  // Anything left is inside a parent cycle; keep it visible.
  for (const term of [...terms].sort(siblingOrder)) walk(term);
  return out;
}

// ---------------------------------------------------------------------------
// Catalogue sync planning
// ---------------------------------------------------------------------------

/**
 * Split a page of products into the order they must be written in.
 *
 * A variation whose parent has not been inserted yet cannot be created —
 * `items.parent_item_id` is a NOT NULL requirement of `variant_child`. The
 * old sync discovered this one product at a time, threw
 * `parent_variant_not_found`, logged it, and moved on, so a page that
 * happened to list a variation before its parent lost it until the next run.
 * Two passes over the whole batch makes the ordering a property of the batch
 * rather than of the store's pagination.
 */
export function planWooCatalogueWrite<T extends { id: number; type?: string; parent_id?: number | null }>(
  products: T[],
): { containers: T[]; sellables: T[]; skipped: T[] } {
  const containers: T[] = [];
  const sellables: T[] = [];
  const skipped: T[] = [];
  const containerIds = new Set<string>();

  for (const product of products) {
    const shape = wooProductShape(inferWooProductType(product));
    if (shape.container) {
      containers.push(product);
      containerIds.add(String(product.id));
      continue;
    }
    if (shape.sellable) {
      sellables.push(product);
      continue;
    }
    // Nothing is unclassifiable now (`unknown` is sellable), but a future
    // shape that is neither must be reported rather than dropped silently.
    skipped.push(product);
  }

  // Variations whose parent is in this same batch wait for pass 2; the rest
  // are written in pass 1 with the containers, because their parent already
  // exists locally (or they have none).
  const deferred: T[] = [];
  const immediate: T[] = [];
  for (const product of sellables) {
    const shape = wooProductShape(inferWooProductType(product));
    if (shape.itemKind === "variant_child" && product.parent_id && containerIds.has(String(product.parent_id))) {
      deferred.push(product);
    } else {
      immediate.push(product);
    }
  }

  return { containers: [...containers, ...immediate], sellables: deferred, skipped };
}

/**
 * Which of a product's remote ids the app should keep a mapping for.
 *
 * A variable parent needs one (order lines for an unmapped variation fall
 * back to it), and so does every variation. A `grouped` product gets one for
 * itself for the same fallback reason even though it is not sellable.
 */
export function wooProductRemoteIds(product: WooProduct): string[] {
  return [String(product.id)];
}

/**
 * The REST path a remote id's updates go to.
 *
 * A variation is not `products/{id}`. It is
 * `products/{parent}/variations/{id}`, and calling the former with a
 * variation id is a 404 that the old outbox retried six times and then
 * dead-lettered — which is why pushing stock to a variation never worked.
 */
export function wooUpdatePath(remoteId: string, parentRemoteId?: string | null): string {
  if (parentRemoteId) return `products/${parentRemoteId}/variations/${remoteId}`;
  return `products/${remoteId}`;
}

// ---------------------------------------------------------------------------
// Catalogue listing rules (issue #943)
// ---------------------------------------------------------------------------
//
// The `/catalogue` API used to filter, count, facet and page the synced
// catalogue with inline array calls, and the dashboard then filtered the
// server's page *again* with a predicate that did not include `wooType` — so
// the same word could match a row in one place and not in the other, the type
// dropdown only listed the types on the visible page, and the page slice came
// out of a mapping list with no ORDER BY at all (two reads of one unchanged
// catalogue could page differently). The rules now live here, pure, so the
// route has exactly one predicate, one sort and one facet list — and so the
// UI never needs a second filter to disagree with the first.

/** The columns of a synced catalogue row the listing rules read. */
export interface CatalogueListRow {
  remoteId: string;
  name: string;
  sku: string | null;
  wooType: string;
  sellable: boolean;
  quantity: number | null;
  categories: string[];
  /** Product tags; optional so callers that never read tags keep their shape. */
  tags?: string[];
  attributes: string[];
}

export interface CatalogueListFilters {
  /** Case-insensitive substring over name, SKU, type, categories, tags, attributes. */
  search?: string;
  /** Exact WooCommerce type, as classified. */
  type?: string;
}

/**
 * The one search predicate. The UI must not re-filter server results with its
 * own variant of this — that mismatch (which excluded `wooType` client-side)
 * is the bug this single implementation removes.
 */
export function catalogueRowMatches(row: CatalogueListRow, filters: CatalogueListFilters): boolean {
  const type = filters.type?.trim() ?? "";
  if (type && row.wooType !== type) return false;
  const search = filters.search?.trim().toLowerCase() ?? "";
  if (!search) return true;
  const haystack = [row.name, row.sku ?? "", row.wooType, ...row.categories, ...(row.tags ?? []), ...row.attributes]
    .join(" ")
    .toLowerCase();
  return haystack.includes(search);
}

export function filterCatalogueRows<T extends CatalogueListRow>(rows: T[], filters: CatalogueListFilters): T[] {
  return rows.filter((row) => catalogueRowMatches(row, filters));
}

/**
 * A deterministic order for the catalogue: name in Persian reading order,
 * then the remote id as the tie-breaker (two products may share a name).
 * Without an explicit sort the page slice followed whatever order the
 * mapping table returned, so paging could repeat or skip a row between reads.
 */
export function sortCatalogueRows<T extends CatalogueListRow>(rows: T[]): T[] {
  return [...rows].sort(
    (a, b) => a.name.localeCompare(b.name, "fa") || a.remoteId.localeCompare(b.remoteId, "en"),
  );
}

/** Every product type present in the *whole* catalogue, not just one page. */
export function catalogueTypeFacets<T extends CatalogueListRow>(rows: T[]): string[] {
  return [...new Set(rows.map((row) => row.wooType).filter(Boolean))].sort((a, b) => a.localeCompare(b, "en"));
}

export interface CatalogueListSummary {
  total: number;
  sellable: number;
  containers: number;
  variations: number;
  outOfStock: number;
  uncategorised: number;
}

/** Counts over the whole mapped catalogue — always unfiltered. */
export function catalogueSummary<T extends CatalogueListRow>(rows: T[]): CatalogueListSummary {
  return {
    total: rows.length,
    sellable: rows.filter((row) => row.sellable).length,
    containers: rows.filter((row) => !row.sellable).length,
    variations: rows.filter((row) => classifyWooProductType(row.wooType) === "variation").length,
    outOfStock: rows.filter((row) => row.quantity === 0).length,
    uncategorised: rows.filter((row) => row.categories.length === 0).length,
  };
}

export interface CataloguePage<T> {
  rows: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

/**
 * Page a deterministically ordered list, clamping the request instead of
 * trusting it: page ≥ 1, 10 ≤ pageSize ≤ 100, and a page past the end
 * answers empty rather than wrapping or erroring.
 */
export function paginateCatalogueRows<T>(rows: T[], page: number, pageSize: number): CataloguePage<T> {
  const safePage = Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1;
  const safeSize = Number.isFinite(pageSize) ? Math.min(100, Math.max(10, Math.floor(pageSize))) : 25;
  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / safeSize));
  const offset = (safePage - 1) * safeSize;
  return { rows: rows.slice(offset, offset + safeSize), page: safePage, pageSize: safeSize, total, totalPages };
}
