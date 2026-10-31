/**
 * Phase 23 (issue #118) — Wave 1: WooCommerce connection lifecycle.
 * DB-touching (not unit-tested directly, per repo convention; the pure crypto
 * and money conversion it leans on are covered by their own tests).
 *
 * Secrets are encrypted at rest (secrets.ts) and never returned by the list
 * endpoint; the only time the plaintext leaves the process is inside the
 * outbound HTTP client's Basic auth header. A newly created connection returns
 * its webhook secret exactly once (the same show-once pattern as an API key).
 */
import { connectionUrl } from "./outbound-http";
import { randomBytes } from "node:crypto";
import { query } from "../db";
import { decryptSecret, encryptSecret, resolveEncryptionKey } from "./secrets";
import { generatePluginToken, hashPluginToken } from "./plugin-link";
import { createWooCommerceClient, type WooCredentials } from "./woocommerce-client";
import type { WooCurrencyUnit } from "./woo-money";
import { writeIntegrationAudit } from "./audit";
import { effectivePushSwitches, isSourceOfTruth, type SourceOfTruth } from "./outbox-policy";
import { pluginSilenceThresholdMs } from "./sync-timing";

/**
 * How a store is connected.
 *
 * `rest_api` is migration 0070's original shape: the owner pastes WooCommerce
 * consumer keys, the app calls the store, and the store calls back with
 * webhooks. `plugin` is migration 0076's: a WordPress plugin holds one
 * integration-scoped token, signs every request with it, and does all the
 * calling in both directions. See migrations/0076_wordpress_plugin_link.sql
 * for why both are kept.
 */
export type LinkMode = "rest_api" | "plugin";

export interface ConnectionRow extends Record<string, unknown> {
  id: string;
  business_id: string;
  location_id: string | null;
  name: string;
  provider: string;
  base_url: string;
  link_mode: LinkMode;
  consumer_key_ciphertext: string | null;
  consumer_secret_ciphertext: string | null;
  webhook_secret_ciphertext: string;
  link_token_hash: string | null;
  link_token_ciphertext: string | null;
  link_token_set_at: string | null;
  plugin_version: string | null;
  plugin_site_url: string | null;
  last_plugin_seen_at: string | null;
  plugin_health: Record<string, unknown>;
  plugin_capabilities: Record<string, unknown> | null;
  pending_plugin_site_url: string | null;
  plugin_site_mismatch_at: string | null;
  wp_username_ciphertext: string | null;
  wp_application_password_ciphertext: string | null;
  currency_unit: WooCurrencyUnit;
  sync_orders: boolean;
  sync_products: boolean;
  sync_customers: boolean;
  push_stock: boolean;
  push_prices: boolean;
  price_source?: "base" | "list";
  price_list_id?: string | null;
  /** Issue #1149 — which side owns stock and prices; `store` switches the scheduled push off. */
  source_of_truth: SourceOfTruth;
  /** Issue #1149 — the owner agreed a stock push may turn on WooCommerce stock tracking. */
  manage_stock_opt_in: boolean;
  /** Phase 38 — mirror the store's product_cat into the local menu (F&B). */
  sync_categories: boolean;
  /** Phase 38 — pull recent orders on a schedule, not only by webhook. */
  auto_pull_orders: boolean;
  /** How far back a scheduled order pull looks, in days. */
  order_lookback_days: number;
  status: "active" | "paused" | "error";
  last_test_at?: string | null;
  last_successful_test_at?: string | null;
  last_test_error?: string | null;
  last_sync_at: string | null;
  /** Phase 38/40 — split from last_sync_at: these jobs fail independently. */
  last_catalogue_sync_at: string | null;
  last_order_sync_at: string | null;
  last_customer_sync_at: string | null;
  last_content_sync_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

/** The safe, secret-free shape returned to the dashboard and routes. */
export interface Connection {
  id: string;
  businessId: string;
  locationId: string | null;
  name: string;
  provider: string;
  baseUrl: string;
  linkMode: LinkMode;
  currencyUnit: WooCurrencyUnit;
  syncOrders: boolean;
  syncProducts: boolean;
  syncCustomers: boolean;
  pushStock: boolean;
  pushPrices: boolean;
  priceSource?: "base" | "list";
  priceListId?: string | null;
  sourceOfTruth: SourceOfTruth;
  manageStockOptIn: boolean;
  syncCategories: boolean;
  autoPullOrders: boolean;
  orderLookbackDays: number;
  status: "active" | "paused" | "error";
  lastTestAt?: string | null;
  lastSuccessfulTestAt?: string | null;
  lastTestError?: string | null;
  lastSyncAt: string | null;
  lastCatalogueSyncAt: string | null;
  lastOrderSyncAt: string | null;
  lastCustomerSyncAt: string | null;
  lastContentSyncAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  /** The path this store's webhook must be configured to deliver to (rest_api mode only). */
  webhookPath: string;
  /** Whether a link token has been issued for this connection at all. Never the token. */
  hasLinkToken: boolean;
  linkTokenSetAt: string | null;
  pluginVersion: string | null;
  pluginSiteUrl: string | null;
  /** The last time the plugin authenticated — the only real "is it alive?" signal in plugin mode. */
  lastPluginSeenAt: string | null;
  pluginHealth: Record<string, unknown>;
  pluginCapabilities: Record<string, unknown> | null;
  pendingPluginSiteUrl: string | null;
  pluginSiteMismatchAt: string | null;
  hasWordPressCredentials: boolean;
  transportHealth: TransportHealth;
}

export function webhookPathFor(connectionId: string): string {
  return `/api/integrations/woocommerce/webhook/${connectionId}`;
}

/** Plugin-mode freshness threshold. The plugin's fast lane runs every five minutes; three missed runs is stale. */
export const PLUGIN_HEALTH_STALE_MS = 10 * 60 * 1000;

export type TransportHealthState = "never_connected" | "healthy" | "stale" | "paused" | "error" | "site_mismatch";

export interface TransportHealth {
  state: TransportHealthState;
  lastSeenAt: string | null;
  staleAfterMs: number;
  checkedAt: string;
  message?: string;
}

export function deriveTransportHealth(
  connection: Pick<ConnectionRow, "link_mode" | "status" | "last_plugin_seen_at" | "last_error" | "plugin_site_mismatch_at"> & { plugin_health?: Record<string, unknown> },
  now = new Date(),
): TransportHealth {
  const staleAfterMs = pluginSilenceThresholdMs(connection.plugin_health);
  if (connection.status === "paused") {
    return {
      state: "paused",
      lastSeenAt: connection.last_plugin_seen_at,
      staleAfterMs,
      checkedAt: now.toISOString(),
      message: "همگام‌سازی از سمت پنل متوقف شده است",
    };
  }
  if (connection.status === "error") {
    return {
      state: "error",
      lastSeenAt: connection.last_plugin_seen_at,
      staleAfterMs,
      checkedAt: now.toISOString(),
      message: connection.last_error ?? "connection_error",
    };
  }
  if (connection.link_mode !== "plugin") {
    return {
      state: "healthy",
      lastSeenAt: null,
      staleAfterMs,
      checkedAt: now.toISOString(),
    };
  }
  if (connection.plugin_site_mismatch_at) {
    return {
      state: "site_mismatch",
      lastSeenAt: connection.last_plugin_seen_at,
      staleAfterMs,
      checkedAt: now.toISOString(),
      message: "site_mismatch",
    };
  }
  if (!connection.last_plugin_seen_at) {
    return {
      state: "never_connected",
      lastSeenAt: null,
      staleAfterMs,
      checkedAt: now.toISOString(),
      message: "plugin_never_connected",
    };
  }
  const lastSeenMs = Date.parse(connection.last_plugin_seen_at);
  if (!Number.isFinite(lastSeenMs) || now.getTime() - lastSeenMs > staleAfterMs) {
    return {
      state: "stale",
      lastSeenAt: connection.last_plugin_seen_at,
      staleAfterMs,
      checkedAt: now.toISOString(),
      message: "plugin_stale",
    };
  }
  return {
    state: "healthy",
    lastSeenAt: connection.last_plugin_seen_at,
    staleAfterMs,
    checkedAt: now.toISOString(),
  };
}

function mapConnection(row: ConnectionRow): Connection {
  return {
    id: row.id,
    businessId: row.business_id,
    locationId: row.location_id,
    name: row.name,
    provider: row.provider,
    baseUrl: row.base_url,
    linkMode: row.link_mode,
    currencyUnit: row.currency_unit,
    syncOrders: row.sync_orders,
    syncProducts: row.sync_products,
    syncCustomers: row.sync_customers,
    pushStock: row.push_stock,
    pushPrices: row.push_prices,
    priceSource: row.price_source ?? "base",
    priceListId: row.price_list_id ?? null,
    sourceOfTruth: row.source_of_truth ?? "two_way",
    manageStockOptIn: Boolean(row.manage_stock_opt_in),
    syncCategories: row.sync_categories,
    autoPullOrders: row.auto_pull_orders,
    orderLookbackDays: row.order_lookback_days,
    status: row.status,
    lastTestAt: row.last_test_at ?? null,
    lastSuccessfulTestAt: row.last_successful_test_at ?? null,
    lastTestError: row.last_test_error ?? null,
    lastSyncAt: row.last_sync_at,
    lastCatalogueSyncAt: row.last_catalogue_sync_at,
    lastOrderSyncAt: row.last_order_sync_at,
    lastCustomerSyncAt: row.last_customer_sync_at,
    lastContentSyncAt: row.last_content_sync_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    webhookPath: webhookPathFor(row.id),
    hasLinkToken: Boolean(row.link_token_hash),
    linkTokenSetAt: row.link_token_set_at,
    pluginVersion: row.plugin_version,
    pluginSiteUrl: row.plugin_site_url,
    lastPluginSeenAt: row.last_plugin_seen_at,
    pluginHealth: row.plugin_health ?? {},
    pluginCapabilities: row.plugin_capabilities ?? null,
    pendingPluginSiteUrl: row.pending_plugin_site_url,
    pluginSiteMismatchAt: row.plugin_site_mismatch_at,
    hasWordPressCredentials: Boolean(row.wp_username_ciphertext && row.wp_application_password_ciphertext),
    transportHealth: deriveTransportHealth(row),
  };
}

export const CONNECTION_COLUMNS = `id, business_id, location_id, name, provider, base_url,
  link_mode, consumer_key_ciphertext, consumer_secret_ciphertext, webhook_secret_ciphertext,
  link_token_hash, link_token_ciphertext, link_token_set_at,
  plugin_version, plugin_site_url, last_plugin_seen_at,
  plugin_health, plugin_capabilities, pending_plugin_site_url, plugin_site_mismatch_at,
  wp_username_ciphertext, wp_application_password_ciphertext,
  currency_unit, sync_orders, sync_products, sync_customers, push_stock, push_prices,
  source_of_truth, manage_stock_opt_in, price_source, price_list_id,
  sync_categories, auto_pull_orders, order_lookback_days,
  status, last_test_at, last_successful_test_at, last_test_error, last_sync_at, last_catalogue_sync_at, last_order_sync_at,
  last_customer_sync_at, last_content_sync_at, last_error, created_at, updated_at`;

export async function listConnections(businessId: string): Promise<Connection[]> {
  const { rows } = await query<ConnectionRow>(
    `SELECT ${CONNECTION_COLUMNS} FROM integration_connections WHERE business_id = $1 AND deleted_at IS NULL ORDER BY created_at`,
    [businessId],
  );
  return rows.map(mapConnection);
}

export async function getConnection(businessId: string, id: string): Promise<ConnectionRow | null> {
  const { rows } = await query<ConnectionRow>(
    `SELECT ${CONNECTION_COLUMNS} FROM integration_connections WHERE business_id = $1 AND id = $2 AND deleted_at IS NULL`,
    [businessId, id],
  );
  return rows[0] ?? null;
}

export interface CreateConnectionInput {
  name: string;
  baseUrl: string;
  /** Which of the two link modes; omitted means the original REST/consumer-key shape. */
  linkMode?: LinkMode;
  /** Required in `rest_api` mode, ignored in `plugin` mode. */
  consumerKey?: string;
  consumerSecret?: string;
  /** Optional separate WordPress Core REST credentials for wp/v2 content/taxonomy calls. */
  wpUsername?: string;
  wpApplicationPassword?: string;
  currencyUnit: WooCurrencyUnit;
  locationId?: string | null;
  syncOrders?: boolean;
  syncProducts?: boolean;
  syncCustomers?: boolean;
  pushStock?: boolean;
  pushPrices?: boolean;
  /** Phase 38 — mirror the store's categories into the local menu. Opt-in. */
  syncCategories?: boolean;
  /** Phase 38 — scheduled order pull, in addition to webhooks. */
  autoPullOrders?: boolean;
  orderLookbackDays?: number;
}

export type CreateConnectionResult =
  | {
      ok: true;
      connection: Connection;
      /** Shown once. In plugin mode this is the store's own webhook secret and stays unused. */
      webhookSecret: string;
      /** Shown once, and only in plugin mode: what the owner pastes into the WordPress plugin. */
      linkToken?: string;
    }
  | { ok: false; error: string };

export async function createConnection(
  businessId: string,
  createdBy: string,
  input: CreateConnectionInput,
): Promise<CreateConnectionResult> {
  const name = input.name.trim();
  let baseUrl: string;
  try { baseUrl = connectionUrl(input.baseUrl).toString().replace(/\/+$/, ""); }
  catch { return { ok: false, error: "invalid_base_url" }; }
  const linkMode: LinkMode = input.linkMode === "plugin" ? "plugin" : "rest_api";
  if (!name || name.length > 120) return { ok: false, error: "invalid_name" };
  // Consumer keys are what a rest_api connection *is*; a plugin connection has
  // no use for them and must not be made to invent a pair.
  if (linkMode === "rest_api" && (!input.consumerKey?.trim() || !input.consumerSecret?.trim())) {
    return { ok: false, error: "missing_credentials" };
  }
  if (input.currencyUnit !== "rial" && input.currencyUnit !== "toman") {
    return { ok: false, error: "invalid_currency_unit" };
  }

  const key = resolveEncryptionKey(process.env);
  const webhookSecret = randomBytes(32).toString("base64url");
  const linkToken = linkMode === "plugin" ? generatePluginToken() : null;
  const { rows } = await query<ConnectionRow>(
    `INSERT INTO integration_connections
       (business_id, location_id, name, base_url, link_mode,
        consumer_key_ciphertext, consumer_secret_ciphertext, webhook_secret_ciphertext,
        link_token_hash, link_token_ciphertext, link_token_set_at,
        wp_username_ciphertext, wp_application_password_ciphertext,
        currency_unit, sync_orders, sync_products, sync_customers, push_stock, push_prices,
        sync_categories, auto_pull_orders, order_lookback_days, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
             CASE WHEN $9::text IS NULL THEN NULL ELSE now() END,
             $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)
     RETURNING ${CONNECTION_COLUMNS}`,
    [
      businessId,
      input.locationId ?? null,
      name,
      baseUrl,
      linkMode,
      linkMode === "rest_api" ? encryptSecret(input.consumerKey!.trim(), key) : null,
      linkMode === "rest_api" ? encryptSecret(input.consumerSecret!.trim(), key) : null,
      encryptSecret(webhookSecret, key),
      linkToken ? hashPluginToken(linkToken) : null,
      linkToken ? encryptSecret(linkToken, key) : null,
      input.wpUsername?.trim() ? encryptSecret(input.wpUsername.trim(), key) : null,
      input.wpApplicationPassword?.trim() ? encryptSecret(input.wpApplicationPassword.trim(), key) : null,
      input.currencyUnit,
      input.syncOrders ?? true,
      input.syncProducts ?? true,
      input.syncCustomers ?? true,
      input.pushStock ?? true,
      input.pushPrices ?? true,
      input.syncCategories ?? false,
      input.autoPullOrders ?? true,
      Math.min(365, Math.max(1, Math.round(input.orderLookbackDays ?? 7))),
      createdBy,
    ],
  );
  await writeIntegrationAudit({
    businessId,
    connectionId: rows[0].id,
    action: "connection.created",
    payload: { name, baseUrl, linkMode, currencyUnit: input.currencyUnit },
  });
  return {
    ok: true,
    connection: mapConnection(rows[0]),
    webhookSecret,
    ...(linkToken ? { linkToken } : {}),
  };
}

/**
 * Mint a fresh link token for a plugin connection, invalidating the old one.
 *
 * Rotation is a break in service by design — the plugin stops authenticating
 * the instant this returns and resumes when the new token is pasted in — which
 * is what makes it useful after a WordPress compromise. Nothing queued is
 * lost: the outbox rows the plugin had not yet acked simply wait.
 */
export async function rotateLinkToken(
  businessId: string,
  id: string,
  actorUserId?: string,
): Promise<{ ok: true; linkToken: string } | { ok: false; error: "not_found" | "not_plugin_mode" }> {
  const existing = await getConnection(businessId, id);
  if (!existing) return { ok: false, error: "not_found" };
  if (existing.provider !== "woocommerce" || existing.link_mode !== "plugin") return { ok: false, error: "not_plugin_mode" };

  const key = resolveEncryptionKey(process.env);
  const linkToken = generatePluginToken();
  const { rowCount } = await query(
    `WITH rotated AS (UPDATE integration_connections
        SET link_token_hash = $3,
            link_token_ciphertext = $4,
            link_token_set_at = now(),
            last_plugin_seen_at = NULL,
            plugin_version = NULL,
            plugin_health = jsonb_build_object('state', 'needs_reconnect', 'rotatedAt', now()),
            plugin_capabilities = NULL,
            last_error = 'needs_reconnect',
            updated_at = now()
      WHERE business_id = $1 AND id = $2 AND deleted_at IS NULL
      RETURNING business_id, id)
     INSERT INTO integration_audit_log (business_id, connection_id, action, payload)
     SELECT business_id, id, 'connection.link_token_rotated', jsonb_build_object('actorUserId', $5::text) FROM rotated`,
    [businessId, id, hashPluginToken(linkToken), encryptSecret(linkToken, key), actorUserId ?? null],
  );
  if (rowCount !== 1) return { ok: false, error: "not_found" };
  return { ok: true, linkToken };
}

export interface UpdateConnectionInput {
  priceSource?: "base" | "list";
  priceListId?: string | null;
  name?: string;
  locationId?: string | null;
  status?: "active" | "paused";
  syncOrders?: boolean;
  syncProducts?: boolean;
  syncCustomers?: boolean;
  pushStock?: boolean;
  pushPrices?: boolean;
  /** Issue #1149 — see migration 0258. */
  sourceOfTruth?: SourceOfTruth;
  manageStockOptIn?: boolean;
  syncCategories?: boolean;
  autoPullOrders?: boolean;
  orderLookbackDays?: number;
  /** New WooCommerce credentials, only when the owner is re-authenticating the store. */
  consumerKey?: string;
  consumerSecret?: string;
  /** Separate WordPress Core REST credentials for wp/v2 posts/pages/media in REST mode. */
  wpUsername?: string;
  wpApplicationPassword?: string;
}

export async function updateConnection(
  businessId: string,
  id: string,
  input: UpdateConnectionInput,
): Promise<{ ok: true; connection: Connection } | { ok: false; error: string }> {
  const existing = await getConnection(businessId, id);
  if (!existing) return { ok: false, error: "not_found" };

  const key = resolveEncryptionKey(process.env);
  const sets: string[] = [];
  let priceSourceChanged = false;
  const params: unknown[] = [businessId, id];
  const add = (column: string, value: unknown) => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name || name.length > 120) return { ok: false, error: "invalid_name" };
    add("name", name);
  }
  if (input.locationId !== undefined) {
    if (!input.locationId) return { ok: false, error: "invalid_location" };
    const { rows: locations } = await query(
      `SELECT id FROM locations WHERE id = $1 AND business_id = $2`,
      [input.locationId, businessId],
    );
    if (!locations.length) return { ok: false, error: "invalid_location" };
    add("location_id", input.locationId);
  }
  if (input.status !== undefined) {
    if (input.status !== "active" && input.status !== "paused") return { ok: false, error: "invalid_status" };
    add("status", input.status);
  }
  if (input.syncOrders !== undefined) add("sync_orders", input.syncOrders);
  if (input.syncProducts !== undefined) add("sync_products", input.syncProducts);
  if (input.syncCustomers !== undefined) add("sync_customers", input.syncCustomers);
  if (input.pushStock !== undefined) add("push_stock", input.pushStock);
  if (input.pushPrices !== undefined) add("push_prices", input.pushPrices);
  if (input.priceSource !== undefined || input.priceListId !== undefined) {
    const source = input.priceSource ?? existing.price_source ?? "base";
    const listId = source === "base" ? null : (input.priceListId ?? existing.price_list_id);
    if (source !== "base" && source !== "list") return { ok: false, error: "invalid_price_source" };
    if (source === "list") {
      if (!listId || !/^[0-9a-f-]{36}$/i.test(listId)) return { ok: false, error: "invalid_price_list" };
      const { rows: lists } = await query(
        `SELECT p.id FROM price_lists p JOIN locations l ON l.id = p.location_id
         WHERE p.id = $1 AND l.business_id = $2 AND p.currency IN ('IRR', 'IRT')
           AND ($3::uuid IS NULL OR p.location_id = $3)`,
        [listId, businessId, input.locationId ?? existing.location_id],
      );
      if (!lists.length) return { ok: false, error: "invalid_price_list" };
    }
    add("price_source", source);
    add("price_list_id", listId);
    priceSourceChanged = source !== (existing.price_source ?? "base") || listId !== (existing.price_list_id ?? null);
  }
  if (input.sourceOfTruth !== undefined) {
    if (!isSourceOfTruth(input.sourceOfTruth)) return { ok: false, error: "invalid_source_of_truth" };
    add("source_of_truth", input.sourceOfTruth);
  }
  if (input.manageStockOptIn !== undefined) add("manage_stock_opt_in", input.manageStockOptIn);
  if (input.syncCategories !== undefined) add("sync_categories", input.syncCategories);
  if (input.autoPullOrders !== undefined) add("auto_pull_orders", input.autoPullOrders);
  if (input.orderLookbackDays !== undefined) {
    add("order_lookback_days", Math.min(365, Math.max(1, Math.round(input.orderLookbackDays))));
  }
  if (input.consumerKey !== undefined) add("consumer_key_ciphertext", encryptSecret(input.consumerKey.trim(), key));
  if (input.consumerSecret !== undefined) add("consumer_secret_ciphertext", encryptSecret(input.consumerSecret.trim(), key));
  if (input.wpUsername !== undefined) add("wp_username_ciphertext", encryptSecret(input.wpUsername.trim(), key));
  if (input.wpApplicationPassword !== undefined) {
    add("wp_application_password_ciphertext", encryptSecret(input.wpApplicationPassword.trim(), key));
  }
  if (sets.length === 0) return { ok: true, connection: mapConnection(existing) };

  // Issue #1149 (C6): a switch that is off has no queue behind it. Turning a
  // push off — or handing the store the authority — closes the stock/price
  // jobs still waiting, in the SAME statement as the switch, so no tick or
  // plugin pull can lease a job in the gap between the two. A job already
  // leased (`processing`) is mid-delivery and finishes; dead / needs_review
  // rows are a human's to decide; manual `product_update` events are the
  // owner's own edits and are never touched.
  const touchesPush =
    input.pushStock !== undefined || input.pushPrices !== undefined || input.sourceOfTruth !== undefined;
  const effective = effectivePushSwitches({
    source_of_truth: input.sourceOfTruth ?? existing.source_of_truth,
    push_stock: input.pushStock ?? existing.push_stock,
    push_prices: input.pushPrices ?? existing.push_prices,
  });
  const closeTypes = touchesPush
    ? [...(effective.pushStock ? [] : ["stock"]), ...(effective.pushPrices ? [] : ["price"])]
    : [];
  if (priceSourceChanged && !closeTypes.includes("price")) closeTypes.push("price");
  let sql: string;
  if (closeTypes.length > 0) {
    params.push(closeTypes);
    sql = `WITH updated AS (
             UPDATE integration_connections SET ${sets.join(", ")}, updated_at = now()
              WHERE business_id = $1 AND id = $2 AND deleted_at IS NULL
              RETURNING ${CONNECTION_COLUMNS}
           ), closed AS (
             UPDATE integration_outbox_events
                SET status = 'skipped', last_error = CASE WHEN entity_type = 'price' AND ${priceSourceChanged ? "true" : "false"}
                      THEN 'price_source_changed' ELSE 'push_switch_off' END,
                    leased_until = NULL, lease_token = NULL, updated_at = now()
              WHERE business_id = $1 AND connection_id = $2
                AND entity_type = ANY($${params.length}::text[])
                AND status IN ('pending', 'deferred', 'failed')
                AND EXISTS (SELECT 1 FROM updated)
              RETURNING id
           )
           SELECT * FROM updated`;
  } else {
    sql = `UPDATE integration_connections SET ${sets.join(", ")}, updated_at = now()
            WHERE business_id = $1 AND id = $2 AND deleted_at IS NULL
            RETURNING ${CONNECTION_COLUMNS}`;
  }
  const { rows } = await query<ConnectionRow>(sql, params);
  if (!rows[0]) return { ok: false, error: "not_found" };
  const auditPayload = { ...input } as Record<string, unknown>;
  for (const secretKey of ["consumerKey", "consumerSecret", "wpApplicationPassword"] as const) {
    if (secretKey in auditPayload) auditPayload[secretKey] = "[stored]";
  }
  await writeIntegrationAudit({ businessId, connectionId: id, action: "connection.updated", payload: auditPayload });
  if (existing.status === "paused" && input.status === "active") {
    const { reprocessDeferredIngestEvents } = await import("./webhook-ingest-service");
    await reprocessDeferredIngestEvents(rows[0]);
  }
  return { ok: true, connection: mapConnection(rows[0]) };
}

/** A disconnect is an irreversible credential revocation, never a history purge. */
export async function deleteConnection(businessId: string, id: string, actorUserId?: string): Promise<boolean> {
  // One statement: revocation and its durable audit commit together or neither
  // does. Do not send this security event through the best-effort logger.
  const { rowCount } = await query(
    `WITH revoked AS (
       UPDATE integration_connections
          SET deleted_at = now(), status = 'paused', updated_at = now(),
              consumer_key_ciphertext = NULL, consumer_secret_ciphertext = NULL,
              wp_username_ciphertext = NULL, wp_application_password_ciphertext = NULL,
              link_token_hash = NULL, link_token_ciphertext = NULL,
              webhook_secret_ciphertext = ''
        WHERE business_id = $1 AND id = $2 AND deleted_at IS NULL
        RETURNING id, business_id
     ), cleared_holoo AS (
       UPDATE holoo_connection_settings
          SET sql_user_ciphertext = NULL, sql_password_ciphertext = NULL,
              ws_user_ciphertext = NULL, ws_password_ciphertext = NULL,
              write_mode = 'none', companion_activated_at = NULL,
              direct_sql_armed_at = NULL, direct_sql_armed_by = NULL, updated_at = now()
        WHERE business_id = $1 AND connection_id IN (SELECT id FROM revoked)
     )
     INSERT INTO integration_audit_log (business_id, connection_id, action, payload)
     SELECT business_id, id, 'connection.deleted',
            jsonb_build_object('actorUserId', $3::text, 'retention', 'preserved') FROM revoked`,
    [businessId, id, actorUserId ?? null],
  );
  return rowCount === 1;
}

/**
 * Decrypts a connection's credentials and returns a ready-to-use client.
 *
 * Throws in plugin mode rather than returning null: there are no consumer keys
 * there *by design*, so any code path that reaches this has assumed the wrong
 * link mode, and a thrown error names that at the point of the mistake instead
 * of producing an unauthenticated request against the store.
 */
export function wooClientFor(connection: ConnectionRow) {
  if (connection.provider !== "woocommerce" || connection.link_mode !== "rest_api" || !connection.consumer_key_ciphertext || !connection.consumer_secret_ciphertext) {
    throw new Error("no_rest_credentials");
  }
  const key = resolveEncryptionKey(process.env);
  const credentials: WooCredentials = {
    baseUrl: connection.base_url,
    consumerKey: decryptSecret(connection.consumer_key_ciphertext, key),
    consumerSecret: decryptSecret(connection.consumer_secret_ciphertext, key),
    ...(connection.wp_username_ciphertext && connection.wp_application_password_ciphertext
      ? {
          wpUsername: decryptSecret(connection.wp_username_ciphertext, key),
          wpApplicationPassword: decryptSecret(connection.wp_application_password_ciphertext, key),
        }
      : {}),
  };
  return createWooCommerceClient(credentials);
}

/**
 * The plugin's link token in plaintext, for verifying an inbound request's
 * HMAC. Null when this connection has none (a rest_api connection, or one
 * whose token was never issued).
 */
export function linkTokenFor(connection: ConnectionRow): string | null {
  if (!connection.link_token_ciphertext) return null;
  return decryptSecret(connection.link_token_ciphertext, resolveEncryptionKey(process.env));
}

/** Decrypts the webhook secret used to verify inbound delivery signatures. */
export function webhookSecretFor(connection: ConnectionRow): string {
  return decryptSecret(connection.webhook_secret_ciphertext, resolveEncryptionKey(process.env));
}

/**
 * Connection test, in whichever direction this connection actually runs.
 *
 * `rest_api`: a 1-page products read proves the credentials and the store's
 * reachability, because in that mode the app is the caller.
 *
 * `plugin`: the app never dials the store, so there is nothing to call. What
 * "connected" means there is that the plugin has authenticated recently — so
 * that is what is reported, together with the last time it did. The plugin's
 * own «آزمایش اتصال» button is the active half of this test: it calls
 * /api/integrations/wordpress/ping, which updates exactly this timestamp.
 */
export async function testConnection(
  businessId: string,
  id: string,
): Promise<{ ok: boolean; error?: string; lastSeenAt?: string | null }> {
  const connection = await getConnection(businessId, id);
  if (!connection || connection.provider !== "woocommerce") return { ok: false, error: "not_found" };

  if (connection.link_mode === "plugin") {
    const health = deriveTransportHealth(connection);
    const ok = health.state === "healthy" || health.state === "paused";
    await writeIntegrationAudit({
      businessId,
      connectionId: id,
      action: ok ? "connection.plugin_status_ok" : "connection.plugin_status_failed",
      payload: { health },
      error: ok ? undefined : health.message ?? health.state,
    });
    return ok
      ? { ok: true, lastSeenAt: health.lastSeenAt }
      : { ok: false, error: health.message ?? health.state, lastSeenAt: health.lastSeenAt };
  }

  try {
    await wooClientFor(connection).listProducts({ per_page: 1 });
    await query(
      `UPDATE integration_connections SET last_test_at = now(), last_successful_test_at = now(), last_test_error = NULL, updated_at = now()
        WHERE business_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [businessId, id],
    );
    await writeIntegrationAudit({ businessId, connectionId: id, action: "connection.test_ok" });
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error && /^[a-z_]+$/.test(err.message) ? err.message : "connection_test_failed";
    await query(
      `UPDATE integration_connections SET last_test_at = now(), last_test_error = $3, updated_at = now()
        WHERE business_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [businessId, id, message],
    );
    await writeIntegrationAudit({ businessId, connectionId: id, action: "connection.test_failed", error: message });
    return { ok: false, error: message };
  }
}
