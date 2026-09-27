/**
 * Eshobe CMS — the Website Manager service (issue #378's subject, built on
 * the headless integration).
 *
 * The screen-level orchestration: connect a business to its CMS site (test
 * first, then store the key encrypted), or provision a brand-new site from
 * the operator's platform key; then read the site's descriptor, pages,
 * products and orders, and move order statuses.
 *
 * All validation returns an error *code* the API layer maps to a status and
 * the UI maps to Persian (see src/app/dashboard/ui.tsx) — the same contract
 * `connections-service.ts` uses. DB-touching, per repo convention not unit
 * tested directly; the client it leans on is (client.test.ts).
 */
import { promises as dns } from "node:dns";
import {
  CmsApiError,
  CmsNetworkError,
  createPage,
  createPost,
  deletePage,
  fetchMedia,
  deleteMedia,
  updateMedia,
  fetchRegistrarQuote,
  fetchSiteCdnStatus,
  orderRegistrarDomain,
  purgeSiteCdn,
  type RegistrarQuote,
  type SiteCdnStatus,
  createProduct,
  deletePost,
  deleteProduct,
  fetchOrders,
  fetchPages,
  fetchPosts,
  fetchProducts,
  fetchSiteDescriptor,
  issueSiteApiKey,
  provisionSite,
  updateOrderStatus,
  updatePage,
  updatePost,
  updateProduct,
  updateSiteDomain as updateSiteDomainOnCms,
  type CmsConfig,
} from "./client";
import {
  simpleLexicalRoot,
  type CmsMedia,
  type CmsOrder,
  type CmsPage,
  type CmsPost,
  type CmsProduct,
  type SiteDescriptor,
} from "./types";
// Migration 0139: the platform credential now lives in `platform_cms_config`
// (encrypted, editable in the super-admin console) with the ESHOBE_CMS_* env pair
// as the fallback for deployments configured before it. `resolvePlatformCmsConfig`
// is that resolution in one place; `cmsPlatformConfig(process.env)` is the env half
// and is no longer called directly, so a rotated key is a form submission rather
// than a redeploy.
import { resolvePlatformCmsConfig } from "./platform-control-service";
import { inboxStatusForCmsOrders } from "./order-inbox-service";
import { dnsHint, ipsOverlap, type DnsCheck } from "./dns";
import {
  CmsConnectionError,
  deleteCmsConnection,
  getCmsConfigForBusiness,
  listCmsConnections,
  saveCmsConnection,
  updateCmsConnectionDomain,
  type CmsConnectionSummary,
} from "./connections";
import { publishOwnerContent } from "./owner-bridge";

const DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const SITE_TYPES = ["business", "portfolio", "store"] as const;

export interface WebsiteConnectInput {
  baseUrl: string;
  siteDomain: string;
  apiKey: string;
  keyName?: string;
}

export interface WebsiteProvisionInput {
  name: string;
  domain: string;
  type: (typeof SITE_TYPES)[number];
}

export type WebsiteResult<T> = { ok: true; data: T } | { ok: false; error: string };

/** Masked connection state — safe for the browser. */
export async function cmsWebsiteState(businessId: string): Promise<CmsConnectionSummary | null> {
  const rows = await listCmsConnections(businessId);
  return rows[0] ?? null;
}

/**
 * Connect an *existing* CMS site: probe it with the credentials first
 * (descriptor answers one call: does the key work, which site is it), then
 * store the key encrypted. `SiteDescriptor.id` came with the CMS's
 * `/api/site` (patch §5) — it is what revalidation tags key on.
 */
export async function connectCmsWebsite(
  businessId: string,
  input: WebsiteConnectInput,
): Promise<WebsiteResult<{ site: SiteDescriptor; connection: CmsConnectionSummary }>> {
  const baseUrl = input.baseUrl.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//.test(baseUrl)) return { ok: false, error: "invalid_cms_base_url" };

  const domain = input.siteDomain.trim().toLowerCase().replace(/\.$/, "");
  if (!DOMAIN_RE.test(domain)) return { ok: false, error: "invalid_domain" };

  const apiKey = input.apiKey.trim();
  if (!apiKey.startsWith("eshobe_live_")) return { ok: false, error: "invalid_api_key" };

  const probe: CmsConfig = { baseUrl, siteDomain: domain, apiKey };
  let site: SiteDescriptor;
  try {
    site = await fetchSiteDescriptor(probe);
  } catch (error) {
    if (error instanceof CmsApiError) return { ok: false, error: "connection_failed" };
    if (error instanceof CmsNetworkError) return { ok: false, error: "cms_unreachable" };
    return { ok: false, error: "connection_failed" };
  }
  if (!site.id) return { ok: false, error: "cms_old_version" };

  // The probe resolved the tenant; the descriptor's own domain is the answer
  // that must win — a key pasted for the wrong domain is a config error, not
  // a silent cross-tenant connect.
  if (site.domain !== domain) return { ok: false, error: "domain_mismatch" };

  await saveCmsConnection({
    businessId,
    siteId: site.id,
    siteDomain: domain,
    baseUrl,
    apiKey,
    keyName: input.keyName?.trim() || `پنل مدیریت (${domain})`,
  });

  return { ok: true, data: { site, connection: (await cmsWebsiteState(businessId))! } };
}

/**
 * Provision a new site from the operator's platform key: the CMS creates the
 * site + starter content (Wave 5), we issue its site key in the same breath
 * and store it — the business is connected before the UI ever returns.
 */
export async function provisionCmsWebsite(
  businessId: string,
  input: WebsiteProvisionInput,
): Promise<WebsiteResult<{ site: Provisioned; connection: CmsConnectionSummary }>> {
  const platform = await resolvePlatformCmsConfig();
  if (!platform) return { ok: false, error: "cms_not_configured" };

  const name = input.name.trim();
  if (!name || name.length > 120) return { ok: false, error: "invalid_name" };
  const domain = input.domain.trim().toLowerCase().replace(/\.$/, "");
  if (!DOMAIN_RE.test(domain)) return { ok: false, error: "invalid_domain" };
  if (!SITE_TYPES.includes(input.type)) return { ok: false, error: "invalid_type" };

  let site;
  try {
    site = await provisionSite(platform, { name, domain, type: input.type });
  } catch (error) {
    if (error instanceof CmsApiError) return { ok: false, error: "provision_failed" };
    if (error instanceof CmsNetworkError) return { ok: false, error: "cms_unreachable" };
    return { ok: false, error: "provision_failed" };
  }

  let key;
  try {
    key = await issueSiteApiKey(platform, {
      siteId: site.site.id,
      name: `اتصال پنل مدیریت (${domain})`,
      role: "site",
    });
  } catch (error) {
    return { ok: false, error: error instanceof CmsNetworkError ? "cms_unreachable" : "key_issue_failed" };
  }

  await saveCmsConnection({
    businessId,
    siteId: site.site.id,
    siteDomain: site.site.domain,
    baseUrl: platform.baseUrl,
    apiKey: key.key,
    keyName: `اتصال پنل مدیریت (${domain})`,
  });

  return { ok: true, data: { site, connection: (await cmsWebsiteState(businessId))! } };
}

export async function disconnectCmsWebsite(businessId: string): Promise<void> {
  await deleteCmsConnection(businessId);
}

export interface WebsiteOverview {
  site: SiteDescriptor;
  pages: CmsPage[];
  posts: CmsPost[];
  products: CmsProduct[];
  orders: CmsOrder[];
  orderInbox: Record<
    string,
    {
      status: "pending" | "processed" | "failed" | "duplicate";
      error: string | null;
      importedOrderId: string | null;
      reversed: boolean;
    }
  >;
}

/** The connected site, in one call. Every read is cached by the CMS itself. */
export async function cmsWebsiteOverview(businessId: string): Promise<WebsiteResult<WebsiteOverview>> {
  let config: CmsConfig;
  try {
    config = await getCmsConfigForBusiness(businessId);
  } catch (error) {
    return { ok: false, error: error instanceof CmsConnectionError ? "not_connected" : "cms_config_error" };
  }

  try {
    const [site, pages, posts, products, orders] = await Promise.all([
      fetchSiteDescriptor(config),
      fetchPages(config, { limit: 20 }),
      fetchPosts(config, { limit: 20 }),
      fetchProducts(config, { limit: 50 }),
      fetchOrders(config, { limit: 50 }),
    ]);
    const connections = await listCmsConnections(businessId);
    const orderInbox = connections[0]
      ? await inboxStatusForCmsOrders(connections[0].id, orders.docs.map((o) => o.id))
      : {};

    return {
      ok: true,
      data: {
        site,
        pages: pages.docs,
        posts: posts.docs,
        products: products.docs,
        orders: orders.docs,
        orderInbox,
      },
    };
  } catch (error) {
    if (error instanceof CmsNetworkError) return { ok: false, error: "cms_unreachable" };
    if (error instanceof CmsApiError && error.status === 404) return { ok: false, error: "not_connected" };
    return { ok: false, error: "cms_error" };
  }
}

/** Shared 4xx/5xx → `WebsiteResult` error-code mapping for the CRUD writes below. */
function mapCmsWriteError(error: unknown): WebsiteResult<never> {
  if (error instanceof CmsNetworkError) return { ok: false, error: "cms_unreachable" };
  if (error instanceof CmsApiError) {
    if (error.status === 404) return { ok: false, error: "not_found" };
    if (error.status === 403) return { ok: false, error: "forbidden" };
    if (error.status === 409) return { ok: false, error: "domain_taken" };
  }
  return { ok: false, error: "cms_error" };
}

export interface CmsPostInput {
  title: string;
  content: string;
  heroImage?: string;
  categories?: string[];
}

function validatePostInput(
  input: Partial<CmsPostInput>,
  opts: { requireAll: boolean },
): { ok: false; error: string } | null {
  if ((opts.requireAll || input.title !== undefined) && !input.title?.trim()) {
    return { ok: false, error: "title_required" };
  }
  if (input.title !== undefined && input.title.trim().length > 200) return { ok: false, error: "field_too_long" };
  if ((opts.requireAll || input.content !== undefined) && !input.content?.trim()) {
    return { ok: false, error: "content_required" };
  }
  return null;
}

export async function createCmsPost(businessId: string, input: CmsPostInput): Promise<WebsiteResult<CmsPost>> {
  const invalid = validatePostInput(input, { requireAll: true });
  if (invalid) return invalid;

  let config: CmsConfig;
  try {
    config = await getCmsConfigForBusiness(businessId);
  } catch {
    return { ok: false, error: "not_connected" };
  }

  try {
    const post = await createPost(config, {
      title: input.title.trim(),
      content: simpleLexicalRoot(input.content),
      heroImage: input.heroImage,
      categories: input.categories,
    });
    return { ok: true, data: post };
  } catch (error) {
    return mapCmsWriteError(error);
  }
}

export async function updateCmsPost(
  businessId: string,
  id: string,
  input: Partial<CmsPostInput>,
): Promise<WebsiteResult<CmsPost>> {
  const invalid = validatePostInput(input, { requireAll: false });
  if (invalid) return invalid;

  let config: CmsConfig;
  try {
    config = await getCmsConfigForBusiness(businessId);
  } catch {
    return { ok: false, error: "not_connected" };
  }

  try {
    const post = await updatePost(config, id, {
      ...(input.title !== undefined ? { title: input.title.trim() } : {}),
      ...(input.content !== undefined ? { content: simpleLexicalRoot(input.content) } : {}),
      ...(input.heroImage !== undefined ? { heroImage: input.heroImage } : {}),
      ...(input.categories !== undefined ? { categories: input.categories } : {}),
    });
    return { ok: true, data: post };
  } catch (error) {
    return mapCmsWriteError(error);
  }
}

export async function deleteCmsPost(businessId: string, id: string): Promise<WebsiteResult<null>> {
  let config: CmsConfig;
  try {
    config = await getCmsConfigForBusiness(businessId);
  } catch {
    return { ok: false, error: "not_connected" };
  }

  try {
    await deletePost(config, id);
    return { ok: true, data: null };
  } catch (error) {
    return mapCmsWriteError(error);
  }
}

export async function publishCmsPost(businessId: string, id: string): Promise<WebsiteResult<{ id: string }>> {
  const result = await publishOwnerContent(businessId, "posts", id);
  if (!result.ok) return result;
  return { ok: true, data: { id } };
}

export async function publishCmsPage(businessId: string, id: string): Promise<WebsiteResult<{ id: string }>> {
  const result = await publishOwnerContent(businessId, "pages", id);
  if (!result.ok) return result;
  return { ok: true, data: { id } };
}

export async function publishCmsProduct(businessId: string, id: string): Promise<WebsiteResult<{ id: string }>> {
  const result = await publishOwnerContent(businessId, "products", id);
  if (!result.ok) return result;
  return { ok: true, data: { id } };
}

export interface CmsPageInput {
  title: string;
  slug?: string;
}

export async function listCmsPages(
  businessId: string,
  opts?: { limit?: number; page?: number },
): Promise<WebsiteResult<{ pages: CmsPage[]; totalDocs: number }>> {
  let config: CmsConfig;
  try {
    config = await getCmsConfigForBusiness(businessId);
  } catch {
    return { ok: false, error: "not_connected" };
  }
  try {
    const list = await fetchPages(config, { limit: opts?.limit ?? 50, page: opts?.page });
    return { ok: true, data: { pages: list.docs, totalDocs: list.totalDocs ?? list.docs.length } };
  } catch (error) {
    if (error instanceof CmsNetworkError) return { ok: false, error: "cms_unreachable" };
    return { ok: false, error: "cms_error" };
  }
}

export async function createCmsPage(businessId: string, input: CmsPageInput): Promise<WebsiteResult<CmsPage>> {
  if (!input.title?.trim()) return { ok: false, error: "title_required" };
  if (input.title.trim().length > 200) return { ok: false, error: "field_too_long" };
  let config: CmsConfig;
  try {
    config = await getCmsConfigForBusiness(businessId);
  } catch {
    return { ok: false, error: "not_connected" };
  }
  try {
    const page = await createPage(config, { title: input.title.trim(), slug: input.slug?.trim() });
    return { ok: true, data: page };
  } catch (error) {
    return mapCmsWriteError(error);
  }
}

export async function updateCmsPage(
  businessId: string,
  id: string,
  input: Partial<CmsPageInput>,
): Promise<WebsiteResult<CmsPage>> {
  if (input.title !== undefined && !input.title.trim()) return { ok: false, error: "title_required" };
  let config: CmsConfig;
  try {
    config = await getCmsConfigForBusiness(businessId);
  } catch {
    return { ok: false, error: "not_connected" };
  }
  try {
    const page = await updatePage(config, id, {
      ...(input.title !== undefined ? { title: input.title.trim() } : {}),
      ...(input.slug !== undefined ? { slug: input.slug.trim() } : {}),
    });
    return { ok: true, data: page };
  } catch (error) {
    return mapCmsWriteError(error);
  }
}

export async function deleteCmsPage(businessId: string, id: string): Promise<WebsiteResult<null>> {
  let config: CmsConfig;
  try {
    config = await getCmsConfigForBusiness(businessId);
  } catch {
    return { ok: false, error: "not_connected" };
  }
  try {
    await deletePage(config, id);
    return { ok: true, data: null };
  } catch (error) {
    return mapCmsWriteError(error);
  }
}

export async function listCmsMedia(
  businessId: string,
  opts?: { limit?: number; page?: number },
): Promise<WebsiteResult<{ media: CmsMedia[]; totalDocs: number }>> {
  let config: CmsConfig;
  try {
    config = await getCmsConfigForBusiness(businessId);
  } catch {
    return { ok: false, error: "not_connected" };
  }
  try {
    const list = await fetchMedia(config, { limit: opts?.limit ?? 24, page: opts?.page });
    return { ok: true, data: { media: list.docs, totalDocs: list.totalDocs ?? list.docs.length } };
  } catch (error) {
    if (error instanceof CmsNetworkError) return { ok: false, error: "cms_unreachable" };
    return { ok: false, error: "cms_error" };
  }
}

export async function updateCmsMediaAlt(
  businessId: string,
  id: string,
  alt: string,
): Promise<WebsiteResult<CmsMedia>> {
  let config: CmsConfig;
  try {
    config = await getCmsConfigForBusiness(businessId);
  } catch {
    return { ok: false, error: "not_connected" };
  }
  try {
    const media = await updateMedia(config, id, { alt: alt.trim() });
    return { ok: true, data: media };
  } catch (error) {
    return mapCmsWriteError(error);
  }
}

export async function deleteCmsMedia(businessId: string, id: string): Promise<WebsiteResult<null>> {
  let config: CmsConfig;
  try {
    config = await getCmsConfigForBusiness(businessId);
  } catch {
    return { ok: false, error: "not_connected" };
  }
  try {
    await deleteMedia(config, id);
    return { ok: true, data: null };
  } catch (error) {
    return mapCmsWriteError(error);
  }
}

export interface CmsProductInput {
  title: string;
  price: number;
  summary?: string;
  image?: string;
  sku?: string;
  trackInventory?: boolean;
  inventory?: number;
  compareAtPrice?: number;
}

function validateProductInput(
  input: Partial<CmsProductInput>,
  opts: { requireAll: boolean },
): { ok: false; error: string } | null {
  if ((opts.requireAll || input.title !== undefined) && !input.title?.trim()) {
    return { ok: false, error: "title_required" };
  }
  if (input.title !== undefined && input.title.trim().length > 200) return { ok: false, error: "field_too_long" };
  if (opts.requireAll || input.price !== undefined) {
    if (!Number.isInteger(input.price) || (input.price as number) < 0) return { ok: false, error: "invalid_price" };
  }
  if (input.compareAtPrice !== undefined && (!Number.isInteger(input.compareAtPrice) || input.compareAtPrice < 0)) {
    return { ok: false, error: "invalid_price" };
  }
  if (input.inventory !== undefined && (!Number.isInteger(input.inventory) || input.inventory < 0)) {
    return { ok: false, error: "invalid_inventory" };
  }
  return null;
}

export async function createCmsProduct(businessId: string, input: CmsProductInput): Promise<WebsiteResult<CmsProduct>> {
  const invalid = validateProductInput(input, { requireAll: true });
  if (invalid) return invalid;

  let config: CmsConfig;
  try {
    config = await getCmsConfigForBusiness(businessId);
  } catch {
    return { ok: false, error: "not_connected" };
  }

  try {
    const product = await createProduct(config, { ...input, title: input.title.trim() });
    return { ok: true, data: product };
  } catch (error) {
    return mapCmsWriteError(error);
  }
}

export async function updateCmsProduct(
  businessId: string,
  id: string,
  input: Partial<CmsProductInput>,
): Promise<WebsiteResult<CmsProduct>> {
  const invalid = validateProductInput(input, { requireAll: false });
  if (invalid) return invalid;

  let config: CmsConfig;
  try {
    config = await getCmsConfigForBusiness(businessId);
  } catch {
    return { ok: false, error: "not_connected" };
  }

  try {
    const product = await updateProduct(config, id, {
      ...input,
      ...(input.title !== undefined ? { title: input.title.trim() } : {}),
    });
    return { ok: true, data: product };
  } catch (error) {
    return mapCmsWriteError(error);
  }
}

export async function deleteCmsProduct(businessId: string, id: string): Promise<WebsiteResult<null>> {
  let config: CmsConfig;
  try {
    config = await getCmsConfigForBusiness(businessId);
  } catch {
    return { ok: false, error: "not_connected" };
  }

  try {
    await deleteProduct(config, id);
    return { ok: true, data: null };
  } catch (error) {
    return mapCmsWriteError(error);
  }
}

/**
 * Moves the connected site to a new domain: validate the format, call the
 * CMS (which resets `domainVerified` server-side), then keep the stored
 * connection's `site_domain` in step — every later call forwards it as
 * `Host`, and the DNS checklist's preview URL is built from it.
 */
export async function updateCmsSiteDomain(
  businessId: string,
  domain: string,
): Promise<WebsiteResult<{ domain: string; domainVerified: boolean }>> {
  const normalized = domain.trim().toLowerCase().replace(/\.$/, "");
  if (!DOMAIN_RE.test(normalized)) return { ok: false, error: "invalid_domain" };

  let config: CmsConfig;
  try {
    config = await getCmsConfigForBusiness(businessId);
  } catch {
    return { ok: false, error: "not_connected" };
  }

  try {
    const result = await updateSiteDomainOnCms(config, normalized);
    await updateCmsConnectionDomain(businessId, result.domain);
    return { ok: true, data: result };
  } catch (error) {
    return mapCmsWriteError(error);
  }
}

const ORDER_STATUSES: CmsOrder["status"][] = ["pending", "paid", "cancelled", "refunded"];

export async function updateCmsOrderStatus(
  businessId: string,
  orderId: string,
  status: string,
): Promise<WebsiteResult<CmsOrder>> {
  if (!ORDER_STATUSES.includes(status as CmsOrder["status"])) {
    return { ok: false, error: "invalid_status" };
  }

  let config: CmsConfig;
  try {
    config = await getCmsConfigForBusiness(businessId);
  } catch {
    return { ok: false, error: "not_connected" };
  }

  try {
    const order = await updateOrderStatus(config, orderId, status as CmsOrder["status"]);
    return { ok: true, data: order };
  } catch (error) {
    if (error instanceof CmsNetworkError) return { ok: false, error: "cms_unreachable" };
    if (error instanceof CmsApiError && error.status === 404) return { ok: false, error: "not_found" };
    if (error instanceof CmsApiError && error.status === 403) return { ok: false, error: "forbidden" };
    return { ok: false, error: "cms_error" };
  }
}

type Provisioned = Awaited<ReturnType<typeof provisionSite>>;

/* ------------------------------------------------------------------ */
/* DNS checklist + in-app preview                                      */
/* ------------------------------------------------------------------ */

const DNS_TIMEOUT_MS = 4_000;

/**
 * Resolve a host's A/AAAA addresses with a short timeout. An empty array is
 * "did not resolve" — never an exception: a missing record is the thing the
 * checklist exists to surface, not a crash.
 */
async function resolveAddresses(host: string): Promise<string[]> {
  const lookup = async (): Promise<string[]> => {
    const [a, aaaa] = await Promise.allSettled([
      dns.resolve4(host).catch(() => []),
      dns.resolve6(host).catch(() => []),
    ]);
    const v4 = a.status === "fulfilled" ? a.value : [];
    const v6 = aaaa.status === "fulfilled" ? aaaa.value : [];
    return [...v4, ...v6];
  };
  try {
    return await Promise.race([
      lookup(),
      new Promise<string[]>((resolve) => setTimeout(() => resolve([]), DNS_TIMEOUT_MS)),
    ]);
  } catch {
    return [];
  }
}

export interface CmsDnsStatus {
  dns: DnsCheck;
  /** The CMS's own confirmation (descriptor `domainVerified`), if readable. */
  domainVerified: boolean | null;
  /** `https://{domain}/` — what the live site (and the iframe) loads on. */
  previewUrl: string;
  /**
   * The CMS admin for this site — where «تأیید دامنه» is ticked and content is
   * edited. Built here, from the stored `baseUrl`, so the browser never
   * concatenates an admin URL out of a connection field it half understands.
   */
  adminUrl: string;
}

/**
 * The DNS checklist's two observable facts for the connected site: does the
 * domain resolve to the CMS server, and has the operator verified it in the
 * CMS admin. The server does the resolution (same resolver family browsers
 * use); the client only renders the result.
 */
export async function cmsWebsiteDns(businessId: string): Promise<WebsiteResult<CmsDnsStatus>> {
  let config: CmsConfig;
  try {
    config = await getCmsConfigForBusiness(businessId);
  } catch (error) {
    return { ok: false, error: error instanceof CmsConnectionError ? "not_connected" : "cms_config_error" };
  }

  const siteDomain = config.siteDomain ?? "";
  const cmsHost = new URL(config.baseUrl).hostname;
  const [domainAddresses, cmsAddresses] = await Promise.all([
    resolveAddresses(siteDomain),
    resolveAddresses(cmsHost),
  ]);
  const dnsCheck: DnsCheck = {
    domain: siteDomain,
    resolved: domainAddresses.length > 0,
    pointingToCms: ipsOverlap(domainAddresses, cmsAddresses),
    cmsHost,
    domainAddresses,
    cmsAddresses,
  };

  let domainVerified: boolean | null = null;
  try {
    const site = await fetchSiteDescriptor(config);
    domainVerified = Boolean(site.domainVerified);
  } catch {
    // The descriptor is not required for the DNS side of the answer.
    domainVerified = null;
  }

  return {
    ok: true,
    data: {
      dns: dnsCheck,
      domainVerified,
      // The site is served over TLS on its own domain once the checklist is
      // green; the CMS control plane may be plain http in a local/staging
      // deployment, which is the `adminUrl` below, not this.
      previewUrl: `https://${siteDomain}/`,
      adminUrl: `${config.baseUrl.replace(/\/+$/, "")}/admin`,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Domain registrar — pricing and ordering through the CMS's reseller  */
/* ------------------------------------------------------------------ */

const REGISTRAR_OPERATIONS = ["register", "transfer", "renew"] as const;
type RegistrarOperation = (typeof REGISTRAR_OPERATIONS)[number];

/**
 * What a domain costs, before anybody commits to anything.
 *
 * The wizard prices a domain at its first step — before the site exists — so
 * this falls back to the operator's platform key when the business has no
 * connection yet. A price list is not tenant data: the CMS answers the same
 * catalogue price to every caller, and the availability line it returns is
 * deliberately coarse for exactly that reason.
 */
export async function cmsDomainQuote(
  businessId: string,
  input: { domain: string; operation?: string; period?: number },
): Promise<WebsiteResult<RegistrarQuote>> {
  const domain = input.domain.trim().toLowerCase().replace(/\.$/, "");
  if (!DOMAIN_RE.test(domain)) return { ok: false, error: "invalid_domain" };
  const operation = (input.operation ?? "register") as RegistrarOperation;
  if (!REGISTRAR_OPERATIONS.includes(operation)) return { ok: false, error: "invalid_operation" };
  const period = input.period ?? 1;
  if (!Number.isInteger(period) || period < 1 || period > 5) return { ok: false, error: "invalid_period" };

  let config: CmsConfig | null = null;
  try {
    config = await getCmsConfigForBusiness(businessId);
  } catch {
    config = await resolvePlatformCmsConfig();
  }
  if (!config) return { ok: false, error: "cms_not_configured" };

  try {
    return { ok: true, data: await fetchRegistrarQuote(config, { domain, operation, period }) };
  } catch (error) {
    if (error instanceof CmsNetworkError) return { ok: false, error: "cms_unreachable" };
    if (error instanceof CmsApiError && error.status === 404) return { ok: false, error: "tld_not_sold" };
    if (error instanceof CmsApiError && error.status === 403) return { ok: false, error: "forbidden" };
    return { ok: false, error: "quote_failed" };
  }
}

/**
 * Place a domain order with the CMS's registrar for the connected site.
 *
 * Requires a connection: the CMS resolves the tenant from the site key, so
 * there is no request body that could name another business's site. Billing
 * for the order is the caller's job (`src/lib/website/domain-service.ts`) —
 * this function is only the CMS half.
 */
export async function orderCmsDomain(
  businessId: string,
  input: {
    domain: string;
    operation?: string;
    period?: number;
    nameservers?: string[];
    contact?: Record<string, unknown>;
    fields?: Record<string, unknown>;
    irnicHandles?: Record<string, unknown>;
    eppCode?: string;
  },
): Promise<WebsiteResult<{ reference: string | null; state: string | null }>> {
  const domain = input.domain.trim().toLowerCase().replace(/\.$/, "");
  if (!DOMAIN_RE.test(domain)) return { ok: false, error: "invalid_domain" };
  const operation = (input.operation ?? "register") as RegistrarOperation;
  if (!REGISTRAR_OPERATIONS.includes(operation)) return { ok: false, error: "invalid_operation" };
  const period = input.period ?? 1;
  if (!Number.isInteger(period) || period < 1 || period > 5) return { ok: false, error: "invalid_period" };

  let config: CmsConfig;
  try {
    config = await getCmsConfigForBusiness(businessId);
  } catch {
    return { ok: false, error: "not_connected" };
  }

  try {
    const result = await orderRegistrarDomain(config, {
      domain,
      operation,
      period,
      ...(input.nameservers?.length ? { nameservers: input.nameservers } : {}),
      ...(input.contact ? { contact: input.contact } : {}),
      ...(input.fields ? { fields: input.fields } : {}),
      ...(input.irnicHandles ? { irnicHandles: input.irnicHandles } : {}),
      ...(input.eppCode ? { eppCode: input.eppCode } : {}),
    });
    return {
      ok: true,
      data: {
        reference: result.operation?.id ?? result.domain?.id ?? null,
        state: result.operation?.state ?? result.domain?.state ?? null,
      },
    };
  } catch (error) {
    if (error instanceof CmsNetworkError) return { ok: false, error: "cms_unreachable" };
    if (error instanceof CmsApiError && error.status === 409) return { ok: false, error: "registrar_disabled" };
    if (error instanceof CmsApiError && error.status === 404) return { ok: false, error: "tld_not_sold" };
    return { ok: false, error: "domain_order_failed" };
  }
}

/* ------------------------------------------------------------------ */
/* CDN — read the site's own zone, and purge its own cache             */
/* ------------------------------------------------------------------ */

/**
 * The connected site's CDN zone as the CMS observes it.
 *
 * A site with no zone is not an error: `configured: false` is the answer the
 * wizard's CDN step is asking for, and it is what tells an owner their site is
 * being served directly rather than from the edge.
 */
export async function cmsSiteCdn(businessId: string): Promise<WebsiteResult<SiteCdnStatus>> {
  let config: CmsConfig;
  try {
    config = await getCmsConfigForBusiness(businessId);
  } catch {
    return { ok: false, error: "not_connected" };
  }
  try {
    return { ok: true, data: await fetchSiteCdnStatus(config) };
  } catch (error) {
    if (error instanceof CmsNetworkError) return { ok: false, error: "cms_unreachable" };
    if (error instanceof CmsApiError && error.status === 404) return { ok: false, error: "cms_old_version" };
    return { ok: false, error: "cms_error" };
  }
}

/** Empty the site's edge cache. Touches nothing but this site's own cache. */
export async function cmsPurgeCdn(businessId: string, urls?: string[]): Promise<WebsiteResult<null>> {
  let config: CmsConfig;
  try {
    config = await getCmsConfigForBusiness(businessId);
  } catch {
    return { ok: false, error: "not_connected" };
  }
  try {
    await purgeSiteCdn(config, urls);
    return { ok: true, data: null };
  } catch (error) {
    if (error instanceof CmsNetworkError) return { ok: false, error: "cms_unreachable" };
    return { ok: false, error: "cdn_purge_failed" };
  }
}

// `cmsDnsHint` lives in ./dns (pure) so the dashboard's client component can
// render it without pulling this DB-backed module into the browser bundle.
export { cmsDnsHint } from "./dns";
