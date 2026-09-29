/**
 * Server-side inbox for offline-queued client actions (Phase 5). DB-touching
 * (not unit-tested directly, per repo convention) — pure conflict logic
 * lives in offline-sync.ts, pure order-total math in orders.ts; this module
 * only orchestrates dispatch + the idempotency dance around sync_events
 * (migration 0001, `UNIQUE (location_id, client_event_id)`).
 *
 * A device queues actions locally (src/lib/offline-db.ts) while it can't
 * reach the server and flushes them here on reconnect via
 * POST /api/sync/events, one client_event_id per queued action. Replaying
 * the same client_event_id twice (e.g. the client retried a flush that
 * actually succeeded) is a no-op: the DO NOTHING branch below reports the
 * event's original outcome instead of re-applying it.
 */
import { createHash } from "node:crypto";
import { getPool, query, type PoolClient } from "./db";
import { broadcast } from "./realtime";
import type { Role } from "./auth";
import {
  effectivePermissions,
  parseOverrides,
  type Permission,
} from "./permissions";
import type { CartItemInput } from "./order-cart";
import { addItemsToOrder, createOrder } from "./order-mutations";
import type { DiscountInput } from "./orders";
import { classifyStatusReplay } from "./offline-sync";
import type { OrderItemStatus } from "./order-item-status";
import { recordCoworkerEvent } from "./ai-coworker-events";
import {
  applySyncDomainHandler,
  SyncPayloadError,
  syncErrorCode,
} from "./sync-domain-handlers";
import {
  syncEventDefinition,
  type SyncEventDefinition,
  type SyncEventType,
} from "./sync-event-registry";

export type { SyncEventType } from "./sync-event-registry";

export interface SyncEventInput {
  clientEventId: string;
  type: string;
  /** when the client actually took the action, ISO — used for audit only; replay order is server-arrival order. */
  occurredAt: string;
  payload: Record<string, unknown>;
}

export interface SyncEventResult {
  clientEventId: string;
  ok: boolean;
  /** this client_event_id was already processed before; `ok` reflects its original outcome */
  duplicate?: boolean;
  /** a legitimate two-device conflict (see offline-sync.ts), not an error the client should retry */
  conflict?: boolean;
  /** Prerequisite was absent; reconciliation may retry without partial effects. */
  deferred?: boolean;
  /** Terminal poison/unknown event was safely recorded for administration. */
  deadLettered?: boolean;
  error?: string;
  data?: unknown;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface OrderCreatePayload {
  orderId?: string;
  itemIds?: unknown[];
  type?: "dine_in" | "takeaway" | "delivery";
  tableId?: string;
  customerId?: string;
  guestCount?: number;
  note?: string;
  discount?: { type?: "percent" | "amount"; value?: number };
  items?: CartItemInput[];
  delivery?: {
    address?: string;
    phone?: string;
    fee?: number;
    courierId?: string;
    note?: string;
  };
}
interface OrderAddItemsPayload {
  orderId?: string;
  items?: CartItemInput[];
}
interface OrderItemStatusPayload {
  itemId?: string;
  status?: OrderItemStatus;
}

interface DispatchResult {
  data?: unknown;
  conflict?: boolean;
  error?: string;
}

const ORDER_MUTATION_ROLES: Role[] = ["owner", "manager", "cashier", "waiter"];

async function dispatch(
  locationId: string,
  actor: { userId: string; role: Role },
  event: SyncEventInput,
  origin: "local" | "remote" = "local",
): Promise<DispatchResult> {
  if (event.type === "order.create" || event.type === "order.add_items") {
    if (!ORDER_MUTATION_ROLES.includes(actor.role))
      return { error: "forbidden" };
  }

  if (event.type === "order.create") {
    const payload = event.payload as OrderCreatePayload;
    if (
      payload.type !== "dine_in" &&
      payload.type !== "takeaway" &&
      payload.type !== "delivery"
    ) {
      return { error: "invalid_order_type" };
    }
    const discountType =
      payload.discount?.type === "percent" ||
      payload.discount?.type === "amount"
        ? payload.discount.type
        : null;
    const discount: DiscountInput = discountType
      ? { type: discountType, value: Number(payload.discount?.value ?? 0) }
      : { type: null };
    const result = await createOrder({
      locationId,
      type: payload.type,
      tableId: payload.tableId ?? null,
      customerId: payload.customerId ?? null,
      guestCount: Number.isFinite(payload.guestCount)
        ? Number(payload.guestCount)
        : null,
      note: payload.note ?? null,
      discount,
      items: payload.items ?? [],
      openedBy: actor.userId,
      // Domain-level dedupe in `orders` is independent of the transport inbox.
      // If a future retry path reaches order creation without its original
      // sync_events outcome, it still converges on the same order.
      clientRequestId: event.clientEventId,
      orderId:
        typeof payload.orderId === "string"
          ? payload.orderId
          : event.clientEventId,
      // The sender's line ids (migration 0190); absent from an offline-queued
      // phone payload, which the order-state reconciliation then covers.
      itemIds: Array.isArray(payload.itemIds)
        ? payload.itemIds.map((id) => (typeof id === "string" && UUID_PATTERN.test(id) ? id : null))
        : undefined,
      // Only a peer *server's* replay carries the instant the order was
      // really opened. A phone's offline flush does not: there is no
      // "record a past sale" path, and a device clock must not be able to
      // place a new order into a day that has already been closed.
      openedAt: origin === "remote" && Number.isFinite(Date.parse(event.occurredAt)) ? event.occurredAt : null,
      actorRole: actor.role,
      recordSyncEvent: false,
      delivery:
        payload.type === "delivery" && payload.delivery
          ? {
              address: payload.delivery.address ?? "",
              phone: payload.delivery.phone ?? null,
              fee: payload.delivery.fee ?? 0,
              courierId: payload.delivery.courierId ?? null,
              note: payload.delivery.note ?? null,
            }
          : null,
    });
    if (!result.ok) return { error: result.error };
    broadcast(locationId, { type: "order.created", orderId: result.data.id });
    return { data: result.data };
  }

  if (event.type === "order.add_items") {
    const payload = event.payload as OrderAddItemsPayload;
    if (!payload.orderId) return { error: "bad_request" };
    const result = await addItemsToOrder({
      locationId,
      orderId: payload.orderId,
      items: payload.items ?? [],
    });
    if (!result.ok) return { error: result.error };
    broadcast(locationId, { type: "order.updated", orderId: payload.orderId });
    return { data: result.data };
  }

  if (event.type === "order_item.status") {
    const payload = event.payload as OrderItemStatusPayload;
    if (!payload.itemId || !payload.status) return { error: "bad_request" };

    const { rows } = await query<{
      id: string;
      status: OrderItemStatus;
      order_id: string;
    }>(
      `SELECT oi.id, oi.status, oi.order_id
         FROM order_items oi JOIN orders o ON o.id = oi.order_id
        WHERE oi.id = $1 AND oi.location_id = $2 AND o.status = 'open'`,
      [payload.itemId, locationId],
    );
    const item = rows[0];
    if (!item) return { error: "item_not_found" };

    const outcome = classifyStatusReplay(
      item.status,
      payload.status,
      actor.role,
    );
    if (outcome === "duplicate")
      return { data: { status: item.status, alreadyApplied: true } };
    if (outcome === "conflict") return { conflict: true, error: "conflict" };

    if (payload.status === "ready") {
      await query(
        "UPDATE order_items SET status = $2, ready_at = now() WHERE id = $1",
        [payload.itemId, payload.status],
      );
    } else {
      await query("UPDATE order_items SET status = $2 WHERE id = $1", [
        payload.itemId,
        payload.status,
      ]);
    }
    broadcast(locationId, {
      type: "order.item_status",
      orderId: item.order_id,
      itemId: payload.itemId,
      status: payload.status,
    });
    if (payload.status === "ready") {
      const { rows: readyOrders } = await query<{
        customer_id: string;
        business_id: string;
      }>(
        `SELECT o.customer_id, l.business_id FROM orders o JOIN locations l ON l.id = o.location_id
          WHERE o.id = $1 AND o.customer_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM order_items oi
                             WHERE oi.order_id = o.id AND oi.status NOT IN ('ready', 'served'))`,
        [item.order_id],
      );
      if (readyOrders[0])
        await recordCoworkerEvent({
          businessId: readyOrders[0].business_id,
          locationId,
          kind: "order_ready",
          payload: {
            customerId: readyOrders[0].customer_id,
            orderId: item.order_id,
          },
          dedupeKey: `order-ready:${item.order_id}`,
        });
    }
    return { data: { status: payload.status } };
  }

  return { error: "unknown_event_type" };
}

/**
 * Idempotently applies one queued client action, deduping on
 * (location_id, client_event_id). Call once per event, in the order the
 * client queued them — order matters for "add items to an order that was
 * itself just queued".
 */
async function applyLegacySyncEvent(
  locationId: string,
  actor: { userId: string; role: Role },
  event: SyncEventInput,
  /**
   * Where this event came from. 'local' (default) = a client on this server;
   * 'remote' = replayed from the peer server via server-sync pull. The origin
   * is stored so the push side (server-sync.ts) only forwards locally-born
   * events and never bounces a pulled event back to its source.
   */
  origin: "local" | "remote" = "local",
  metadata: { siteDeviceId?: string | null; schemaVersion?: number } = {},
): Promise<SyncEventResult> {
  const { rows: inserted } = await query<{ id: string }>(
    `INSERT INTO sync_events
       (location_id, client_event_id, event_type, payload, occurred_at,
        actor_user_id, actor_role, origin, site_device_id, schema_version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (location_id, client_event_id) DO NOTHING
     RETURNING id`,
    [
      locationId,
      event.clientEventId,
      event.type,
      JSON.stringify(event.payload),
      event.occurredAt,
      actor.userId,
      actor.role,
      origin,
      metadata.siteDeviceId ?? null,
      metadata.schemaVersion ?? 1,
    ],
  );

  if (inserted.length === 0) {
    const { rows: prior } = await query<{
      applied_at: string | null;
      error: string | null;
    }>(
      "SELECT applied_at, error FROM sync_events WHERE location_id = $1 AND client_event_id = $2",
      [locationId, event.clientEventId],
    );
    const row = prior[0];
    if (!row?.applied_at && !row?.error) {
      // Another worker is still applying this event, or a process stopped
      // between the domain mutation and the outcome marker. Never report that
      // ambiguous state as success: callers must retry/raise an operational
      // alert, while the unique inbox row still prevents a second effect.
      return {
        clientEventId: event.clientEventId,
        ok: false,
        duplicate: true,
        error: "event_outcome_pending",
      };
    }
    return {
      clientEventId: event.clientEventId,
      ok: !row.error,
      duplicate: true,
      error: row.error ?? undefined,
    };
  }

  try {
    const result = await dispatch(locationId, actor, event, origin);
    if (result.error) {
      await query("UPDATE sync_events SET error = $2 WHERE id = $1", [
        inserted[0].id,
        result.error,
      ]);
      return {
        clientEventId: event.clientEventId,
        ok: false,
        conflict: result.conflict,
        error: result.error,
      };
    }
    await query("UPDATE sync_events SET applied_at = now() WHERE id = $1", [
      inserted[0].id,
    ]);
    return { clientEventId: event.clientEventId, ok: true, data: result.data };
  } catch (err) {
    const code = (err as { code?: string })?.code ?? "apply_failed";
    await query("UPDATE sync_events SET error = $2 WHERE id = $1", [
      inserted[0].id,
      code,
    ]);
    return { clientEventId: event.clientEventId, ok: false, error: code };
  }
}

interface TransactionalSyncMetadata {
  siteDeviceId?: string | null;
  schemaVersion?: number;
  /** Preserve a manually replayed pull envelope in its original canonical row. */
  deadLetterSource?: "domain" | "server_pull";
  /** Deterministic integration-test failure point; never accepted from HTTP. */
  failureInjection?: "after_domain_effect";
}

function payloadDigest(payload: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

const TERMINAL_SYNC_DOMAIN_ERRORS = new Set([
  "already_reversed",
  "count_layer_settled",
  "count_not_reversible",
  "count_stock_consumed",
  "duplicate_item",
  "insufficient_transfer_layers",
  "insufficient_transfer_stock",
  "invalid_customer_return",
  "invalid_item",
  "invalid_quantity",
  "invalid_return_cost_basis",
  "invalid_supplier_return",
  "invalid_transfer",
  "invalid_transfer_status",
  "invalid_transition",
  "inventory_exact_cutover_required",
  "no_items",
  "periodic_system_unsupported",
  "purchase_total_mismatch",
  "received_transfer_requires_reverse_transfer",
  "refund_exceeds_payment",
  "stock_count_reversal_inconsistent",
  "supplier_required",
  "supplier_return_lot_not_found",
  "supplier_return_lot_required",
  "supplier_return_value_exceeds_carrying_value",
  "transfer_already_cancelled",
  "transfer_already_received",
  "transfer_already_shipped",
]);

export function classifySyncDomainError(
  error: unknown,
  definition: SyncEventDefinition,
): "deferred" | "terminal" | "transient" {
  const code = syncErrorCode(error);
  if (definition.dependencyErrors.includes(code)) return "deferred";
  if (
    error instanceof SyncPayloadError ||
    TERMINAL_SYNC_DOMAIN_ERRORS.has(code)
  )
    return "terminal";
  // SQLSTATEs, network codes, programming exceptions and every unrecognised
  // failure roll back the transaction and remain retryable. They must never be
  // converted into a durable poison/dead-letter outcome merely because an
  // infrastructure failure happened during application.
  return "transient";
}

async function eventScope(
  client: PoolClient,
  locationId: string,
  actor: { userId: string; role: Role },
  siteDeviceId: string | null,
): Promise<{
  businessId: string;
  error: string | null;
  permissions: Set<Permission>;
}> {
  const location = await client.query<{ business_id: string }>(
    "SELECT business_id FROM locations WHERE id=$1",
    [locationId],
  );
  const businessId = location.rows[0]?.business_id;
  if (!businessId)
    return {
      businessId: "",
      error: "unknown_location",
      permissions: new Set(),
    };

  if (siteDeviceId) {
    const device = await client.query(
      `SELECT 1 FROM site_devices
        WHERE id=$1 AND business_id=$2 AND location_id=$3
          AND status='active' AND revoked_at IS NULL`,
      [siteDeviceId, businessId, locationId],
    );
    if (device.rowCount !== 1)
      return {
        businessId,
        error: "site_identity_mismatch",
        permissions: new Set(),
      };
  }

  const user = await client.query<{ role: Role; permissions: unknown }>(
    `SELECT u.role::text AS role, u.permissions
       FROM users u
      WHERE u.id=$1::uuid AND u.business_id=$2 AND u.is_active
        AND u.membership_status = 'active'
        AND (u.role = 'owner' OR u.location_scope = 'all'
             OR (u.location_scope = 'home' AND u.location_id=$3)
             OR (u.location_scope = 'selected' AND EXISTS
                 (SELECT 1 FROM user_locations ul WHERE ul.user_id=u.id AND ul.location_id=$3)))`,
    [actor.userId, businessId, locationId],
  );
  const membership = user.rows[0];
  if (!membership || membership.role !== actor.role) {
    return {
      businessId,
      error: "actor_identity_mismatch",
      permissions: new Set(),
    };
  }
  return {
    businessId,
    error: null,
    permissions: effectivePermissions(
      membership.role,
      parseOverrides(membership.permissions),
    ),
  };
}

async function recordDeadLetter(
  client: PoolClient,
  params: {
    businessId: string;
    locationId: string;
    siteDeviceId: string | null;
    event: SyncEventInput;
    schemaVersion: number;
    error: string;
    syncEventId: string;
    source?: "domain" | "server_pull";
  },
): Promise<void> {
  await client.query(
    `UPDATE sync_events
        SET error=$2, dead_lettered_at=now(), attempt_count=attempt_count+1, last_attempt_at=now()
      WHERE id=$1`,
    [params.syncEventId, params.error],
  );
  await client.query(
    `INSERT INTO sync_domain_effects
       (business_id,location_id,site_device_id,client_event_id,event_type,schema_version,status,error_code)
     VALUES($1,$2,$3,$4,$5,$6,'dead_lettered',$7)
     ON CONFLICT (business_id,client_event_id) DO UPDATE
       SET status='dead_lettered',error_code=EXCLUDED.error_code,attempts=sync_domain_effects.attempts+1,updated_at=now()`,
    [
      params.businessId,
      params.locationId,
      params.siteDeviceId,
      params.event.clientEventId,
      params.event.type,
      params.schemaVersion,
      params.error,
    ],
  );
  await client.query(
    `INSERT INTO sync_event_dead_letters
       (business_id,location_id,site_device_id,client_event_id,event_type,schema_version,payload_sha256,error_code,source)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (business_id,client_event_id,event_type,schema_version,source) DO UPDATE
       SET error_code=EXCLUDED.error_code,status='open',last_seen_at=now(),
           retry_count=CASE WHEN EXCLUDED.source='server_pull' THEN sync_event_dead_letters.retry_count
                            ELSE sync_event_dead_letters.retry_count+1 END,
           resolved_at=NULL,resolved_by=NULL,resolution_note=NULL`,
    [
      params.businessId,
      params.locationId,
      params.siteDeviceId,
      params.event.clientEventId,
      params.event.type,
      params.schemaVersion,
      payloadDigest(params.event.payload),
      params.error,
      params.source ?? "domain",
    ],
  );
}

async function applyTransactionalSyncEvent(
  locationId: string,
  actor: { userId: string; role: Role },
  event: SyncEventInput,
  origin: "local" | "remote",
  metadata: TransactionalSyncMetadata,
): Promise<SyncEventResult> {
  const schemaVersion = metadata.schemaVersion ?? 1;
  const definition = syncEventDefinition(event.type, schemaVersion);
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // Everything this transaction does is a peer's (or a queued device's)
    // action being applied here, not a new one: the outbox and the
    // master-data capture trigger both stand down, so nothing echoes back.
    await client.query("SET LOCAL app.sync_replay = 'on'");
    const scope = await eventScope(
      client,
      locationId,
      actor,
      metadata.siteDeviceId ?? null,
    );
    if (!scope.businessId) {
      await client.query("ROLLBACK");
      return {
        clientEventId: event.clientEventId,
        ok: false,
        error: scope.error ?? "unknown_location",
      };
    }

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO sync_events
         (location_id,client_event_id,event_type,payload,occurred_at,actor_user_id,actor_role,
          origin,site_device_id,schema_version,attempt_count,last_attempt_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,now())
       ON CONFLICT (location_id,client_event_id) DO NOTHING RETURNING id`,
      [
        locationId,
        event.clientEventId,
        event.type,
        JSON.stringify(event.payload),
        event.occurredAt,
        actor.userId,
        actor.role,
        origin,
        metadata.siteDeviceId ?? null,
        schemaVersion,
      ],
    );
    let syncEventId = inserted.rows[0]?.id;
    if (!syncEventId) {
      const prior = await client.query<{
        id: string;
        event_type: string;
        schema_version: number;
        applied_at: string | null;
        error: string | null;
      }>(
        `SELECT id,event_type,schema_version,applied_at::text,error
           FROM sync_events WHERE location_id=$1 AND client_event_id=$2 FOR UPDATE`,
        [locationId, event.clientEventId],
      );
      const row = prior.rows[0];
      if (
        !row ||
        row.event_type !== event.type ||
        row.schema_version !== schemaVersion
      ) {
        await client.query("ROLLBACK");
        return {
          clientEventId: event.clientEventId,
          ok: false,
          duplicate: true,
          error: "event_identity_mismatch",
        };
      }
      syncEventId = row.id;
      const effect = await client.query<{
        status: string;
        result: unknown;
        error_code: string | null;
      }>(
        "SELECT status,result,error_code FROM sync_domain_effects WHERE business_id=$1 AND client_event_id=$2 FOR UPDATE",
        [scope.businessId, event.clientEventId],
      );
      if (effect.rows[0]?.status === "applied") {
        await client.query("COMMIT");
        return {
          clientEventId: event.clientEventId,
          ok: true,
          duplicate: true,
          data: effect.rows[0].result,
        };
      }
      if (effect.rows[0]?.status === "dead_lettered") {
        await client.query("COMMIT");
        return {
          clientEventId: event.clientEventId,
          ok: false,
          duplicate: true,
          deadLettered: true,
          error: effect.rows[0].error_code ?? "dead_lettered",
        };
      }
      await client.query(
        "UPDATE sync_events SET attempt_count=attempt_count+1,last_attempt_at=now(),deferred_until=NULL WHERE id=$1",
        [syncEventId],
      );
    }

    if (!definition || definition.legacy) {
      const error = definition
        ? "transactional_handler_mismatch"
        : "unknown_event_version";
      await recordDeadLetter(client, {
        businessId: scope.businessId,
        locationId,
        siteDeviceId: metadata.siteDeviceId ?? null,
        event,
        schemaVersion,
        error,
        syncEventId,
        source: metadata.deadLetterSource,
      });
      await client.query("COMMIT");
      return {
        clientEventId: event.clientEventId,
        ok: false,
        deadLettered: true,
        error,
      };
    }

    if (scope.error || !scope.permissions.has(definition.permission)) {
      const error = scope.error ?? "forbidden";
      await recordDeadLetter(client, {
        businessId: scope.businessId,
        locationId,
        siteDeviceId: metadata.siteDeviceId ?? null,
        event,
        schemaVersion,
        error,
        syncEventId,
        source: metadata.deadLetterSource,
      });
      await client.query("COMMIT");
      return {
        clientEventId: event.clientEventId,
        ok: false,
        deadLettered: true,
        error,
      };
    }

    await client.query(
      `INSERT INTO sync_domain_effects
         (business_id,location_id,site_device_id,client_event_id,event_type,schema_version,status,error_code)
       VALUES($1,$2,$3,$4,$5,$6,'deferred',NULL)
       ON CONFLICT (business_id,client_event_id) DO UPDATE
         SET attempts=sync_domain_effects.attempts+1,updated_at=now(),error_code=NULL`,
      [
        scope.businessId,
        locationId,
        metadata.siteDeviceId ?? null,
        event.clientEventId,
        event.type,
        schemaVersion,
      ],
    );

    await client.query("SAVEPOINT sync_domain_apply");
    try {
      const effect = await applySyncDomainHandler({
        client,
        businessId: scope.businessId,
        locationId,
        actor,
        clientEventId: event.clientEventId,
        payload: event.payload,
        definition,
        // A peer server's instant is trusted for dating; a device's is not
        // (see the legacy order.create note above).
        occurredAt: origin === "remote" ? event.occurredAt : undefined,
      });
      if (metadata.failureInjection === "after_domain_effect")
        throw new Error("injected_sync_failure_after_domain_effect");
      await client.query("RELEASE SAVEPOINT sync_domain_apply");
      await client.query(
        `UPDATE sync_domain_effects
            SET status='applied',effect_type=$3,effect_id=$4,result=$5,error_code=NULL,
                applied_at=now(),updated_at=now()
          WHERE business_id=$1 AND client_event_id=$2`,
        [
          scope.businessId,
          event.clientEventId,
          effect.effectType,
          effect.effectId,
          effect.result ? JSON.stringify(effect.result) : null,
        ],
      );
      await client.query(
        "UPDATE sync_events SET applied_at=now(),error=NULL,deferred_until=NULL WHERE id=$1",
        [syncEventId],
      );
      await client.query("COMMIT");
      return {
        clientEventId: event.clientEventId,
        ok: true,
        data: effect.result,
      };
    } catch (error) {
      await client.query("ROLLBACK TO SAVEPOINT sync_domain_apply");
      const code = syncErrorCode(error);
      const disposition = classifySyncDomainError(error, definition);
      if (disposition === "deferred") {
        await client.query(
          `UPDATE sync_domain_effects
              SET status='deferred',error_code=$3,updated_at=now()
            WHERE business_id=$1 AND client_event_id=$2`,
          [scope.businessId, event.clientEventId, code],
        );
        await client.query(
          "UPDATE sync_events SET error=NULL,deferred_until=now()+interval '30 seconds' WHERE id=$1",
          [syncEventId],
        );
        await client.query("COMMIT");
        return {
          clientEventId: event.clientEventId,
          ok: false,
          deferred: true,
          error: code,
        };
      }
      if (disposition === "terminal") {
        await recordDeadLetter(client, {
          businessId: scope.businessId,
          locationId,
          siteDeviceId: metadata.siteDeviceId ?? null,
          event,
          schemaVersion,
          error: code,
          syncEventId,
          source: metadata.deadLetterSource,
        });
        await client.query("COMMIT");
        return {
          clientEventId: event.clientEventId,
          ok: false,
          deadLettered: true,
          error: code,
        };
      }
      throw error;
    }
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    return {
      clientEventId: event.clientEventId,
      ok: false,
      error: syncErrorCode(error),
    };
  } finally {
    client.release();
  }
}

/**
 * Version-aware entry point. Legacy order queue events retain their established
 * conflict behaviour; every financial/inventory definition is atomically
 * applied with its inbox/effect record and cannot partially post.
 */
export async function applySyncEvent(
  locationId: string,
  actor: { userId: string; role: Role },
  event: SyncEventInput,
  origin: "local" | "remote" = "local",
  metadata: TransactionalSyncMetadata = {},
): Promise<SyncEventResult> {
  const definition = syncEventDefinition(
    event.type,
    metadata.schemaVersion ?? 1,
  );
  if (definition?.legacy) {
    return applyLegacySyncEvent(locationId, actor, event, origin, metadata);
  }
  return applyTransactionalSyncEvent(
    locationId,
    actor,
    event,
    origin,
    metadata,
  );
}

/** Retry dependency-deferred events after their prerequisite may have arrived. */
export async function reconcileDeferredSyncEvents(
  businessId: string,
  limit = 100,
): Promise<{
  attempted: number;
  applied: number;
  deferred: number;
  deadLettered: number;
  failed: number;
}> {
  const { rows } = await query<{
    location_id: string;
    client_event_id: string;
    event_type: string;
    payload: Record<string, unknown>;
    occurred_at: Date | string;
    actor_user_id: string;
    actor_role: Role;
    origin: "local" | "remote";
    site_device_id: string | null;
    schema_version: number;
  }>(
    `SELECT se.location_id,se.client_event_id,se.event_type,se.payload,se.occurred_at,
            se.actor_user_id,se.actor_role,se.origin,se.site_device_id,se.schema_version
       FROM sync_events se JOIN locations l ON l.id=se.location_id
       JOIN sync_domain_effects e ON e.business_id=l.business_id AND e.client_event_id=se.client_event_id
      WHERE l.business_id=$1 AND e.status='deferred' AND se.error IS NULL
        AND se.applied_at IS NULL AND (se.deferred_until IS NULL OR se.deferred_until<=now())
      ORDER BY se.id LIMIT $2`,
    [businessId, Math.min(Math.max(1, limit), 500)],
  );
  const summary = {
    attempted: rows.length,
    applied: 0,
    deferred: 0,
    deadLettered: 0,
    failed: 0,
  };
  for (const row of rows) {
    const result = await applySyncEvent(
      row.location_id,
      { userId: row.actor_user_id, role: row.actor_role },
      {
        clientEventId: row.client_event_id,
        type: row.event_type,
        occurredAt:
          row.occurred_at instanceof Date
            ? row.occurred_at.toISOString()
            : row.occurred_at,
        payload: row.payload,
      },
      row.origin,
      { siteDeviceId: row.site_device_id, schemaVersion: row.schema_version },
    );
    if (result.ok) summary.applied += 1;
    else if (result.deferred) summary.deferred += 1;
    else if (result.deadLettered) summary.deadLettered += 1;
    else summary.failed += 1;
  }
  return summary;
}
