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
  pendingJobs: number;
  failedJobs: number;
  deadJobs: number;
  pendingInboxEvents: number;
  failedInboxEvents: number;
}

/** Aggregate counts for the manager's میز کار, scoped to one connection or the whole business. */
export async function wpOverviewStats(
  businessId: string,
  connectionId?: string | null,
): Promise<WpOverviewStats> {
  const scope = connectionId ? "AND id = $2" : "";
  const params: unknown[] = connectionId ? [businessId, connectionId] : [businessId];

  const { rows: connRows } = await query<{ total: string; active: string; plugin: string; rest: string }>(
    `SELECT count(*)::text AS total,
            count(*) FILTER (WHERE status = 'active')::text AS active,
            count(*) FILTER (WHERE link_mode = 'plugin')::text AS plugin,
            count(*) FILTER (WHERE link_mode = 'rest_api')::text AS rest
       FROM integration_connections
      WHERE business_id = $1 AND provider = 'woocommerce' ${scope}`,
    params,
  );

  const conn = connRows[0] ?? { total: "0", active: "0", plugin: "0", rest: "0" };

  const { rows: mapRows } = await query<{ entity: string; n: string }>(
    `SELECT entity_type AS entity, count(DISTINCT remote_id)::text AS n
       FROM integration_mappings
      WHERE business_id = $1
        AND connection_id IN (SELECT id FROM integration_connections WHERE business_id = $1 AND provider = 'woocommerce')
        ${connectionId ? "AND connection_id = $2" : ""}
        AND entity_type IN ('product', 'order', 'customer', 'refund')
      GROUP BY entity_type`,
    connectionId ? [businessId, connectionId] : [businessId],
  );
  const byEntity = new Map(mapRows.map((r) => [r.entity, Number(r.n)]));

  const { rows: termRows } = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM integration_woo_terms
      WHERE business_id = $1
        AND connection_id IN (SELECT id FROM integration_connections WHERE business_id = $1 AND provider = 'woocommerce')
        ${connectionId ? "AND connection_id = $2" : ""}`,
    connectionId ? [businessId, connectionId] : [businessId],
  );

  // Content counts mirror one connection per row; across a business with
  // several stores they sum, which is what the overview wants to show.
  const contentTotaled = connectionId
    ? await wpContentCounts(businessId, connectionId)
    : (
        await query<{ wp_type: string; n: string }>(
          `SELECT wp_type, count(*)::text AS n
             FROM integration_wp_content
            WHERE business_id = $1
              AND connection_id IN (SELECT id FROM integration_connections WHERE business_id = $1 AND provider = 'woocommerce')
            GROUP BY wp_type`,
          [businessId],
        )
      ).rows.reduce(
        (acc, r) => {
          if (r.wp_type === "post") acc.posts = Number(r.n);
          else if (r.wp_type === "page") acc.pages = Number(r.n);
          else if (r.wp_type === "attachment") acc.media = Number(r.n);
          return acc;
        },
        { posts: 0, pages: 0, media: 0 },
      );

  const { rows: outboxRows } = await query<{ status: string; n: string }>(
    `SELECT status, count(*)::text AS n FROM integration_outbox_events
      WHERE business_id = $1
        AND connection_id IN (SELECT id FROM integration_connections WHERE business_id = $1 AND provider = 'woocommerce')
        ${connectionId ? "AND connection_id = $2" : ""}
      GROUP BY status`,
    connectionId ? [businessId, connectionId] : [businessId],
  );
  const outbox = new Map(outboxRows.map((r) => [r.status, Number(r.n)]));

  const { rows: inboxRows } = await query<{ status: string; n: string }>(
    `SELECT status, count(*)::text AS n FROM integration_webhook_events
      WHERE business_id = $1
        AND connection_id IN (SELECT id FROM integration_connections WHERE business_id = $1 AND provider = 'woocommerce')
        ${connectionId ? "AND connection_id = $2" : ""}
        AND status IN ('pending', 'failed', 'deferred')
      GROUP BY status`,
    connectionId ? [businessId, connectionId] : [businessId],
  );
  const inbox = new Map(inboxRows.map((r) => [r.status, Number(r.n)]));

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
    pendingInboxEvents: (inbox.get("pending") ?? 0) + (inbox.get("deferred") ?? 0),
    failedInboxEvents: inbox.get("failed") ?? 0,
  };
}

/**
 * Where one store customer stands in identity reconciliation (#937). Derived
 * from `crm_external_profiles.status` when a profile exists for the remote
 * id — `confirmed`/`auto_matched` collapse into `linked` exactly while the
 * profile still points at a live party — and from the bare presence of a
 * mapped party when only the legacy `integration_mappings` row does.
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
  /** The CRM party this remote identity resolves to; null while unreconciled. */
  localId: string | null;
  name: string;
  phone: string | null;
  email: string | null;
  ordersCount: number;
  lastSeen: string | null;
  status: WpStoreCustomerStatus;
}

export interface WpStoreCustomersPage {
  customers: WpStoreCustomerRow[];
  /** All matched mappings, including the ones past the returned page. */
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
 * The store's customers as the app knows them: every remote identity the
 * store has produced — legacy mappings and CRM external profiles unioned on
 * the remote id (#937) — joined to the local customer record when one is
 * resolved, with the count of orders mirrored *from this store* and the
 * identity's reconciliation status beside it.
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
  const status = options.status;

  // One filter, spelled once, used by both the count and the page. `%`/`_`
  // typed by a user are literals, not wildcards. The search also covers the
  // external profile's remote snapshot: an unreconciled shopper has no local
  // party yet, and the name/phone the store sent is all there is to find
  // them by.
  const filterParams: unknown[] = [businessId, connectionId];
  let filterSql = "";
  if (search) {
    const escaped = search.replace(/[\\%_]/g, (ch) => `\\${ch}`);
    filterParams.push(`%${escaped}%`);
    const n = `$${filterParams.length}`;
    filterSql +=
      `AND (pop.remote_id ILIKE ${n} ESCAPE '\\' OR c.name ILIKE ${n} ESCAPE '\\'` +
      ` OR c.phone ILIKE ${n} ESCAPE '\\' OR c.email ILIKE ${n} ESCAPE '\\'` +
      ` OR pop.remote_name ILIKE ${n} ESCAPE '\\' OR pop.remote_phone ILIKE ${n} ESCAPE '\\'` +
      ` OR pop.remote_email ILIKE ${n} ESCAPE '\\')`;
  }
  if (status) {
    filterParams.push(status);
    filterSql += ` AND pop.status = $${filterParams.length}`;
  }

  // The population is the *store's* customer book, not only the rows that
  // already resolved to a party: legacy mappings FULL-JOINED with the CRM
  // external profiles on the remote id, one output row per remote identity.
  // A profile waiting in needs_review / conflict / ignored used to vanish
  // from this screen entirely. Status is derived once, here, so the count,
  // the filter and the badge on screen can never disagree.
  //
  // Both sides of the join are scoped inside the ON clause *and* re-checked
  // in the WHERE: a FULL JOIN pairs rows before filtering, so without the
  // scoped ON, another tenant's mapping could pair with this store's
  // profile on a colliding remote id and leak its local_id into the row.
  const fromWhere = `
       FROM (
         SELECT COALESCE(m.remote_id, p.remote_id) AS remote_id,
                COALESCE(m.local_id, p.party_id) AS party_id,
                p.remote_name, p.remote_phone, p.remote_email,
                m.updated_at AS mapping_updated_at,
                p.last_synced_at AS profile_synced_at,
                p.updated_at AS profile_updated_at,
                CASE
                  WHEN p.status = 'ignored' THEN 'ignored'
                  WHEN p.status = 'conflict' THEN 'conflict'
                  WHEN p.status = 'needs_review' THEN 'needs_review'
                  WHEN p.status = 'unmapped' THEN 'unmapped'
                  WHEN COALESCE(m.local_id, p.party_id) IS NOT NULL THEN 'linked'
                  ELSE 'unmapped'
                END AS status
           FROM integration_mappings m
           FULL OUTER JOIN crm_external_profiles p
             ON p.business_id = $1 AND p.connection_id = $2 AND p.provider = 'woocommerce'
            AND p.remote_id = m.remote_id
            AND m.business_id = $1 AND m.connection_id = $2 AND m.entity_type = 'customer'
          WHERE ((m.business_id = $1 AND m.connection_id = $2 AND m.entity_type = 'customer')
              OR (p.business_id = $1 AND p.connection_id = $2 AND p.provider = 'woocommerce'))
            AND $2 IN (SELECT id FROM integration_connections WHERE business_id = $1 AND provider = 'woocommerce')
       ) pop
       LEFT JOIN parties c ON c.id = pop.party_id
      WHERE TRUE
        ${filterSql}`;

  const { rows: countRows } = await query<{ total: string }>(
    `SELECT count(*)::text AS total ${fromWhere}`,
    filterParams,
  );
  const total = Number(countRows[0]?.total ?? 0);
  const { page, offset, totalPages, clamped } = wpCustomersPageWindow(options.page, pageSize, total);

  if (total === 0) {
    return { customers: [], total: 0, page: 1, pageSize, totalPages: 1, clamped: false };
  }

  const { rows } = await query<{
    remote_id: string;
    local_id: string | null;
    name: string;
    phone: string | null;
    email: string | null;
    status: string;
    orders_count: string;
    last_seen: string | null;
  }>(
    `SELECT pop.remote_id, pop.party_id::text AS local_id,
            COALESCE(NULLIF(c.name, ''), pop.remote_name, '') AS name,
            COALESCE(c.phone, pop.remote_phone) AS phone,
            COALESCE(c.email, pop.remote_email) AS email,
            pop.status,
            (SELECT count(*)
               FROM integration_mappings om
               JOIN orders o ON o.id = om.local_id
              WHERE om.business_id = $1
                AND om.connection_id = $2
                AND om.entity_type = 'order'
                AND o.customer_id = pop.party_id)::text AS orders_count,
            COALESCE(
              (SELECT max(w.created_at)
                 FROM integration_webhook_events w
                WHERE w.connection_id = $2
                  AND w.event_topic LIKE 'customer.%'
                  AND w.remote_id = pop.remote_id),
              GREATEST(pop.mapping_updated_at, pop.profile_synced_at, pop.profile_updated_at)
            )::text AS last_seen
     ${fromWhere}
      ORDER BY name, pop.remote_id
      LIMIT $${filterParams.length + 1} OFFSET $${filterParams.length + 2}`,
    [...filterParams, pageSize, offset],
  );
  return {
    customers: rows.map((r) => ({
      remoteId: r.remote_id,
      localId: r.local_id,
      name: r.name,
      phone: r.phone,
      email: r.email,
      ordersCount: Number(r.orders_count),
      lastSeen: r.last_seen,
      status: r.status as WpStoreCustomerStatus,
    })),
    total,
    page,
    pageSize,
    totalPages,
    clamped,
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
  /** Everything the `open` filter shows: pending + processing + failed + needsReview. */
  open: number;
  pending: number;
  processing: number;
  /** The خطا و متوقف bucket: outbox failed+dead plus inbox failed. */
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
  /** When the oldest still-open row was created — the backlog's age. */
  oldestOpenAt: string | null;
  /** When the next outbound retry is due, if any row is waiting out a backoff. */
  nextRetryAt: string | null;
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
    "connection_id IN (SELECT id FROM integration_connections WHERE business_id = $1 AND provider = 'woocommerce')",
  ];
  const inboxParts: string[] = [
    "business_id = $1",
    "connection_id = $2",
    "connection_id IN (SELECT id FROM integration_connections WHERE business_id = $1 AND provider = 'woocommerce')",
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

  const deferred = inbox.get("deferred") ?? 0;
  const pending = (outbox.get("pending") ?? 0) + (inbox.get("pending") ?? 0) + deferred;
  const processing = outbox.get("processing") ?? 0;
  const dead = outbox.get("dead") ?? 0;
  const failed = (outbox.get("failed") ?? 0) + dead + (inbox.get("failed") ?? 0);
  const needsReview = outbox.get("needs_review") ?? 0;
  const skipped = outbox.get("skipped") ?? 0;
  const sent = (outbox.get("sent") ?? 0) + (inbox.get("processed") ?? 0);
  const outboundFailed = (outbox.get("failed") ?? 0) + dead + needsReview;
  const inboundFailed = inbox.get("failed") ?? 0;
  const open = pending + processing + failed + needsReview;
  const total =
    Array.from(outbox.values()).reduce((a, b) => a + b, 0) +
    Array.from(inbox.values()).reduce((a, b) => a + b, 0);

  return {
    total,
    open,
    pending,
    processing,
    failed,
    dead,
    needsReview,
    skipped,
    sent,
    deferred,
    inboundFailed,
    outboundFailed,
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
 * The F11 verify assist: before an operator has to guess whether a
 * needs-review operation landed remotely, ask the store when we can.
 *
 * Only REST mode can be probed (in plugin mode the server never dials the
 * store), and today only `refund_create` carries a remote verification
 * handle — the `_pos_operation_id` meta the applier itself tags and checks
 * before retrying. Everything else returns an honest "unknown" with
 * guidance instead of pretending certainty. Read-only by design: it never
 * mutates the row, so it is allowed even while the connection is paused.
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
  if (connection.link_mode !== "rest_api") {
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
