import { NextRequest, NextResponse } from "next/server";
import { query, withTenant, withoutTenantScope } from "@/lib/db";
import { recordLegacyTokenUsage, resolveSyncCredential, tokensMatch, legacySyncToken, recordSyncRun } from "@/lib/server-sync";

/**
 * Server-to-server pull endpoint (Phase 11).
 * The local (café laptop) server GETs events from here that it hasn't seen yet.
 * Returns sync_events rows with origin='local' (never bounces remote-origin events back).
 *
 * Phase 17 security review: the query below used to run with no tenant scope
 * and no business filter at all — under enforced RLS that failed closed (an
 * empty result, so nothing leaked), but under a superuser/BYPASSRLS database
 * role (this project's own stock docker-compose default) it would have
 * returned every business's events to anyone holding the one shared
 * REMOTE_SYNC_TOKEN. Resolving the caller's business explicitly (per-business
 * token first, legacy env-var + an explicit ?businessId second) and wrapping
 * the read in withTenant() closes that regardless of which role the DB
 * connection happens to be.
 */
type SyncEventRow = {
  /** bigint identity — node-postgres hands it over as a string. */
  id: string | number;
  /** xid8 of the writing transaction, as text (migration 0190). */
  txid: string;
  location_id: string;
  client_event_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  occurred_at: Date;
  actor_user_id: string | null;
  actor_role: string | null;
  site_device_id: string | null;
  schema_version: number;
};

export async function GET(request: NextRequest) {
  const auth = request.headers.get("authorization");
  const bearer = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  if (!bearer) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);

  const credential = await resolveSyncCredential(bearer);
  let businessId = credential?.businessId ?? null;
  let usedLegacyToken = false;
  if (!businessId) {
    const legacy = legacySyncToken();
    if (!legacy || !tokensMatch(bearer, legacy)) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    usedLegacyToken = true;
    // Legacy mode has no per-business token to resolve identity from, so the
    // caller must say which business it's pulling for; a per-business token
    // (the non-legacy path above) doesn't need this.
    const requested = searchParams.get("businessId");
    if (!requested) return NextResponse.json({ error: "business_id_required" }, { status: 400 });
    const known = await withoutTenantScope("server-sync-auth", () =>
      query(`SELECT 1 FROM businesses WHERE id = $1`, [requested]),
    );
    if (known.rows.length === 0) return NextResponse.json({ error: "unknown_business" }, { status: 422 });
    businessId = requested;

    const { rows: tokenRows } = await withoutTenantScope("server-sync-auth", () =>
      query(`SELECT 1 FROM server_sync_tokens WHERE business_id = $1`, [businessId])
    );
    if (tokenRows.length > 0) {
      return NextResponse.json({ error: "legacy_token_superseded" }, { status: 403 });
    }
  }

  const after = Number(searchParams.get("after") ?? "0");
  const limit = Math.min(Number(searchParams.get("limit") ?? "100"), 200);
  // Migration 0190: a site that sends afterTx reads in (txid, id) order and
  // only rows whose transaction has finished (below the snapshot's xmin), so a
  // row that commits after a higher id was handed out can never be skipped.
  const afterTxRaw = searchParams.get("afterTx");
  const afterTx = afterTxRaw !== null && /^[0-9]{1,20}$/.test(afterTxRaw) ? afterTxRaw : null;
  // Long-poll: with nothing to return, hold the request up to `wait` seconds
  // and answer as soon as something commits, so a desktop hears about a cloud
  // edit in about a second instead of on its next 30-second tick.
  const waitSeconds = Math.min(Math.max(Number(searchParams.get("wait") ?? "0") || 0, 0), 25);

  if (!Number.isFinite(after) || !Number.isFinite(limit) || (afterTxRaw !== null && afterTx === null)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const readPage = () =>
    withTenant(businessId, async () => {
      const result = afterTx
        ? await query<SyncEventRow>(
            `SELECT se.id, se.txid::text AS txid, se.location_id, se.client_event_id, se.event_type,
                    se.payload, se.occurred_at, se.actor_user_id, se.actor_role,
                    se.site_device_id, se.schema_version
               FROM sync_events se
              WHERE (se.txid, se.id) > ($4::xid8, $1::bigint)
                AND se.txid < pg_snapshot_xmin(pg_current_snapshot())
                AND se.applied_at IS NOT NULL
                AND se.error IS NULL
                AND se.origin = 'local'
                AND ($3::uuid IS NULL OR se.location_id = $3::uuid)
              ORDER BY se.txid, se.id
              LIMIT $2`,
            [after, limit, credential?.locationId ?? null, afterTx],
          )
        : await query<SyncEventRow>(
            `SELECT se.id, se.txid::text AS txid, se.location_id, se.client_event_id, se.event_type,
                    se.payload, se.occurred_at, se.actor_user_id, se.actor_role,
                    se.site_device_id, se.schema_version
               FROM sync_events se
              WHERE se.id > $1
                AND se.applied_at IS NOT NULL
                AND se.error IS NULL
                AND (se.origin IS NULL OR se.origin = 'local')
                AND ($3::uuid IS NULL OR se.location_id = $3::uuid)
              ORDER BY se.id
              LIMIT $2`,
            [after, limit, credential?.locationId ?? null],
          );
      return result.rows;
    });

  if (usedLegacyToken) await withTenant(businessId, () => recordLegacyTokenUsage(businessId!));
  let rows = await readPage();
  const deadline = Date.now() + waitSeconds * 1000;
  while (rows.length === 0 && Date.now() < deadline && !request.signal.aborted) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    rows = await readPage();
  }
  // The desktop's wake-up watcher only asks whether anything is waiting; the
  // events themselves are fetched by the full sync tick, which settles
  // permissions (IAM) first.
  if (searchParams.get("peek") === "1") {
    return NextResponse.json({ pending: rows.length > 0 });
  }

  // `id` is the site's pull cursor and it validates it with
  // Number.isSafeInteger. node-postgres returns bigint as a string, and sending
  // that string through made the site reject every event it was offered as
  // `remote_protocol_invalid_event_id` — cloud → site sync never advanced.
  const events = rows.map((r) => ({
    id: Number(r.id),
    txid: r.txid,
    locationId: r.location_id,
    clientEventId: r.client_event_id,
    type: r.event_type,
    payload: r.payload,
    occurredAt: r.occurred_at instanceof Date ? r.occurred_at.toISOString() : r.occurred_at,
    actorUserId: r.actor_user_id ?? "",
    actorRole: r.actor_role ?? "cashier",
    businessId,
    siteDeviceId: r.site_device_id,
    schemaVersion: r.schema_version,
    origin: "cloud",
  }));

  // An empty (often long-polled) read is the idle state and is not recorded.
  if (credential?.siteDeviceId && events.length > 0) {
    await withTenant(businessId, () => recordSyncRun({
      businessId,
      siteDeviceId: credential.siteDeviceId,
      locationId: credential.locationId,
      direction: "pull",
      status: "ok",
      startCursor: after,
      endCursor: events.at(-1)?.id ?? after,
      eventsAttempted: events.length,
      eventsApplied: events.length,
    }));
  }
  return NextResponse.json({ events });
}
