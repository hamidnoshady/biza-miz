/**
 * Phase 40 — read models for the WordPress & WooCommerce Manager app.
 *
 * All queries here are local: they read what the sync has already mirrored
 * (mappings, terms, inbox events, content mirror, outbox queue). In plugin
 * mode that is the *only* data the app can have — it never dials the store —
 * so every manager screen works identically in both link modes.
 */
import { query } from "../db";
import { getConnection } from "./connections-service";
import { drainOutbox } from "./outbox-service";
import { reprocessExistingIngestEvent } from "./webhook-ingest-service";

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
        AND status IN ('pending', 'failed', 'deferred')
      GROUP BY status`,
    params,
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

export interface WpStoreCustomerRow {
  remoteId: string;
  localId: string;
  name: string;
  phone: string | null;
  email: string | null;
  ordersCount: number;
  lastSeen: string | null;
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
 * The store's customers as the app knows them: mapping joined to the local
 * customer record, with the count of orders mirrored *from this store*.
 *
 * The order count deliberately goes through the order mappings — not
 * `orders.customer_id` alone — because the same CRM party also buys at the
 * POS, and the badge this feeds is labeled «سفارش آنلاین». `last_seen`
 * falls back to the mapping's own update time: a store that only ever
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

  // One filter, spelled once, used by both the count and the page. `%`/`_`
  // typed by a user are literals, not wildcards.
  const filterParams: unknown[] = [businessId, connectionId];
  let searchSql = "";
  if (search) {
    const escaped = search.replace(/[\\%_]/g, (ch) => `\\${ch}`);
    filterParams.push(`%${escaped}%`);
    const n = `$${filterParams.length}`;
    searchSql =
      `AND (m.remote_id ILIKE ${n} ESCAPE '\\' OR c.name ILIKE ${n} ESCAPE '\\'` +
      ` OR c.phone ILIKE ${n} ESCAPE '\\' OR c.email ILIKE ${n} ESCAPE '\\')`;
  }
  const fromWhere = `
       FROM integration_mappings m
       LEFT JOIN parties c ON c.id = m.local_id
      WHERE m.business_id = $1 AND m.connection_id = $2
        AND m.connection_id IN (SELECT id FROM integration_connections WHERE business_id = $1 AND provider = 'woocommerce' AND deleted_at IS NULL)
        AND m.entity_type = 'customer'
        ${searchSql}`;

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
    local_id: string;
    name: string;
    phone: string | null;
    email: string | null;
    orders_count: string;
    last_seen: string | null;
  }>(
    `SELECT m.remote_id, m.local_id::text,
            COALESCE(c.name, '') AS name,
            c.phone, c.email,
            (SELECT count(*)
               FROM integration_mappings om
               JOIN orders o ON o.id = om.local_id
              WHERE om.business_id = $1
                AND om.connection_id = m.connection_id
                AND om.entity_type = 'order'
                AND o.customer_id = m.local_id)::text AS orders_count,
            COALESCE(
              (SELECT max(w.created_at)
                 FROM integration_webhook_events w
                WHERE w.connection_id = m.connection_id
                  AND w.event_topic LIKE 'customer.%'
                  AND w.remote_id = m.remote_id),
              m.updated_at
            )::text AS last_seen
     ${fromWhere}
      ORDER BY name, m.remote_id
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
  sentAt?: string | null;
  processedAt?: string | null;
  deliveryId?: string | null;
  payload?: Record<string, unknown> | null;
  createdAt: string;
  updatedAt?: string | null;
}

export interface WpQueueFilterOptions {
  status?: "open" | "pending" | "processing" | "failed" | "dead" | "sent" | "deferred" | "all";
  direction?: "all" | "out" | "in";
  search?: string;
  limit?: number;
  page?: number;
  pageSize?: number;
}

export interface WpQueueSummary {
  total: number;
  pending: number;
  processing: number;
  failed: number;
  dead: number;
  sent: number;
  deferred: number;
  inboundFailed: number;
  outboundFailed: number;
}

/** The combined operational queue: outbound outbox jobs and inbound inbox failures. */
export async function wpQueue(
  businessId: string,
  connectionId: string,
  options?: WpQueueFilterOptions,
): Promise<WpQueueRow[]> {
  const statusFilter = options?.status ?? "open";
  const direction = options?.direction ?? "all";
  const search = options?.search?.trim() || "";
  const page = Math.max(1, Math.floor(options?.page ?? 1));
  const pageSize = Math.min(100, Math.max(10, Math.floor(options?.pageSize ?? options?.limit ?? 25)));
  const limit = options?.pageSize === undefined && options?.limit !== undefined
    ? Math.min(Math.max(1, Math.floor(options.limit)), 500)
    : pageSize;
  const offset = (page - 1) * pageSize;

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

  if (statusFilter === "open") {
    outboxParts.push("status IN ('pending', 'failed', 'processing', 'dead', 'needs_review')");
    inboxParts.push("status IN ('failed', 'pending', 'deferred')");
  } else if (statusFilter === "pending") {
    outboxParts.push("status IN ('pending', 'processing')");
    inboxParts.push("status IN ('pending', 'deferred')");
  } else if (statusFilter === "processing") {
    outboxParts.push("status = 'processing'");
    inboxParts.push("1=0");
  } else if (statusFilter === "failed") {
    outboxParts.push("status IN ('failed', 'dead', 'needs_review')");
    inboxParts.push("status = 'failed'");
  } else if (statusFilter === "dead") {
    outboxParts.push("status = 'dead'");
    inboxParts.push("1=0");
  } else if (statusFilter === "sent") {
    outboxParts.push("status = 'sent'");
    inboxParts.push("status = 'processed'");
  } else if (statusFilter === "deferred") {
    outboxParts.push("1=0");
    inboxParts.push("status = 'deferred'");
  }
  // statusFilter === 'all' adds no extra status constraint

  const params: unknown[] = [businessId, connectionId];
  if (search) {
    params.push(`%${search}%`);
    const searchIdx = `$${params.length}`;
    outboxParts.push(`(remote_id ILIKE ${searchIdx} OR entity_type ILIKE ${searchIdx} OR last_error ILIKE ${searchIdx})`);
    inboxParts.push(`(remote_id ILIKE ${searchIdx} OR event_topic ILIKE ${searchIdx} OR error ILIKE ${searchIdx})`);
  }

  const outboxSql = `
    SELECT id::text, 'out' AS direction, entity_type AS kind, status, remote_id, local_id::text,
           last_error AS error, attempts, next_attempt_at::text, sent_at::text,
           NULL::text AS processed_at, NULL::text AS delivery_id, payload,
           created_at::text, updated_at::text
      FROM integration_outbox_events
     WHERE ${outboxParts.join(" AND ")}
  `;

  const inboxSql = `
    SELECT id::text, 'in' AS direction, event_topic AS kind, status, remote_id, NULL::text AS local_id,
           error, 0 AS attempts, NULL::text AS next_attempt_at, NULL::text AS sent_at,
           processed_at::text, delivery_id, payload,
           created_at::text, created_at::text AS updated_at
      FROM integration_webhook_events
     WHERE ${inboxParts.join(" AND ")}
  `;

  let combinedSql: string;
  if (direction === "out") {
    combinedSql = `${outboxSql} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`;
  } else if (direction === "in") {
    combinedSql = `${inboxSql} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`;
  } else {
    combinedSql = `(${outboxSql}) UNION ALL (${inboxSql}) ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`;
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
    sent_at: string | null;
    processed_at: string | null;
    delivery_id: string | null;
    payload: Record<string, unknown> | null;
    created_at: string;
    updated_at: string | null;
  }>(combinedSql, params);

  return rows.map((r) => ({
    id: r.id,
    direction: r.direction as "out" | "in",
    kind: r.kind,
    status: r.status,
    remoteId: r.remote_id,
    localId: r.local_id,
    error: r.error,
    attempts: r.attempts,
    nextAttemptAt: r.next_attempt_at,
    sentAt: r.sent_at,
    processedAt: r.processed_at,
    deliveryId: r.delivery_id,
    payload: r.payload,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

/** Aggregate counts of outbox & inbox events for the queue dashboard. */
export async function wpQueueSummary(businessId: string, connectionId: string): Promise<WpQueueSummary> {
  const [outboxRes, inboxRes] = await Promise.all([
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
  ]);

  const outbox = new Map(outboxRes.rows.map((r) => [r.status, Number(r.n)]));
  const inbox = new Map(inboxRes.rows.map((r) => [r.status, Number(r.n)]));

  const deferred = inbox.get("deferred") ?? 0;
  const pending = (outbox.get("pending") ?? 0) + (inbox.get("pending") ?? 0) + deferred;
  const processing = outbox.get("processing") ?? 0;
  const failed = (outbox.get("failed") ?? 0) + (outbox.get("needs_review") ?? 0) + (inbox.get("failed") ?? 0);
  const dead = outbox.get("dead") ?? 0;
  const sent = (outbox.get("sent") ?? 0) + (inbox.get("processed") ?? 0);
  const outboundFailed = (outbox.get("failed") ?? 0) + (outbox.get("dead") ?? 0) + (outbox.get("needs_review") ?? 0);
  const inboundFailed = inbox.get("failed") ?? 0;
  const total =
    Array.from(outbox.values()).reduce((a, b) => a + b, 0) +
    Array.from(inbox.values()).reduce((a, b) => a + b, 0);

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
  };
}

/** Retry a single queue row (either outbound outbox or inbound webhook). */
export async function retryWpQueueRow(
  businessId: string,
  connectionId: string,
  rowId: string,
  direction?: "out" | "in",
): Promise<{ ok: boolean; error?: string; status?: string }> {
  // If direction is "out" or not specified, try outbox first
  if (direction !== "in") {
    const { rows: outboxRows } = await query<{ id: string }>(
      `SELECT id FROM integration_outbox_events
        WHERE id = $1 AND business_id = $2 AND connection_id = $3`,
      [rowId, businessId, connectionId],
    );
    if (outboxRows.length > 0) {
      await query(
        `UPDATE integration_outbox_events
            SET status = 'pending',
                attempts = 0,
                next_attempt_at = now(),
                last_error = NULL,
                leased_until = NULL,
                updated_at = now()
          WHERE id = $1 AND business_id = $2 AND connection_id = $3`,
        [rowId, businessId, connectionId],
      );

      const connection = await getConnection(businessId, connectionId);
      if (connection && connection.status === "active" && connection.link_mode === "rest_api") {
        try {
          await drainOutbox(connection);
        } catch {
          // Ignored — background worker will pick it up
        }
      }
      return { ok: true, status: "pending" };
    }
  }

  // If not found in outbox or direction is "in", try webhook events (inbox)
  const { rows: inboxRows } = await query<{
    id: string;
    event_topic: string;
    remote_id: string;
    delivery_id: string;
    payload: unknown;
  }>(
    `SELECT id, event_topic, remote_id, delivery_id, payload
       FROM integration_webhook_events
      WHERE id = $1 AND business_id = $2 AND connection_id = $3`,
    [rowId, businessId, connectionId],
  );

  if (inboxRows.length > 0) {
    const row = inboxRows[0];
    const connection = await getConnection(businessId, connectionId);
    if (!connection) return { ok: false, error: "connection_not_found" };

    const outcome = await reprocessExistingIngestEvent(connection, row.id);
    return { ok: outcome.status !== "failed", status: outcome.status, error: "error" in outcome ? outcome.error : undefined };
  }

  return { ok: false, error: "not_found" };
}

/** Retry all failed and dead events for a connection. */
export async function retryAllFailedWpQueue(
  businessId: string,
  connectionId: string,
): Promise<{ ok: boolean; outboxRetried: number; inboxRetried: number }> {
  // 1. Reset all failed / dead outbox events
  const { rowCount: outboxCount } = await query(
    `UPDATE integration_outbox_events
        SET status = 'pending',
            attempts = 0,
            next_attempt_at = now(),
            last_error = NULL,
            leased_until = NULL,
            updated_at = now()
      WHERE business_id = $1 AND connection_id = $2 AND status IN ('failed', 'dead')`,
    [businessId, connectionId],
  );

  // 2. Fetch failed inbox events and re-process them
  const { rows: failedInbox } = await query<{ id: string }>(
    `SELECT id
       FROM integration_webhook_events
      WHERE business_id = $1 AND connection_id = $2 AND status = 'failed'
      ORDER BY created_at ASC`,
    [businessId, connectionId],
  );

  const connection = await getConnection(businessId, connectionId);
  let inboxRetried = 0;
  if (connection) {
    for (const item of failedInbox) {
      const outcome = await reprocessExistingIngestEvent(connection, item.id);
      if (outcome.status !== "failed") inboxRetried++;
    }

    if (connection.status === "active" && connection.link_mode === "rest_api" && (outboxCount ?? 0) > 0) {
      try {
        await drainOutbox(connection);
      } catch {
        // Ignored
      }
    }
  }

  return { ok: true, outboxRetried: outboxCount ?? 0, inboxRetried };
}

/** Flush outbox queue for connection. */
export async function flushWpOutbox(
  businessId: string,
  connectionId: string,
): Promise<{ ok: boolean; mode: "rest_api" | "plugin"; drained?: number; message?: string }> {
  const connection = await getConnection(businessId, connectionId);
  if (!connection || connection.provider !== "woocommerce") {
    return { ok: false, mode: "rest_api", message: "فروشگاه یافت نشد" };
  }

  if (connection.link_mode === "rest_api") {
    await drainOutbox(connection);
    return { ok: true, mode: "rest_api", message: "صف خروجی به فروشگاه ارسال شد." };
  } else {
    return {
      ok: true,
      mode: "plugin",
      message: "در حالت افزونه، کارهای در انتظار در درخواست دوره‌ای بعدی افزونه دریافت و اعمال می‌شوند.",
    };
  }
}
