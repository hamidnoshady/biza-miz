/**
 * Phase 40 — read models for the WordPress & WooCommerce Manager app.
 *
 * All queries here are local: they read what the sync has already mirrored
 * (mappings, terms, inbox events, content mirror, outbox queue). In plugin
 * mode that is the *only* data the app can have — it never dials the store —
 * so every manager screen works identically in both link modes.
 */
import { randomUUID } from "node:crypto";
import { query } from "../db";
import { toLatinDigits } from "../digits";
import { getConnection, wooClientFor } from "./connections-service";
import { drainOutbox } from "./outbox-service";
import { reprocessExistingIngestEvent } from "./webhook-ingest-service";
import { wpContentCounts } from "./wp-content-service";
import { writeIntegrationAudit } from "./audit";
import { capQueueError, redactPayload } from "./payload-redact";
import { OUTBOX_MAX_ATTEMPTS, PLUGIN_JOB_MAX_ATTEMPTS } from "./retry";
import { toPersianDigits } from "../digits";

export interface WpOverviewStats {
  connections: {
    total: number;
    active: number;
    plugin: number;
    rest: number;
  };
  products: number;
  orders: number;
  customers: number;
  terms: number;
  content: { posts: number; pages: number; media: number };
  /** Outbound `pending` + `processing` + `failed` — kept for the platform report; prefer `queue`. */
  pendingJobs: number;
  failedJobs: number;
  deadJobs: number;
  pendingInboxEvents: number;
  failedInboxEvents: number;
  /**
   * The same classification the Queue page shows (#944 / OVR-03), so the
   * overview's tiles and the queue's summary never disagree on what counts
   * as waiting versus what needs a person.
   */
  queue: WpQueueSummary;
}

/**
 * The one status-to-KPI classification for the sync queue, shared by the
 * overview (`wpOverviewStats`) and the Queue page (`wpQueueSummary`).
 *
 * Outbound (`integration_outbox_events`) statuses:
 *   pending, processing            → in flight (`pending` / `processing`)
 *   failed, needs_review           → failed (retryable / needs a decision)
 *   dead                           → dead (gave up; a person must act)
 *   skipped                        → skipped (plugin policy did not apply it)
 *   sent                           → done
 * Inbound (`integration_webhook_events`) statuses:
 *   pending, deferred              → in flight (`pending`; `deferred` also
 *                                    reported on its own)
 *   failed                         → failed
 *   processed                      → done
 *
 * `inFlight` is everything still expected to move on its own; `attention`
 * is everything that will not move without a person (failed + needs_review +
 * dead + inbound failed). `open` is the sum of the two.
 */
export function summarizeQueueCounts(
  outbox: ReadonlyMap<string, number>,
  inbox: ReadonlyMap<string, number>,
): WpQueueSummary {
  const n = (map: ReadonlyMap<string, number>, status: string) => map.get(status) ?? 0;
  const deferred = n(inbox, "deferred");
  const inboundPending = n(inbox, "pending") + deferred;
  const needsReview = n(outbox, "needs_review");
  const pending = n(outbox, "pending") + inboundPending;
  const processing = n(outbox, "processing");
  const inboundFailed = n(inbox, "failed");
  const failed = n(outbox, "failed") + needsReview + inboundFailed;
  const dead = n(outbox, "dead");
  const skipped = n(outbox, "skipped");
  const sent = n(outbox, "sent") + n(inbox, "processed");
  const outboundFailed = n(outbox, "failed") + dead + needsReview;
  const total =
    Array.from(outbox.values()).reduce((a, b) => a + b, 0) +
    Array.from(inbox.values()).reduce((a, b) => a + b, 0);
  const inFlight = pending + processing;
  const attention = failed + dead;

  return {
    total,
    pending,
    processing,
    failed,
    dead,
    sent,
    deferred,
    inboundFailed,
    outboundFailed,
    needsReview,
    skipped,
    inboundPending,
    inFlight,
    attention,
    open: inFlight + attention,
  };
}

/** Aggregate counts for the manager's میز کار, scoped to one connection or the whole business. */
export async function wpOverviewStats(
  businessId: string,
  connectionId?: string | readonly string[] | null,
): Promise<WpOverviewStats> {
  // A supplied empty list means no access, never an unfiltered business view.
  // The omitted scope remains available to trusted platform reporting callers.
  const ids = typeof connectionId === "string" ? [connectionId] : connectionId ?? null;
  const scope = ids !== null ? "AND id = ANY($2::uuid[])" : "";
  const eventScope = ids !== null ? "AND connection_id = ANY($2::uuid[])" : "";
  const params: unknown[] = ids !== null ? [businessId, ids] : [businessId];

  const { rows: connRows } = await query<{ total: string; active: string; plugin: string; rest: string }>(
    `SELECT count(*)::text AS total,
            count(*) FILTER (WHERE status = 'active')::text AS active,
            count(*) FILTER (WHERE link_mode = 'plugin')::text AS plugin,
            count(*) FILTER (WHERE link_mode = 'rest_api')::text AS rest
       FROM integration_connections
      WHERE business_id = $1 AND provider = 'woocommerce' AND deleted_at IS NULL ${scope}`,
    params,
  );

  const conn = connRows[0] ?? { total: "0", active: "0", plugin: "0", rest: "0" };

  const { rows: mapRows } = await query<{ entity: string; n: string }>(
    `SELECT entity_type AS entity, count(DISTINCT remote_id)::text AS n
       FROM integration_mappings
      WHERE business_id = $1
        AND connection_id IN (SELECT id FROM integration_connections WHERE business_id = $1 AND provider = 'woocommerce' AND deleted_at IS NULL)
        ${eventScope}
        AND entity_type IN ('product', 'order', 'customer', 'refund')
      GROUP BY entity_type`,
    params,
  );
  const byEntity = new Map(mapRows.map((r) => [r.entity, Number(r.n)]));

  const { rows: termRows } = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM integration_woo_terms
      WHERE business_id = $1
        AND connection_id IN (SELECT id FROM integration_connections WHERE business_id = $1 AND provider = 'woocommerce' AND deleted_at IS NULL)
        ${eventScope}`,
    params,
  );

  // Content counts mirror one connection per row; across a business with
  // several stores they sum, which is what the overview wants to show.
  const { rows: contentRows } = await query<{ wp_type: string; n: string }>(
    `SELECT wp_type, count(*)::text AS n
       FROM integration_wp_content
      WHERE business_id = $1
        AND connection_id IN (SELECT id FROM integration_connections WHERE business_id = $1 AND provider = 'woocommerce' AND deleted_at IS NULL)
        ${eventScope}
      GROUP BY wp_type`,
    params,
  );
  const contentTotaled = contentRows.reduce(
    (acc, row) => {
      if (row.wp_type === "post") acc.posts = Number(row.n);
      else if (row.wp_type === "page") acc.pages = Number(row.n);
      else if (row.wp_type === "attachment") acc.media = Number(row.n);
      return acc;
    },
    { posts: 0, pages: 0, media: 0 },
  );

  const { rows: outboxRows } = await query<{ status: string; n: string }>(
    `SELECT status, count(*)::text AS n FROM integration_outbox_events
      WHERE business_id = $1
        AND connection_id IN (SELECT id FROM integration_connections WHERE business_id = $1 AND provider = 'woocommerce' AND deleted_at IS NULL)
        ${eventScope}
      GROUP BY status`,
    params,
  );
  const outbox = new Map(outboxRows.map((r) => [r.status, Number(r.n)]));

  const { rows: inboxRows } = await query<{ status: string; n: string }>(
    `SELECT status, count(*)::text AS n FROM integration_webhook_events
      WHERE business_id = $1
        AND connection_id IN (SELECT id FROM integration_connections WHERE business_id = $1 AND provider = 'woocommerce' AND deleted_at IS NULL)
        ${eventScope}
        -- Exactly the inbox statuses summarizeQueueCounts classifies (#944 /
        -- OVR-03): in-flight ones for the pending/failed KPIs and 'processed'
        -- for sent/total. 'duplicate' and friends stay out of every KPI.
        AND status IN ('pending', 'failed', 'deferred', 'processed')
      GROUP BY status`,
    params,
  );
  const inbox = new Map(inboxRows.map((r) => [r.status, Number(r.n)]));
  const queue = summarizeQueueCounts(outbox, inbox);

  return {
    connections: {
      total: Number(conn.total),
      active: Number(conn.active),
      plugin: Number(conn.plugin),
      rest: Number(conn.rest),
    },
    products: byEntity.get("product") ?? 0,
    orders: byEntity.get("order") ?? 0,
    customers: byEntity.get("customer") ?? 0,
    terms: Number(termRows[0]?.n ?? 0),
    content: contentTotaled,
    pendingJobs: (outbox.get("pending") ?? 0) + (outbox.get("processing") ?? 0) + (outbox.get("failed") ?? 0),
    failedJobs: outbox.get("failed") ?? 0,
    deadJobs: outbox.get("dead") ?? 0,
    pendingInboxEvents: queue.inboundPending,
    failedInboxEvents: queue.inboundFailed,
    queue,
  };
}

export type WpStoreCustomerAccountType = "registered" | "guest" | "subscriber";
export type WpStoreCustomerIdentityFilter =
  | "all"
  | "linked"
  | "unlinked"
  | "needs_review"
  | "conflict"
  | "ignored";
export type WpStoreCustomerRemoteFilter = "active" | "deleted" | "all";
export type WpStoreCustomerSort = "name" | "last_synced" | "orders";

/**
 * Where one store customer stands in identity reconciliation (#937). Derived
 * from `identity_status` above — `auto_matched`/`confirmed`/`legacy` all mean a
 * live party is linked, so they collapse into `linked`.
 */
export type WpStoreCustomerStatus = "linked" | "unmapped" | "needs_review" | "conflict" | "ignored";

export const WP_STORE_CUSTOMER_STATUSES: readonly WpStoreCustomerStatus[] = [
  "linked",
  "unmapped",
  "needs_review",
  "conflict",
  "ignored",
];

/** Narrow an untrusted `?status=` value to a filter the read model understands. */
export function wpCustomersStatusFilter(requested: string | undefined): WpStoreCustomerStatus | undefined {
  return (WP_STORE_CUSTOMER_STATUSES as readonly string[]).includes(requested ?? "")
    ? (requested as WpStoreCustomerStatus)
    : undefined;
}

export interface WpStoreCustomerRow {
  remoteId: string;
  localId: string | null;
  externalProfileId: string | null;
  /**
   * The raw reconciliation state (#1040): `linked` parties keep their original
   * `legacy`/`auto_matched`/`confirmed` label, and a resolved-but-deleted
   * remote is `remote_deleted`.
   */
  identityStatus: string;
  /**
   * The same state in the vocabulary the `?status=` filter speaks (#937), so a
   * filtered page and an unfiltered one can be compared on one field: every
   * live party is `linked`, a profile with no party is `unmapped`, and
   * `needs_review`/`conflict`/`ignored` pass through unchanged. `null` when the
   * caller may not read identity details.
   */
  status: WpStoreCustomerStatus | null;
  accountType: WpStoreCustomerAccountType;
  remoteStatus: "active" | "deleted";
  name: string;
  remoteName: string;
  remotePhone: string | null;
  remoteEmail: string | null;
  canonicalName: string | null;
  canonicalPhone: string | null;
  canonicalEmail: string | null;
  phone: string | null;
  email: string | null;
  ordersCount: number | null;
  lastOnlineOrderAt: string | null;
  lastSyncedAt: string | null;
}

export interface WpStoreCustomersPage {
  customers: WpStoreCustomerRow[];
  /** All matched store identities, including the ones past the returned page. */
  total: number;
  /**
   * The page actually returned. May differ from the page requested: an
   * out-of-range request is clamped onto the last page that has rows, so the
   * caller can echo a page number that agrees with the rows beside it.
   */
  page: number;
  pageSize: number;
  /** `ceil(total / pageSize)`, at least 1 — so the UI never derives it twice. */
  totalPages: number;
  /** True when the requested page was past the end and had to be clamped. */
  clamped: boolean;
}

export interface WpStoreCustomerOptions {
  page?: number;
  pageSize?: number;
  search?: string;
  accountType?: WpStoreCustomerAccountType | "all";
  identityFilter?: WpStoreCustomerIdentityFilter;
  remoteFilter?: WpStoreCustomerRemoteFilter;
  sort?: WpStoreCustomerSort;
  /** CRM-backed party fields are returned only when the caller may open person files. */
  includePartyDetails?: boolean;
  /** Identity status and internal profile ids require CRM read access. */
  includeIdentityDetails?: boolean;
  /** Online order counts and dates are sensitive history and require orders.view. */
  includeOrderCounts?: boolean;
  /** Only rows whose reconciliation status equals this; undefined = the whole book. */
  status?: WpStoreCustomerStatus;
}

export const WP_CUSTOMERS_MIN_PAGE_SIZE = 10;
export const WP_CUSTOMERS_MAX_PAGE_SIZE = 100;
export const WP_CUSTOMERS_DEFAULT_PAGE_SIZE = 25;

/** Clamp a requested page size into the supported window. */
export function wpCustomersPageSize(requested: number | undefined): number {
  const raw = Math.floor(Number(requested ?? WP_CUSTOMERS_DEFAULT_PAGE_SIZE));
  // NaN is "the caller sent nonsense" → the default. Infinity is "the caller
  // wants everything" → the ceiling, not the default: silently handing back 25
  // rows for `pageSize=Infinity` is the same class of surprise as the window
  // count this function exists to replace.
  if (Number.isNaN(raw)) return WP_CUSTOMERS_DEFAULT_PAGE_SIZE;
  return Math.min(WP_CUSTOMERS_MAX_PAGE_SIZE, Math.max(WP_CUSTOMERS_MIN_PAGE_SIZE, raw));
}

/**
 * Resolve the page that will actually be read.
 *
 * Pure, and unit-tested, because this is the half that was wrong: the old code
 * derived the total from `count(*) OVER ()` on the *page* query, so an OFFSET
 * past the end returned zero rows — and therefore no window row to read the
 * count from — and the screen reported «۰ مشتری» for a store that plainly had
 * customers on page 1. Narrowing a search while sitting on page 4 hit exactly
 * that. Count first, clamp second, then read the page.
 */
export function wpCustomersPageWindow(
  requestedPage: number | undefined,
  pageSize: number,
  total: number,
): { page: number; offset: number; totalPages: number; clamped: boolean } {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const raw = Math.floor(Number(requestedPage ?? 1));
  const asked = Number.isFinite(raw) && raw >= 1 ? raw : 1;
  const page = Math.min(asked, totalPages);
  return { page, offset: (page - 1) * pageSize, totalPages, clamped: page !== asked };
}

/**
 * The store's customers as the app knows them: external profiles plus
 * profile-less legacy mappings, joined to any local party, with the count of
 * orders mirrored *from this store*. Unresolved profiles remain visible.
 *
 * The order count deliberately goes through the order mappings — not
 * `orders.customer_id` alone — because the same CRM party also buys at the
 * POS, and the badge this feeds is labeled «سفارش آنلاین». `last_seen`
 * falls back to the freshest of the mapping's and the profile's own
 * timestamps: a store that only ever
 * pull-syncs (REST scheduled pulls, plugin exports) has no `customer.*`
 * inbox events, and without the fallback the column was blank for exactly
 * those stores.
 *
 * **Two queries, deliberately.** `total` comes from its own `COUNT(*)` over
 * the same filter rather than from a `count(*) OVER ()` window on the page
 * query. A window count only exists on rows that were returned, so an OFFSET
 * past the last page produced `total = 0` — a store with 300 mapped customers
 * claiming to have none, purely because the caller was on page 13. With the
 * count known first the page is clamped onto the last page that has rows, and
 * the caller is told (`clamped`) so it can correct its own state.
 */
export async function wpStoreCustomers(
  businessId: string,
  connectionId: string,
  options: WpStoreCustomerOptions = {},
): Promise<WpStoreCustomersPage> {
  const pageSize = wpCustomersPageSize(options.pageSize);
  const search = options.search?.trim().slice(0, 200) ?? "";
  const includePartyDetails = options.includePartyDetails ?? true;
  const includeOrderCounts = options.includeOrderCounts ?? true;
  const includeIdentityDetails = options.includeIdentityDetails ?? true;
  const accountType = options.accountType ?? "all";
  const identityFilter = options.identityFilter ?? "all";
  const remoteFilter = options.remoteFilter ?? "active";
  const sort = options.sort ?? "name";
  const status = options.status;

  // Profiles are the authoritative store-scoped customer population, including
  // unresolved identities with no integration_mappings row. Legacy mappings
  // remain visible only when no external profile exists for that remote key.
  // Every party join includes business_id: a corrupt legacy mapping must never
  // disclose another tenant's name or contact details.
  const customerCte = `WITH store_customers AS (
    SELECT p.remote_id,
           CASE WHEN party.id IS NOT NULL THEN p.party_id::text ELSE NULL END AS local_id,
           p.id::text AS external_profile_id,
           CASE WHEN p.remote_deleted_at IS NOT NULL THEN 'remote_deleted'
                WHEN party.id IS NULL AND p.status IN ('auto_matched', 'confirmed', 'conflict')
                THEN 'unmapped' ELSE p.status END AS identity_status,
           CASE
             WHEN p.remote_id LIKE 'guest:%' THEN 'guest'
             WHEN lower(COALESCE(p.remote_payload->>'role', '')) = 'subscriber'
               AND CASE
                     WHEN COALESCE(p.remote_payload->>'orders_count', '') ~ '^[0-9]+$'
                     THEN (p.remote_payload->>'orders_count')::int
                     ELSE 0
                   END = 0
               AND COALESCE(p.remote_payload->>'is_paying_customer', 'false') <> 'true'
             THEN 'subscriber'
             ELSE 'registered'
           END AS account_type,
           CASE WHEN p.remote_deleted_at IS NULL THEN 'active' ELSE 'deleted' END AS remote_status,
           p.remote_name,
           p.remote_email,
           p.remote_phone,
           party.name AS party_name,
           party.phone AS party_phone,
           party.email AS party_email,
           p.last_synced_at AS source_updated_at,
           p.last_synced_at,
           p.business_id,
           p.connection_id
      FROM crm_external_profiles p
      JOIN integration_connections pc
        ON pc.id = p.connection_id AND pc.business_id = p.business_id AND pc.provider = 'woocommerce' AND pc.deleted_at IS NULL
      LEFT JOIN parties party ON party.id = p.party_id AND party.business_id = p.business_id
     WHERE p.business_id = $1 AND p.connection_id = $2 AND p.provider = 'woocommerce'

    UNION ALL

    SELECT m.remote_id,
           CASE WHEN party.id IS NOT NULL THEN m.local_id::text ELSE NULL END AS local_id,
           NULL::text AS external_profile_id,
           CASE WHEN party.id IS NULL THEN 'unmapped' ELSE 'legacy' END AS identity_status,
           'registered'::text AS account_type,
           'active'::text AS remote_status,
           ''::text AS remote_name,
           NULL::text AS remote_email,
           NULL::text AS remote_phone,
           party.name AS party_name,
           party.phone AS party_phone,
           party.email AS party_email,
           m.updated_at AS source_updated_at,
           NULL::timestamptz AS last_synced_at,
           m.business_id,
           m.connection_id
      FROM integration_mappings m
      JOIN integration_connections mc
        ON mc.id = m.connection_id AND mc.business_id = m.business_id AND mc.provider = 'woocommerce' AND mc.deleted_at IS NULL
      LEFT JOIN parties party ON party.id = m.local_id AND party.business_id = m.business_id
     WHERE m.business_id = $1 AND m.connection_id = $2 AND m.entity_type = 'customer'
       AND NOT EXISTS (
         SELECT 1 FROM crm_external_profiles p
          WHERE p.business_id = m.business_id AND p.connection_id = m.connection_id
            AND p.provider = 'woocommerce' AND p.remote_id = m.remote_id
       )
  )`;

  // One parameterized filter is shared by the count and page query. Search
  // wildcards stay literal, and localized digits are normalized without
  // dropping the raw term (useful when a name contains Persian numerals).
  const filterParams: unknown[] = [businessId, connectionId, includePartyDetails, includeOrderCounts, includeIdentityDetails];
  const scopeFilters: string[] = [];
  if (remoteFilter !== "all") {
    filterParams.push(remoteFilter);
    scopeFilters.push(`s.remote_status = $${filterParams.length}`);
  }
  if (accountType !== "all") {
    filterParams.push(accountType);
    scopeFilters.push(`s.account_type = $${filterParams.length}`);
  }
  // `?status=` (issue #942) narrows on the same reconciliation state the rows
  // already carry; `linked` spans every identity_status that resolved to a
  // live party.
  if (status === "linked") scopeFilters.push("s.identity_status IN ('legacy', 'auto_matched', 'confirmed')");
  else if (status) {
    filterParams.push(status);
    scopeFilters.push(`s.identity_status = $${filterParams.length}`);
  }
  if (identityFilter === "linked") scopeFilters.push("s.local_id IS NOT NULL");
  else if (identityFilter === "unlinked") scopeFilters.push("s.identity_status = 'unmapped'");
  else if (identityFilter !== "all") {
    filterParams.push(identityFilter);
    scopeFilters.push(`s.identity_status = $${filterParams.length}`);
  }

  let searchSql = "";
  const searchVariants = search ? [...new Set([search, toLatinDigits(search)])] : [];
  if (searchVariants.length > 0) {
    const parts: string[] = [];
    for (const variant of searchVariants) {
      const escaped = variant.replace(/[\\%_]/g, (ch) => `\\${ch}`);
      filterParams.push(`%${escaped}%`);
      const n = `$${filterParams.length}`;
      parts.push(
        `(s.remote_id ILIKE ${n} ESCAPE '\\' OR s.remote_name ILIKE ${n} ESCAPE '\\'` +
        ` OR s.remote_phone ILIKE ${n} ESCAPE '\\' OR s.remote_email ILIKE ${n} ESCAPE '\\'` +
        ` OR ($3::boolean AND (s.party_name ILIKE ${n} ESCAPE '\\'` +
        ` OR s.party_phone ILIKE ${n} ESCAPE '\\' OR s.party_email ILIKE ${n} ESCAPE '\\')))`
      );
    }
    searchSql = `AND (${parts.join(" OR ")})`;
  }
  const scopeSql = scopeFilters.length ? `AND ${scopeFilters.join(" AND ")}` : "";
  // The CTE already scopes every row to this connection and excludes soft-
  // deleted connections in both the profile and legacy-mapping branches.
  const fromWhere = `FROM store_customers s WHERE s.business_id = $1 AND s.connection_id = $2
    AND $3::boolean IS NOT NULL AND $4::boolean IS NOT NULL AND $5::boolean IS NOT NULL ${scopeSql} ${searchSql}`;

  const { rows: countRows } = await query<{ total: string }>(
    `${customerCte} SELECT count(*)::text AS total ${fromWhere}`,
    filterParams,
  );
  const total = Number(countRows[0]?.total ?? 0);
  const { page, offset, totalPages, clamped } = wpCustomersPageWindow(options.page, pageSize, total);
  if (total === 0) {
    return { customers: [], total: 0, page: 1, pageSize, totalPages: 1, clamped: false };
  }

  const sortSql = sort === "last_synced"
    ? "last_synced_at DESC NULLS LAST, name ASC, s.remote_id ASC"
    : sort === "orders"
      ? "orders_count DESC NULLS LAST, name ASC, s.remote_id ASC"
      : "name ASC, s.remote_id ASC";
  const { rows } = await query<{
    remote_id: string;
    local_id: string | null;
    external_profile_id: string | null;
    identity_status: string;
    status: WpStoreCustomerStatus | null;
    account_type: WpStoreCustomerAccountType;
    remote_status: "active" | "deleted";
    name: string;
    remote_name: string;
    remote_phone: string | null;
    remote_email: string | null;
    canonical_name: string | null;
    canonical_phone: string | null;
    canonical_email: string | null;
    phone: string | null;
    email: string | null;
    orders_count: string | null;
    last_online_order_at: string | null;
    last_synced_at: string | null;
  }>(
    `${customerCte}
     SELECT s.remote_id,
            CASE WHEN $3::boolean THEN s.local_id ELSE NULL END AS local_id,
            CASE WHEN $5::boolean THEN s.external_profile_id ELSE NULL END AS external_profile_id,
            CASE WHEN $5::boolean THEN s.identity_status ELSE 'unavailable' END AS identity_status,
            CASE WHEN $5::boolean THEN
              CASE WHEN s.identity_status IN ('needs_review', 'conflict', 'ignored') THEN s.identity_status
                   WHEN s.local_id IS NOT NULL THEN 'linked'
                   ELSE 'unmapped' END
            ELSE NULL END::text AS status,
            s.account_type,
            s.remote_status,
            COALESCE(NULLIF(s.remote_name, ''), CASE WHEN $3::boolean THEN s.party_name ELSE '' END, '') AS name,
            s.remote_name,
            s.remote_phone,
            s.remote_email,
            CASE WHEN $3::boolean THEN s.party_name ELSE NULL END AS canonical_name,
            CASE WHEN $3::boolean THEN s.party_phone ELSE NULL END AS canonical_phone,
            CASE WHEN $3::boolean THEN s.party_email ELSE NULL END AS canonical_email,
            COALESCE(s.remote_phone, CASE WHEN $3::boolean THEN s.party_phone ELSE NULL END) AS phone,
            COALESCE(s.remote_email, CASE WHEN $3::boolean THEN s.party_email ELSE NULL END) AS email,
            CASE WHEN $4::boolean AND s.local_id IS NOT NULL THEN (
              SELECT count(*)::text
                FROM integration_mappings om
                JOIN orders o ON o.id = om.local_id
                JOIN locations ol ON ol.id = o.location_id AND ol.business_id = om.business_id
               WHERE om.business_id = $1 AND om.connection_id = s.connection_id
                 AND om.entity_type = 'order' AND o.customer_id::text = s.local_id
            ) ELSE NULL END AS orders_count,
            CASE WHEN $4::boolean AND s.local_id IS NOT NULL THEN (
              SELECT max(d.occurred_at)::text
                FROM integration_mappings om
                JOIN orders o ON o.id = om.local_id
                JOIN online_order_documents d
                  ON d.order_id = o.id AND d.source_type = 'woocommerce_order'
                JOIN locations ol ON ol.id = o.location_id AND ol.business_id = om.business_id
               WHERE om.business_id = $1 AND om.connection_id = s.connection_id
                 AND om.entity_type = 'order' AND o.customer_id::text = s.local_id
            ) ELSE NULL END AS last_online_order_at,
            COALESCE(
              (SELECT max(w.created_at)
                 FROM integration_webhook_events w
                WHERE w.business_id = $1 AND w.connection_id = s.connection_id
                  AND w.event_topic LIKE 'customer.%' AND w.remote_id = s.remote_id),
              s.last_synced_at,
              s.source_updated_at
            )::text AS last_synced_at
       ${fromWhere}
      ORDER BY ${sortSql}
      LIMIT $${filterParams.length + 1} OFFSET $${filterParams.length + 2}`,
    [...filterParams, pageSize, offset],
  );
  return {
    customers: rows.map((r) => ({
      remoteId: r.remote_id,
      localId: r.local_id,
      externalProfileId: r.external_profile_id,
      identityStatus: r.identity_status,
      status: r.status,
      accountType: r.account_type,
      remoteStatus: r.remote_status,
      name: r.name,
      remoteName: r.remote_name,
      remotePhone: r.remote_phone,
      remoteEmail: r.remote_email,
      canonicalName: r.canonical_name,
      canonicalPhone: r.canonical_phone,
      canonicalEmail: r.canonical_email,
      phone: r.phone,
      email: r.email,
      ordersCount: r.orders_count === null ? null : Number(r.orders_count),
      lastOnlineOrderAt: r.last_online_order_at,
      lastSyncedAt: r.last_synced_at,
    })),
    total,
    page,
    pageSize,
    totalPages,
    clamped,
  };
}

export interface WpCustomerSyncStatus {
  runId: string;
  transport: "rest_api" | "plugin";
  status: "running" | "partial" | "completed" | "failed";
  expected: number | null;
  processed: number;
  pending: number | null;
  failed: number;
  deleted: number;
  currentPage: number;
  totalPages: number | null;
  hasError: boolean;
  updatedAt: string;
}

/** Latest durable customer-sync checkpoint for a store, for the manager UI. */
export async function wpCustomerSyncStatus(
  businessId: string,
  connectionId: string,
): Promise<WpCustomerSyncStatus | null> {
  const { rows } = await query<{
    run_id: string;
    transport: WpCustomerSyncStatus["transport"];
    status: WpCustomerSyncStatus["status"];
    expected_count: number | null;
    processed: number;
    failed: number;
    deleted: number;
    current_page: number;
    total_pages: number | null;
    has_error: boolean;
    updated_at: string;
  }>(
    `SELECT r.id::text AS run_id, r.transport, r.status, r.expected_count,
            count(i.remote_id)::int AS processed,
            count(i.remote_id) FILTER (WHERE i.outcome = 'failed')::int AS failed,
            count(i.remote_id) FILTER (WHERE i.outcome = 'deleted')::int AS deleted,
            r.current_page, r.total_pages,
            (r.last_error IS NOT NULL) AS has_error,
            r.updated_at::text AS updated_at
       FROM integration_customer_sync_runs r
       JOIN integration_connections c
         ON c.id = r.connection_id AND c.business_id = r.business_id AND c.provider = 'woocommerce'
       LEFT JOIN integration_customer_sync_run_items i
         ON i.run_id = r.id AND i.business_id = r.business_id AND i.connection_id = r.connection_id
      WHERE r.business_id = $1 AND r.connection_id = $2
      GROUP BY r.id
      ORDER BY r.started_at DESC
      LIMIT 1`,
    [businessId, connectionId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    runId: row.run_id,
    transport: row.transport,
    status: row.status,
    expected: row.expected_count,
    processed: row.processed,
    pending: row.expected_count === null ? null : Math.max(0, row.expected_count - row.processed),
    failed: row.failed,
    deleted: row.deleted,
    currentPage: row.current_page,
    totalPages: row.total_pages,
    hasError: row.has_error,
    updatedAt: row.updated_at,
  };
}

export interface WpQueueRow {
  id: string;
  direction: "out" | "in";
  kind: string;
  status: string;
  remoteId: string;
  localId?: string | null;
  error: string | null;
  attempts: number;
  nextAttemptAt?: string | null;
  leasedUntil?: string | null;
  sentAt?: string | null;
  processedAt?: string | null;
  deliveryId?: string | null;
  /** The stable id of a non-idempotent outbound operation, when the row has one. */
  operationId?: string | null;
  /**
   * Never populated by the list (issue #942, F13): full bodies are fetched
   * per row through `wpQueueRowDetail`, redacted and bounded. Kept on the
   * type so existing consumers keep compiling.
   */
  payload?: Record<string, unknown> | null;
  /** True when the row carries a non-empty payload worth inspecting. */
  hasPayload?: boolean;
  createdAt: string;
  updatedAt?: string | null;
}

export interface WpQueueFilterOptions {
  status?: "open" | "pending" | "processing" | "failed" | "dead" | "sent" | "deferred" | "needs_review" | "skipped" | "all";
  direction?: "all" | "out" | "in";
  search?: string;
  limit?: number;
  page?: number;
  pageSize?: number;
}

export interface WpQueueSummary {
  total: number;
  /** `inFlight` + `attention`: every row the `open` queue filter shows. */
  open: number;
  /** Outbound `pending` + inbound `pending`/`deferred`. */
  pending: number;
  processing: number;
  /** Outbound `failed` + `needs_review` + inbound `failed`. */
  failed: number;
  dead: number;
  /** Non-idempotent jobs awaiting an operator decision — never auto-retried. */
  needsReview: number;
  /** Jobs the plugin deliberately did not apply (its policy switch was off). */
  skipped: number;
  sent: number;
  deferred: number;
  inboundFailed: number;
  outboundFailed: number;
  /** Inbound `pending` + `deferred` on its own — the inbox backlog. */
  inboundPending: number;
  /** `pending` + `processing`: moves on its own. */
  inFlight: number;
  /** `failed` + `dead`: moves only when a person acts. */
  attention: number;
  /** When the oldest still-open row was created — queue-page diagnostics. */
  oldestOpenAt?: string | null;
  /** When the next outbound retry is due, if a row is waiting out backoff. */
  nextRetryAt?: string | null;
}

export interface WpQueuePage {
  rows: WpQueueRow[];
  /** How many rows match the filters across all pages (not just this page). */
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/**
 * The one status classification (issue #942, F14). The list filter, the KPI
 * summary and the UI chips all read these buckets, so a tile's number is
 * always the number of rows its click shows — previously `pending` counted
 * without `processing` in the summary but filtered with it, and the
 * processing tile opened `open`. Each bucket name maps to the raw statuses
 * it contains, per table; buckets may overlap only where documented
 * (`dead` is a subset of the `failed` bucket, shown as its subtext).
 */
const QUEUE_BUCKETS: Record<string, { outbox: string[]; inbox: string[] }> = {
  open: { outbox: ["pending", "processing", "failed", "dead", "needs_review"], inbox: ["pending", "deferred", "failed"] },
  pending: { outbox: ["pending"], inbox: ["pending", "deferred"] },
  processing: { outbox: ["processing"], inbox: [] },
  failed: { outbox: ["failed", "dead"], inbox: ["failed"] },
  dead: { outbox: ["dead"], inbox: [] },
  needs_review: { outbox: ["needs_review"], inbox: [] },
  skipped: { outbox: ["skipped"], inbox: [] },
  sent: { outbox: ["sent"], inbox: ["processed"] },
  deferred: { outbox: [], inbox: ["deferred"] },
};

function statusInSql(statuses: string[]): string {
  if (statuses.length === 0) return "1=0";
  return `status IN (${statuses.map((s) => `'${s}'`).join(", ")})`;
}

/**
 * The attempt cap that dead-letters a job on this connection (issue #942,
 * F16): the REST drain and the plugin lease use different policies, and the
 * queue UI must quote the one actually in force instead of a hardcoded ۶.
 */
export function wpQueueMaxAttempts(linkMode: string): number {
  return linkMode === "plugin" ? PLUGIN_JOB_MAX_ATTEMPTS : OUTBOX_MAX_ATTEMPTS;
}

/**
 * The combined operational queue, one page at a time: outbound outbox jobs
 * and inbound inbox events under the one status classification above.
 *
 * The list returns metadata only (issue #942, F13/F20): no payload bodies —
 * `wpQueueRowDetail` fetches one row's diagnostics, redacted, on demand —
 * and errors are capped. It also returns the filtered total and clamps the
 * requested page to the last one (F17), so the UI can say «صفحهٔ ۲ از ۵»
 * truthfully instead of guessing from `rows.length < pageSize`, and a stale
 * deep page lands on real rows instead of an empty «همه‌چیز همگام است».
 */
export async function wpQueuePage(
  businessId: string,
  connectionId: string,
  options?: WpQueueFilterOptions,
): Promise<WpQueuePage> {
  const statusFilter = options?.status ?? "open";
  const direction = options?.direction ?? "all";
  const search = options?.search?.trim() || "";
  const requestedPage = Math.max(1, Math.floor(options?.page ?? 1));
  const pageSize = Math.min(500, Math.max(1, Math.floor(options?.pageSize ?? options?.limit ?? 25)));

  const outboxParts: string[] = [
    "business_id = $1",
    "connection_id = $2",
    "connection_id IN (SELECT id FROM integration_connections WHERE business_id = $1 AND provider = 'woocommerce' AND deleted_at IS NULL)",
  ];
  const inboxParts: string[] = [
    "business_id = $1",
    "connection_id = $2",
    "connection_id IN (SELECT id FROM integration_connections WHERE business_id = $1 AND provider = 'woocommerce' AND deleted_at IS NULL)",
  ];

  const bucket = statusFilter === "all" ? null : QUEUE_BUCKETS[statusFilter];
  if (bucket) {
    outboxParts.push(statusInSql(bucket.outbox));
    inboxParts.push(statusInSql(bucket.inbox));
  }

  const params: unknown[] = [businessId, connectionId];
  if (search) {
    params.push(`%${search}%`);
    const searchIdx = `$${params.length}`;
    outboxParts.push(`(remote_id ILIKE ${searchIdx} OR entity_type ILIKE ${searchIdx} OR last_error ILIKE ${searchIdx})`);
    inboxParts.push(`(remote_id ILIKE ${searchIdx} OR event_topic ILIKE ${searchIdx} OR error ILIKE ${searchIdx})`);
  }

  const wantOut = direction !== "in";
  const wantIn = direction !== "out";

  let total = 0;
  if (wantOut) {
    const { rows } = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM integration_outbox_events WHERE ${outboxParts.join(" AND ")}`,
      params,
    );
    total += Number(rows[0]?.n ?? 0);
  }
  if (wantIn) {
    const { rows } = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM integration_webhook_events WHERE ${inboxParts.join(" AND ")}`,
      params,
    );
    total += Number(rows[0]?.n ?? 0);
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(requestedPage, totalPages);
  const offset = (page - 1) * pageSize;

  const outboxSql = `
    SELECT id::text, 'out' AS direction, entity_type AS kind, status, remote_id, local_id::text,
           last_error AS error, attempts, next_attempt_at::text, leased_until::text, sent_at::text,
           NULL::text AS processed_at, NULL::text AS delivery_id, operation_id,
           (payload IS NOT NULL AND payload <> '{}'::jsonb) AS has_payload,
           created_at::text, updated_at::text
      FROM integration_outbox_events
     WHERE ${outboxParts.join(" AND ")}
  `;

  const inboxSql = `
    SELECT id::text, 'in' AS direction, event_topic AS kind, status, remote_id, NULL::text AS local_id,
           error, 0 AS attempts, NULL::text AS next_attempt_at, NULL::text AS leased_until, NULL::text AS sent_at,
           processed_at::text, delivery_id, NULL::text AS operation_id,
           (payload IS NOT NULL AND payload <> '{}'::jsonb) AS has_payload,
           created_at::text, created_at::text AS updated_at
      FROM integration_webhook_events
     WHERE ${inboxParts.join(" AND ")}
  `;

  // Stable order: created_at alone ties whenever a batch lands in one
  // statement, and unstable ties make rows jump between pages.
  let combinedSql: string;
  if (!wantIn) {
    combinedSql = `${outboxSql} ORDER BY created_at DESC, id DESC LIMIT ${pageSize} OFFSET ${offset}`;
  } else if (!wantOut) {
    combinedSql = `${inboxSql} ORDER BY created_at DESC, id DESC LIMIT ${pageSize} OFFSET ${offset}`;
  } else {
    combinedSql = `(${outboxSql}) UNION ALL (${inboxSql}) ORDER BY created_at DESC, id DESC LIMIT ${pageSize} OFFSET ${offset}`;
  }

  const { rows } = await query<{
    id: string;
    direction: string;
    kind: string;
    status: string;
    remote_id: string;
    local_id: string | null;
    error: string | null;
    attempts: number;
    next_attempt_at: string | null;
    leased_until: string | null;
    sent_at: string | null;
    processed_at: string | null;
    delivery_id: string | null;
    operation_id: string | null;
    has_payload: boolean;
    created_at: string;
    updated_at: string | null;
  }>(combinedSql, params);

  return {
    rows: rows.map((r) => ({
      id: r.id,
      direction: r.direction as "out" | "in",
      kind: r.kind,
      status: r.status,
      remoteId: r.remote_id,
      localId: r.local_id,
      error: capQueueError(r.error),
      attempts: r.attempts,
      nextAttemptAt: r.next_attempt_at,
      leasedUntil: r.leased_until,
      sentAt: r.sent_at,
      processedAt: r.processed_at,
      deliveryId: r.delivery_id,
      operationId: r.operation_id,
      payload: null,
      hasPayload: r.has_payload,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    })),
    total,
    page,
    pageSize,
    totalPages,
  };
}

/** The queue rows without the page envelope — kept for existing callers. */
export async function wpQueue(
  businessId: string,
  connectionId: string,
  options?: WpQueueFilterOptions,
): Promise<WpQueueRow[]> {
  return (await wpQueuePage(businessId, connectionId, options)).rows;
}

export type WpQueueRowDetail = Omit<WpQueueRow, "payload"> & {
  /** The row's payload, credentials removed and contact data masked. */
  payload: unknown;
};

/**
 * One row's diagnostics, fetched on demand (issue #942, F13). The payload
 * passes through `redactPayload`: passwords/tokens/authorization values are
 * removed outright, customer contact fields are partially masked, and the
 * body is bounded in depth, entries and string length — so opening an
 * inspector can neither leak a credential nor stream back a megabyte.
 */
export async function wpQueueRowDetail(
  businessId: string,
  connectionId: string,
  rowId: string,
  direction?: "out" | "in",
): Promise<WpQueueRowDetail | null> {
  if (direction !== "in") {
    const { rows } = await query<{
      id: string; entity_type: string; status: string; remote_id: string; local_id: string | null;
      last_error: string | null; attempts: number; next_attempt_at: string | null; leased_until: string | null;
      sent_at: string | null; operation_id: string | null; payload: unknown; created_at: string; updated_at: string | null;
    }>(
      `SELECT id::text, entity_type, status, remote_id, local_id::text, last_error, attempts,
              next_attempt_at::text, leased_until::text, sent_at::text, operation_id, payload,
              created_at::text, updated_at::text
         FROM integration_outbox_events
        WHERE id = $1 AND business_id = $2 AND connection_id = $3`,
      [rowId, businessId, connectionId],
    );
    if (rows[0]) {
      const r = rows[0];
      return {
        id: r.id,
        direction: "out",
        kind: r.entity_type,
        status: r.status,
        remoteId: r.remote_id,
        localId: r.local_id,
        error: capQueueError(r.last_error, 2000),
        attempts: r.attempts,
        nextAttemptAt: r.next_attempt_at,
        leasedUntil: r.leased_until,
        sentAt: r.sent_at,
        operationId: r.operation_id,
        payload: redactPayload(r.payload ?? null),
        hasPayload: true,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      };
    }
    if (direction === "out") return null;
  }

  const { rows } = await query<{
    id: string; event_topic: string; status: string; remote_id: string; error: string | null;
    processed_at: string | null; delivery_id: string | null; payload: unknown; created_at: string;
  }>(
    `SELECT id::text, event_topic, status, remote_id, error, processed_at::text, delivery_id, payload, created_at::text
       FROM integration_webhook_events
      WHERE id = $1 AND business_id = $2 AND connection_id = $3`,
    [rowId, businessId, connectionId],
  );
  if (!rows[0]) return null;
  const r = rows[0];
  return {
    id: r.id,
    direction: "in",
    kind: r.event_topic,
    status: r.status,
    remoteId: r.remote_id,
    error: capQueueError(r.error, 2000),
    attempts: 0,
    processedAt: r.processed_at,
    deliveryId: r.delivery_id,
    payload: redactPayload(r.payload ?? null),
    hasPayload: true,
    createdAt: r.created_at,
    updatedAt: r.created_at,
  };
}

/**
 * Aggregate counts of outbox & inbox events for the queue dashboard, in the
 * same buckets `QUEUE_BUCKETS` defines for the list filter — a tile's number
 * is the count its click lists (issue #942, F14). `needs_review` is its own
 * bucket now, never folded into `failed`: it needs an operator decision,
 * not a retry, and hiding it inside the failure count is how ambiguous
 * refunds stayed invisible (F15).
 */
export async function wpQueueSummary(businessId: string, connectionId: string): Promise<WpQueueSummary> {
  const [outboxRes, inboxRes, ageRes] = await Promise.all([
    query<{ status: string; n: string }>(
      `SELECT status, count(*)::text AS n FROM integration_outbox_events
        WHERE business_id = $1 AND connection_id = $2
        GROUP BY status`,
      [businessId, connectionId],
    ),
    query<{ status: string; n: string }>(
      `SELECT status, count(*)::text AS n FROM integration_webhook_events
        WHERE business_id = $1 AND connection_id = $2
        GROUP BY status`,
      [businessId, connectionId],
    ),
    query<{ oldest_open_at: string | null; next_retry_at: string | null }>(
      `SELECT (
         SELECT min(created_at)::text FROM (
           SELECT created_at FROM integration_outbox_events
            WHERE business_id = $1 AND connection_id = $2
              AND status IN ('pending', 'processing', 'failed', 'dead', 'needs_review')
           UNION ALL
           SELECT created_at FROM integration_webhook_events
            WHERE business_id = $1 AND connection_id = $2
              AND status IN ('pending', 'deferred', 'failed')
         ) open_rows
       ) AS oldest_open_at,
       (
         SELECT min(next_attempt_at)::text FROM integration_outbox_events
          WHERE business_id = $1 AND connection_id = $2 AND status IN ('pending', 'failed')
       ) AS next_retry_at`,
      [businessId, connectionId],
    ),
  ]);

  const outbox = new Map(outboxRes.rows.map((r) => [r.status, Number(r.n)]));
  const inbox = new Map(inboxRes.rows.map((r) => [r.status, Number(r.n)]));
  return {
    ...summarizeQueueCounts(outbox, inbox),
    oldestOpenAt: ageRes.rows[0]?.oldest_open_at ?? null,
    nextRetryAt: ageRes.rows[0]?.next_retry_at ?? null,
  };
}

export interface WpQueueActionResult {
  ok: boolean;
  /** Machine-readable reason when `ok` is false: not_found, not_retryable, connection_paused, … */
  error?: string;
  /** The row's status after the action — or its current status when the action was refused. */
  status?: string;
}

/**
 * The paused-connection guard every queue action shares (issue #942, F06).
 * It used to live only in the bulk route, so the single-row retry endpoint
 * happily moved data for a connection the operator had paused. Putting it
 * in the service means both endpoints — and any future caller — enforce the
 * same rule, alongside the tenant scope every query here already carries.
 */
async function queueActionConnection(
  businessId: string,
  connectionId: string,
): Promise<{ connection: NonNullable<Awaited<ReturnType<typeof getConnection>>> } | { refusal: WpQueueActionResult }> {
  const connection = await getConnection(businessId, connectionId);
  if (!connection || connection.provider !== "woocommerce") {
    return { refusal: { ok: false, error: "connection_not_found" } };
  }
  if (connection.status === "paused") {
    return { refusal: { ok: false, error: "connection_paused", status: "paused" } };
  }
  return { connection };
}

async function drainIfRest(connection: NonNullable<Awaited<ReturnType<typeof getConnection>>>): Promise<void> {
  if (connection.status === "active" && connection.link_mode === "rest_api") {
    try {
      await drainOutbox(connection);
    } catch {
      // Ignored — the row is queued and due; the background tick drains it.
    }
  }
}

/**
 * Retry a single queue row (either outbound outbox or inbound webhook).
 *
 * Only explicitly retryable states move (issue #942, F05): outbox
 * `failed`/`dead`, inbox `failed`/`deferred` — claimed with a conditional
 * update so a double-click or a racing worker cannot reset a row twice.
 * `sent`/`processed` rows are never replayed, a `processing` row belongs to
 * its lease holder, and `needs_review` demands `resolveWpQueueReview`'s
 * explicit decision instead of a blind retry of a non-idempotent write.
 * Refusals carry the row's current status so the API can answer 409 with a
 * truthful reason.
 */
export async function retryWpQueueRow(
  businessId: string,
  connectionId: string,
  rowId: string,
  direction?: "out" | "in",
  actorId?: string,
): Promise<WpQueueActionResult> {
  const gate = await queueActionConnection(businessId, connectionId);
  if ("refusal" in gate) return gate.refusal;
  const { connection } = gate;

  if (direction !== "in") {
    const { rows: retried } = await query<{ entity_type: string; remote_id: string }>(
      `UPDATE integration_outbox_events
          SET status = 'pending',
              attempts = 0,
              next_attempt_at = now(),
              last_error = NULL,
              leased_until = NULL,
              lease_token = NULL,
              updated_at = now()
        WHERE id = $1 AND business_id = $2 AND connection_id = $3
          AND status IN ('failed', 'dead')
      RETURNING entity_type, remote_id`,
      [rowId, businessId, connectionId],
    );
    if (retried.length > 0) {
      await writeIntegrationAudit({
        businessId,
        connectionId,
        action: "queue.retry",
        entityType: retried[0].entity_type,
        remoteId: retried[0].remote_id,
        payload: actorId ? { actorId } : undefined,
      });
      await drainIfRest(connection);
      return { ok: true, status: "pending" };
    }
    // Not reset: either the row is not in the outbox at all, or it is in a
    // state a retry must not touch. One scoped read tells them apart.
    const { rows: current } = await query<{ status: string }>(
      `SELECT status FROM integration_outbox_events
        WHERE id = $1 AND business_id = $2 AND connection_id = $3`,
      [rowId, businessId, connectionId],
    );
    if (current.length > 0) {
      return { ok: false, error: "not_retryable", status: current[0].status };
    }
    if (direction === "out") return { ok: false, error: "not_found" };
  }

  // Inbox: the reprocessor claims conditionally and refuses applied rows;
  // translate its outcome into the action result, reporting the row's real
  // status when it would not move.
  const outcome = await reprocessExistingIngestEvent(connection, rowId);
  if (outcome.status === "duplicate") {
    const { rows: current } = await query<{ status: string }>(
      `SELECT status FROM integration_webhook_events
        WHERE id = $1 AND business_id = $2 AND connection_id = $3`,
      [rowId, businessId, connectionId],
    );
    return { ok: false, error: "not_retryable", status: current[0]?.status ?? "processed" };
  }
  if (outcome.status === "failed" && outcome.error === "inbox_not_found") {
    return { ok: false, error: "not_found" };
  }
  if (outcome.status === "processed") {
    await writeIntegrationAudit({
      businessId,
      connectionId,
      action: "queue.retry",
      payload: actorId ? { actorId, direction: "in" } : { direction: "in" },
    });
  }
  return {
    ok: outcome.status !== "failed",
    status: outcome.status,
    error: "error" in outcome ? outcome.error : undefined,
  };
}

export type WpReviewResolution = "mark_sent" | "retry" | "stop";

/**
 * Resolve a `needs_review` outbox row — the deliberate, audited alternative
 * to a blind retry (issue #942, F05/F15). These rows are non-idempotent
 * operations whose remote outcome could not be proven (an ambiguous refund
 * response, a vanished lease holder, a missing operation id). The operator
 * inspects the store, then says exactly one of:
 *
 *   `mark_sent` — "I verified it landed remotely": close as sent.
 *   `retry`     — "I verified it did not land": queue it again, due now.
 *   `stop`      — "abandon it": dead-letter with the decision recorded.
 *
 * Only a row actually in `needs_review` can be resolved; anything else is a
 * 409-shaped refusal carrying the current status. The actor is written to
 * the audit trail with the resolution.
 */
export async function resolveWpQueueReview(
  businessId: string,
  connectionId: string,
  rowId: string,
  resolution: WpReviewResolution,
  actorId?: string,
): Promise<WpQueueActionResult> {
  const gate = await queueActionConnection(businessId, connectionId);
  if ("refusal" in gate) return gate.refusal;
  const { connection } = gate;

  const transitions: Record<WpReviewResolution, { set: string; status: string }> = {
    mark_sent: {
      set: "status = 'sent', sent_at = now(), last_error = NULL, leased_until = NULL, lease_token = NULL, updated_at = now()",
      status: "sent",
    },
    retry: {
      set: "status = 'pending', next_attempt_at = now(), leased_until = NULL, lease_token = NULL, updated_at = now()",
      status: "pending",
    },
    stop: {
      set: "status = 'dead', last_error = left('operator_stopped: ' || COALESCE(last_error, ''), 500), leased_until = NULL, lease_token = NULL, updated_at = now()",
      status: "dead",
    },
  };
  const transition = transitions[resolution];
  if (!transition) return { ok: false, error: "unknown_resolution" };

  // A "retry" of a row that is in review *because* its non-idempotent
  // operation has no operation id would bounce straight back: the plugin
  // pull sweep and the REST refund path both refuse to apply an unverifiable
  // write (PR #1053 review). The operator has just verified the operation
  // did not land, so this is the one safe moment to mint the stable
  // operation id it should always have had — persisted in the column (what
  // the sweep and the uniqueness index read) and in the payload (what both
  // appliers tag and check remotely), so every later attempt is
  // exactly-once verifiable.
  let backfilledOperationId: string | null = null;
  const extraSets: string[] = [];
  const params: unknown[] = [rowId, businessId, connectionId];
  if (resolution === "retry") {
    const { rows: current } = await query<{
      entity_type: string;
      remote_id: string;
      status: string;
      operation_id: string | null;
      payload: Record<string, unknown> | null;
    }>(
      `SELECT entity_type, remote_id, status, operation_id, payload
         FROM integration_outbox_events
        WHERE id = $1 AND business_id = $2 AND connection_id = $3`,
      [rowId, businessId, connectionId],
    );
    const row = current[0];
    if (row && row.status === "needs_review") {
      const payload = (row.payload ?? {}) as Record<string, unknown>;
      const payloadOperationId = typeof payload.__operationId === "string" && payload.__operationId ? payload.__operationId : null;
      const needsOperationId =
        row.entity_type === "refund_create" ||
        row.entity_type === "media_create" ||
        (row.entity_type === "post_upsert" && !("id" in payload));
      if (needsOperationId && (!row.operation_id || !payloadOperationId || row.operation_id !== payloadOperationId)) {
        const orderRemoteId =
          typeof payload.__orderRemoteId === "string" && payload.__orderRemoteId
            ? payload.__orderRemoteId
            : row.remote_id.split(":")[0];
        let effective = row.operation_id ?? payloadOperationId;
        if (!effective) {
          effective =
            row.entity_type === "refund_create"
              ? `woo-refund:${connectionId}:${orderRemoteId}:${randomUUID()}`
              : row.entity_type === "media_create"
                ? `wp-media:${connectionId}:${row.remote_id}:${randomUUID()}`
                : `wp-post:${connectionId}:${randomUUID()}`;
          backfilledOperationId = effective;
        } else if (!row.operation_id) {
          // The id survives only in the payload. Promoting it into the
          // unique-indexed column must not collide with a sibling row that
          // already carries it there.
          const { rows: clash } = await query<{ id: string }>(
            `SELECT id FROM integration_outbox_events WHERE connection_id = $1 AND operation_id = $2 AND id <> $3`,
            [connectionId, effective, rowId],
          );
          if (clash.length > 0) {
            effective = `${effective}:${randomUUID()}`;
            backfilledOperationId = effective;
          }
        }
        params.push(effective);
        const opParam = `$${params.length}`;
        extraSets.push(`operation_id = ${opParam}`);
        if (row.entity_type === "refund_create") {
          params.push(orderRemoteId);
          const orderParam = `$${params.length}`;
          extraSets.push(
            `payload = payload || jsonb_build_object('__operationId', ${opParam}::text, '__orderRemoteId', COALESCE(payload->>'__orderRemoteId', ${orderParam}::text))`,
          );
        } else {
          extraSets.push(`payload = payload || jsonb_build_object('__operationId', ${opParam}::text)`);
        }
      }
    }
  }

  const { rows } = await query<{ entity_type: string; remote_id: string }>(
    `UPDATE integration_outbox_events
        SET ${[transition.set, ...extraSets].join(", ")}
      WHERE id = $1 AND business_id = $2 AND connection_id = $3 AND status = 'needs_review'
    RETURNING entity_type, remote_id`,
    params,
  );
  if (rows.length === 0) {
    const { rows: current } = await query<{ status: string }>(
      `SELECT status FROM integration_outbox_events
        WHERE id = $1 AND business_id = $2 AND connection_id = $3`,
      [rowId, businessId, connectionId],
    );
    if (current.length === 0) return { ok: false, error: "not_found" };
    return { ok: false, error: "not_in_review", status: current[0].status };
  }

  await writeIntegrationAudit({
    businessId,
    connectionId,
    action: "queue.review_resolved",
    entityType: rows[0].entity_type,
    remoteId: rows[0].remote_id,
    payload: {
      resolution,
      ...(actorId ? { actorId } : {}),
      ...(backfilledOperationId ? { operationIdBackfilled: backfilledOperationId } : {}),
    },
  });
  if (resolution === "retry") await drainIfRest(connection);
  return { ok: true, status: transition.status };
}

export interface WpQueueVerifyResult {
  ok: boolean;
  /** not_found | not_in_review when the probe could not run at all. */
  error?: string;
  /** Current row status, when the refusal is "not in review". */
  status?: string;
  /**
   * landed — the remote side provably holds this operation;
   * not_landed — provably absent (retry is safe unless done manually);
   * unknown — no automatic probe exists, the operator must look.
   */
  verdict?: "landed" | "not_landed" | "unknown";
  /** Operator-facing explanation of the verdict. */
  detail?: string;
}

/**
 * Evidence, from the app's own records, that a plugin-mode create landed
 * (issue #1075). Matches only on the exact operation id the plugin stamped
 * and echoed — never on title or content, which a hand-written post could
 * share. Edits (a post payload with an `id`) are not creates and have no
 * such handle, so they are never claimed here.
 */
async function findLandedCreate(
  businessId: string,
  connectionId: string,
  entityType: string,
  payload: Record<string, unknown>,
  operationId: string,
): Promise<{ kind: "media" | "post"; remoteId: string } | null> {
  if (entityType === "media_create") {
    const mapped = await query<{ wp_media_id: string }>(
      `SELECT wp_media_id FROM wordpress_media_mapping
        WHERE business_id = $1 AND connection_id = $2 AND operation_id = $3
          AND status = 'synced' AND wp_media_id IS NOT NULL
        LIMIT 1`,
      [businessId, connectionId, operationId],
    );
    if (mapped.rows[0]) return { kind: "media", remoteId: mapped.rows[0].wp_media_id };
    const mirrored = await query<{ remote_id: string }>(
      `SELECT remote_id FROM integration_wp_content
        WHERE business_id = $1 AND connection_id = $2 AND wp_type = 'attachment'
          AND payload->>'operation_id' = $3
        LIMIT 1`,
      [businessId, connectionId, operationId],
    );
    return mirrored.rows[0] ? { kind: "media", remoteId: mirrored.rows[0].remote_id } : null;
  }
  if (entityType === "post_upsert" && !("id" in payload)) {
    const mirrored = await query<{ remote_id: string }>(
      `SELECT remote_id FROM integration_wp_content
        WHERE business_id = $1 AND connection_id = $2 AND wp_type IN ('post', 'page')
          AND payload->>'operation_id' = $3
        LIMIT 1`,
      [businessId, connectionId, operationId],
    );
    return mirrored.rows[0] ? { kind: "post", remoteId: mirrored.rows[0].remote_id } : null;
  }
  return null;
}

/**
 * The F11 verify assist: before an operator has to guess whether a
 * needs-review operation landed remotely, ask the store when we can.
 *
 * Two kinds of evidence, never mixed up:
 *  - REST mode can dial the store, and `refund_create` carries a remote
 *    handle — the `_pos_operation_id` meta the applier itself tags and
 *    checks before retrying — so it can be `landed` or `not_landed`.
 *  - A create-shaped `post_upsert` and a `media_create` (issue #1075) are
 *    plugin-mode jobs; the server never dials that store. The plugin
 *    stamps the same meta and echoes it on the content event it sends
 *    back, so the app's own mirror (`integration_wp_content`,
 *    `wordpress_media_mapping`) is the evidence. Finding it proves
 *    `landed`; not finding it proves nothing — the report may simply not
 *    have arrived yet — so the answer is "unknown", never `not_landed`.
 * Everything else returns an honest "unknown" with guidance instead of
 * pretending certainty. Read-only by design: it never mutates the row, so
 * it is allowed even while the connection is paused.
 */
export async function verifyWpQueueReview(
  businessId: string,
  connectionId: string,
  rowId: string,
  actorId?: string,
): Promise<WpQueueVerifyResult> {
  const { rows } = await query<{
    entity_type: string;
    remote_id: string;
    status: string;
    operation_id: string | null;
    payload: Record<string, unknown> | null;
  }>(
    `SELECT entity_type, remote_id, status, operation_id, payload
       FROM integration_outbox_events
      WHERE id = $1 AND business_id = $2 AND connection_id = $3`,
    [rowId, businessId, connectionId],
  );
  const row = rows[0];
  if (!row) return { ok: false, error: "not_found" };
  if (row.status !== "needs_review") return { ok: false, error: "not_in_review", status: row.status };

  const connection = await getConnection(businessId, connectionId);
  if (!connection) return { ok: false, error: "not_found" };

  const payload = (row.payload ?? {}) as Record<string, unknown>;
  const operationId =
    row.operation_id ??
    (typeof payload.__operationId === "string" && payload.__operationId ? payload.__operationId : null);

  let verdict: NonNullable<WpQueueVerifyResult["verdict"]>;
  let detail: string;
  const createEvidence = operationId
    ? await findLandedCreate(businessId, connectionId, row.entity_type, payload, operationId)
    : null;
  if (createEvidence) {
    verdict = "landed";
    detail = `${createEvidence.kind === "media" ? "فایل" : "نوشته یا برگه"} با همین شناسهٔ عملیات در وردپرس ثبت شده است (شناسهٔ وردپرس: ${toPersianDigits(createEvidence.remoteId)}). گزینهٔ «انجام شده» امن است.`;
  } else if (
    connection.link_mode !== "rest_api" &&
    operationId &&
    (row.entity_type === "media_create" || (row.entity_type === "post_upsert" && !("id" in payload)))
  ) {
    verdict = "unknown";
    detail =
      "هنوز گزارشی از افزونه دربارهٔ ثبت این مورد در وردپرس نرسیده است؛ ممکن است ثبت نشده باشد یا گزارش در راه باشد. اگر آن را دستی نساخته‌اید، «تلاش مجدد» امن است، چون افزونه مورد تکراری با همین شناسهٔ عملیات را نادیده می‌گیرد.";
  } else if (connection.link_mode !== "rest_api") {
    verdict = "unknown";
    detail =
      "در حالت افزونه، سرور نمی‌تواند مستقیم از فروشگاه استعلام بگیرد. انجام‌شدن عملیات را در پیشخوان وردپرس بررسی کنید و سپس تصمیم بگیرید.";
  } else if (row.entity_type === "refund_create" && operationId) {
    const orderRemoteId =
      typeof payload.__orderRemoteId === "string" && payload.__orderRemoteId
        ? payload.__orderRemoteId
        : row.remote_id.split(":")[0];
    if (!/^\d+$/.test(orderRemoteId)) {
      verdict = "unknown";
      detail = "شناسهٔ سفارش ووکامرس برای این بازپرداخت قابل تشخیص نیست؛ آن را در ووکامرس بررسی کنید و سپس تصمیم بگیرید.";
    } else {
      try {
        const client = wooClientFor(connection);
        const refunds = await client.listOrderRefunds(Number(orderRemoteId));
        const match = refunds.find((refund) =>
          (refund.meta_data ?? []).some((meta) => meta.key === "_pos_operation_id" && meta.value === operationId),
        );
        if (match) {
          verdict = "landed";
          detail = `بازپرداخت با همین شناسهٔ عملیات در فروشگاه ثبت شده است (شناسهٔ بازپرداخت: ${toPersianDigits(match.id)}). گزینهٔ «انجام شده» امن است.`;
        } else {
          verdict = "not_landed";
          detail =
            "هیچ بازپرداختی با این شناسهٔ عملیات در فروشگاه یافت نشد. اگر بازپرداخت را دستی ثبت نکرده‌اید، «تلاش مجدد» امن است.";
        }
      } catch (error) {
        verdict = "unknown";
        detail = `استعلام از فروشگاه ناموفق بود: ${capQueueError(error instanceof Error ? error.message : String(error))}`;
      }
    }
  } else if (row.entity_type === "refund_create") {
    verdict = "unknown";
    detail =
      "این عملیات شناسهٔ بررسی ندارد و قابل استعلام خودکار نیست. در ووکامرس بررسی کنید بازپرداختی ثبت نشده باشد؛ اگر «تلاش مجدد» را انتخاب کنید، شناسهٔ پایدار برای آن ساخته و ذخیره می‌شود.";
  } else {
    verdict = "unknown";
    detail = "برای این نوع عملیات استعلام خودکار در دسترس نیست؛ نتیجه را در فروشگاه بررسی کنید و سپس تصمیم بگیرید.";
  }

  await writeIntegrationAudit({
    businessId,
    connectionId,
    action: "queue.review_verified",
    entityType: row.entity_type,
    remoteId: row.remote_id,
    payload: { verdict, ...(actorId ? { actorId } : {}) },
  });
  return { ok: true, verdict, detail };
}

export interface RetryAllResult {
  ok: boolean;
  error?: string;
  /** Outbox rows reset to pending in this batch. */
  outboxRetried: number;
  /** Inbox events reprocessed successfully in this batch. */
  inboxRetried: number;
  /** Inbox events attempted in this batch that failed again. */
  inboxFailed: number;
  /** Failed/dead outbox + failed inbox rows still waiting after this batch. */
  remaining: number;
  /** True when the batch bound was hit and another call would do more. */
  hasMore: boolean;
}

/**
 * Retry failed work in bounded batches (issue #942, F07).
 *
 * The old version reset every failed/dead outbox row in one UPDATE and then
 * reprocessed *every* failed inbox event sequentially inside one HTTP
 * request — a backlog of thousands meant a request that timed out with no
 * record of how far it got. Now each call moves at most `outboxLimit`
 * outbox rows (oldest first) and reprocesses at most `inboxLimit` inbox
 * events, isolates each event's failure, and reports exactly what it did:
 * succeeded / failed again / still remaining, with `hasMore` telling the UI
 * to offer «ادامه». `needs_review` stays excluded by construction — those
 * rows are resolved one by one through `resolveWpQueueReview`, never in
 * bulk.
 */
export async function retryAllFailedWpQueue(
  businessId: string,
  connectionId: string,
  options?: { outboxLimit?: number; inboxLimit?: number },
): Promise<RetryAllResult> {
  const outboxLimit = Math.min(500, Math.max(1, Math.floor(options?.outboxLimit ?? 100)));
  const inboxLimit = Math.min(100, Math.max(1, Math.floor(options?.inboxLimit ?? 25)));
  const empty: RetryAllResult = { ok: true, outboxRetried: 0, inboxRetried: 0, inboxFailed: 0, remaining: 0, hasMore: false };

  const gate = await queueActionConnection(businessId, connectionId);
  if ("refusal" in gate) return { ...empty, ok: false, error: gate.refusal.error };
  const { connection } = gate;

  // 1. Reset one bounded batch of failed / dead outbox rows, oldest first.
  const { rowCount: outboxCount } = await query(
    `UPDATE integration_outbox_events
        SET status = 'pending',
            attempts = 0,
            next_attempt_at = now(),
            last_error = NULL,
            leased_until = NULL,
            lease_token = NULL,
            updated_at = now()
      WHERE id IN (
        SELECT id FROM integration_outbox_events
         WHERE business_id = $1 AND connection_id = $2 AND status IN ('failed', 'dead')
         ORDER BY updated_at ASC, id ASC
         LIMIT $3
      )`,
    [businessId, connectionId, outboxLimit],
  );

  // 2. Reprocess one bounded batch of failed inbox events, each isolated.
  const { rows: failedInbox } = await query<{ id: string }>(
    `SELECT id
       FROM integration_webhook_events
      WHERE business_id = $1 AND connection_id = $2 AND status = 'failed'
      ORDER BY created_at ASC, id ASC
      LIMIT $3`,
    [businessId, connectionId, inboxLimit],
  );

  let inboxRetried = 0;
  let inboxFailed = 0;
  for (const item of failedInbox) {
    try {
      const outcome = await reprocessExistingIngestEvent(connection, item.id);
      if (outcome.status === "failed") inboxFailed++;
      else inboxRetried++;
    } catch {
      // One poisoned event must not abort the batch; it stays failed and
      // is counted, and the next event still gets its chance.
      inboxFailed++;
    }
  }

  if ((outboxCount ?? 0) > 0) await drainIfRest(connection);

  // 3. What is still owed — the honest end state of this call.
  const { rows: remainingRows } = await query<{ remaining: string }>(
    `SELECT (
       (SELECT count(*) FROM integration_outbox_events
         WHERE business_id = $1 AND connection_id = $2 AND status IN ('failed', 'dead'))
       + (SELECT count(*) FROM integration_webhook_events
           WHERE business_id = $1 AND connection_id = $2 AND status = 'failed')
     )::text AS remaining`,
    [businessId, connectionId],
  );
  const remaining = Number(remainingRows[0]?.remaining ?? 0);

  return {
    ok: true,
    outboxRetried: outboxCount ?? 0,
    inboxRetried,
    inboxFailed,
    remaining,
    hasMore: remaining > 0,
  };
}

export interface FlushResult {
  ok: boolean;
  mode: "rest_api" | "plugin";
  message?: string;
  /** REST mode: what this flush's one drain batch actually did. */
  attempted?: number;
  sent?: number;
  failed?: number;
  remaining?: number;
  hasMore?: boolean;
  /** Plugin mode: open outbox rows waiting for the plugin's next pull. */
  waitingForPlugin?: number;
}

/**
 * Flush the outbox — truthfully (issue #942, F08). A REST flush runs ONE
 * drain batch and reports attempted/sent/failed/remaining instead of
 * claiming the whole queue was sent; a plugin-mode flush delivers nothing
 * at all (this side cannot dial the store) and says so, with the count
 * still waiting for the plugin's next scheduled pull.
 */
export async function flushWpOutbox(businessId: string, connectionId: string): Promise<FlushResult> {
  const connection = await getConnection(businessId, connectionId);
  if (!connection || connection.provider !== "woocommerce") {
    return { ok: false, mode: "rest_api", message: "فروشگاه یافت نشد" };
  }

  if (connection.link_mode === "rest_api") {
    const drained = await drainOutbox(connection);
    const failedNow = drained.failed + drained.dead + drained.needsReview;
    const message =
      drained.attempted === 0
        ? drained.remaining > 0
          ? `در این نوبت کاری آمادهٔ ارسال نبود؛ ${toPersianDigits(drained.remaining)} کار هنوز در صف است و طبق زمان‌بندی تلاش بعدی ارسال می‌شود.`
          : "صف خروجی خالی است؛ کاری برای ارسال به فروشگاه وجود نداشت."
        : `از ${toPersianDigits(drained.attempted)} کار این نوبت، ${toPersianDigits(drained.sent)} کار به فروشگاه ارسال شد` +
          (failedNow > 0 ? ` و ${toPersianDigits(failedNow)} کار ناموفق بود` : "") +
          (drained.remaining > 0
            ? `؛ ${toPersianDigits(drained.remaining)} کار دیگر هنوز در صف است${drained.hasMore ? " و با ارسال دوباره ادامه می‌یابد" : ""}.`
            : "؛ صف خروجی خالی شد.");
    return {
      ok: true,
      mode: "rest_api",
      attempted: drained.attempted,
      sent: drained.sent,
      failed: failedNow,
      remaining: drained.remaining,
      hasMore: drained.hasMore,
      message,
    };
  }

  const { rows } = await query<{ waiting: string }>(
    `SELECT count(*)::text AS waiting FROM integration_outbox_events
      WHERE business_id = $1 AND connection_id = $2 AND status IN ('pending', 'processing', 'failed')`,
    [businessId, connectionId],
  );
  const waitingForPlugin = Number(rows[0]?.waiting ?? 0);
  return {
    ok: true,
    mode: "plugin",
    waitingForPlugin,
    message:
      waitingForPlugin > 0
        ? `در حالت افزونه از این‌جا چیزی ارسال نمی‌شود؛ ${toPersianDigits(waitingForPlugin)} کار در صف است و افزونهٔ وردپرس در اجرای دوره‌ای بعدی آن‌ها را دریافت و اعمال می‌کند.`
        : "در حالت افزونه از این‌جا چیزی ارسال نمی‌شود؛ در حال حاضر کاری هم منتظر دریافت توسط افزونه نیست.",
  };
}
