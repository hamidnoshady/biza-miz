/**
 * Transactional producer for site/cloud convergence.
 *
 * Call only with the PoolClient that owns the domain transaction. There is no
 * standalone-query overload on purpose: making it impossible to commit an
 * outbox row separately prevents the crash gap this module exists to close.
 */
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import type { Role } from "./auth";
import type { SyncEventType } from "./sync-event-registry";
import { deploymentRole } from "./deployment-role";

/** Postgres NOTIFY channel a site raises when it queues an event for the central server. */
export const SYNC_OUTBOX_CHANNEL = "sync_outbox";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** sync_events uses uuid keys; derive a stable UUID when the domain identity is textual. */
export function syncClientEventId(identity: string): string {
  if (UUID.test(identity)) return identity.toLowerCase();
  const hex = createHash("sha256").update(`eshobe-sync-event:${identity}`).digest("hex").slice(0, 32).split("");
  hex[12] = "5"; // name-derived UUID semantics
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8).join("")}-${hex.slice(8, 12).join("")}-${hex.slice(12, 16).join("")}-${hex.slice(16, 20).join("")}-${hex.slice(20).join("")}`;
}

export async function appendSyncOutboxEvent(
  client: PoolClient,
  input: {
    locationId: string;
    clientEventId: string;
    eventType: SyncEventType;
    payload: Record<string, unknown>;
    actorUserId: string | null;
    actorRole: Role;
    occurredAt?: string;
    schemaVersion?: number;
  },
): Promise<void> {
  // Who records, decided in the INSERT itself so it costs no extra round trip:
  //
  //  - never while applying a peer's event. applySyncEvent sets
  //    app.sync_replay on its transaction, and a handler calls the same domain
  //    services as a normal request; recording there would bounce the event
  //    straight back to where it came from, even if a caller forgot a flag.
  //  - always on a site (the desktop's own sales go up to the cloud).
  //  - on the central server only for a branch a desktop is paired to
  //    (migration 0190): a sale, purchase or journal the owner records in the
  //    cloud for that branch travels down to it. A cloud-only branch has no
  //    one to deliver to, so nothing is queued for it.
  // On a site the same statement also raises a NOTIFY, delivered when this
  // transaction commits: the desktop's sync runner (server.ts) wakes and
  // pushes within seconds instead of on its next 30-second tick.
  await client.query(
    `WITH queued AS (
       INSERT INTO sync_events
         (location_id,client_event_id,event_type,payload,occurred_at,applied_at,
          actor_user_id,actor_role,origin,schema_version)
       SELECT $1::uuid,$2::uuid,$3::text,$4::jsonb,$5::timestamptz,now(),$6::text,$7::text,'local',$8::integer
        WHERE coalesce(current_setting('app.sync_replay', true), '') <> 'on'
          AND ($9::boolean OR EXISTS (
                SELECT 1 FROM site_devices d
                 WHERE d.location_id = $1::uuid AND d.status = 'active' AND d.revoked_at IS NULL))
       ON CONFLICT (location_id,client_event_id) DO NOTHING
       RETURNING 1)
     SELECT pg_notify('${SYNC_OUTBOX_CHANNEL}', '') FROM queued WHERE $9::boolean`,
    [
      input.locationId,
      syncClientEventId(input.clientEventId),
      input.eventType,
      JSON.stringify(input.payload),
      input.occurredAt ?? new Date().toISOString(),
      input.actorUserId,
      input.actorRole,
      input.schemaVersion ?? 1,
      deploymentRole() === "site",
    ],
  );
}

/**
 * Record a business-wide event (#869): one that belongs to no location, such as a
 * commission payout, which covers every branch at once. It is written with
 * `scope = 'business'`, `business_id` set and `location_id` NULL. Nothing is
 * borrowed from a branch.
 *
 * Only the cloud records these. A site pushes only its own location's rows, so a
 * business-scope row written on a site would never leave it, and a payout made
 * there would be silently unrecorded. Refusing is the safe answer.
 *
 * Same contract as `appendSyncOutboxEvent`: pass the PoolClient of the domain
 * transaction, so the event commits or rolls back with the money it records. A
 * replay of a peer's event stands down. A repeat of the same identity is absorbed
 * by the business-scope unique index, so a retried or doubly delivered event lands
 * once.
 */
export async function appendBusinessSyncOutboxEvent(
  client: PoolClient,
  input: {
    businessId: string;
    clientEventId: string;
    eventType: SyncEventType;
    payload: Record<string, unknown>;
    actorUserId: string | null;
    actorRole: Role;
    occurredAt?: string;
    schemaVersion?: number;
  },
): Promise<void> {
  if (deploymentRole() === "site") throw new Error("business_sync_event_cloud_only");
  await client.query(
    `INSERT INTO sync_events
       (scope,business_id,location_id,client_event_id,event_type,payload,occurred_at,applied_at,
        actor_user_id,actor_role,origin,schema_version)
     SELECT 'business',$1::uuid,NULL,$2::uuid,$3::text,$4::jsonb,$5::timestamptz,now(),$6::text,$7::text,'local',$8::integer
      WHERE coalesce(current_setting('app.sync_replay', true), '') <> 'on'
     ON CONFLICT (business_id,client_event_id) WHERE scope = 'business' DO NOTHING`,
    [
      input.businessId,
      syncClientEventId(input.clientEventId),
      input.eventType,
      JSON.stringify(input.payload),
      input.occurredAt ?? new Date().toISOString(),
      input.actorUserId,
      input.actorRole,
      input.schemaVersion ?? 1,
    ],
  );
}
