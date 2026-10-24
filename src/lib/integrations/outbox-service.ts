/**
 * Phase 23 (issue #118) — Wave 4: push stock & price from the POS to
 * WooCommerce through the outbox. DB-touching (not unit-tested directly; the
 * backoff/dead-letter and money conversion logic it leans on are pure).
 *
 * The background tick (wired in server.ts) enumerates active connections under
 * the documented platform bypass, then re-enters each business with
 * withTenant() before touching tenant data — the same shape as every other
 * server.ts tick. For each connection it (1) diffs local price/stock against
 * the mapping's last-pushed value and upserts due outbox events, then (2)
 * drains due events to the store with retry/backoff/dead-lettering.
 */
import { query, withoutTenantScope, withTenant } from "../db";
import { getBusinessIndustry } from "../industry-guard";
import { hasSellableCatalogue } from "../industries";
import { getConnection, wooClientFor } from "./connections-service";
import { isWooCommerce } from "./provider-registry";
import { listMappings, mergeMappingMeta } from "./mapping-service";
import { rialToWooAmount, wooAmountToRial } from "./woo-money";
import { backoffDelayMs, isDeadAfterAttempts, OUTBOX_MAX_ATTEMPTS } from "./retry";
import { writeIntegrationAudit } from "./audit";
import { wooProductShape, wooUpdatePath } from "./woo-catalogue";
import { parentRemoteIdFor, parentRemoteIdFromMeta } from "./sync-service";
import type { ConnectionRow } from "./connections-service";

export const WOO_SYNC_TICK_INTERVAL_MS = 60 * 1000;
export const DRAIN_BATCH = 25;
/**
 * How long a REST claim stays fenced to its claimer (issue #942, F02/F04).
 * Generous against a slow store, short enough that a crashed worker's rows
 * are claimable again within minutes instead of sitting `processing`
 * forever — the state the pre-fencing drainer could never select again.
 */
export const OUTBOX_LEASE_MS = 5 * 60 * 1000;

class NeedsReviewError extends Error {}

async function resolveLocationId(connection: ConnectionRow): Promise<string> {
  if (connection.location_id) return connection.location_id;
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM locations WHERE business_id = $1 AND is_active ORDER BY created_at LIMIT 1`,
    [connection.business_id],
  );
  if (!rows[0]) throw new Error("no_location");
  return rows[0].id;
}

/**
 * The sellable quantity of a menu item, from its recipe: the minimum over its
 * ingredients of floor(on-hand / required-per-unit). NULL when the item has no
 * recipe — without one, the POS itself can't know how many it can sell.
 */
async function sellableStock(locationId: string, menuItemId: string): Promise<number | null> {
  const { rows } = await query<{ quantity: string; stock: string }>(
    `SELECT mii.quantity,
            COALESCE(SUM(sm.quantity), 0)::text AS stock
       FROM menu_item_ingredients mii
       LEFT JOIN stock_movements sm
         ON sm.inventory_item_id = mii.inventory_item_id AND sm.location_id = $1
      WHERE mii.menu_item_id = $2
      GROUP BY mii.inventory_item_id, mii.quantity`,
    [locationId, menuItemId],
  );
  if (rows.length === 0) return null;
  let min = Number.POSITIVE_INFINITY;
  for (const row of rows) {
    const sellable = Math.floor(Number(row.stock) / Number(row.quantity));
    if (sellable < min) min = sellable;
  }
  return min === Number.POSITIVE_INFINITY ? 0 : min;
}

interface DesiredState {
  stock: number | null;
  priceRial: bigint | null;
}

/** What should currently be pushed for one mapped product. */
async function desiredState(
  connection: ConnectionRow,
  locationId: string,
  mapping: { localId: string; lastPushedPayload: unknown },
): Promise<DesiredState> {
  const industry = await getBusinessIndustry(connection.business_id);
  const localId = mapping.localId;

  // The recorded shape decides whether a stock figure may be pushed at all
  // (issue #943, item 4): `variable`/`grouped` containers hold no quantity,
  // and an `external` product is sold on someone else's site — a stale
  // item_stock row on any of them is a number this app must not fabricate
  // into the store's live inventory. A legacy mapping with no recorded
  // wooType classifies as `unknown → simple`, which stays tracked exactly
  // like before; the retail query below keeps its own variant_parent guard.
  const shape = wooProductShape((mapping.lastPushedPayload as { wooType?: string } | null)?.wooType);

  // A trade with no sellable catalogue has no local state to push: the mapping
  // cannot exist in the first place (product sync skips), so this is the safe
  // answer rather than a query against a table the business does not fill.
  if (!hasSellableCatalogue(industry)) return { stock: null, priceRial: null };

  if (industry === "food_service") {
    const { rows } = await query<{ price: string }>(
      `SELECT price FROM menu_items WHERE id = $1 AND location_id = $2`,
      [localId, locationId],
    );
    if (!rows[0]) return { stock: null, priceRial: null };
    return {
      stock: connection.push_stock && shape.stockTracked ? await sellableStock(locationId, localId) : null,
      priceRial: connection.push_prices ? BigInt(rows[0].price) : null,
    };
  }

  // Retail: read the item_stock row directly — no recipe-based sellable stock.
  const { rows } = await query<{ quantity: string; unit_price: string | null }>(
    `SELECT s.quantity::text, s.unit_price::text
       FROM items i
       JOIN item_stock s ON s.item_id = i.id
      WHERE i.id = $1 AND i.location_id = $2
        AND i.kind <> 'variant_parent'`,
    [localId, locationId],
  );
  if (!rows[0]) return { stock: null, priceRial: null };
  return {
    stock: connection.push_stock && shape.stockTracked ? Number(rows[0].quantity) : null,
    priceRial: connection.push_prices && rows[0].unit_price ? BigInt(rows[0].unit_price) : null,
  };
}

/**
 * The products with an undelivered manual edit, per axis, in one query.
 *
 * A manual product update queued from the products page is a human decision
 * about the *store's* value; the scheduled diff below derives its value from
 * the *local* catalogue. Queueing both for the same axis means the drain
 * delivers them in next_attempt_at order and whichever lands last silently
 * wins — the local-derived push could overwrite the manual one before it was
 * ever applied (issue #943's overwrite/loop hazard). While a manual edit is
 * open, the manual edit owns that axis; when it is delivered, the drain's
 * last-pushed bookkeeping keeps the automatic diff quiet again.
 */
async function openManualProductAxes(connectionId: string): Promise<Map<string, { price: boolean; stock: boolean }>> {
  const { rows } = await query<{ remote_id: string; payload: Record<string, unknown> | null }>(
    `SELECT remote_id, payload FROM integration_outbox_events
      WHERE connection_id = $1 AND entity_type = 'product_update'
        AND status IN ('pending', 'processing', 'deferred', 'failed')`,
    [connectionId],
  );
  const out = new Map<string, { price: boolean; stock: boolean }>();
  for (const row of rows) {
    const payload = row.payload ?? {};
    const axes = out.get(row.remote_id) ?? { price: false, stock: false };
    if ("regular_price" in payload || "sale_price" in payload) axes.price = true;
    if ("stock_quantity" in payload || "manage_stock" in payload) axes.stock = true;
    out.set(row.remote_id, axes);
  }
  return out;
}

/** Diffs desired vs last-pushed and upserts outbox events for anything changed. */
export async function refreshOutboxForConnection(connection: ConnectionRow): Promise<void> {
  const businessId = connection.business_id;
  const locationId = await resolveLocationId(connection);
  const mappings = await listMappings(businessId, connection.id, "product");
  const manualAxes = await openManualProductAxes(connection.id);

  for (const mapping of mappings) {
    const desired = await desiredState(connection, locationId, mapping);
    // The variation's parent, from the mapping's own metadata — the one
    // central rule (parentRemoteIdFromMeta). Without it the scheduled push
    // for a variation went to `products/{variation}`, which is a 404 in REST
    // mode: manual product updates resolved the parent, scheduled price and
    // stock pushes never did.
    const parentRemoteId = parentRemoteIdFromMeta(mapping.lastPushedPayload);
    const manual = manualAxes.get(mapping.remoteId);
    // The per-product switches (issue #943, item 4): an owner who paused the
    // scheduled stock or price push for THIS product is not overruled by the
    // tick. Manual edits still queue — the pause stops the automation, not
    // the human.
    const pause = (mapping.lastPushedPayload ?? {}) as { stockPushPaused?: unknown; pricePushPaused?: unknown };
    const stockPaused = pause.stockPushPaused === true;
    const pricePaused = pause.pricePushPaused === true;
    // The diff runs against `lastPushedPayload` — the store's acknowledged
    // state — and the guarded upsert turns that diff into queue work without
    // ever touching a leased or human-parked event, so the refresh can
    // neither overwrite a remote edit on its way nor loop on one a human
    // parked (issue #943, item 2). A value that moved twice between ticks
    // still gets its queued payload corrected to the current desire. Axes
    // with an open MANUAL edit stay out of the way: that payload is a
    // deliberate store-side decision, and the scheduled push must not race
    // it. Per-product pauses (item 4) are read from the same metadata.
    const previous = (mapping.lastPushedPayload ?? {}) as { stock?: number; priceRial?: string };
    if (desired.priceRial !== null && !manual?.price && !pricePaused) {
      await upsertOutbox(
        businessId,
        connection.id,
        "price",
        mapping.remoteId,
        mapping.localId,
        {
          regular_price: rialToWooAmount(desired.priceRial, connection.currency_unit),
          ...(parentRemoteId ? { __parentRemoteId: parentRemoteId } : {}),
        },
        previous.priceRial !== desired.priceRial.toString(),
      );
    }
    if (desired.stock !== null && !manual?.stock && !stockPaused) {
      await upsertOutbox(
        businessId,
        connection.id,
        "stock",
        mapping.remoteId,
        mapping.localId,
        {
          stock_quantity: desired.stock,
          manage_stock: true,
          ...(parentRemoteId ? { __parentRemoteId: parentRemoteId } : {}),
        },
        previous.stock !== desired.stock,
      );
    }
  }
}

/**
 * Queue (or refresh) one scheduled stock/price push — without ever
 * overwriting or looping on a remote edit that is already on its way
 * (issue #943, item 2).
 *
 * The old upsert reset the conflicting row unconditionally, which meant the
 * scheduled diff:
 *   - resurrected `dead` / `needs_review` events every tick — a human had
 *     decided that push must not retry itself, and the refresh overruled
 *     that decision forever;
 *   - rewrote the payload of a `processing` event the plugin or the drain
 *     had already leased, so the store could receive a value the queue no
 *     longer showed;
 *   - zeroed `attempts` and `next_attempt_at` on `failed` events, turning
 *     every backoff into a per-tick hammer against a store that was
 *     rejecting the push.
 *
 * The guarded pair below keeps the delivery state machine authoritative.
 * `changedFromAck` is the caller's diff against `lastPushedPayload` — the
 * store's ACKNOWLEDGED state, which is the only honest memory of what the
 * store holds:
 *
 *   - changed: upsert. No row → insert. An open (`pending`/`deferred`) or
 *     backing-off (`failed`) row → freshest payload in place, status and
 *     backoff untouched. A `sent` row → re-armed to pending, because there
 *     is new news since the ack. A leased (`processing`) or human-parked
 *     (`dead`/`needs_review`) row → untouched, always.
 *   - not changed: NEVER insert and never re-arm — comparing against the
 *     sent event's payload instead of the ack would re-push a value the
 *     store already has and overwrite a manual override the moment it was
 *     delivered. The one job left is repairing a queued event whose payload
 *     went stale because the local value moved twice between ticks.
 */
async function upsertOutbox(
  businessId: string,
  connectionId: string,
  entityType: "stock" | "price",
  remoteId: string,
  localId: string,
  payload: Record<string, unknown>,
  changedFromAck: boolean,
): Promise<void> {
  const payloadJson = JSON.stringify(payload);
  // Issue #942 + PR #1054: two rules share this upsert. A row a worker
  // currently holds (`processing`) is immutable — status, attempts, lease
  // *and payload* — so the value its holder applies is exactly the value
  // the eventual ack records as last-pushed; the WHERE below simply never
  // touches such a row, and a newer desired value is not lost: the mapping
  // still holds the older delivered value, so the next tick's diff requeues
  // the newer one. And a delivered value is only re-armed when the desired
  // state actually moved since the last ack (`changedFromAck`): resetting a
  // `sent` row whose payload already matches what the store acknowledged
  // would push the same update forever. A `skipped` row (the plugin's local
  // policy switch was off) is not resurrected for the same payload every
  // tick; a changed value is worth one fresh attempt.
  if (changedFromAck) {
    await query(
      `INSERT INTO integration_outbox_events
         (business_id, connection_id, entity_type, remote_id, local_id, payload)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (connection_id, entity_type, remote_id)
       DO UPDATE SET
         payload = EXCLUDED.payload,
         status = CASE WHEN integration_outbox_events.status IN ('sent', 'skipped') THEN 'pending'
                       ELSE integration_outbox_events.status END,
         attempts = CASE WHEN integration_outbox_events.status IN ('sent', 'skipped') THEN 0
                         ELSE integration_outbox_events.attempts END,
         next_attempt_at = CASE WHEN integration_outbox_events.status IN ('sent', 'skipped') THEN now()
                                ELSE integration_outbox_events.next_attempt_at END,
         last_error = CASE WHEN integration_outbox_events.status IN ('sent', 'skipped') THEN NULL
                           ELSE integration_outbox_events.last_error END,
         leased_until = CASE WHEN integration_outbox_events.status IN ('sent', 'skipped') THEN NULL
                             ELSE integration_outbox_events.leased_until END,
         lease_token = CASE WHEN integration_outbox_events.status IN ('sent', 'skipped') THEN NULL
                            ELSE integration_outbox_events.lease_token END,
         updated_at = now()
       WHERE integration_outbox_events.status IN ('pending', 'deferred', 'failed', 'sent', 'skipped')
         AND (integration_outbox_events.payload IS DISTINCT FROM EXCLUDED.payload
              OR integration_outbox_events.status = 'sent')`,
      [businessId, connectionId, entityType, remoteId, localId, payloadJson],
    );
    return;
  }
  await query(
    `UPDATE integration_outbox_events
        SET payload = $5::jsonb, updated_at = now()
      WHERE business_id = $1 AND connection_id = $2 AND entity_type = $3 AND remote_id = $4
        AND status IN ('pending', 'deferred', 'failed')
        AND payload IS DISTINCT FROM $5::jsonb`,
    [businessId, connectionId, entityType, remoteId, payloadJson],
  );
}

export type OutboxEntityType =
  | "stock"
  | "price"
  | "product_update"
  | "order_status"
  | "refund_create"
  | "catalogue_export"
  | "customer_export"
  | "orders_export";

/**
 * Apply one queued push to the store.
 *
 * The variation path is the Phase 38 fix. A variation is
 * `products/{parent}/variations/{id}` and not `products/{id}`; sending the
 * flat path with a variation id answers 404, and every push to a variation
 * duly walked itself into the dead-letter queue. The parent id is recorded
 * on the mapping when the product is synced (see sync-service's
 * `recordProductShape`) and carried on the row so the plugin — which leases
 * these rows and applies them itself — can make the same choice.
 */
async function applyOutboundEvent(
  connection: ConnectionRow,
  client: ReturnType<typeof wooClientFor>,
  event: { entity_type: string; remote_id: string; payload: unknown },
): Promise<void> {
  const patch = (event.payload ?? {}) as Record<string, unknown>;
  // Reserved keys never reach the store: `__parentRemoteId` is routing
  // metadata for this channel, not a WooCommerce field.
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!key.startsWith("__")) body[key] = value;
  }

  switch (event.entity_type) {
    case "stock":
    case "price":
    case "product_update": {
      // The parent the variation path needs. Carried on the payload since
      // issue #943 (both the manual enqueue and the scheduled refresh write
      // it); rows queued before that fix — and any writer that forgot — fall
      // back to the mapping's metadata here, the same COALESCE the plugin's
      // job lease does in SQL. A missing parent must not mean "guess the
      // flat path" for a variation: `products/{variation}` is a 404.
      const parent =
        (typeof patch.__parentRemoteId === "string" && patch.__parentRemoteId
          ? patch.__parentRemoteId
          : null) ?? (await parentRemoteIdFor(connection.business_id, connection.id, event.remote_id));
      await client.updateAt(wooUpdatePath(event.remote_id, parent), body);
      return;
    }
    case "order_status":
      await client.updateOrder(Number(event.remote_id), { status: body.status });
      return;
    case "refund_create": {
      // `api_refund` is forced false by woo-ops-service and re-forced here:
      // this channel records a refund, it does not move money through
      // someone's payment gateway. Non-idempotent: tag the remote refund with
      // a stable operation id and check for it before retrying after an
      // ambiguous ACK/network failure.
      const operationId = typeof patch.__operationId === "string" ? patch.__operationId : null;
      if (!operationId) {
        throw new NeedsReviewError("operation_id_missing_for_non_idempotent_refund");
      }
      const orderRemoteId = typeof patch.__orderRemoteId === "string" ? patch.__orderRemoteId : event.remote_id;
      if (operationId) {
        const existing = await client.listOrderRefunds(Number(orderRemoteId));
        if (
          existing.some((refund) =>
            (refund.meta_data ?? []).some((meta) => meta.key === "_pos_operation_id" && meta.value === operationId),
          )
        ) {
          return;
        }
      }
      await client.createRefund(Number(orderRemoteId), {
        amount: body.amount,
        reason: body.reason ?? "",
        api_refund: false,
        ...(operationId ? { meta_data: [{ key: "_pos_operation_id", value: operationId }] } : {}),
      });
      return;
    }
    case "catalogue_export":
    case "customer_export":
    case "orders_export":
    case "content_export":
      // Plugin-only: they ask the plugin to send what only it can see. In
      // REST mode there is nothing to apply (the app pulled the data
      // itself), and leaving them queued would dead-letter a job that was
      // never meant for this side.
      return;
    case "post_upsert":
    case "media_create":
      // Plugin-side jobs for WordPress content. REST mode writes content
      // directly through the manager's API route (wpUpsertPost), so nothing
      // is drained here; in plugin mode the plugin leases and applies these
      // rows itself.
      return;
    default:
      return;
  }
}

export type ClaimedOutboxEvent = {
  id: string;
  entity_type: OutboxEntityType;
  remote_id: string;
  payload: unknown;
  attempts: number;
  lease_token: string;
};

/**
 * The one definition of "this row can be claimed right now", as a SQL
 * fragment over `$N` = the lease window in milliseconds. The claim and the
 * drain's follow-up `hasMore` count both build on it — when the two were
 * written out separately, the count omitted the legacy unleased-stale arm
 * and a manual flush could report "nothing more due" while a second flush
 * would immediately have found work (PR #1053 review).
 *
 * The third arm is the pre-fencing residue: rows the old drainer flipped to
 * `processing` with no lease at all. They are claimable once untouched for
 * a full lease window — long enough that no live worker can still hold one.
 */
export function claimableOutboxSql(leaseMsParam: string): string {
  return `(
    (status IN ('pending', 'failed') AND next_attempt_at <= now())
    OR (status = 'processing' AND leased_until IS NOT NULL AND leased_until < now())
    OR (status = 'processing' AND leased_until IS NULL
        AND updated_at < now() - (${leaseMsParam} || ' milliseconds')::interval)
  )`;
}

/**
 * Atomically claim one batch of due outbox rows for this connection
 * (issue #942, F02/F04).
 *
 * The claim is a single statement: candidate rows are locked
 * `FOR UPDATE SKIP LOCKED` inside the UPDATE, so two concurrent drainers —
 * a periodic tick racing a manual flush, or two server instances — can
 * never both hold the same row. Each claimed row gets a fresh
 * `lease_token` (its lease generation) and a `leased_until`; every later
 * transition out of `processing` is conditional on that token, so a worker
 * whose lease expired mid-apply cannot overwrite a newer attempt's state.
 *
 * Rows stuck in `processing` come back: an expired lease (or, for rows the
 * pre-fencing drainer left with no lease at all, an `updated_at` older than
 * one lease window) makes the row claimable again. Re-applying is safe for
 * the one non-idempotent REST operation — `refund_create` checks the store
 * for its operation id before creating (see `applyOutboundEvent`) — and a
 * refund without an operation id is routed to `needs_review` by that same
 * check rather than resent blind.
 */

export async function claimOutboxBatch(
  connectionId: string,
  limit = DRAIN_BATCH,
): Promise<ClaimedOutboxEvent[]> {
  const { rows } = await query<ClaimedOutboxEvent>(
    `UPDATE integration_outbox_events o
        SET status = 'processing',
            lease_token = gen_random_uuid(),
            leased_until = now() + ($3 || ' milliseconds')::interval,
            updated_at = now()
      WHERE o.id IN (
        SELECT id FROM integration_outbox_events
         WHERE connection_id = $1
           AND ${claimableOutboxSql("$3")}
         ORDER BY next_attempt_at, created_at
         LIMIT $2
         FOR UPDATE SKIP LOCKED
      )
      RETURNING o.id, o.entity_type, o.remote_id, o.payload, o.attempts, o.lease_token::text`,
    [connectionId, limit, OUTBOX_LEASE_MS],
  );
  return rows;
}

/**
 * What a connection's outbox still owes: `open` rows in flight or waiting,
 * and how many of them a claim could take *right now* (`due` — the exact
 * predicate `claimOutboxBatch` uses, via `claimableOutboxSql`). These are
 * the numbers a manual flush reports, so they must never disagree with
 * what the next flush would actually find.
 */
export async function outboxOpenCounts(connectionId: string): Promise<{ open: number; due: number }> {
  const { rows } = await query<{ open_count: number; due_count: number }>(
    `SELECT count(*) FILTER (WHERE status IN ('pending', 'failed', 'processing'))::int AS open_count,
            count(*) FILTER (WHERE ${claimableOutboxSql("$2")})::int AS due_count
       FROM integration_outbox_events
      WHERE connection_id = $1`,
    [connectionId, OUTBOX_LEASE_MS],
  );
  return { open: rows[0]?.open_count ?? 0, due: rows[0]?.due_count ?? 0 };
}

export interface DrainOutboxResult {
  /** Rows this call claimed and tried to apply. */
  attempted: number;
  sent: number;
  failed: number;
  dead: number;
  needsReview: number;
  /** Rows whose lease was lost mid-apply — another holder owns the outcome. */
  leaseLost: number;
  /** Open rows (pending/processing/failed) still on the queue afterwards. */
  remaining: number;
  /** True when another batch would find due work right now. */
  hasMore: boolean;
}

const EMPTY_DRAIN: DrainOutboxResult = {
  attempted: 0,
  sent: 0,
  failed: 0,
  dead: 0,
  needsReview: 0,
  leaseLost: 0,
  remaining: 0,
  hasMore: false,
};

/**
 * The last-pushed stock/price a *delivered* payload proves, in mapping
 * terms. The price is converted back from the payload that was actually
 * sent — never re-read from current local state, which may already hold a
 * newer value the store has not received (issue #942, F03). An unparsable
 * price records nothing: the next tick then requeues, which fails safe.
 */
export function lastPushedFromPayload(
  entityType: string,
  payload: unknown,
  currencyUnit: ConnectionRow["currency_unit"],
): Record<string, unknown> {
  const patch = (payload ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (entityType !== "stock" && entityType !== "price" && entityType !== "product_update") return out;
  if ("stock_quantity" in patch && typeof patch.stock_quantity === "number") {
    out.stock = patch.stock_quantity;
  }
  if ("regular_price" in patch && (typeof patch.regular_price === "string" || typeof patch.regular_price === "number")) {
    try {
      out.priceRial = wooAmountToRial(patch.regular_price, currencyUnit).toString();
    } catch {
      // Leave priceRial unrecorded — see above.
    }
  }
  return out;
}

export async function drainOutbox(connection: ConnectionRow): Promise<DrainOutboxResult> {
  if (connection.status !== "active") return { ...EMPTY_DRAIN };
  const businessId = connection.business_id;
  const client = wooClientFor(connection);
  const result: DrainOutboxResult = { ...EMPTY_DRAIN };

  const claimed = await claimOutboxBatch(connection.id);
  result.attempted = claimed.length;

  for (const event of claimed) {
    try {
      await applyOutboundEvent(connection, client, event);
      // Fenced on the lease generation: if our lease expired while the
      // store was answering and another worker re-claimed the row, this
      // matches nothing and the newer holder's outcome stands.
      const { rowCount } = await query(
        `UPDATE integration_outbox_events
            SET status = 'sent', sent_at = now(), last_error = NULL,
                leased_until = NULL, lease_token = NULL, updated_at = now()
          WHERE id = $1 AND status = 'processing' AND lease_token = $2`,
        [event.id, event.lease_token],
      );
      if ((rowCount ?? 0) === 0) {
        result.leaseLost += 1;
        continue;
      }
      result.sent += 1;
      // Preserve the other half so a stock push doesn't erase the last-pushed price (and vice versa).
      if (event.entity_type === "stock" || event.entity_type === "price" || event.entity_type === "product_update") {
        await acknowledgePushedEvent(connection, event);
      }
    } catch (err) {
      if (err instanceof NeedsReviewError) {
        const { rowCount } = await query(
          `UPDATE integration_outbox_events
              SET status = 'needs_review', last_error = $3,
                  leased_until = NULL, lease_token = NULL, updated_at = now()
            WHERE id = $1 AND status = 'processing' AND lease_token = $2`,
          [event.id, event.lease_token, err.message],
        );
        if ((rowCount ?? 0) === 0) {
          result.leaseLost += 1;
          continue;
        }
        result.needsReview += 1;
        await writeIntegrationAudit({
          businessId,
          connectionId: connection.id,
          action: "outbox.needs_review",
          entityType: event.entity_type,
          remoteId: event.remote_id,
          error: err.message,
        });
        continue;
      }
      const attempts = event.attempts + 1;
      if (isDeadAfterAttempts(attempts, OUTBOX_MAX_ATTEMPTS)) {
        const { rowCount } = await query(
          `UPDATE integration_outbox_events
              SET status = 'dead', attempts = $3, last_error = $4,
                  leased_until = NULL, lease_token = NULL, updated_at = now()
            WHERE id = $1 AND status = 'processing' AND lease_token = $2`,
          [event.id, event.lease_token, attempts, (err as Error).message],
        );
        if ((rowCount ?? 0) === 0) {
          result.leaseLost += 1;
          continue;
        }
        result.dead += 1;
        await writeIntegrationAudit({
          businessId,
          connectionId: connection.id,
          action: "outbox.dead_lettered",
          entityType: event.entity_type,
          remoteId: event.remote_id,
          error: (err as Error).message,
        });
      } else {
        const delay = backoffDelayMs(attempts);
        const { rowCount } = await query(
          `UPDATE integration_outbox_events
              SET status = 'failed', attempts = $3, last_error = $4,
                  next_attempt_at = now() + ($5 || ' milliseconds')::interval,
                  leased_until = NULL, lease_token = NULL, updated_at = now()
            WHERE id = $1 AND status = 'processing' AND lease_token = $2`,
          [event.id, event.lease_token, attempts, (err as Error).message, delay],
        );
        if ((rowCount ?? 0) === 0) {
          result.leaseLost += 1;
          continue;
        }
        result.failed += 1;
      }
    }
  }

  // What is still owed after this batch — the numbers a manual flush must
  // report instead of claiming the whole queue was sent (issue #942, F08).
  const counts = await outboxOpenCounts(connection.id);
  result.remaining = counts.open;
  result.hasMore = counts.due > 0;
  return result;
}

/**
 * Record, on the mapping, that a stock/price/product_update push was
 * DELIVERED — the acknowledged state the scheduled refresh diffs against.
 *
 * Both delivery paths land here: the REST drain above, and the plugin ack
 * (`pluginAckJobs`). The plugin path used to only mark the outbox row
 * `sent` and never move this memory, so the next refresh still computed
 * "changed since ack" and re-armed the sent row to pending — the plugin
 * then applied the same price/stock update on every sync tick, forever
 * (PR #1054; issue #942 F03). One helper, one memory, no drift between
 * modes.
 *
 * What is recorded comes from the delivered payload itself
 * (`lastPushedFromPayload`), merged into the mapping's memory so a stock
 * push doesn't erase the last-pushed price, a variation's
 * `remoteParentId`, or vice versa — and a value changed locally while the
 * push was in flight is not falsely recorded as delivered.
 */
export async function acknowledgePushedEvent(
  connection: ConnectionRow,
  event: { entity_type: string; remote_id: string; payload: unknown },
): Promise<void> {
  const pushed = lastPushedFromPayload(event.entity_type, event.payload, connection.currency_unit);
  if (Object.keys(pushed).length === 0) return;
  await mergeMappingMeta(connection.business_id, connection.id, "product", event.remote_id, pushed);
}

/** The background tick: enumerate connections, then scope each business's work. */
export async function runWooCommerceSyncTick(): Promise<void> {
  const { rows } = await withoutTenantScope("platform", () =>
    query<{ business_id: string; id: string }>(
      `SELECT id, business_id FROM integration_connections WHERE status = 'active' AND provider = 'woocommerce'`,
    ),
  );
  for (const { business_id, id } of rows) {
    // Issue #942 (F09): one broken store must not starve the rest. Each
    // business/connection runs behind its own guard; a failure is recorded
    // against that connection's audit trail and the tick moves on to the
    // next tenant instead of aborting the whole enumeration.
    try {
      await withTenant(business_id, async () => {
        try {
          await runWooCommerceSyncForConnection(business_id, id);
        } catch (err) {
          console.error("woo_sync_tick_connection_failed", {
            businessId: business_id,
            connectionId: id,
            error: (err as Error).message,
          });
          await writeIntegrationAudit({
            businessId: business_id,
            connectionId: id,
            action: "sync.tick_failed",
            error: (err as Error).message,
          });
        }
      });
    } catch (err) {
      console.error("woo_sync_tick_connection_failed", {
        businessId: business_id,
        connectionId: id,
        error: (err as Error).message,
      });
    }
  }
}

/** One connection's share of the tick — see runWooCommerceSyncTick. */
async function runWooCommerceSyncForConnection(business_id: string, id: string): Promise<void> {
  const connection = await getConnection(business_id, id);
  if (!connection || connection.status !== "active") return;
  // Provider dispatch (Phase 26): the WooCommerce tick owns only
  // WooCommerce connections. Holoo's push path is a separate tick
  // (Wave 8). The guard is belt-and-braces with the SQL filter above.
  if (!isWooCommerce(connection)) return;
  if (connection.push_stock || connection.push_prices) {
    await refreshOutboxForConnection(connection);
  }
  // Phase 38 — a scheduled order pull, in REST mode only. The plugin
  // pushes its own orders, so pulling there would be a second path to the
  // same rows; but a REST connection whose webhook was never configured
  // (or whose webhook has been failing for a week) has no other way for a
  // sale to reach this app at all. The inbox's delivery-id dedup makes
  // re-reading the same orders free.
  if (connection.link_mode === "rest_api" && connection.auto_pull_orders && connection.sync_orders) {
    try {
      const { syncOrders } = await import("./sync-service");
      await syncOrders(connection.business_id, connection.id, { maxPages: 10 });
    } catch (err) {
      await writeIntegrationAudit({
        businessId: connection.business_id,
        connectionId: connection.id,
        action: "orders.pull_failed",
        error: (err as Error).message,
      });
    }
  }
  // Filling the queue is the same in both link modes — it only reads local
  // stock and prices. Draining is not: in plugin mode the WordPress plugin
  // pulls these rows and applies them itself (there are no REST credentials
  // here to call the store with), so this side must leave them alone or it
  // would immediately dead-letter every job the plugin was about to take.
  if (connection.link_mode === "rest_api") {
    await drainOutbox(connection);
  }
}
