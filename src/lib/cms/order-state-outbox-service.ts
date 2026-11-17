/**
 * ESH-148 (biza-miz#1306) — durable CMS order-state outbox & worker.
 *
 * Whenever a website-originated order moves in POS (approval accept/reject,
 * kitchen item transitions to preparing/ready/served, counter payment, void,
 * or verified refund), the state transition is written to
 * `cms_order_state_outbox` inside the *same* database transaction as the POS
 * mutation. A leased background worker (`runCmsOrderStateOutboxTick` in
 * `server.ts`) and manual sync controls in CMS Manager push those transitions
 * to `eshobe-cms` over `PATCH /api/orders/:id`.
 *
 * Security & operational guarantees:
 * - Multi-site safe: decrypts the API key scoped to each row's own
 *   `cms_connection_id` and checks `business_id` + `site_id` match before send.
 * - Concurrency safe: `FOR UPDATE SKIP LOCKED` + per-claim UUID `lease_token`
 *   with 5-minute lease TTL prevents duplicate/racing workers from double-
 *   sending or clobbering newer attempts.
 * - Monotonic & non-echoing: older undelivered states on the same axis are
 *   marked `superseded`; pre-send fencing drops delayed retries overtaken by a
 *   newer state; terminal cancellations/rejections are never resurrected.
 * - Redacted diagnostics: API keys and raw URLs never appear in `last_error`
 *   or `integration_audit_log`.
 */
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { query, withTenant, withoutTenantScope, withTenantTransaction } from "../db";
import { writeIntegrationAudit } from "../integrations/audit";
import {
  OUTBOX_MAX_ATTEMPTS,
  backoffDelayMs,
  isDeadAfterAttempts,
} from "../integrations/retry";
import { scrubUrls } from "../integrations/url-redact";
import type { OrderItemStatus } from "../order-item-status";
import { isAppServiceOperational } from "../service-activation/app-gate-service";
import { recordWebsiteError } from "../website/connection-service";
import { patchCmsOrderState, type CmsOrderStatePatch, type FetchLike } from "./client";
import { getCmsConfigForConnection } from "./connections";
import {
  axisForCmsOrderState,
  buildCmsOrderPatchBody,
  canEnqueueOrderStateTransition,
  classifyCmsOrderStateDeliveryError,
  deriveOrderFulfillmentState,
  isCmsOrderOutboxState,
  isOutboxRowSupersededByExisting,
  versionForCmsOrderState,
  type CmsOrderOutboxAxis,
  type CmsOrderOutboxState,
  type CmsOrderOutboxStatus,
  type ExistingOutboxStateEntry,
} from "./order-state-sync-policy";

export const CMS_ORDER_STATE_LEASE_MS = 5 * 60 * 1000;
const DEFAULT_BATCH_SIZE = 25;

export interface EnqueueOrderStateInput {
  businessId: string;
  locationId: string | null;
  cmsConnectionId: string;
  siteId?: string | null;
  cmsOrderId: string;
  posOrderId: string;
  state: CmsOrderOutboxState;
  reason?: string | null;
  occurredAt?: string | null;
}

export interface EnqueueOrderStateResult {
  enqueued: boolean;
  id?: string;
  reason?: string;
}

interface RawOutboxStateRow extends Record<string, unknown> {
  axis: CmsOrderOutboxAxis;
  state: CmsOrderOutboxState;
  state_version: number;
  status: CmsOrderOutboxStatus;
}

function toExistingEntry(row: RawOutboxStateRow): ExistingOutboxStateEntry {
  return {
    axis: row.axis,
    state: row.state,
    stateVersion: Number(row.state_version),
    status: row.status,
  };
}

/**
 * Append one monotonic order-state transition to `cms_order_state_outbox`
 * inside the caller's already-open transaction.
 *
 * Uses a transaction-scoped advisory lock per `(cmsConnectionId, cmsOrderId)`
 * so concurrent POS actions (e.g. rapid kitchen bumps or void vs bump) serialize
 * cleanly on version ordering and never emit a stale downgrade.
 */
export async function enqueueOrderStateInTx(
  client: PoolClient,
  input: EnqueueOrderStateInput,
): Promise<EnqueueOrderStateResult> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
    `cms-order-state:${input.cmsConnectionId}:${input.cmsOrderId}`,
  ]);

  let siteId = input.siteId ?? null;
  if (!siteId) {
    const { rows: connRows } = await client.query<{ site_id: string }>(
      `SELECT site_id FROM eshobe_cms_connections WHERE id = $1 AND business_id = $2 LIMIT 1`,
      [input.cmsConnectionId, input.businessId],
    );
    siteId = connRows[0]?.site_id ?? null;
  }
  if (!siteId) {
    return { enqueued: false, reason: "connection_missing" };
  }

  const { rows: existingRows } = await client.query<RawOutboxStateRow>(
    `SELECT axis, state, state_version, status
       FROM cms_order_state_outbox
      WHERE cms_connection_id = $1 AND cms_order_id = $2`,
    [input.cmsConnectionId, input.cmsOrderId],
  );

  const existing = existingRows.map(toExistingEntry);
  const verdict = canEnqueueOrderStateTransition(existing, input.state);
  if (!verdict.allowed) {
    return { enqueued: false, reason: verdict.reason };
  }

  const occurredAtIso = input.occurredAt ?? new Date().toISOString();
  const payload = buildCmsOrderPatchBody(input.state, occurredAtIso);

  // Any older undelivered event on this axis is obsolete once a higher state
  // on the same axis commits; superseding it prevents wasted HTTP calls and
  // avoids stale delayed retries.
  await client.query(
    `UPDATE cms_order_state_outbox
        SET status = 'superseded',
            last_error = 'superseded_by_newer_state',
            leased_until = NULL,
            lease_token = NULL,
            updated_at = now()
      WHERE business_id = $1
        AND cms_connection_id = $2
        AND cms_order_id = $3
        AND axis = $4
        AND state_version < $5
        AND status IN ('pending', 'failed', 'dead')`,
    [
      input.businessId,
      input.cmsConnectionId,
      input.cmsOrderId,
      verdict.axis,
      verdict.stateVersion,
    ],
  );

  // Cancelling the order also supersedes any undelivered non-rejected
  // fulfillment updates so a dead `preparing`/`ready` row is not surfaced or
  // sent after cancellation.
  if (input.state === "cancelled") {
    await client.query(
      `UPDATE cms_order_state_outbox
          SET status = 'superseded',
              last_error = 'superseded_by_cancellation',
              leased_until = NULL,
              lease_token = NULL,
              updated_at = now()
        WHERE business_id = $1
          AND cms_connection_id = $2
          AND cms_order_id = $3
          AND axis = 'fulfillment'
          AND state <> 'rejected'
          AND status IN ('pending', 'failed', 'dead')`,
      [input.businessId, input.cmsConnectionId, input.cmsOrderId],
    );
  }

  const { rows: inserted } = await client.query<{ id: string }>(
    `INSERT INTO cms_order_state_outbox (
       business_id, location_id, cms_connection_id, site_id,
       cms_order_id, pos_order_id, axis, state, state_version,
       reason, payload
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
     ON CONFLICT (cms_connection_id, cms_order_id, axis, state_version) DO NOTHING
     RETURNING id`,
    [
      input.businessId,
      input.locationId,
      input.cmsConnectionId,
      siteId,
      input.cmsOrderId,
      input.posOrderId,
      verdict.axis,
      input.state,
      verdict.stateVersion,
      input.reason ?? null,
      JSON.stringify(payload),
    ],
  );

  if (!inserted[0]) {
    return { enqueued: false, reason: "duplicate_version" };
  }
  return { enqueued: true, id: inserted[0].id };
}

/**
 * Re-evaluate and enqueue whole-order CMS fulfillment from an accepted
 * website order's current item kitchen states inside an open transaction.
 */
export async function syncOrderFulfillmentInTx(
  client: PoolClient,
  input: {
    businessId: string;
    locationId: string;
    orderId: string;
    occurredAt?: string | null;
  },
): Promise<EnqueueOrderStateResult> {
  const { rows: orderRows } = await client.query<{
    origin: string;
    cms_connection_id: string | null;
    cms_order_id: string | null;
    website_approval_state: "pending" | "accepted" | "rejected" | null;
    status: string;
  }>(
    `SELECT origin, cms_connection_id, cms_order_id, website_approval_state, status::text AS status
       FROM orders
      WHERE id = $1 AND location_id = $2
      LIMIT 1`,
    [input.orderId, input.locationId],
  );
  const order = orderRows[0];
  if (
    !order ||
    order.origin !== "website" ||
    !order.cms_connection_id ||
    !order.cms_order_id
  ) {
    return { enqueued: false, reason: "not_website_order" };
  }

  const { rows: itemRows } = await client.query<{ status: OrderItemStatus }>(
    `SELECT status::text AS status FROM order_items WHERE order_id = $1`,
    [input.orderId],
  );
  const nextFulfillment = deriveOrderFulfillmentState({
    approvalState: order.website_approval_state,
    orderStatus: order.status,
    itemStatuses: itemRows.map((row) => row.status),
  });
  if (!nextFulfillment) {
    return { enqueued: false, reason: "no_fulfillment_state" };
  }

  return enqueueOrderStateInTx(client, {
    businessId: input.businessId,
    locationId: input.locationId,
    cmsConnectionId: order.cms_connection_id,
    cmsOrderId: order.cms_order_id,
    posOrderId: input.orderId,
    state: nextFulfillment,
    occurredAt: input.occurredAt,
  });
}

/**
 * Enqueue a verified POS payment, cancellation, or full refund state for a
 * website-originated order inside the mutating transaction.
 */
export async function syncOrderPaymentStateInTx(
  client: PoolClient,
  input: {
    businessId: string;
    locationId: string;
    orderId: string;
    state: "paid" | "cancelled" | "refunded";
    reason?: string | null;
    occurredAt?: string | null;
  },
): Promise<EnqueueOrderStateResult> {
  const { rows: orderRows } = await client.query<{
    origin: string;
    cms_connection_id: string | null;
    cms_order_id: string | null;
  }>(
    `SELECT origin, cms_connection_id, cms_order_id
       FROM orders
      WHERE id = $1 AND location_id = $2
      LIMIT 1`,
    [input.orderId, input.locationId],
  );
  const order = orderRows[0];
  if (
    !order ||
    order.origin !== "website" ||
    !order.cms_connection_id ||
    !order.cms_order_id
  ) {
    return { enqueued: false, reason: "not_website_order" };
  }

  return enqueueOrderStateInTx(client, {
    businessId: input.businessId,
    locationId: input.locationId,
    cmsConnectionId: order.cms_connection_id,
    cmsOrderId: order.cms_order_id,
    posOrderId: input.orderId,
    state: input.state,
    reason: input.reason,
    occurredAt: input.occurredAt,
  });
}

export interface ClaimedOutboxRow extends Record<string, unknown> {
  id: string;
  business_id: string;
  location_id: string | null;
  cms_connection_id: string;
  site_id: string;
  cms_order_id: string;
  pos_order_id: string | null;
  axis: CmsOrderOutboxAxis;
  state: CmsOrderOutboxState;
  state_version: number;
  reason: string | null;
  payload: CmsOrderStatePatch;
  attempts: number;
  lease_token: string;
}

/**
 * Claim up to `limit` due or expired-lease rows for `businessId` using
 * `FOR UPDATE SKIP LOCKED` and a unique `lease_token`. Must run inside a
 * tenant-scoped context (`withTenant`).
 */
export async function claimDueCmsOrderStateOutboxBatch(
  businessId: string,
  opts: { connectionId?: string; limit?: number; leaseMs?: number } = {},
): Promise<ClaimedOutboxRow[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? DEFAULT_BATCH_SIZE, 100));
  const leaseMs = Math.max(1_000, opts.leaseMs ?? CMS_ORDER_STATE_LEASE_MS);
  const leaseToken = randomUUID();

  const { rows } = await query<ClaimedOutboxRow>(
    `WITH due AS (
       SELECT id
         FROM cms_order_state_outbox
        WHERE business_id = $1
          AND ($2::uuid IS NULL OR cms_connection_id = $2)
          AND (
            (status IN ('pending', 'failed') AND next_attempt_at <= now())
            OR (status = 'processing' AND (leased_until IS NULL OR leased_until < now()))
          )
        ORDER BY cms_order_id, CASE axis WHEN 'payment' THEN 1 ELSE 0 END, state_version ASC, next_attempt_at ASC, created_at ASC
        LIMIT $3
        FOR UPDATE SKIP LOCKED
     )
     UPDATE cms_order_state_outbox o
        SET status = 'processing',
            lease_token = $4::uuid,
            leased_until = now() + ($5::bigint * interval '1 millisecond'),
            updated_at = now()
       FROM due
      WHERE o.id = due.id
     RETURNING o.id, o.business_id, o.location_id, o.cms_connection_id, o.site_id,
               o.cms_order_id, o.pos_order_id, o.axis, o.state, o.state_version,
               o.reason, o.payload, o.attempts, o.lease_token`,
    [businessId, opts.connectionId ?? null, limit, leaseToken, leaseMs],
  );
  return rows;
}

export interface SyncCmsOrderStatesResult {
  processed: number;
  sent: number;
  failed: number;
  dead: number;
  superseded: number;
}

/**
 * Drain due `cms_order_state_outbox` events for one business.
 *
 * Rows for the same CMS order execute sequentially inside one drain pass and
 * guard against stale deliveries both before sending and via lease-token
 * verification on state finalization.
 */
export async function syncCmsOrderStatesForBusiness(
  businessId: string,
  opts: {
    connectionId?: string;
    limit?: number;
    leaseMs?: number;
    fetchImpl?: FetchLike;
    maxAttempts?: number;
  } = {},
): Promise<SyncCmsOrderStatesResult> {
  const claimed = await claimDueCmsOrderStateOutboxBatch(businessId, opts);
  const result: SyncCmsOrderStatesResult = {
    processed: 0,
    sent: 0,
    failed: 0,
    dead: 0,
    superseded: 0,
  };
  if (claimed.length === 0) return result;

  const maxAttempts = opts.maxAttempts ?? OUTBOX_MAX_ATTEMPTS;

  for (const row of claimed) {
    result.processed += 1;

    const preCheck = await checkOutboxRowStillCurrent(businessId, row);
    if (preCheck.superseded) {
      const changed = await markOutboxRowSuperseded(
        businessId,
        row.id,
        row.lease_token,
        preCheck.reason ?? "superseded_by_newer_state",
      );
      if (changed) result.superseded += 1;
      continue;
    }

    let config;
    try {
      config = await getCmsConfigForConnection(businessId, row.cms_connection_id);
      const { rows: siteCheck } = await query<{ site_id: string }>(
        `SELECT site_id FROM eshobe_cms_connections WHERE id = $1 AND business_id = $2 AND status = 'active' LIMIT 1`,
        [row.cms_connection_id, businessId],
      );
      if (!siteCheck[0] || siteCheck[0].site_id !== row.site_id) {
        throw new Error("site_connection_mismatch");
      }
    } catch (err) {
      const classified = classifyCmsOrderStateDeliveryError(err);
      await recordOutboxFailure(businessId, row, classified, maxAttempts, result);
      continue;
    }

    try {
      const patch = buildNormalizedPatch(row);
      await patchCmsOrderState(config, row.cms_order_id, patch, {
        fetchImpl: opts.fetchImpl,
      });

      const finalized = await markOutboxRowSent(businessId, row.id, row.lease_token);
      if (finalized) {
        result.sent += 1;
        await query(
          `UPDATE eshobe_cms_connections
              SET last_checked_at = now(), last_error = NULL, updated_at = now()
            WHERE id = $1 AND business_id = $2 AND last_error IS NOT NULL`,
          [row.cms_connection_id, businessId],
        );
      }
    } catch (err) {
      const classified = classifyCmsOrderStateDeliveryError(err);
      await recordOutboxFailure(businessId, row, classified, maxAttempts, result);
    }
  }

  return result;
}

function buildNormalizedPatch(row: ClaimedOutboxRow): CmsOrderStatePatch {
  if (row.axis === "fulfillment") {
    return {
      cafe: {
        fulfillment: row.payload?.cafe?.fulfillment ??
          (row.state as NonNullable<CmsOrderStatePatch["cafe"]>["fulfillment"]),
        fulfillmentAt: row.payload?.cafe?.fulfillmentAt ?? new Date().toISOString(),
      },
    };
  }
  return {
    status: row.payload?.status ?? (row.state as CmsOrderStatePatch["status"]),
  };
}

async function checkOutboxRowStillCurrent(
  businessId: string,
  row: ClaimedOutboxRow,
): Promise<{ superseded: boolean; reason?: string }> {
  return withTenantTransaction(businessId, async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
      `cms-order-state:${row.cms_connection_id}:${row.cms_order_id}`,
    ]);
    const { rows: siblingRows } = await client.query<RawOutboxStateRow>(
      `SELECT axis, state, state_version, status
         FROM cms_order_state_outbox
        WHERE business_id = $1
          AND cms_connection_id = $2
          AND cms_order_id = $3
          AND id <> $4`,
      [businessId, row.cms_connection_id, row.cms_order_id, row.id],
    );
    const superseded = isOutboxRowSupersededByExisting(
      {
        axis: row.axis,
        state: row.state,
        stateVersion: Number(row.state_version),
        status: "processing",
      },
      siblingRows.map(toExistingEntry),
    );
    return superseded
      ? { superseded: true, reason: "superseded_by_newer_state" }
      : { superseded: false };
  });
}

async function markOutboxRowSuperseded(
  businessId: string,
  id: string,
  leaseToken: string,
  reason: string,
): Promise<boolean> {
  const { rowCount } = await query(
    `UPDATE cms_order_state_outbox
        SET status = 'superseded',
            last_error = $4,
            lease_token = NULL,
            leased_until = NULL,
            updated_at = now()
      WHERE id = $1
        AND business_id = $2
        AND status = 'processing'
        AND lease_token = $3::uuid`,
    [id, businessId, leaseToken, reason],
  );
  return (rowCount ?? 0) > 0;
}

async function markOutboxRowSent(
  businessId: string,
  id: string,
  leaseToken: string,
): Promise<boolean> {
  const { rowCount } = await query(
    `UPDATE cms_order_state_outbox
        SET status = 'sent',
            delivered_at = now(),
            lease_token = NULL,
            leased_until = NULL,
            last_error = NULL,
            updated_at = now()
      WHERE id = $1
        AND business_id = $2
        AND status = 'processing'
        AND lease_token = $3::uuid`,
    [id, businessId, leaseToken],
  );
  return (rowCount ?? 0) > 0;
}

async function recordOutboxFailure(
  businessId: string,
  row: ClaimedOutboxRow,
  classified: { retryable: boolean; code: string; authFailure: boolean },
  maxAttempts: number,
  result: SyncCmsOrderStatesResult,
): Promise<void> {
  const nextAttempts = Number(row.attempts) + 1;
  const dead = !classified.retryable || isDeadAfterAttempts(nextAttempts, maxAttempts);
  const nextStatus: CmsOrderOutboxStatus = dead ? "dead" : "failed";
  const delayMs = backoffDelayMs(Math.max(0, nextAttempts - 1));
  const safeError = scrubUrls(classified.code).slice(0, 240);

  const { rowCount } = await query(
    `UPDATE cms_order_state_outbox
        SET status = $4,
            attempts = $5,
            next_attempt_at = CASE WHEN $4 = 'dead' THEN next_attempt_at ELSE now() + ($6::bigint * interval '1 millisecond') END,
            lease_token = NULL,
            leased_until = NULL,
            last_error = $7,
            updated_at = now()
      WHERE id = $1
        AND business_id = $2
        AND status = 'processing'
        AND lease_token = $3::uuid`,
    [
      row.id,
      businessId,
      row.lease_token,
      nextStatus,
      nextAttempts,
      delayMs,
      safeError,
    ],
  );

  if ((rowCount ?? 0) === 0) return;

  if (dead) {
    result.dead += 1;
    await writeIntegrationAudit({
      businessId,
      action: "cms.order_state.dead_lettered",
      entityType: "cms_order_state",
      remoteId: row.cms_order_id,
      localId: row.pos_order_id,
      payload: {
        connectionId: row.cms_connection_id,
        siteId: row.site_id,
        axis: row.axis,
        state: row.state,
        stateVersion: row.state_version,
        attempts: nextAttempts,
      },
      error: safeError,
    });
  } else {
    result.failed += 1;
  }

  if (classified.authFailure) {
    await recordWebsiteError(businessId, safeError, row.cms_connection_id).catch(
      () => {},
    );
  }
}

export interface CmsOrderStateTickSummary {
  businesses: number;
  sent: number;
  failed: number;
  dead: number;
  superseded: number;
}

/**
 * Background tick invoked from `server.ts` on the central VPS. Scans only
 * businesses with due or expired-lease rows and drains each inside `withTenant`.
 */
export async function runCmsOrderStateOutboxTick(opts: {
  fetchImpl?: FetchLike;
} = {}): Promise<CmsOrderStateTickSummary> {
  const businessIds = await withoutTenantScope(
    "cms-order-state-outbox-scan",
    async () => {
      const { rows } = await query<{ business_id: string }>(
        `SELECT DISTINCT o.business_id
           FROM cms_order_state_outbox o
           JOIN eshobe_cms_connections c
             ON c.id = o.cms_connection_id AND c.business_id = o.business_id
          WHERE c.status = 'active'
            AND (
              (o.status IN ('pending', 'failed') AND o.next_attempt_at <= now())
              OR (o.status = 'processing' AND (o.leased_until IS NULL OR o.leased_until < now()))
            )
          ORDER BY o.business_id`,
      );
      return rows.map((row) => row.business_id);
    },
  );

  const summary: CmsOrderStateTickSummary = {
    businesses: 0,
    sent: 0,
    failed: 0,
    dead: 0,
    superseded: 0,
  };

  for (const businessId of businessIds) {
    const operational = await isAppServiceOperational(businessId, "website");
    if (!operational) continue;
    summary.businesses += 1;
    const drained = await withTenant(businessId, () =>
      syncCmsOrderStatesForBusiness(businessId, { fetchImpl: opts.fetchImpl }),
    );
    summary.sent += drained.sent;
    summary.failed += drained.failed;
    summary.dead += drained.dead;
    summary.superseded += drained.superseded;
  }

  return summary;
}

/* ------------------------------------------------------------------ */
/* Queue inspection & reconciliation / manual retry surface            */
/* ------------------------------------------------------------------ */

export type CmsOrderStateQueueFilter = "open" | "dead" | "sent" | "all";

export interface CmsOrderStateQueueRow {
  id: string;
  cmsConnectionId: string;
  siteId: string;
  siteDomain: string | null;
  cmsOrderId: string;
  posOrderId: string | null;
  orderNumber: string | null;
  axis: CmsOrderOutboxAxis;
  state: CmsOrderOutboxState;
  stateVersion: number;
  status: CmsOrderOutboxStatus;
  attempts: number;
  nextAttemptAt: string;
  deliveredAt: string | null;
  lastError: string | null;
  reason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CmsOrderStateQueueSummary {
  pending: number;
  processing: number;
  failed: number;
  dead: number;
  sent: number;
  superseded: number;
  maxAttempts: number;
  lastSentAt: string | null;
  lastError: string | null;
}

export async function listCmsOrderStateOutbox(
  businessId: string,
  filter: CmsOrderStateQueueFilter = "open",
  limit = 100,
  connectionId?: string,
): Promise<CmsOrderStateQueueRow[]> {
  const safeLimit = Math.max(1, Math.min(limit, 200));
  const statusClause =
    filter === "open"
      ? "o.status IN ('pending', 'processing', 'failed', 'dead')"
      : filter === "dead"
        ? "o.status = 'dead'"
        : filter === "sent"
          ? "o.status = 'sent'"
          : "TRUE";

  const { rows } = await query<{
    id: string;
    cms_connection_id: string;
    site_id: string;
    site_domain: string | null;
    cms_order_id: string;
    pos_order_id: string | null;
    order_number: string | null;
    axis: CmsOrderOutboxAxis;
    state: CmsOrderOutboxState;
    state_version: number;
    status: CmsOrderOutboxStatus;
    attempts: number;
    next_attempt_at: string;
    delivered_at: string | null;
    last_error: string | null;
    reason: string | null;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT o.id,
            o.cms_connection_id,
            o.site_id,
            c.site_domain,
            o.cms_order_id,
            o.pos_order_id,
            ord.order_number::text AS order_number,
            o.axis,
            o.state,
            o.state_version,
            o.status,
            o.attempts,
            o.next_attempt_at,
            o.delivered_at,
            o.last_error,
            o.reason,
            o.created_at,
            o.updated_at
       FROM cms_order_state_outbox o
       LEFT JOIN eshobe_cms_connections c ON c.id = o.cms_connection_id
       LEFT JOIN orders ord ON ord.id = o.pos_order_id
      WHERE o.business_id = $1
        AND ($2::uuid IS NULL OR o.cms_connection_id = $2)
        AND ${statusClause}
      ORDER BY (o.status = 'dead') DESC, o.updated_at DESC, o.created_at DESC
      LIMIT $3`,
    [businessId, connectionId ?? null, safeLimit],
  );

  return rows.map((row) => ({
    id: row.id,
    cmsConnectionId: row.cms_connection_id,
    siteId: row.site_id,
    siteDomain: row.site_domain,
    cmsOrderId: row.cms_order_id,
    posOrderId: row.pos_order_id,
    orderNumber: row.order_number,
    axis: row.axis,
    state: isCmsOrderOutboxState(row.state) ? row.state : "accepted",
    stateVersion: Number(row.state_version),
    status: row.status,
    attempts: Number(row.attempts),
    nextAttemptAt: row.next_attempt_at,
    deliveredAt: row.delivered_at,
    lastError: row.last_error,
    reason: row.reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export async function summarizeCmsOrderStateOutbox(
  businessId: string,
  connectionId?: string,
): Promise<CmsOrderStateQueueSummary> {
  const { rows } = await query<{
    pending: string;
    processing: string;
    failed: string;
    dead: string;
    sent: string;
    superseded: string;
    last_sent_at: string | null;
    last_error: string | null;
  }>(
    `SELECT
       count(*) FILTER (WHERE status = 'pending')::text AS pending,
       count(*) FILTER (WHERE status = 'processing')::text AS processing,
       count(*) FILTER (WHERE status = 'failed')::text AS failed,
       count(*) FILTER (WHERE status = 'dead')::text AS dead,
       count(*) FILTER (WHERE status = 'sent')::text AS sent,
       count(*) FILTER (WHERE status = 'superseded')::text AS superseded,
       max(delivered_at) FILTER (WHERE status = 'sent')::text AS last_sent_at,
       (SELECT o2.last_error
          FROM cms_order_state_outbox o2
         WHERE o2.business_id = $1
           AND ($2::uuid IS NULL OR o2.cms_connection_id = $2)
           AND o2.status IN ('failed', 'dead')
           AND o2.last_error IS NOT NULL
         ORDER BY o2.updated_at DESC
         LIMIT 1) AS last_error
       FROM cms_order_state_outbox
      WHERE business_id = $1
        AND ($2::uuid IS NULL OR cms_connection_id = $2)`,
    [businessId, connectionId ?? null],
  );
  const row = rows[0];
  return {
    pending: Number(row?.pending ?? 0),
    processing: Number(row?.processing ?? 0),
    failed: Number(row?.failed ?? 0),
    dead: Number(row?.dead ?? 0),
    sent: Number(row?.sent ?? 0),
    superseded: Number(row?.superseded ?? 0),
    maxAttempts: OUTBOX_MAX_ATTEMPTS,
    lastSentAt: row?.last_sent_at ?? null,
    lastError: row?.last_error ?? null,
  };
}

/** Re-queue one failed or dead-lettered order-state outbox row for immediate delivery. */
export async function retryCmsOrderStateOutboxRow(
  businessId: string,
  outboxId: string,
): Promise<boolean> {
  const { rows } = await query<{
    id: string;
    cms_connection_id: string;
    site_id: string;
    cms_order_id: string;
    pos_order_id: string | null;
    axis: CmsOrderOutboxAxis;
    state: CmsOrderOutboxState;
    state_version: number;
  }>(
    `UPDATE cms_order_state_outbox
        SET status = 'pending',
            attempts = 0,
            next_attempt_at = now(),
            lease_token = NULL,
            leased_until = NULL,
            last_error = NULL,
            updated_at = now()
      WHERE id = $1
        AND business_id = $2
        AND status IN ('failed', 'dead')
      RETURNING id, cms_connection_id, site_id, cms_order_id, pos_order_id, axis, state, state_version`,
    [outboxId, businessId],
  );
  if (!rows[0]) return false;

  await writeIntegrationAudit({
    businessId,
    action: "cms.order_state.retried",
    entityType: "cms_order_state",
    remoteId: rows[0].cms_order_id,
    localId: rows[0].pos_order_id,
    payload: {
      connectionId: rows[0].cms_connection_id,
      siteId: rows[0].site_id,
      axis: rows[0].axis,
      state: rows[0].state,
      stateVersion: rows[0].state_version,
    },
  });
  return true;
}

/** Re-queue every failed or dead-lettered order-state row for this business. */
export async function retryAllCmsOrderStateFailures(
  businessId: string,
  connectionId?: string,
): Promise<number> {
  const { rowCount } = await query(
    `UPDATE cms_order_state_outbox
        SET status = 'pending',
            attempts = 0,
            next_attempt_at = now(),
            lease_token = NULL,
            leased_until = NULL,
            last_error = NULL,
            updated_at = now()
      WHERE business_id = $1
        AND ($2::uuid IS NULL OR cms_connection_id = $2)
        AND status IN ('failed', 'dead')`,
    [businessId, connectionId ?? null],
  );
  const count = rowCount ?? 0;
  if (count > 0) {
    await writeIntegrationAudit({
      businessId,
      action: "cms.order_state.retried_all",
      entityType: "cms_order_state",
      payload: { connectionId: connectionId ?? null, count },
    });
  }
  return count;
}

export { versionForCmsOrderState, axisForCmsOrderState };
