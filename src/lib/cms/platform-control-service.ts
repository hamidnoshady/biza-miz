/**
 * The CMS control plane's store (migration 0139) — DB-touching, so per repo
 * convention not unit-tested directly; the pure half is `platform-control.ts`.
 *
 * Three tables, three jobs:
 *
 *   `platform_cms_config`    one row: the CMS address and its `role: "platform"`
 *                            key (encrypted), the sync switches, and the cursor
 *                            the event shipper resumes from.
 *   `platform_cms_sites`     a mirror of the CMS's own site list, so the console
 *                            renders a report when the CMS is unreachable and a
 *                            fleet-wide question needs one query instead of N
 *                            calls across the network.
 *   `platform_cms_sync_runs` one row per sync, either direction.
 *
 * None of them is tenant data (they are in `EXEMPT_TABLES`), so every function
 * here assumes the caller has already established the platform bypass scope —
 * which `withPlatformScope` does for every console route, and
 * `withoutTenantScope("platform", …)` does for the server tick.
 *
 * The credential rule, restated because it is the one thing worth getting wrong
 * only once: an empty `apiKey` in a patch means *unchanged*. `parseCmsConfigPatch`
 * omits the field entirely in that case, and `clearApiKey` is the explicit door.
 */
import { query, withoutTenantScope } from "../db";
import { decryptSecret, encryptSecret, resolveEncryptionKey } from "../integrations/secrets";
import type { CmsConfig } from "./client";
import { normalizeCmsBaseUrl } from "./client";
import {
  cmsConfigSetClause,
  cmsConfigUpdateAssignments,
  maskCmsControlConfig,
  type CmsControlConfig,
  type CmsSiteRow,
  type MaskedCmsControlConfig,
  type MirroredCmsSite,
  type SyncKind,
  type SyncRunRow,
  type ValidatedCmsPatch,
} from "./platform-control";

interface ConfigRow extends Record<string, unknown> {
  allow_insecure: boolean;
  api_key_ciphertext: null | string;
  api_key_hint: string;
  billing_entitlement_key_id: string;
  billing_entitlement_secret_hint: string;
  base_url: string;
  events_cursor: null | string;
  events_shipped: string;
  store_order_ingest_cursor: null | string;
  label: string;
  last_events_at: null | string;
  last_events_error: null | string;
  last_mirror_at: null | string;
  last_mirror_error: null | string;
  log_shipping_enabled: boolean;
  mirror_enabled: boolean;
  mirror_interval_minutes: number;
  updated_at: null | string;
  verified_at: null | string;
  verify_error: null | string;
}

const CONFIG_COLUMNS = `base_url, label, allow_insecure, api_key_ciphertext, api_key_hint,
       billing_entitlement_key_id, billing_entitlement_secret_hint,
       verified_at, verify_error, mirror_enabled, mirror_interval_minutes,
       last_mirror_at, last_mirror_error, log_shipping_enabled, events_cursor,
       store_order_ingest_cursor,
       last_events_at, last_events_error, events_shipped, updated_at`;

function toConfig(row: ConfigRow | undefined): CmsControlConfig {
  return {
    allowInsecure: row?.allow_insecure ?? false,
    baseUrl: row?.base_url ?? "",
    eventsCursor: row?.events_cursor ?? null,
    storeOrderIngestCursor: row?.store_order_ingest_cursor ?? null,
    // `bigint` comes back as a string from node-postgres; a console figure that
    // silently became "12" + 1 = "121" is the classic version of this bug.
    eventsShipped: Number(row?.events_shipped ?? 0),
    label: row?.label ?? "",
    lastEventsAt: row?.last_events_at ?? null,
    lastEventsError: row?.last_events_error ?? null,
    lastMirrorAt: row?.last_mirror_at ?? null,
    lastMirrorError: row?.last_mirror_error ?? null,
    logShippingEnabled: row?.log_shipping_enabled ?? false,
    mirrorEnabled: row?.mirror_enabled ?? false,
    mirrorIntervalMinutes: row?.mirror_interval_minutes ?? 30,
    updatedAt: row?.updated_at ?? null,
    verifiedAt: row?.verified_at ?? null,
    verifyError: row?.verify_error ?? null,
  };
}

async function readConfigRow(): Promise<ConfigRow | undefined> {
  const { rows } = await query<ConfigRow>(
    `SELECT ${CONFIG_COLUMNS} FROM platform_cms_config WHERE id = true`,
  );
  return rows[0];
}

/** The console's view: never the key, only which key. */
export async function getCmsControlConfig(): Promise<MaskedCmsControlConfig> {
  const row = await readConfigRow();
  return maskCmsControlConfig(toConfig(row), {
    apiKeyHint: row?.api_key_hint ?? "",
    billingEntitlementKeyId: row?.billing_entitlement_key_id ?? "",
    billingEntitlementSecretHint: row?.billing_entitlement_secret_hint ?? "",
    hasApiKey: Boolean(row?.api_key_ciphertext),
  });
}

/**
 * The client config for the CMS's platform API: address + decrypted key.
 *
 * `null` when either half is missing, so a route can answer `cms_not_configured`
 * instead of throwing — an operator has to be able to open the settings page on a
 * deployment that has never had a CMS.
 *
 * No `siteDomain`: a platform call is dialed at the control-plane origin with the
 * control plane's own `Host`, which is what keeps `/api/platform/*` on the
 * control-plane block of the CMS's Caddyfile (see that repo's
 * docs/platform-control-api.md §2).
 */
export async function resolvePlatformCmsConfig(): Promise<CmsConfig | null> {
  const row = await readConfigRow();
  if (row?.base_url && row.api_key_ciphertext) {
    try {
      return {
        apiKey: decryptSecret(row.api_key_ciphertext, resolveEncryptionKey(process.env)),
        baseUrl: normalizeCmsBaseUrl(row.base_url),
      };
    } catch {
      // A rotated INTEGRATIONS_ENCRYPTION_KEY / JWT_SECRET orphans the ciphertext.
      // Falling through to the env pair is the right direction: an operator who
      // still has the env credential keeps working while they re-enter the key,
      // and the console's `verifyError` is where the state is visible.
    }
  }

  // The env pair stays supported for deployments configured before migration
  // 0139 (and for a container that would rather hold the credential in its
  // environment than its database). The stored row wins when both exist.
  const baseUrl = process.env.ESHOBE_CMS_URL?.trim();
  const apiKey = process.env.ESHOBE_CMS_PLATFORM_API_KEY?.trim();
  if (!baseUrl || !apiKey) return null;
  return { apiKey, baseUrl: normalizeCmsBaseUrl(baseUrl) };
}

/** True when a platform credential exists at all — the cheap check a route makes first. */
export async function hasPlatformCmsConfig(): Promise<boolean> {
  return (await resolvePlatformCmsConfig()) !== null;
}

export async function saveCmsControlConfig(
  changes: ValidatedCmsPatch,
  adminId: null | string,
): Promise<MaskedCmsControlConfig> {
  // Which column each edit touches, and how it is folded into one UPDATE, is
  // `platform-control.ts`'s decision — see `cmsConfigUpdateAssignments`. It lives
  // there so the interesting case (a save that changes the address *and* the key,
  // and so clears the same proof twice) is unit-tested rather than discovered on
  // a console at 1am.
  const { sets, values } = cmsConfigSetClause(
    cmsConfigUpdateAssignments(changes, {
      adminId,
      encryptApiKey: (apiKey) => encryptSecret(apiKey, resolveEncryptionKey(process.env)),
    }),
  );

  await query(`UPDATE platform_cms_config SET ${sets.join(", ")} WHERE id = true`, values);
  return getCmsControlConfig();
}

/** Stamp the result of an actual round trip to the CMS. */
export async function recordCmsVerification(result: {
  error?: null | string;
  ok: boolean;
}): Promise<void> {
  await query(
    `UPDATE platform_cms_config
        SET verified_at = CASE WHEN $1 THEN now() ELSE verified_at END,
            verify_error = $2
      WHERE id = true`,
    [result.ok, result.ok ? null : (result.error ?? "unknown_error").slice(0, 500)],
  );
}

// ---------------------------------------------------------------------------
// The mirror
// ---------------------------------------------------------------------------

interface SiteMirrorRow extends Record<string, unknown> {
  aliases: unknown;
  available_locales: string[];
  business_id: null | string;
  business_name: null | string;
  categories: number;
  cms_updated_at: null | string;
  currency: null | string;
  default_locale: string;
  domain: string;
  domain_verified: boolean;
  gateways: unknown;
  media: number;
  mirrored_at: string;
  name: string;
  orders: number;
  orders_paid: number;
  pages: number;
  pages_published: number;
  posts: number;
  posts_published: number;
  products: number;
  products_published: number;
  site_id: string;
  site_type: string;
  status: string;
}

function toMirroredSite(row: SiteMirrorRow): MirroredCmsSite {
  return {
    aliases: Array.isArray(row.aliases)
      ? (row.aliases as { hostname?: unknown; verified?: unknown }[]).map((alias) => ({
          hostname: String(alias?.hostname ?? ""),
          verified: alias?.verified === true,
        }))
      : [],
    availableLocales: row.available_locales ?? [],
    businessId: row.business_id,
    businessName: row.business_name,
    currency: row.currency,
    defaultLocale: row.default_locale,
    domain: row.domain,
    domainVerified: row.domain_verified,
    gateways: Array.isArray(row.gateways)
      ? (row.gateways as { enabled?: unknown; gateway?: unknown; selfTest?: unknown }[]).map(
          (gateway) => ({
            enabled: gateway?.enabled === true,
            gateway: String(gateway?.gateway ?? ""),
            selfTest: typeof gateway?.selfTest === "string" ? gateway.selfTest : null,
          }),
        )
      : [],
    id: row.site_id,
    mirroredAt: row.mirrored_at,
    name: row.name,
    status: row.status,
    totals: {
      categories: row.categories,
      media: row.media,
      orders: row.orders,
      ordersPaid: row.orders_paid,
      pages: row.pages,
      pagesPublished: row.pages_published,
      posts: row.posts,
      postsPublished: row.posts_published,
      products: row.products,
      productsPublished: row.products_published,
    },
    type: row.site_type,
    updatedAt: row.cms_updated_at,
  };
}

/**
 * Replace the mirror with what the CMS just reported.
 *
 * An upsert per site plus a delete of what the CMS no longer lists — because a
 * site *removed* from the CMS is the one state a pure upsert can never represent,
 * and a console that keeps showing a deleted customer's site is worse than one
 * showing none. `business_id` is resolved by joining this platform's own
 * `eshobe_cms_connections`, so "whose site is this?" is answered here rather than
 * asked of the CMS, which has no idea who bills for it.
 */
export async function replaceCmsSiteMirror(sites: readonly CmsSiteRow[]): Promise<number> {
  for (const site of sites) {
    await query(
      `INSERT INTO platform_cms_sites
         (site_id, domain, name, site_type, status, domain_verified, default_locale,
          available_locales, currency, pages, pages_published, posts, posts_published,
          products, products_published, categories, media, orders, orders_paid,
          aliases, gateways, business_id, cms_updated_at, mirrored_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
               $17, $18, $19, $20::jsonb, $21::jsonb,
               (SELECT business_id FROM eshobe_cms_connections WHERE site_id = $1 LIMIT 1),
               $22, now())
       ON CONFLICT (site_id) DO UPDATE SET
         domain = EXCLUDED.domain,
         name = EXCLUDED.name,
         site_type = EXCLUDED.site_type,
         status = EXCLUDED.status,
         domain_verified = EXCLUDED.domain_verified,
         default_locale = EXCLUDED.default_locale,
         available_locales = EXCLUDED.available_locales,
         currency = EXCLUDED.currency,
         pages = EXCLUDED.pages,
         pages_published = EXCLUDED.pages_published,
         posts = EXCLUDED.posts,
         posts_published = EXCLUDED.posts_published,
         products = EXCLUDED.products,
         products_published = EXCLUDED.products_published,
         categories = EXCLUDED.categories,
         media = EXCLUDED.media,
         orders = EXCLUDED.orders,
         orders_paid = EXCLUDED.orders_paid,
         aliases = EXCLUDED.aliases,
         gateways = EXCLUDED.gateways,
         business_id = EXCLUDED.business_id,
         cms_updated_at = EXCLUDED.cms_updated_at,
         mirrored_at = now()`,
      [
        site.id,
        site.domain,
        site.name,
        site.type,
        site.status,
        site.domainVerified,
        site.defaultLocale ?? "fa",
        site.availableLocales,
        site.currency,
        site.totals.pages ?? 0,
        site.totals.pagesPublished ?? 0,
        site.totals.posts ?? 0,
        site.totals.postsPublished ?? 0,
        site.totals.products ?? 0,
        site.totals.productsPublished ?? 0,
        site.totals.categories ?? 0,
        site.totals.media ?? 0,
        site.totals.orders ?? 0,
        site.totals.ordersPaid ?? 0,
        JSON.stringify(site.aliases ?? []),
        JSON.stringify(site.gateways ?? []),
        site.updatedAt,
      ],
    );
  }

  const ids = sites.map((site) => site.id);
  if (ids.length) {
    await query(`DELETE FROM platform_cms_sites WHERE site_id <> ALL($1::text[])`, [ids]);
  } else {
    await query(`DELETE FROM platform_cms_sites`);
  }

  await query(
    `UPDATE platform_cms_config SET last_mirror_at = now(), last_mirror_error = NULL WHERE id = true`,
  );
  return sites.length;
}

export async function recordMirrorFailure(error: string): Promise<void> {
  await query(
    `UPDATE platform_cms_config SET last_mirror_error = $1 WHERE id = true`,
    [error.slice(0, 500)],
  );
}

export async function listMirroredCmsSites(): Promise<MirroredCmsSite[]> {
  const { rows } = await query<SiteMirrorRow>(
    `SELECT s.site_id, s.domain, s.name, s.site_type, s.status, s.domain_verified,
            s.default_locale, s.available_locales, s.currency,
            s.pages, s.pages_published, s.posts, s.posts_published,
            s.products, s.products_published, s.categories, s.media,
            s.orders, s.orders_paid, s.aliases, s.gateways,
            s.business_id, b.name AS business_name, s.cms_updated_at, s.mirrored_at
       FROM platform_cms_sites s
       LEFT JOIN businesses b ON b.id = s.business_id
      ORDER BY s.domain`,
  );
  return rows.map(toMirroredSite);
}

// ---------------------------------------------------------------------------
// The event cursor
// ---------------------------------------------------------------------------

/**
 * Advance the shipper's cursor and count what it shipped.
 *
 * `GREATEST` rather than a plain assignment: two overlapping polls (a manual
 * button pressed while the tick was running) must never walk the cursor
 * backwards and re-ship a window that was already sent.
 */
export async function advanceCmsEventsCursor(cursor: null | string, shipped: number): Promise<void> {
  await query(
    `UPDATE platform_cms_config
        SET events_cursor = CASE
              WHEN $1::timestamptz IS NULL THEN events_cursor
              WHEN events_cursor IS NULL THEN $1::timestamptz
              ELSE GREATEST(events_cursor, $1::timestamptz)
            END,
            events_shipped = events_shipped + $2,
            last_events_at = now(),
            last_events_error = NULL
      WHERE id = true`,
    [cursor, Math.max(0, Math.trunc(shipped))],
  );
}

export async function recordEventsFailure(error: string): Promise<void> {
  await query(`UPDATE platform_cms_config SET last_events_error = $1 WHERE id = true`, [
    error.slice(0, 500),
  ]);
}

export async function advanceStoreOrderIngestCursor(cursor: null | string): Promise<void> {
  await query(
    `UPDATE platform_cms_config
        SET store_order_ingest_cursor = CASE
              WHEN $1::timestamptz IS NULL THEN store_order_ingest_cursor
              WHEN store_order_ingest_cursor IS NULL THEN $1::timestamptz
              ELSE GREATEST(store_order_ingest_cursor, $1::timestamptz)
            END
      WHERE id = true`,
    [cursor],
  );
}

// ---------------------------------------------------------------------------
// The sync log
// ---------------------------------------------------------------------------

export interface RecordSyncRunInput {
  created?: number;
  detail?: Record<string, unknown>;
  dryRun?: boolean;
  durationMs: number;
  error?: null | string;
  items?: number;
  kind: SyncKind;
  siteId?: null | string;
  skipped?: number;
  startedBy?: null | string;
  status: "failed" | "ok" | "partial";
  trigger: "manual" | "scheduled";
  updated?: number;
}

export async function recordCmsSyncRun(input: RecordSyncRunInput): Promise<void> {
  await query(
    `INSERT INTO platform_cms_sync_runs
       (kind, trigger, site_id, status, dry_run, items, created, updated, skipped,
        duration_ms, error, detail, started_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13)`,
    [
      input.kind,
      input.trigger,
      input.siteId ?? null,
      input.status,
      input.dryRun ?? false,
      Math.max(0, Math.trunc(input.items ?? 0)),
      Math.max(0, Math.trunc(input.created ?? 0)),
      Math.max(0, Math.trunc(input.updated ?? 0)),
      Math.max(0, Math.trunc(input.skipped ?? 0)),
      Math.max(0, Math.trunc(input.durationMs)),
      input.error ? input.error.slice(0, 1000) : null,
      JSON.stringify(input.detail ?? {}),
      input.startedBy ?? null,
    ],
  );
}

export async function listCmsSyncRuns(limit = 30): Promise<SyncRunRow[]> {
  const { rows } = await query<{
    created: number;
    created_at: string;
    detail: unknown;
    dry_run: boolean;
    duration_ms: number;
    error: null | string;
    id: string;
    items: number;
    kind: SyncKind;
    site_id: null | string;
    skipped: number;
    status: "failed" | "ok" | "partial";
    trigger: "manual" | "scheduled";
    updated: number;
  }>(
    `SELECT id, kind, trigger, site_id, status, dry_run, items, created, updated,
            skipped, duration_ms, error, detail, created_at
       FROM platform_cms_sync_runs
      ORDER BY created_at DESC
      LIMIT $1`,
    [Math.min(Math.max(Math.trunc(limit), 1), 200)],
  );
  return rows.map((row) => ({
    created: row.created,
    createdAt: row.created_at,
    detail: (row.detail ?? {}) as Record<string, unknown>,
    dryRun: row.dry_run,
    durationMs: row.duration_ms,
    error: row.error,
    id: row.id,
    items: row.items,
    kind: row.kind,
    siteId: row.site_id,
    skipped: row.skipped,
    status: row.status,
    trigger: row.trigger,
    updated: row.updated,
  }));
}

/**
 * The same three reads, for code with no request behind it (`server.ts`'s tick).
 *
 * Background work has no session to derive a tenant from, so it enters the
 * platform bypass explicitly — the documented `platform` reason in `db.ts`, the
 * same one every other console-owned tick uses.
 */
export function inPlatformScope<T>(fn: () => Promise<T>): Promise<T> {
  return withoutTenantScope("platform", fn);
}
