import { connectionUrl } from "../integrations/outbound-http";
/**
 * Phase 38 Wave 1 (issue #379) — the website connection, seen through the
 * adapter pattern. DB-touching; per repo convention not unit-tested directly
 * (the adapters it constructs are).
 *
 * The row is `eshobe_cms_connections` (migration 0122), extended by 0136 with
 * `adapter_key`, the connection-test record and the Wave 3 sync switches. The
 * issue drafted a separate `website_connections`; by the time the waves were
 * built, 0122 already held the encrypted credential for the one adapter that
 * exists, so one table it stays — this module is the only place that knows
 * which one.
 *
 * Rules kept here:
 *   - **Test before save.** `connectWebsite` runs `adapter.testConnection()`
 *     and refuses to store a credential that failed — Phase 28's lesson.
 *   - **The credential never leaves the server.** `WebsiteConnectionSummary`
 *     carries a masked state only; the plaintext key exists inside the
 *     adapter's HTTP client and nowhere else.
 *   - **Price and stock are two switches**, default off; the product scope
 *     defaults to `selected` (nothing goes until the owner marks it).
 */
import { query } from "../db";
import { decryptSecret, encryptSecret, resolveEncryptionKey } from "../integrations/secrets";
import type { CmsConfig } from "../cms/client";
import type { WebsiteAdapter, WebsiteAdapterKey } from "./adapter";
import { MockWebsiteAdapter } from "./providers/mock";
import { PayloadWebsiteAdapter, type SiteCurrency } from "./providers/payload";

export interface WebsiteConnectionRow extends Record<string, unknown> {
  id: string;
  business_id: string;
  adapter_key: WebsiteAdapterKey;
  site_id: string;
  site_domain: string;
  base_url: string;
  key_name: string | null;
  api_key_ciphertext: string;
  site_currency: SiteCurrency;
  status: "active" | "disabled";
  last_checked_at: string | null;
  last_error: string | null;
  push_prices: boolean;
  push_stock: boolean;
  product_scope: "selected" | "all";
  sync_location_id: string | null;
  created_at: string;
  updated_at: string;
}

const COLUMNS = `id, business_id, adapter_key, site_id, site_domain, base_url, key_name, api_key_ciphertext,
  site_currency, status, last_checked_at, last_error, push_prices, push_stock, product_scope,
  sync_location_id, created_at, updated_at`;

/** Masked — safe for the browser and the assistant. Never the key. */
export interface WebsiteConnectionSummary {
  id: string;
  adapterKey: WebsiteAdapterKey;
  siteId: string;
  siteDomain: string;
  baseUrl: string;
  siteCurrency: SiteCurrency;
  status: "active" | "disabled";
  lastCheckedAt: string | null;
  lastError: string | null;
  pushPrices: boolean;
  pushStock: boolean;
  productScope: "selected" | "all";
  syncLocationId: string | null;
  updatedAt: string;
}

export function summarize(row: WebsiteConnectionRow): WebsiteConnectionSummary {
  return {
    id: row.id,
    adapterKey: row.adapter_key,
    siteId: row.site_id,
    siteDomain: row.site_domain,
    baseUrl: row.base_url,
    siteCurrency: row.site_currency,
    status: row.status,
    lastCheckedAt: row.last_checked_at,
    lastError: row.last_error,
    pushPrices: row.push_prices,
    pushStock: row.push_stock,
    productScope: row.product_scope,
    syncLocationId: row.sync_location_id,
    updatedAt: row.updated_at,
  };
}

export async function getWebsiteConnectionRow(businessId: string): Promise<WebsiteConnectionRow | null> {
  const { rows } = await query<WebsiteConnectionRow>(
    `SELECT ${COLUMNS} FROM eshobe_cms_connections WHERE business_id = $1`,
    [businessId],
  );
  return rows[0] ?? null;
}

export async function getWebsiteConnection(businessId: string): Promise<WebsiteConnectionSummary | null> {
  const row = await getWebsiteConnectionRow(businessId);
  return row ? summarize(row) : null;
}

// ---------------------------------------------------------------------------
// Adapter construction
// ---------------------------------------------------------------------------

/**
 * Test seam: the mock adapter must survive across calls within one process
 * (its state is in memory), so the factory keeps one instance per business.
 */
const mockInstances = new Map<string, MockWebsiteAdapter>();
export function mockAdapterFor(businessId: string): MockWebsiteAdapter {
  let instance = mockInstances.get(businessId);
  if (!instance) {
    instance = new MockWebsiteAdapter();
    mockInstances.set(businessId, instance);
  }
  return instance;
}
/** Tests only. */
export function resetMockAdapters(): void {
  mockInstances.clear();
}

export function adapterFromRow(row: WebsiteConnectionRow): WebsiteAdapter {
  if (row.adapter_key === "mock") return mockAdapterFor(row.business_id);
  const key = resolveEncryptionKey(process.env);
  const config: CmsConfig = {
    baseUrl: row.base_url,
    siteDomain: row.site_domain,
    apiKey: decryptSecret(row.api_key_ciphertext, key),
  };
  return new PayloadWebsiteAdapter({ config, currency: row.site_currency });
}

export class WebsiteNotConnectedError extends Error {
  readonly code = "not_connected" as const;
  constructor() {
    super("website_not_connected");
    this.name = "WebsiteNotConnectedError";
  }
}

/** The adapter for a business, or `WebsiteNotConnectedError`. */
export async function adapterForBusiness(businessId: string): Promise<{ adapter: WebsiteAdapter; row: WebsiteConnectionRow }> {
  const row = await getWebsiteConnectionRow(businessId);
  if (!row || row.status !== "active") throw new WebsiteNotConnectedError();
  return { adapter: adapterFromRow(row), row };
}

// ---------------------------------------------------------------------------
// Connect / test / disconnect / settings
// ---------------------------------------------------------------------------

export interface ConnectWebsiteInput {
  adapterKey: WebsiteAdapterKey;
  baseUrl: string;
  siteDomain: string;
  apiKey: string;
  siteCurrency?: SiteCurrency;
  keyName?: string;
}

export type ConnectWebsiteResult =
  | { ok: true; connection: WebsiteConnectionSummary; siteName: string | null }
  | { ok: false; error: string };

const DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

/**
 * Test the credentials with a throwaway adapter first; store only on success.
 * A failed test returns the adapter's error code and writes nothing — a
 * credential that does not work must not be saved and then go quiet.
 */
export async function connectWebsite(businessId: string, input: ConnectWebsiteInput): Promise<ConnectWebsiteResult> {
  const baseUrl = input.baseUrl.trim().replace(/\/+$/, "");
  const domain = input.siteDomain.trim().toLowerCase().replace(/\.$/, "");
  const apiKey = input.apiKey.trim();
  const currency: SiteCurrency = input.siteCurrency ?? "IRT";

  if (input.adapterKey !== "mock") {
    try { connectionUrl(baseUrl); } catch { return { ok: false, error: "invalid_cms_base_url" }; }
    if (!DOMAIN_RE.test(domain)) return { ok: false, error: "invalid_domain" };
    if (!apiKey.startsWith("eshobe_live_")) return { ok: false, error: "invalid_api_key" };
  }
  if (!["IRT", "IRR"].includes(currency)) return { ok: false, error: "unsupported_currency" };

  const probe: WebsiteAdapter =
    input.adapterKey === "mock"
      ? mockAdapterFor(businessId)
      : new PayloadWebsiteAdapter({ config: { baseUrl, siteDomain: domain, apiKey }, currency });

  const test = await probe.testConnection();
  if (!test.ok) return { ok: false, error: test.error ?? "connection_failed" };

  // For Payload the descriptor's id is what revalidation tags key on; the
  // adapter's test already checked the domain matched. Read it once more here
  // so the stored row names the site.
  let siteId = "mock";
  if (input.adapterKey === "payload") {
    const { fetchSiteDescriptor } = await import("../cms/client");
    try {
      const site = await fetchSiteDescriptor({ baseUrl, siteDomain: domain, apiKey });
      siteId = site.id ?? "";
    } catch {
      return { ok: false, error: "connection_failed" };
    }
    if (!siteId) return { ok: false, error: "cms_old_version" };
  }

  const key = resolveEncryptionKey(process.env);
  await query(
    `INSERT INTO eshobe_cms_connections
       (business_id, adapter_key, site_id, site_domain, base_url, key_name, api_key_ciphertext,
        site_currency, status, last_checked_at, last_error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', now(), NULL)
     ON CONFLICT (business_id) DO UPDATE SET
       push_prices = CASE WHEN eshobe_cms_connections.site_id = EXCLUDED.site_id AND eshobe_cms_connections.base_url = EXCLUDED.base_url THEN eshobe_cms_connections.push_prices ELSE false END,
       push_stock = CASE WHEN eshobe_cms_connections.site_id = EXCLUDED.site_id AND eshobe_cms_connections.base_url = EXCLUDED.base_url THEN eshobe_cms_connections.push_stock ELSE false END,
       product_scope = CASE WHEN eshobe_cms_connections.site_id = EXCLUDED.site_id AND eshobe_cms_connections.base_url = EXCLUDED.base_url THEN eshobe_cms_connections.product_scope ELSE 'selected' END,
       sync_location_id = CASE WHEN eshobe_cms_connections.site_id = EXCLUDED.site_id AND eshobe_cms_connections.base_url = EXCLUDED.base_url THEN eshobe_cms_connections.sync_location_id ELSE NULL END,
       adapter_key = EXCLUDED.adapter_key,
       site_id = EXCLUDED.site_id,
       site_domain = EXCLUDED.site_domain,
       base_url = EXCLUDED.base_url,
       key_name = EXCLUDED.key_name,
       api_key_ciphertext = EXCLUDED.api_key_ciphertext,
       site_currency = EXCLUDED.site_currency,
       status = 'active', last_checked_at = now(), last_error = NULL, updated_at = now()`,
    [
      businessId,
      input.adapterKey,
      siteId,
      input.adapterKey === "mock" ? domain || "mock.local" : domain,
      input.adapterKey === "mock" ? baseUrl || "https://mock.local" : baseUrl,
      input.keyName?.trim() || null,
      encryptSecret(apiKey || "mock", key),
      currency,
    ],
  );
  const row = (await getWebsiteConnectionRow(businessId))!;
  return { ok: true, connection: summarize(row), siteName: test.siteName ?? null };
}

/** Re-run the connection test on the stored credential and record the result. */
export async function testWebsiteConnection(businessId: string): Promise<{ ok: boolean; siteName?: string; error?: string }> {
  const row = await getWebsiteConnectionRow(businessId);
  if (!row) return { ok: false, error: "not_connected" };
  const result = await adapterFromRow(row).testConnection();
  await query(
    `UPDATE eshobe_cms_connections SET last_checked_at = now(), last_error = $2, updated_at = now() WHERE business_id = $1`,
    [businessId, result.ok ? null : (result.error ?? "connection_failed")],
  );
  return result;
}

export async function recordWebsiteError(businessId: string, error: string | null): Promise<void> {
  await query(
    `UPDATE eshobe_cms_connections SET last_checked_at = now(), last_error = $2, updated_at = now() WHERE business_id = $1`,
    [businessId, error],
  );
}

export async function disconnectWebsite(businessId: string): Promise<void> {
  await query(`DELETE FROM eshobe_cms_connections WHERE business_id = $1`, [businessId]);
  mockInstances.delete(businessId);
}

export interface WebsiteSyncSettingsInput {
  pushPrices?: boolean;
  pushStock?: boolean;
  productScope?: "selected" | "all";
  syncLocationId?: string | null;
}

export async function updateWebsiteSyncSettings(
  businessId: string,
  input: WebsiteSyncSettingsInput,
): Promise<WebsiteConnectionSummary | null> {
  if (input.productScope !== undefined && !["selected", "all"].includes(input.productScope)) return null;
  await query(
    `UPDATE eshobe_cms_connections
        SET push_prices = COALESCE($2, push_prices),
            push_stock = COALESCE($3, push_stock),
            product_scope = COALESCE($4, product_scope),
            sync_location_id = CASE WHEN $6 THEN $5 ELSE sync_location_id END,
            updated_at = now()
      WHERE business_id = $1`,
    [
      businessId,
      input.pushPrices ?? null,
      input.pushStock ?? null,
      input.productScope ?? null,
      input.syncLocationId ?? null,
      input.syncLocationId !== undefined,
    ],
  );
  return getWebsiteConnection(businessId);
}
