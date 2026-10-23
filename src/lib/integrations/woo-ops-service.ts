/**
 * Phase 38 — operating the store from the app, through the outbox.
 *
 * Phase 23's outbox could do exactly two things: set a stock number and set a
 * price. Both were automatic — a background diff pushed whatever the local
 * catalogue said, and no human ever chose to send anything. That is the right
 * design for a number and the wrong one for an action, so this module adds
 * the actions an owner actually asks for — mark that order completed, refund
 * those two lines, put that product on sale — and puts every one of them
 * through the same queue.
 *
 * Why the queue and not a direct call: half the stores this app connects to
 * are reachable only from the inside. In plugin mode the app holds no
 * credentials for the store and cannot dial it at all; the WordPress plugin
 * pulls these rows and applies them. Routing an operation through the outbox
 * is what makes «تغییر وضعیت سفارش» behave identically whether the store is
 * open to the internet or behind a firewall — and what gives it the retry,
 * the backoff and the dead-letter trail every push here already had.
 *
 * The fields an operation may send are closed lists, validated here. This
 * channel writes to a live shopfront, and "send whatever the dashboard sent"
 * is how a typo becomes a store-wide price change.
 */
import { randomUUID } from "node:crypto";
import { query } from "../db";
import { normalizeNumericText } from "../digits";
import { writeIntegrationAudit } from "./audit";
import { mergeMappingMeta } from "./mapping-service";
import { parentRemoteIdFor } from "./sync-service";

export type OpsEntityType = "product_update" | "order_status" | "refund_create";

/**
 * Fields the app will write to a WooCommerce product.
 *
 * Deliberately narrow. `type`, `parent_id`, `sku`, `attributes` and
 * `categories` are all writable over REST and all absent here: changing one
 * from the POS would restructure a catalogue the store owns, and a mis-sent
 * `type` can orphan every variation a product has.
 */
export const PRODUCT_UPDATE_FIELDS = [
  "name",
  "regular_price",
  "sale_price",
  "stock_quantity",
  "manage_stock",
  "status",
  "description",
  "short_description",
] as const;
export type ProductUpdateField = (typeof PRODUCT_UPDATE_FIELDS)[number];

/** WooCommerce's canonical order statuses. */
export const ORDER_STATUSES = [
  "pending",
  "processing",
  "on-hold",
  "completed",
  "cancelled",
  "refunded",
  "failed",
] as const;
export type WooOrderStatus = (typeof ORDER_STATUSES)[number];

/** A product's publish status, which is a different axis from its order status. */
export const PRODUCT_STATUSES = ["publish", "draft", "pending", "private"] as const;

export class WooOpsError extends Error {}

/**
 * Filter a requested patch down to the fields this channel will write.
 *
 * Returns the filtered patch rather than throwing on an unknown key: the
 * dashboard is allowed to send a fuller object, and silently dropping
 * `type` is safer than rejecting a legitimate price change because the
 * caller also mentioned something we will not write.
 */
export function sanitizeProductPatch(patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of PRODUCT_UPDATE_FIELDS) {
    if (!(field in patch)) continue;
    const value = patch[field];
    if (value === undefined || value === null) continue;
    if (field === "stock_quantity" || field === "manage_stock") {
      if (field === "manage_stock") {
        // Strict, because `Boolean("false")` is `true`: a caller that sent the
        // *string* "false" meant to stop tracking stock and the old coercion
        // queued the exact opposite against a live shopfront (issue #943).
        // Booleans pass; the JSON-string and 0/1 spellings a form or an older
        // client produces are read by value; anything else is refused rather
        // than guessed at.
        if (typeof value === "boolean") out[field] = value;
        else if (value === "true") out[field] = true;
        else if (value === "false") out[field] = false;
        else if (value === 1 || value === "1") out[field] = true;
        else if (value === 0 || value === "0") out[field] = false;
        else throw new WooOpsError("invalid_manage_stock");
      } else {
        // A whole number or nothing: flooring 3.7 to 3 quietly sent a
        // quantity nobody typed, and a tracked stock figure is an integer
        // count in WooCommerce anyway. Booleans and blank strings are refused
        // too — `Number("")` is 0, and zeroing a store's stock because a form
        // sent an empty field is exactly the fabrication this rejects.
        const isNumeric =
          typeof value === "number" || (typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value)));
        const quantity = isNumeric ? Number(value) : Number.NaN;
        if (!Number.isFinite(quantity) || !Number.isSafeInteger(quantity) || quantity < 0) {
          throw new WooOpsError("invalid_stock_quantity");
        }
        out[field] = quantity;
      }
      continue;
    }
    if (field === "regular_price" || field === "sale_price") {
      // Sent as a decimal string in the store's own unit, never as a number:
      // WooCommerce rejects a JSON number for prices, and a float would
      // round an amount the owner typed by hand.
      const text = String(value).trim();
      if (text !== "" && !/^\d+(?:\.\d+)?$/.test(text)) throw new WooOpsError("invalid_price");
      out[field] = text;
      continue;
    }
    if (field === "status") {
      const status = String(value);
      if (!(PRODUCT_STATUSES as readonly string[]).includes(status)) throw new WooOpsError("invalid_product_status");
      out[field] = status;
      continue;
    }
    out[field] = String(value);
  }
  if (Object.keys(out).length === 0) throw new WooOpsError("empty_patch");
  return out;
}

export function sanitizeOrderStatus(status: string): WooOrderStatus {
  if (!(ORDER_STATUSES as readonly string[]).includes(status)) throw new WooOpsError("invalid_order_status");
  return status as WooOrderStatus;
}

export interface RefundRequest {
  amount: string;
  reason?: string;
  /**
   * Whether WooCommerce should also call the payment gateway.
   *
   * Forced false, and not accepted from a caller. Refunding through a gateway
   * is irreversible and happens on someone else's money; this app's job is to
   * record that a refund was agreed, not to move funds. A store owner who
   * wants the card credited does that in WooCommerce, where the gateway's own
   * confirmation is visible.
   */
  apiRefund?: false;
}

export function sanitizeRefund(body: Record<string, unknown>): { amount: string; reason: string; api_refund: false } {
  const amount = normalizeNumericText(String(body.amount ?? ""), {
    allowDecimal: true,
    allowNegative: true,
    grouping: true,
  });
  if (amount.startsWith("-") || !/^\d+(?:\.\d+)?$/.test(amount) || Number(amount) <= 0) {
    throw new WooOpsError("invalid_refund_amount");
  }
  return {
    amount,
    reason: String(body.reason ?? "").trim().slice(0, 500),
    api_refund: false,
  };
}

/**
 * Enqueue one operation.
 *
 * Idempotent product/order updates are upserted on `(connection_id,
 * entity_type, remote_id)` like every other push. Refunds are intentionally
 * different: each click gets its own operation id and queue key, because a
 * second partial refund against the same order is a real business action, not
 * a duplicate to collapse.
 *
 * The product-update conflict rule (issue #943): while an edit is still
 * *undelivered* — pending, deferred, failed, or mid-flight — a newer edit
 * merges into it field by field (`payload || EXCLUDED.payload`), the newer
 * value winning per field. Queueing a price-only change and then a stock-only
 * change before the worker runs therefore delivers BOTH; the old
 * `payload = EXCLUDED.payload` silently discarded the first. Once an event
 * has reached a terminal state (sent, dead, needs_review) the row starts
 * over with exactly the new patch — a fresh intent does not resurrect the
 * fields of one already delivered or given up on.
 */
export async function enqueueOperation(
  businessId: string,
  connectionId: string,
  entityType: OpsEntityType,
  remoteId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const parentRemoteId =
    entityType === "product_update" ? await parentRemoteIdFor(businessId, connectionId, remoteId) : null;
  const operationId = entityType === "refund_create" ? `woo-refund:${connectionId}:${remoteId}:${randomUUID()}` : null;
  const queuedRemoteId = operationId ? `${remoteId}:${operationId}` : remoteId;
  const fullPayload = {
    ...payload,
    ...(parentRemoteId ? { __parentRemoteId: parentRemoteId } : {}),
    ...(operationId ? { __operationId: operationId, __orderRemoteId: remoteId } : {}),
  };
  await query(
    `INSERT INTO integration_outbox_events (business_id, connection_id, entity_type, remote_id, payload, operation_id)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)
     ON CONFLICT (connection_id, entity_type, remote_id)
     DO UPDATE SET payload = CASE
                     WHEN integration_outbox_events.entity_type = 'product_update'
                      AND integration_outbox_events.status IN ('pending', 'deferred', 'failed', 'processing')
                     THEN integration_outbox_events.payload || EXCLUDED.payload
                     ELSE EXCLUDED.payload
                   END,
                   operation_id = COALESCE(integration_outbox_events.operation_id, EXCLUDED.operation_id),
                   status = 'pending', attempts = 0,
                   next_attempt_at = now(), last_error = NULL, leased_until = NULL, updated_at = now()`,
    [businessId, connectionId, entityType, queuedRemoteId, JSON.stringify(fullPayload), operationId],
  );
  await writeIntegrationAudit({
    businessId,
    connectionId,
    action: `outbox.${entityType}_queued`,
    entityType,
    remoteId,
    payload,
  });
}

/** Ask a plugin-connected store to (re)send what only it can see. */
export async function enqueueExport(
  businessId: string,
  connectionId: string,
  entityType: "catalogue_export" | "customer_export" | "orders_export" | "content_export",
  options: { sinceDays?: number } = {},
): Promise<{ jobId: string | null }> {
  // The row id comes back so a sync route can name the job it queued (#944 / OVR-04).
  const { rows } = await query<{ id: string }>(
    `INSERT INTO integration_outbox_events (business_id, connection_id, entity_type, remote_id, payload)
     VALUES ($1, $2, $3, 'all', $4::jsonb)
     ON CONFLICT (connection_id, entity_type, remote_id)
     DO UPDATE SET payload = EXCLUDED.payload, status = 'pending', attempts = 0,
                   next_attempt_at = now(), last_error = NULL, leased_until = NULL, updated_at = now()
     RETURNING id`,
    [businessId, connectionId, entityType, JSON.stringify({ sinceDays: options.sinceDays ?? null })],
  );
  return { jobId: rows[0]?.id ?? null };
}

// ---------------------------------------------------------------------------
// Product queue state (issue #943)
// ---------------------------------------------------------------------------

/** Outbox states that mean "this edit has not reached the store yet". */
const OPEN_PRODUCT_QUEUE_STATES = new Set(["pending", "processing", "deferred"]);
/** Outbox states that mean "this edit needs a human — it will not retry itself". */
const FAILED_PRODUCT_QUEUE_STATES = new Set(["failed", "dead", "needs_review"]);

export interface ProductQueueState {
  /** `failed` outranks `queued`: an event that needs attention is the news. */
  state: "idle" | "queued" | "failed";
  /** Which pushes are open: any of stock / price / product_update. */
  kinds: string[];
  /** The undelivered product_update patch, without `__` routing keys — what the store will receive. */
  pendingPatch: Record<string, unknown> | null;
  lastError: string | null;
  updatedAt: string | null;
  /** When the last push for this product was acknowledged by the store. */
  lastSentAt: string | null;
}

/**
 * The queue state of a page of products, in one query.
 *
 * The products page used to close an edit with "queued" and then show
 * nothing: no pending badge, no failure, no way to know the price push
 * dead-lettered overnight. This is the read that makes the queue visible per
 * row — the same honesty the store-orders section already had.
 */
export async function productQueueStates(
  businessId: string,
  connectionId: string,
  remoteIds: string[],
): Promise<Record<string, ProductQueueState>> {
  const out: Record<string, ProductQueueState> = {};
  if (remoteIds.length === 0) return out;
  const { rows } = await query<{
    remote_id: string;
    entity_type: string;
    status: string;
    payload: Record<string, unknown> | null;
    last_error: string | null;
    updated_at: string | null;
    sent_at: string | null;
  }>(
    `SELECT remote_id, entity_type, status, payload, last_error, updated_at, sent_at
       FROM integration_outbox_events
      WHERE business_id = $1 AND connection_id = $2
        AND entity_type IN ('stock', 'price', 'product_update')
        AND remote_id = ANY($3::text[])`,
    [businessId, connectionId, remoteIds],
  );
  for (const row of rows) {
    const state: ProductQueueState = (out[row.remote_id] ??= {
      state: "idle",
      kinds: [],
      pendingPatch: null,
      lastError: null,
      updatedAt: null,
      lastSentAt: null,
    });
    if (FAILED_PRODUCT_QUEUE_STATES.has(row.status)) {
      state.state = "failed";
      if (!state.kinds.includes(row.entity_type)) state.kinds.push(row.entity_type);
      if (row.last_error) state.lastError = row.last_error;
    } else if (OPEN_PRODUCT_QUEUE_STATES.has(row.status)) {
      if (state.state !== "failed") state.state = "queued";
      if (!state.kinds.includes(row.entity_type)) state.kinds.push(row.entity_type);
      if (row.entity_type === "product_update" && row.payload) {
        const patch: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(row.payload)) {
          if (!key.startsWith("__")) patch[key] = value;
        }
        // One open product_update row per product (the upsert key), but merge
        // defensively in case both an old and a re-queued row exist.
        state.pendingPatch = { ...(state.pendingPatch ?? {}), ...patch };
      }
    } else if (row.status === "sent" && row.sent_at) {
      if (!state.lastSentAt || row.sent_at > state.lastSentAt) state.lastSentAt = row.sent_at;
    }
    if (row.updated_at && (!state.updatedAt || row.updated_at > state.updatedAt)) {
      state.updatedAt = row.updated_at;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-product push switches and the explicit retry (issue #943, items 4–5)
// ---------------------------------------------------------------------------

/**
 * Pause or resume the SCHEDULED stock/price push for one product.
 *
 * The connection-level `push_stock`/`push_prices` switches answer "does this
 * store receive automatic pushes at all"; this is the per-product half of
 * item 4: one product the owner sells only in person, or prices by hand in
 * the store, opts out without turning the whole connection off. The pause
 * lives in the mapping's metadata, which `refreshOutboxForConnection` reads
 * before queueing either axis, and the catalogue page carries it back so the
 * UI shows the switch's true state.
 *
 * Pausing also drops the axis's not-yet-sent scheduled events — a pause that
 * leaves a queued push in the queue is not a pause. `processing` events are
 * mid-delivery (leased by the drain or the plugin) and finish; `dead` and
 * `needs_review` rows stay, because they are history a human owes a decision
 * on. Manual `product_update` events are never touched: this switch stops the
 * automation, not the owner.
 */
export async function setProductPushPause(
  businessId: string,
  connectionId: string,
  remoteId: string,
  axes: { stock?: boolean; price?: boolean },
): Promise<void> {
  const patch: Record<string, unknown> = {};
  if (axes.stock !== undefined) patch.stockPushPaused = axes.stock;
  if (axes.price !== undefined) patch.pricePushPaused = axes.price;
  if (Object.keys(patch).length === 0) throw new WooOpsError("empty_patch");
  await mergeMappingMeta(businessId, connectionId, "product", remoteId, patch);
  for (const [axis, paused] of [["stock", axes.stock], ["price", axes.price]] as const) {
    if (paused !== true) continue;
    await query(
      `DELETE FROM integration_outbox_events
        WHERE business_id = $1 AND connection_id = $2 AND remote_id = $3
          AND entity_type = $4 AND status IN ('pending', 'deferred', 'failed')`,
      [businessId, connectionId, remoteId, axis],
    );
  }
  await writeIntegrationAudit({
    businessId,
    connectionId,
    action: "product.push_pause",
    entityType: "product",
    remoteId,
    payload: patch,
  });
}

/**
 * Put a product's failed queue events back in line, on purpose.
 *
 * The scheduled refresh may never resurrect a `dead`/`needs_review`/leased
 * event — that is the loop item 2 forbids. A human pressing «retry» on the
 * row is the one actor allowed to: this resets the delivery clock
 * (attempts, backoff, lease) on the failed events of all three product
 * entity types and leaves `last_error` readable until the next delivery
 * overwrites it. Returns how many events were requeued — 0 is an honest
 * answer, not an error: nothing was parked.
 */
export async function retryProductQueue(
  businessId: string,
  connectionId: string,
  remoteId: string,
): Promise<number> {
  const result = await query(
    `UPDATE integration_outbox_events
        SET status = 'pending', attempts = 0, next_attempt_at = now(),
            leased_until = NULL, updated_at = now()
      WHERE business_id = $1 AND connection_id = $2 AND remote_id = $3
        AND entity_type IN ('stock', 'price', 'product_update')
        AND status IN ('failed', 'dead', 'needs_review')`,
    [businessId, connectionId, remoteId],
  );
  const retried = result.rowCount ?? 0;
  await writeIntegrationAudit({
    businessId,
    connectionId,
    action: "product.queue_retry",
    entityType: "product",
    remoteId,
    payload: { retried },
  });
  return retried;
}

// ---------------------------------------------------------------------------
// Reading the store's orders back
// ---------------------------------------------------------------------------

export interface StoreOrderOperationRow {
  type: "order_status" | "refund_create";
  status: string;
  targetStatus: string | null;
  amount: string | null;
  reason: string | null;
  error: string | null;
}

export interface StoreOrderRow {
  remoteId: string;
  localOrderId: string | null;
  localOrderNumber: number | null;
  number: string;
  status: string;
  total: string;
  currency: string;
  dateCreated: string | null;
  customer: string;
  paymentMethod: string;
  /** Whether the last delivery of this order applied cleanly. */
  ingestStatus: string;
  ingestError: string | null;
  lineCount: number;
  /** Pending/failed live-store operations queued from the manager for this order. */
  operations: StoreOrderOperationRow[];
}

export interface StoreOrdersQueryOptions {
  page?: number;
  pageSize?: number;
  search?: string;
  status?: string;
  ingestStatus?: string;
  view?: "imported" | "unrecorded" | "queued" | "attention" | "";
}

export interface StoreOrdersPage {
  orders: StoreOrderRow[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * The orders this connection knows about, newest first.
 *
 * Read from the ingest inbox, not by calling the store: in plugin mode there
 * is no call to make, and in REST mode an extra round trip per screen would
 * put the store's latency into a dashboard. What the app already received is
 * also what it actually recorded — which is the question being asked.
 */
export async function storeOrdersPageFor(
  businessId: string,
  connectionId: string,
  options: StoreOrdersQueryOptions = {},
): Promise<StoreOrdersPage> {
  const page = Math.max(1, Math.floor(options.page ?? 1));
  const pageSize = Math.min(200, Math.max(10, Math.floor(options.pageSize ?? 25)));
  const offset = (page - 1) * pageSize;
  const search = options.search?.trim().slice(0, 200) ?? "";
  const status = options.status?.trim().slice(0, 80) ?? "";
  const ingestStatus = options.ingestStatus?.trim().slice(0, 80) ?? "";
  const view = options.view ?? "";

  const params: unknown[] = [businessId, connectionId, pageSize, offset];
  const filters: string[] = [];
  if (search) {
    params.push(`%${search}%`);
    const idx = `$${params.length}`;
    filters.push(`(
      remote_id ILIKE ${idx}
      OR COALESCE(order_number::text, '') ILIKE ${idx}
      OR COALESCE(payload->>'number', '') ILIKE ${idx}
      OR COALESCE(payload #>> '{billing,first_name}', '') ILIKE ${idx}
      OR COALESCE(payload #>> '{billing,last_name}', '') ILIKE ${idx}
      OR COALESCE(payload #>> '{billing,company}', '') ILIKE ${idx}
      OR COALESCE(payload #>> '{billing,phone}', '') ILIKE ${idx}
      OR COALESCE(payload #>> '{billing,email}', '') ILIKE ${idx}
    )`);
  }
  if (status) {
    params.push(status);
    filters.push(`COALESCE(payload->>'status', '') = $${params.length}`);
  }
  if (ingestStatus) {
    params.push(ingestStatus);
    filters.push(`COALESCE(ingest_status, 'none') = $${params.length}`);
  }
  if (view === "imported") {
    filters.push("local_order_id IS NOT NULL");
  } else if (view === "unrecorded") {
    filters.push("local_order_id IS NULL");
  } else if (view === "queued") {
    filters.push("jsonb_array_length(outbox_operations) > 0");
  } else if (view === "attention") {
    filters.push("(COALESCE(ingest_status, 'none') = 'failed' OR outbox_operations @> '[{\"status\": \"failed\"}]'::jsonb OR outbox_operations @> '[{\"status\": \"dead\"}]'::jsonb OR outbox_operations @> '[{\"status\": \"needs_review\"}]'::jsonb)");
  }
  const filterSql = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

  const { rows } = await query<{
    remote_id: string;
    local_order_id: string | null;
    order_number: string | null;
    event_topic: string | null;
    payload: Record<string, unknown> | null;
    ingest_status: string | null;
    ingest_error: string | null;
    created_at: string | null;
    outbox_operations: StoreOrderOperationRow[] | null;
    total_count: string;
  }>(
    `WITH latest_events AS (
       SELECT DISTINCT ON (w.remote_id)
              w.remote_id,
              w.event_topic,
              w.payload,
              w.status,
              w.error,
              w.created_at
         FROM integration_webhook_events w
        WHERE w.business_id = $1
          AND w.connection_id = $2
          AND w.remote_id <> ''
          AND w.event_topic IN ('order.created', 'order.updated', 'order.restored')
        ORDER BY w.remote_id, w.created_at DESC, w.id DESC
     ), order_keys AS (
       SELECT remote_id FROM latest_events
       UNION
       SELECT remote_id
         FROM integration_mappings
        WHERE business_id = $1 AND connection_id = $2 AND entity_type = 'order'
       UNION
       SELECT CASE
                WHEN entity_type = 'refund_create' THEN COALESCE(payload->>'__orderRemoteId', remote_id)
                ELSE remote_id
              END AS remote_id
         FROM integration_outbox_events
        WHERE business_id = $1
          AND connection_id = $2
          AND remote_id <> ''
          AND entity_type IN ('order_status', 'refund_create')
          AND status IN ('pending', 'processing', 'failed', 'dead', 'needs_review')
     ), base AS (
       SELECT k.remote_id,
              m.local_id::text AS local_order_id,
              o.order_number::text,
              e.event_topic,
              e.payload,
              COALESCE(e.status, 'none') AS ingest_status,
              e.error AS ingest_error,
              e.created_at,
              COALESCE(ops.operations, '[]'::jsonb) AS outbox_operations,
              GREATEST(
                COALESCE(e.created_at, '-infinity'::timestamptz),
                COALESCE(ops.latest_at, '-infinity'::timestamptz),
                COALESCE(m.updated_at, '-infinity'::timestamptz)
              ) AS sort_at
         FROM order_keys k
         LEFT JOIN integration_mappings m
           ON m.business_id = $1
          AND m.connection_id = $2
          AND m.entity_type = 'order'
          AND m.remote_id = k.remote_id
         LEFT JOIN orders o ON o.id = m.local_id
         LEFT JOIN latest_events e ON e.remote_id = k.remote_id
         LEFT JOIN LATERAL (
           SELECT jsonb_agg(
                    jsonb_build_object(
                      'type', oe.entity_type,
                      'status', oe.status,
                      'targetStatus', oe.payload->>'status',
                      'amount', oe.payload->>'amount',
                      'reason', oe.payload->>'reason',
                      'error', oe.last_error
                    )
                    ORDER BY oe.updated_at DESC, oe.created_at DESC
                  ) AS operations,
                  max(oe.updated_at) AS latest_at
             FROM integration_outbox_events oe
            WHERE oe.business_id = $1
              AND oe.connection_id = $2
              AND (oe.remote_id = k.remote_id OR (oe.entity_type = 'refund_create' AND oe.payload->>'__orderRemoteId' = k.remote_id))
              AND oe.entity_type IN ('order_status', 'refund_create')
              AND oe.status IN ('pending', 'processing', 'failed', 'dead', 'needs_review')
         ) ops ON true
     ), filtered AS (
       SELECT *, count(*) OVER ()::text AS total_count
         FROM base
         ${filterSql}
     )
     SELECT remote_id, local_order_id, order_number, event_topic, payload,
            ingest_status, ingest_error, created_at, outbox_operations, total_count
       FROM filtered
      ORDER BY sort_at DESC, remote_id DESC
      LIMIT $3 OFFSET $4`,
    params,
  );

  const orders = rows.map((row) => {
    const payload = (row.payload ?? {}) as Record<string, unknown>;
    const billing = (payload.billing ?? {}) as Record<string, unknown>;
    const operations = (Array.isArray(row.outbox_operations) ? row.outbox_operations : []).filter(
      (operation): operation is StoreOrderOperationRow =>
        operation?.type === "order_status" || operation?.type === "refund_create",
    );
    const company = String(billing.company ?? "").trim();
    const name = [billing.first_name, billing.last_name].filter(Boolean).join(" ").trim();
    return {
      remoteId: row.remote_id,
      localOrderId: row.local_order_id,
      localOrderNumber: row.order_number === null ? null : Number(row.order_number),
      number: String(payload.number ?? row.remote_id),
      status: String(payload.status ?? ""),
      total: String(payload.total ?? "0"),
      currency: String(payload.currency ?? ""),
      dateCreated: typeof payload.date_created === "string" ? payload.date_created : null,
      customer: name || company,
      paymentMethod: String(payload.payment_method ?? ""),
      ingestStatus: row.ingest_status ?? "none",
      ingestError: row.ingest_error,
      lineCount: Array.isArray(payload.line_items) ? payload.line_items.length : 0,
      operations,
    } satisfies StoreOrderRow;
  });

  return { orders, total: Number(rows[0]?.total_count ?? 0), page, pageSize };
}

/** Back-compatible first page helper used by older callers/tests. */
export async function storeOrdersFor(
  businessId: string,
  connectionId: string,
  limit = 50,
): Promise<StoreOrderRow[]> {
  return (await storeOrdersPageFor(businessId, connectionId, { page: 1, pageSize: limit })).orders;
}

/** True when an order id belongs to the connection's local mirror or inbox. */
export async function storeOrderKnownFor(businessId: string, connectionId: string, remoteId: string): Promise<boolean> {
  const { rows } = await query<{ found: number }>(
    `SELECT 1 AS found
       FROM integration_mappings
      WHERE business_id = $1 AND connection_id = $2 AND entity_type = 'order' AND remote_id = $3
      UNION
     SELECT 1 AS found
       FROM integration_webhook_events
      WHERE business_id = $1
        AND connection_id = $2
        AND remote_id = $3
        AND event_topic IN ('order.created', 'order.updated', 'order.restored')
      UNION
     SELECT 1 AS found
       FROM integration_outbox_events
      WHERE business_id = $1
        AND connection_id = $2
        AND remote_id = $3
        AND entity_type IN ('order_status', 'refund_create')
      LIMIT 1`,
    [businessId, connectionId, remoteId],
  );
  return rows.length > 0;
}
