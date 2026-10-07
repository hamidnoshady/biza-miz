/**
 * Phase 23 (issue #118) — the Integration Gateway: the only place in the app
 * that talks to a WooCommerce store.
 *
 * WooCommerce credentials are sent as HTTP Basic auth for `wc/v3` only
 * (consumer key = username, consumer secret = password), WooCommerce REST API
 * v3's recommended scheme. WordPress Core `wp/v2` calls require a separate
 * Application Password credential; Woo consumer keys are not silently reused
 * for posts/pages/media. The URL and auth-header construction is pure
 * (unit-tested); `fetch` is injectable so tests never touch the network and
 * the background outbox tick can pass a shared client around.
 *
 * Phase 38 widened it from "products and orders" to the whole catalogue:
 * variations, the taxonomy tree (categories, tags, attribute terms and the
 * custom taxonomies a store's plugins register), and the write endpoints the
 * app needs to *operate* a store rather than only nudge numbers on it. Two
 * namespaces are in play — `wc/v3` for commerce, `wp/v2` for taxonomies —
 * because WooCommerce's own REST API has never exposed arbitrary taxonomies.
 */

export interface WooCredentials {
  baseUrl: string;
  consumerKey: string;
  consumerSecret: string;
  /** WordPress Core REST username for wp/v2. Separate from Woo consumer key. */
  wpUsername?: string;
  /** WordPress Application Password for wp/v2. Separate from Woo consumer secret. */
  wpApplicationPassword?: string;
}

export interface WooProductAttribute {
  id: number;
  name: string;
  slug?: string;
  position: number;
  visible: boolean;
  variation: boolean;
  options: string[];
  /** Present on a variation's `attributes`, absent on a parent's. */
  option?: string;
}

export interface WooProductImage {
  id: number;
  src: string;
  alt: string;
  position: number;
}

export interface WooProductCategory {
  id: number;
  name: string;
  slug: string;
}

export interface WooVariationAttribute {
  name: string;
  option: string;
}

export interface WooMetaData {
  key?: string;
  value?: unknown;
}

/**
 * One product or variation, as WooCommerce's REST API returns it.
 *
 * Fields the app does not model are typed loosely on purpose: a store
 * running an extension adds fields, and `unknown`-ing them would make the
 * payload round-trip lossy for no gain.
 */
export interface WooProduct {
  id: number;
  /** `simple` | `variable` | `variation` | `grouped` | `external` | … — see woo-catalogue.ts. */
  type: string;
  name: string;
  sku: string;
  price: string;
  regular_price: string;
  sale_price?: string;
  manage_stock: boolean;
  stock_quantity: number | null;
  stock_status: string;
  status: string;
  description?: string;
  short_description?: string;
  permalink?: string;
  /** Non-zero on a variation: the variable product it belongs to. */
  parent_id?: number;
  /** Set on a `grouped` product: the ids it shelves. Not its children. */
  grouped_products?: number[];
  attributes?: WooProductAttribute[];
  variation_attributes?: WooVariationAttribute[];
  categories?: WooProductCategory[];
  tags?: WooProductCategory[];
  images?: WooProductImage[];
  menu_order?: number;
  catalog_visibility?: string;
  virtual?: boolean;
  downloadable?: boolean;
  tax_class?: string;
  weight?: string;
  /** Date the store last wrote this row — the watermark for an incremental pull. */
  date_modified?: string;
  meta_data?: WooMetaData[];
}

/** One variation, as `products/{parent}/variations` returns it. */
export interface WooVariation extends Omit<WooProduct, "type"> {
  type?: string;
  /** The variable parent. Always present on this endpoint. */
  parent_id: number;
}

/**
 * One term of any taxonomy — `product_cat`, `product_tag`, `pa_colour`, or
 * a custom taxonomy the store registered.
 */
export interface WooTerm {
  id: number;
  name: string;
  slug: string;
  parent: number;
  description: string;
  count: number;
  menu_order?: number;
  taxonomy?: string;
}

/**
 * One taxonomy as `/wp-json/wp/v2/taxonomies` reports it.
 *
 * This is the only way to discover a store's *custom* taxonomies (a brand, a
 * fabric, a region — anything a theme or plugin added), which is why the
 * client reaches outside `wc/v3` at all.
 */
export interface WooTaxonomy {
  name: string;
  slug: string;
  description: string;
  /** Its REST base, used to list its terms: `product_cat`, `brand`, … */
  rest_base: string;
  types: string[];
  hierarchical: boolean;
  visibility?: Record<string, unknown>;
}

/** One global product attribute (`wc/v3/products/attributes`). */
export interface WooAttribute {
  id: number;
  name: string;
  slug: string;
  type: string;
  order_by: string;
  has_archives: boolean;
  /** `pa_colour` on a modern store, `colour` on an older one. */
  taxonomy?: string;
}

/** One value of a global attribute (`wc/v3/products/attributes/{id}/terms`). */
export interface WooAttributeTerm extends WooTerm {
  menu_order?: number;
}

export interface WooCustomer {
  id: number;
  email: string;
  first_name: string;
  last_name: string;
  billing?: { phone?: string; address_1?: string; city?: string; email?: string };
}

/**
 * One order line.
 *
 * `variation_id` is the field Phase 38 turned on. WooCommerce sends both it
 * and `product_id`, and for a variable product they are different rows: the
 * variation is the one with a SKU, a price and stock. Reading only
 * `product_id` — as every path did before — resolved a variation line to its
 * parent, which is created as a non-sellable container with no stock row, so
 * the sale recorded revenue and silently dropped its COGS.
 */
export interface WooOrderLineItem {
  id: number;
  name: string;
  product_id: number;
  /** Non-zero when the line is a specific variation of a variable product. */
  variation_id?: number;
  quantity: number;
  price: string;
  total: string;
  subtotal?: string;
  total_tax?: string;
  sku?: string;
  /** The parent product's name — what a customer would call what they bought. */
  parent_name?: string;
  meta_data?: WooMetaData[];
}

export interface WooOrder {
  id: number;
  number: string;
  status: string;
  total: string;
  total_tax: string;
  currency: string;
  date_created: string;
  payment_method: string;
  line_items: WooOrderLineItem[];
  billing?: {
    first_name?: string;
    last_name?: string;
    phone?: string;
    email?: string;
    address_1?: string;
    city?: string;
    company?: string;
  };
  shipping?: { address_1?: string; city?: string };
  /** 0 for a guest checkout — the common case, and why billing is matched on. */
  customer_id?: number;
  /** The watermark for an incremental order pull. */
  date_modified?: string;
  date_paid?: string | null;
  /** UTC twins of the store-local dates above (no offset, by Woo's convention). */
  date_created_gmt?: string;
  date_paid_gmt?: string | null;
  date_completed?: string | null;
  date_completed_gmt?: string | null;
  discount_total?: string;
  shipping_total?: string;
  fee_lines?: { name?: string; total: string }[];
  meta_data?: WooMetaData[];
}

export interface WooRefundLineItem {
  product_id: number;
  /** The variation, when the refunded line was one. */
  variation_id?: number;
  /** Negative for refunds (the WooCommerce convention). */
  quantity: number;
  /** Negative for refunds. */
  total: string;
}

export interface WooRefund {
  id: number;
  /** The order the refund belongs to. */
  parent_id: number;
  date_created: string;
  amount: string;
  total_tax?: string;
  reason: string;
  line_items?: WooRefundLineItem[];
  meta_data?: WooMetaData[];
}

export interface WooList<T> {
  items: T[];
  totalPages: number;
}

export type FetchLikeResponse = {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  /** Needed to read `X-WP-TotalPages`; optional so existing mocks keep working. */
  headers?: { get(name: string): string | null };
};

export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<FetchLikeResponse>;

export class WooCommerceError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** `consumerKey:consumerSecret` in base64 — the WooCommerce wc/v3 Basic auth credential. */
export function wooAuthHeader(credentials: WooCredentials): string {
  return `Basic ${Buffer.from(`${credentials.consumerKey}:${credentials.consumerSecret}`).toString("base64")}`;
}

/** `wpUsername:wpApplicationPassword` in base64 — WordPress Core wp/v2 auth. */
export function wpAuthHeader(credentials: WooCredentials): string {
  if (!credentials.wpUsername || !credentials.wpApplicationPassword) {
    throw new WooCommerceError("wordpress_credentials_missing", 401);
  }
  return `Basic ${Buffer.from(`${credentials.wpUsername}:${credentials.wpApplicationPassword}`).toString("base64")}`;
}

/** The REST API URL for a path, keeping the store's base exactly as given. */
export function wooApiUrl(
  baseUrl: string,
  path: string,
  query?: Record<string, string | number | boolean>,
): string {
  return namespacedApiUrl(baseUrl, "wc/v3", path, query);
}

/**
 * A WordPress core REST URL (`/wp-json/wp/v2/…`).
 *
 * Taxonomies — including every custom one a store registers — are only
 * published here. WooCommerce's own namespace exposes `product_cat`,
 * `product_tag` and its attributes and nothing else, so a shop whose
 * catalogue is organised by a `brand` taxonomy was invisible to this app.
 */
export function wpApiUrl(
  baseUrl: string,
  path: string,
  query?: Record<string, string | number | boolean>,
): string {
  return namespacedApiUrl(baseUrl, "wp/v2", path, query);
}

function namespacedApiUrl(
  baseUrl: string,
  namespace: string,
  path: string,
  query?: Record<string, string | number | boolean>,
): string {
  const base = baseUrl.replace(/\/+$/, "");
  const endpoint = `/wp-json/${namespace}/${path.replace(/^\/+/, "")}`;
  if (!query) return `${base}${endpoint}`;
  const qs = Object.entries(query)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
  return qs ? `${base}${endpoint}?${qs}` : `${base}${endpoint}`;
}

interface RequestOptions {
  query?: Record<string, string | number | boolean>;
  body?: unknown;
  /** Which namespace — `wc/v3` unless a taxonomy's `rest_base` says otherwise. */
  namespace?: "wc/v3" | "wp/v2";
}

async function request<T>(
  credentials: WooCredentials,
  fetchImpl: FetchLike,
  method: string,
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const namespace = options.namespace ?? "wc/v3";
  const url = namespacedApiUrl(credentials.baseUrl, namespace, path, options.query);
  const response = await fetchImpl(url, {
    method,
    headers: {
      Authorization: namespace === "wp/v2" ? wpAuthHeader(credentials) : wooAuthHeader(credentials),
      "Content-Type": "application/json",
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const json = (await response.json()) as T & { code?: string; message?: string };
  if (!response.ok) {
    throw new WooCommerceError(json?.message ?? `woocommerce_${method.toLowerCase()}_failed`, response.status);
  }
  return json as T;
}

/**
 * One page, plus the store's own page count.
 *
 * `X-WP-TotalPages` is authoritative; guessing from a full page costs an
 * extra empty request at the end of every sync and — worse — stops early on
 * a store whose last page holds exactly `per_page` rows of deleted-but-
 * returned products.
 */
async function requestPage<T>(
  credentials: WooCredentials,
  fetchImpl: FetchLike,
  path: string,
  options: RequestOptions & { page?: number },
): Promise<WooList<T>> {
  const query = { ...(options.query ?? {}) };
  if (options.page) query.page = options.page;
  const url = namespacedApiUrl(credentials.baseUrl, options.namespace ?? "wc/v3", path, query);
  const response = await fetchImpl(url, {
    method: "GET",
    headers: { Authorization: wooAuthHeader(credentials), "Content-Type": "application/json" },
  });
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    // A WAF interstitial, a cached HTML error page, a truncated body — none
    // of it is a list. Letting JSON.parse's own error escape reported a
    // bare syntax error with no status and no hint of which request made
    // it, which is exactly the "sync just doesn't work" report that cannot
    // be diagnosed from the app side.
    throw new WooCommerceError(`woocommerce_list_failed_http_${response.status}`, response.status);
  }
  const err = (json ?? {}) as { code?: string; message?: string };
  if (!response.ok) {
    throw new WooCommerceError(err?.message ?? "woocommerce_list_failed", response.status);
  }
  const totalPagesHeader = response.headers?.get("X-WP-TotalPages");
  const parsed = totalPagesHeader ? Number.parseInt(totalPagesHeader, 10) : Number.NaN;
  const items = Array.isArray(json) ? json : [];
  // The page number reaches here two ways: `options.page` (the internal
  // helpers) or `query.page` (the public listProductsPage/listOrdersPage/
  // listCustomersPage shape). Read the *merged* query so both work — the old
  // fallback read only `options.page`, so the public helpers' header-less
  // fallback always believed it was on page 1.
  const page = Number(query.page ?? options.page) || 1;
  const perPage = Number(query.per_page ?? 0);
  const totalPages = Number.isFinite(parsed) && parsed > 0
    ? parsed
    : items.length === 0
      ? 0
      : // A store that withholds the header (a caching proxy, an old
        // WooCommerce) still syncs: a full page promises one more look, a
        // short page is the last one. The previous fallback returned the
        // *current* page as the final one, so any store whose proxy strips
        // response headers had every sync silently truncated to its first
        // 100 rows — "only some of my products are in the app".
        perPage > 0 && items.length >= perPage
        ? page + 1
        : page;
  return { items, totalPages };
}

export interface WooCommerceClient {
  listProducts(query?: Record<string, string | number | boolean>): Promise<WooProduct[]>;
  listProductsPage(
    query: Record<string, string | number | boolean> & { page: number },
  ): Promise<WooList<WooProduct>>;
  getProduct(id: number): Promise<WooProduct>;
  updateProduct(id: number, patch: Record<string, unknown>): Promise<WooProduct>;
  listVariations(parentId: number, query?: Record<string, string | number | boolean>): Promise<WooProduct[]>;
  updateVariation(parentId: number, variationId: number, patch: Record<string, unknown>): Promise<WooProduct>;
  listCategories(query?: Record<string, string | number | boolean>): Promise<WooTerm[]>;
  listTags(query?: Record<string, string | number | boolean>): Promise<WooTerm[]>;
  listAttributes(): Promise<WooAttribute[]>;
  listAttributeTerms(attributeId: number): Promise<WooAttributeTerm[]>;
  listTaxonomies(): Promise<WooTaxonomy[]>;
  listTerms(taxonomy: string, query?: Record<string, string | number | boolean>): Promise<WooTerm[]>;
  listOrders(query?: Record<string, string | number | boolean>): Promise<WooOrder[]>;
  /** One page of orders plus the store's page count — the scheduled pull pages with it. */
  listOrdersPage(
    query: Record<string, string | number | boolean> & { page: number },
  ): Promise<WooList<WooOrder>>;
  getOrder(id: number): Promise<WooOrder>;
  updateOrder(id: number, patch: Record<string, unknown>): Promise<WooOrder>;
  listRefunds(query?: Record<string, string | number | boolean>): Promise<WooRefund[]>;
  listOrderRefunds(orderId: number): Promise<WooRefund[]>;
  createRefund(orderId: number, body: Record<string, unknown>): Promise<WooRefund>;
  listCustomers(query?: Record<string, string | number | boolean>): Promise<WooCustomer[]>;
  /** One page of WordPress core content (posts/pages/media) over wp/v2. */
  wpListPage(
    type: "posts" | "pages" | "media" | string,
    query: Record<string, string | number | boolean> & { page: number },
  ): Promise<WooList<Record<string, unknown>>>;
  /** Create or update one WordPress post/page over wp/v2 (id omitted = create). */
  wpUpsertPost(
    type: "posts" | "pages",
    body: Record<string, unknown>,
    id?: number,
  ): Promise<Record<string, unknown>>;
  /**
   * One page of customers plus the store's page count.
   *
   * `listCustomers` is a one-page convenience read; a full sync that called
   * it with `per_page=100` still only ever saw the first hundred — which is
   * how a store with six hundred customers synced twenty of them. The sync
   * loop pages with this instead, the same way products and variations do.
   */
  listCustomersPage(
    query: Record<string, string | number | boolean> & { page: number },
  ): Promise<WooList<WooCustomer>>;
  /** Write to any REST path — used for variation paths the typed helpers wrap. */
  updateAt(path: string, patch: Record<string, unknown>): Promise<WooProduct>;
}

export function createWooCommerceClient(
  credentials: WooCredentials,
  fetchImpl: FetchLike = (url, init) =>
    fetch(url, init).then((r) => ({ ok: r.ok, status: r.status, json: () => r.json(), headers: r.headers })),
): WooCommerceClient {
  const get = <T>(path: string, query?: Record<string, string | number | boolean>) =>
    request<T>(credentials, fetchImpl, "GET", path, { query });
  const getWp = <T>(path: string, query?: Record<string, string | number | boolean>) =>
    request<T>(credentials, fetchImpl, "GET", path, { query, namespace: "wp/v2" });

  return {
    listProducts: (query) => get<WooProduct[]>("products", query),
    listProductsPage: (query) =>
      requestPage<WooProduct>(credentials, fetchImpl, "products", { query }),
    getProduct: (id) => get<WooProduct>(`products/${id}`),
    updateProduct: (id, patch) =>
      request<WooProduct>(credentials, fetchImpl, "PUT", `products/${id}`, { body: patch }),

    /**
     * A variable product's sellable children.
     *
     * `/products` does not include them — this endpoint is the only way to
     * see them over REST, and before Phase 38 nothing called it, so a REST
     * connection never had a variation to map.
     */
    listVariations: async (parentId, query) => {
      const all: WooProduct[] = [];
      let page = 1;
      for (;;) {
        const { items, totalPages } = await requestPage<WooProduct>(credentials, fetchImpl, `products/${parentId}/variations`, {
          query: { per_page: 100, ...(query ?? {}) },
          page,
        });
        // A variation resource omits `type`; the parent id is what makes it
        // one, and the sync infers the rest from that.
        all.push(...items.map((v) => ({ ...v, type: v.type ?? "variation", parent_id: parentId })));
        if (!totalPages || page >= totalPages) break;
        page += 1;
      }
      return all;
    },
    updateVariation: (parentId, variationId, patch) =>
      request<WooProduct>(credentials, fetchImpl, "PUT", `products/${parentId}/variations/${variationId}`, {
        body: patch,
      }),

    listCategories: async (query) => {
      const all: WooTerm[] = [];
      let page = 1;
      for (;;) {
        const { items, totalPages } = await requestPage<WooTerm>(credentials, fetchImpl, "products/categories", {
          query: { per_page: 100, ...(query ?? {}) },
          page,
        });
        all.push(...items);
        if (!totalPages || page >= totalPages) break;
        page += 1;
      }
      return all;
    },
    listTags: async (query) => {
      const all: WooTerm[] = [];
      let page = 1;
      for (;;) {
        const { items, totalPages } = await requestPage<WooTerm>(credentials, fetchImpl, "products/tags", {
          query: { per_page: 100, ...(query ?? {}) },
          page,
        });
        all.push(...items);
        if (!totalPages || page >= totalPages) break;
        page += 1;
      }
      return all;
    },
    listAttributes: () => get<WooAttribute[]>("products/attributes", { per_page: 100 }),
    listAttributeTerms: async (attributeId) => {
      const all: WooAttributeTerm[] = [];
      let page = 1;
      for (;;) {
        const { items, totalPages } = await requestPage<WooAttributeTerm>(
          credentials,
          fetchImpl,
          `products/attributes/${attributeId}/terms`,
          { query: { per_page: 100 }, page },
        );
        all.push(...items);
        if (!totalPages || page >= totalPages) break;
        page += 1;
      }
      return all;
    },

    /**
     * Every taxonomy the store publishes, not just WooCommerce's own.
     *
     * Filtered to the ones that apply to products: a store also publishes
     * `category` (blog posts) and `post_tag`, and syncing those would fill
     * the taxonomy browser with a blog.
     */
    listTaxonomies: async () => {
      const all = await getWp<Record<string, WooTaxonomy>>("taxonomies");
      const values = all && typeof all === "object" ? Object.values(all) : [];
      return values.filter((t) => (t.types ?? []).includes("product"));
    },
    listTerms: async (taxonomy, query) => {
      const all: WooTerm[] = [];
      let page = 1;
      for (;;) {
        const { items, totalPages } = await requestPage<WooTerm>(credentials, fetchImpl, taxonomy, {
          query: { per_page: 100, ...(query ?? {}) },
          page,
          namespace: "wp/v2",
        });
        // wp/v2 terms do not carry their taxonomy; the caller sorts by it.
        all.push(...items.map((t) => ({ ...t, taxonomy })));
        if (!totalPages || page >= totalPages) break;
        page += 1;
      }
      return all;
    },

    listOrders: (query) => get<WooOrder[]>("orders", query),
    listOrdersPage: (query) => requestPage<WooOrder>(credentials, fetchImpl, "orders", { query }),
    getOrder: (id) => get<WooOrder>(`orders/${id}`),
    updateOrder: (id, patch) =>
      request<WooOrder>(credentials, fetchImpl, "PUT", `orders/${id}`, { body: patch }),
    listRefunds: (query) => get<WooRefund[]>("refunds", query),
    listOrderRefunds: (orderId) => get<WooRefund[]>(`orders/${orderId}/refunds`),
    createRefund: (orderId, body) =>
      request<WooRefund>(credentials, fetchImpl, "POST", `orders/${orderId}/refunds`, { body }),
    listCustomers: (query) => get<WooCustomer[]>("customers", query),
    listCustomersPage: (query) => requestPage<WooCustomer>(credentials, fetchImpl, "customers", { query }),
    // WordPress core content. wp/v2 requires a WordPress Application Password;
    // WooCommerce consumer keys are deliberately not reused here.
    wpListPage: (type, query) =>
      requestPage<Record<string, unknown>>(credentials, fetchImpl, type, {
        query: { context: "view", ...query },
        namespace: "wp/v2",
      }),
    // wp/v2 uses POST for both create (…/posts) and update (…/posts/{id}) —
    // it has no PUT for content — so the method is constant and only the path
    // gains the id when updating.
    wpUpsertPost: (type, body, id) =>
      request<Record<string, unknown>>(
        credentials,
        fetchImpl,
        "POST",
        id ? `${type}/${id}` : type,
        { body, namespace: "wp/v2" },
      ),
    updateAt: (path, patch) => request<WooProduct>(credentials, fetchImpl, "PUT", path, { body: patch }),
  };
}
