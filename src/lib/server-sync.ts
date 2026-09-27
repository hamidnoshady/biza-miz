/**
 * Bidirectional server-to-server sync (Phase 11).
 *
 * Architecture:
 *   LOCAL server (café laptop) ←→ REMOTE server (VPS / pos.eshobe.com)
 *
 * Push: local sends its unsynced sync_events rows to the remote's
 *   POST /api/server-sync/push endpoint, which replays them via the
 *   existing applySyncEvent() engine — same idempotency guarantees as
 *   the client offline-queue flush.
 *
 * Pull: local calls GET /api/server-sync/pull?after=<last_pulled_id>
 *   on the remote, receives events the remote accepted from *other*
 *   sources (e.g. owner making a menu change remotely), and replays
 *   them locally.
 *
 * Conflict resolution: identical to the client queue — the
 *   UNIQUE(location_id, client_event_id) constraint on sync_events
 *   deduplicates replays; classifyStatusReplay() handles status
 *   machine conflicts. No extra logic needed.
 *
 * Config is stored in the settings table under SETTING_KEYS.serverSyncConfig.
 * State (high-water marks) is stored under SETTING_KEYS.serverSyncState.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { getPool, query, withTenant, withoutTenantScope } from "./db";
import { getSetting, setSetting, SETTING_KEYS } from "./settings";
import { applySyncEvent, reconcileDeferredSyncEvents, type SyncEventInput, type SyncEventType } from "./sync-events";
import type { ServerSyncConfig } from "./server-sync-config";
import { refreshAppUpdateStatus } from "./app-update";

export type { ServerSyncConfig } from "./server-sync-config";

// ---------------------------------------------------------------------------
// Config & state types
// ---------------------------------------------------------------------------

export interface ServerSyncState {
  /** sync_events.id of the last row we successfully pushed to remote */
  lastPushedEventId: number | null;
  /** sync_events.id of the last row we successfully pulled from remote */
  lastPulledEventId: number | null;
  lastPushAttemptAt: string | null;
  lastPullAttemptAt: string | null;
  lastPushSuccessAt: string | null;
  lastPullSuccessAt: string | null;
  lastPushError: string | null;
  lastPullError: string | null;
  /**
   * Last time this business's incoming push/pull authenticated via the
   * shared REMOTE_SYNC_TOKEN fallback instead of its own per-business token —
   * see recordLegacyTokenUsage(). Null if it has never happened.
   */
  legacyTokenLastUsedAt: string | null;
}

const EMPTY_STATE: ServerSyncState = {
  lastPushedEventId: null,
  lastPulledEventId: null,
  lastPushAttemptAt: null,
  lastPullAttemptAt: null,
  lastPushSuccessAt: null,
  lastPullSuccessAt: null,
  lastPushError: null,
  lastPullError: null,
  legacyTokenLastUsedAt: null,
};

export function legacySyncTokenAllowed(): boolean {
  return process.env.ALLOW_LEGACY_SYNC_TOKEN === "1";
}

export function legacySyncToken(): string | null {
  if (!legacySyncTokenAllowed()) return null;
  return process.env.REMOTE_SYNC_TOKEN?.trim() || null;
}

export function legacyTokenWarning(): string | null {
  if (process.env.REMOTE_SYNC_TOKEN && !legacySyncTokenAllowed()) {
    return "REMOTE_SYNC_TOKEN is set but ALLOW_LEGACY_SYNC_TOKEN is not. Legacy sync token is denied by default.";
  }
  return null;
}

export async function getServerSyncConfig(businessId: string): Promise<ServerSyncConfig | null> {
  return getSetting<ServerSyncConfig>(businessId, SETTING_KEYS.serverSyncConfig);
}

function hashSyncToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Alongside the existing settings-stored config, keeps `server_sync_tokens`
 * (migration 0033) in lockstep — an indexed hash the *receiving* side's
 * push/pull routes look up to resolve which business an incoming request is
 * for, rather than trusting one shared REMOTE_SYNC_TOKEN for the whole
 * server. Called from within a normal tenant-scoped request (the owner's
 * own config PUT), so this insert needs no bypass — RLS's own WITH CHECK
 * already confines it to the caller's business.
 */
export async function setServerSyncConfig(businessId: string, config: ServerSyncConfig): Promise<void> {
  await setSetting(businessId, SETTING_KEYS.serverSyncConfig, config);
  if (config.siteDeviceId) {
    if (config.token) {
      // A site can briefly have an active and a staged credential during a
      // rotation.  Updating the local installation's active row must not use
      // the old one-row-per-device conflict target.
      const updated = await query(
        `UPDATE site_sync_credentials
            SET token_hash = $3, rotated_at = now()
          WHERE site_device_id = $1 AND business_id = $2
            AND state = 'active' AND revoked_at IS NULL`,
        [config.siteDeviceId, businessId, hashSyncToken(config.token)],
      );
      if ((updated.rowCount ?? 0) === 0) {
        await query(
          `INSERT INTO site_sync_credentials (site_device_id, business_id, token_hash, state)
           VALUES ($1, $2, $3, 'active')`,
          [config.siteDeviceId, businessId, hashSyncToken(config.token)],
        );
      }
    } else {
      await query(`DELETE FROM site_sync_credentials WHERE site_device_id = $1 AND business_id = $2`, [
        config.siteDeviceId,
        businessId,
      ]);
    }
    return;
  }
  // Compatibility for pre-site-device installations and manually configured
  // non-desktop peers. New desktop pairings never enter this singular table.
  if (config.token) {
    await query(
      `INSERT INTO server_sync_tokens (business_id, token_hash, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (business_id) DO UPDATE SET token_hash = EXCLUDED.token_hash, updated_at = now()`,
      [businessId, hashSyncToken(config.token)],
    );
  } else {
    await query(`DELETE FROM server_sync_tokens WHERE business_id = $1`, [businessId]);
  }
}

/**
 * Resolves an incoming server-sync bearer token to the business it belongs
 * to, or null if it matches no configured token. Runs before any tenant is
 * chosen — the token *is* how a business gets identified here — the same
 * bypass category as resolving a login email across businesses.
 */
export interface SyncCredentialIdentity {
  businessId: string;
  siteDeviceId: string | null;
  locationId: string | null;
  credentialId?: string | null;
  credentialState?: "active" | "staged" | null;
}

export async function resolveSyncCredential(token: string): Promise<SyncCredentialIdentity | null> {
  return withoutTenantScope("server-sync-auth", async () => {
    const site = await query<{
      business_id: string; site_device_id: string; location_id: string; credential_id: string;
      credential_state: "active" | "staged";
    }>(
      `SELECT c.business_id, c.site_device_id, d.location_id, c.id AS credential_id, c.state AS credential_state
         FROM site_sync_credentials c
         JOIN site_devices d ON d.id = c.site_device_id AND d.business_id = c.business_id
        WHERE c.token_hash = $1 AND d.status = 'active' AND d.revoked_at IS NULL
          AND c.state IN ('active', 'staged') AND c.revoked_at IS NULL
          AND (c.valid_until IS NULL OR c.valid_until > now())`,
      [hashSyncToken(token)],
    );
    if (site.rows[0]) {
      await query(`UPDATE site_devices SET last_seen_at = now() WHERE id = $1`, [site.rows[0].site_device_id]);
      return {
        businessId: site.rows[0].business_id,
        siteDeviceId: site.rows[0].site_device_id,
        locationId: site.rows[0].location_id,
        credentialId: site.rows[0].credential_id,
        credentialState: site.rows[0].credential_state,
      };
    }
    const legacy = await query<{ business_id: string }>(
      `SELECT business_id FROM server_sync_tokens WHERE token_hash = $1`,
      [hashSyncToken(token)],
    );
    return legacy.rows[0]
      ? { businessId: legacy.rows[0].business_id, siteDeviceId: null, locationId: null }
      : null;
  });
}

export async function resolveBusinessBySyncToken(token: string): Promise<string | null> {
  return (await resolveSyncCredential(token))?.businessId ?? null;
}

/**
 * Constant-time comparison for the legacy single-secret REMOTE_SYNC_TOKEN
 * path (kept for deployments that haven't configured a per-business token
 * yet — see the two receiving routes). Hashing both sides first means the
 * comparison is always between two fixed-length digests, so a length
 * mismatch can't itself leak anything and `timingSafeEqual` never throws.
 */
export function tokensMatch(a: string, b: string): boolean {
  return timingSafeEqual(Buffer.from(hashSyncToken(a)), Buffer.from(hashSyncToken(b)));
}

export async function getServerSyncState(businessId: string): Promise<ServerSyncState> {
  const s = await getSetting<ServerSyncState>(businessId, SETTING_KEYS.serverSyncState);
  return s ? { ...EMPTY_STATE, ...s } : { ...EMPTY_STATE };
}

export interface SyncRunRecord {
  businessId: string;
  siteDeviceId?: string | null;
  locationId?: string | null;
  direction: "push" | "pull" | "activation";
  status: "ok" | "error" | "skipped";
  startCursor?: number | null;
  endCursor?: number | null;
  eventsAttempted?: number;
  eventsApplied?: number;
  eventsDeferred?: number;
  eventsConflicted?: number;
  eventsDeadLettered?: number;
  httpStatus?: number | null;
  errorCode?: string | null;
  errorDetail?: string | null;
  remoteIdentity?: string | null;
}

/** Safe summary only: sync-run diagnostics intentionally contain no payload or credential. */
export async function recordSyncRun(run: SyncRunRecord): Promise<void> {
  await query(
    `INSERT INTO sync_runs
       (business_id, site_device_id, location_id, direction, status, remote_identity,
        start_cursor, end_cursor, events_attempted, events_applied, events_deferred,
        events_conflicted, events_dead_lettered, http_status, error_code, error_detail, completed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,now())`,
    [
      run.businessId, run.siteDeviceId ?? null, run.locationId ?? null, run.direction, run.status,
      run.remoteIdentity ?? null, run.startCursor ?? null, run.endCursor ?? null,
      run.eventsAttempted ?? 0, run.eventsApplied ?? 0, run.eventsDeferred ?? 0,
      run.eventsConflicted ?? 0, run.eventsDeadLettered ?? 0, run.httpStatus ?? null,
      run.errorCode ?? null, run.errorDetail?.slice(0, 500) ?? null,
    ],
  );
}

export interface SyncRunView {
  id: string;
  siteDeviceId: string | null;
  locationId: string | null;
  direction: "push" | "pull" | "activation";
  status: "running" | "ok" | "error" | "skipped";
  startedAt: string;
  completedAt: string | null;
  eventsAttempted: number;
  eventsApplied: number;
  eventsDeferred: number;
  eventsConflicted: number;
  eventsDeadLettered: number;
  errorCode: string | null;
}

/** Owner-facing run trace; deliberately omits payloads, secrets and error detail. */
export async function listSyncRuns(businessId: string, limit = 50): Promise<SyncRunView[]> {
  const safeLimit = Math.min(Math.max(1, limit), 200);
  const { rows } = await query<{
    id: string; site_device_id: string | null; location_id: string | null; direction: SyncRunView["direction"];
    status: SyncRunView["status"]; started_at: Date; completed_at: Date | null;
    events_attempted: number; events_applied: number; events_deferred: number; events_conflicted: number;
    events_dead_lettered: number; error_code: string | null;
  }>(
    `SELECT id,site_device_id,location_id,direction,status,started_at,completed_at,events_attempted,
            events_applied,events_deferred,events_conflicted,events_dead_lettered,error_code
       FROM sync_runs WHERE business_id=$1 ORDER BY started_at DESC LIMIT $2`,
    [businessId, safeLimit],
  );
  return rows.map((row) => ({
    id: row.id, siteDeviceId: row.site_device_id, locationId: row.location_id,
    direction: row.direction, status: row.status, startedAt: row.started_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null, eventsAttempted: row.events_attempted,
    eventsApplied: row.events_applied, eventsDeferred: row.events_deferred,
    eventsConflicted: row.events_conflicted, eventsDeadLettered: row.events_dead_lettered,
    errorCode: row.error_code,
  }));
}

/**
 * Called by the push/pull routes whenever an incoming request authenticates
 * via the shared REMOTE_SYNC_TOKEN fallback rather than this business's own
 * per-business token — the weaker of the two paths (see tokensMatch's doc
 * comment). Otherwise a deployment can stay on it indefinitely with no way
 * for the owner to notice, since the fallback works identically from the
 * caller's point of view. Runs within the caller's own withTenant() scope.
 */
export async function recordLegacyTokenUsage(businessId: string): Promise<void> {
  console.warn(`server-sync: business ${businessId} authenticated via the legacy REMOTE_SYNC_TOKEN fallback`);
  const state = await getServerSyncState(businessId);
  await setSetting(businessId, SETTING_KEYS.serverSyncState, {
    ...state,
    legacyTokenLastUsedAt: new Date().toISOString(),
  } satisfies ServerSyncState);
}

export interface ServerSyncDeadLetter {
  id: number;
  remoteEventId: number;
  locationId: string;
  clientEventId: string;
  eventType: string;
  /** SHA-256 only; diagnostics never expose the business payload. */
  payloadSha256: string;
  error: string;
  createdAt: string;
}

/** Pulled events that failed to apply and were dropped from the pull's forward progress; see runServerPull. */
export async function listServerSyncDeadLetters(businessId: string, limit = 50): Promise<ServerSyncDeadLetter[]> {
  const { rows } = await query<{
    id: number;
    remote_event_id: number;
    location_id: string;
    client_event_id: string;
    event_type: string;
    payload: Record<string, unknown>;
    error: string;
    created_at: string;
  }>(
    `SELECT id, remote_event_id, location_id, client_event_id, event_type, payload, error, created_at
       FROM server_sync_dead_letters
      WHERE business_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [businessId, limit],
  );
  return rows.map((r) => ({
    // bigint columns come back from pg as strings; safe to convert here since
    // these are small monotonic counters, never anywhere near MAX_SAFE_INTEGER.
    id: Number(r.id),
    remoteEventId: Number(r.remote_event_id),
    locationId: r.location_id,
    clientEventId: r.client_event_id,
    eventType: r.event_type,
    payloadSha256: createHash("sha256").update(JSON.stringify(r.payload)).digest("hex"),
    error: r.error,
    createdAt: r.created_at,
  }));
}



export interface SyncDomainDiagnostic {
  clientEventId: string;
  eventType: string;
  schemaVersion: number;
  status: "deferred" | "applied" | "dead_lettered";
  effectType: string | null;
  effectId: string | null;
  errorCode: string | null;
  attempts: number;
  updatedAt: string;
}

export interface SyncDomainDeadLetterDiagnostic {
  id: number;
  clientEventId: string;
  eventType: string;
  schemaVersion: number | null;
  payloadSha256: string;
  errorCode: string;
  status: "open" | "resolved" | "discarded";
  retryCount: number;
  lastSeenAt: string;
}

/** Owner diagnostics deliberately omit event payloads, results and credentials. */
export async function getSyncDomainDiagnostics(
  businessId: string,
  limit = 50,
): Promise<{
  counts: { deferred: number; applied: number; deadLettered: number; openDeadLetters: number };
  recent: SyncDomainDiagnostic[];
  deadLetters: SyncDomainDeadLetterDiagnostic[];
}> {
  const safeLimit = Math.min(Math.max(1, limit), 200);
  const [counts, effects, dead] = await Promise.all([
    query<{ deferred: string; applied: string; dead_lettered: string; open_dead_letters: string }>(
      `SELECT
         (SELECT count(*) FROM sync_domain_effects WHERE business_id=$1 AND status='deferred')::text deferred,
         (SELECT count(*) FROM sync_domain_effects WHERE business_id=$1 AND status='applied')::text applied,
         (SELECT count(*) FROM sync_domain_effects WHERE business_id=$1 AND status='dead_lettered')::text dead_lettered,
         (SELECT count(*) FROM sync_event_dead_letters WHERE business_id=$1 AND status='open')::text open_dead_letters`,
      [businessId],
    ),
    query<{
      client_event_id: string; event_type: string; schema_version: number; status: SyncDomainDiagnostic["status"];
      effect_type: string | null; effect_id: string | null; error_code: string | null; attempts: number; updated_at: string;
    }>(
      `SELECT client_event_id::text,event_type,schema_version,status,effect_type,effect_id,error_code,attempts,updated_at::text
         FROM sync_domain_effects WHERE business_id=$1 ORDER BY updated_at DESC LIMIT $2`,
      [businessId, safeLimit],
    ),
    query<{
      id: number; client_event_id: string; event_type: string; schema_version: number | null; payload_sha256: string;
      error_code: string; status: SyncDomainDeadLetterDiagnostic["status"]; retry_count: number; last_seen_at: string;
    }>(
      `SELECT id,client_event_id,event_type,schema_version,payload_sha256,error_code,status,retry_count,last_seen_at::text
         FROM sync_event_dead_letters WHERE business_id=$1 ORDER BY last_seen_at DESC LIMIT $2`,
      [businessId, safeLimit],
    ),
  ]);
  const count = counts.rows[0];
  return {
    counts: {
      deferred: Number(count?.deferred ?? 0),
      applied: Number(count?.applied ?? 0),
      deadLettered: Number(count?.dead_lettered ?? 0),
      openDeadLetters: Number(count?.open_dead_letters ?? 0),
    },
    recent: effects.rows.map((row) => ({
      clientEventId: row.client_event_id,
      eventType: row.event_type,
      schemaVersion: row.schema_version,
      status: row.status,
      effectType: row.effect_type,
      effectId: row.effect_id,
      errorCode: row.error_code,
      attempts: row.attempts,
      updatedAt: row.updated_at,
    })),
    deadLetters: dead.rows.map((row) => ({
      id: Number(row.id),
      clientEventId: row.client_event_id,
      eventType: row.event_type,
      schemaVersion: row.schema_version,
      payloadSha256: row.payload_sha256,
      errorCode: row.error_code,
      status: row.status,
      retryCount: row.retry_count,
      lastSeenAt: row.last_seen_at,
    })),
  };
}



export async function updateSyncDeadLetter(
  businessId: string,
  deadLetterId: number,
  action: "retry" | "discard",
  actorId: string,
  note: string | null,
): Promise<boolean> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const row = await client.query<{ client_event_id: string; location_id: string | null }>(
      `SELECT client_event_id,location_id FROM sync_event_dead_letters
        WHERE id=$1 AND business_id=$2 AND status='open' FOR UPDATE`,
      [deadLetterId, businessId],
    );
    if (!row.rows[0]) {
      await client.query("ROLLBACK");
      return false;
    }
    if (action === "retry") {
      await client.query(
        `UPDATE sync_domain_effects SET status='deferred',error_code=NULL,updated_at=now()
          WHERE business_id=$1 AND client_event_id=$2::uuid`,
        [businessId, row.rows[0].client_event_id],
      );
      if (row.rows[0].location_id) {
        await client.query(
          `UPDATE sync_events SET error=NULL,dead_lettered_at=NULL,deferred_until=now()
            WHERE location_id=$1 AND client_event_id=$2::uuid`,
          [row.rows[0].location_id, row.rows[0].client_event_id],
        );
      }
    }
    await client.query(
      `UPDATE sync_event_dead_letters
          SET status=$3,resolved_at=now(),resolved_by=$4,resolution_note=$5
        WHERE id=$1 AND business_id=$2`,
      [deadLetterId, businessId, action === "retry" ? "resolved" : "discarded", actorId, note?.slice(0, 500) || null],
    );
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export interface PairedSite {
  /** Most recent credential issue/rotation among active site devices. */
  tokenSetAt: string;
  /** Most recent authenticated request among active site devices. */
  lastSeenAt: string | null;
  lastSeenStatus: "ok" | "error" | "skipped" | null;
  deviceCount: number;
  locationCount: number;
}

/** Aggregate status for a central server's independently managed site devices. */
export async function getPairedSite(businessId: string): Promise<PairedSite | null> {
  const [siteRes, logRes] = await Promise.all([
    query<{
      token_set_at: string;
      last_seen_at: string | null;
      device_count: string;
      location_count: string;
    }>(
      `SELECT max(c.rotated_at)::text AS token_set_at,
              max(d.last_seen_at)::text AS last_seen_at,
              count(*)::text AS device_count,
              count(DISTINCT d.location_id)::text AS location_count
         FROM site_devices d
         JOIN site_sync_credentials c
           ON c.site_device_id = d.id AND c.business_id = d.business_id
        WHERE d.business_id = $1 AND d.status = 'active' AND d.revoked_at IS NULL
       HAVING count(*) > 0`,
      [businessId],
    ),
    query<{ attempted_at: string; status: "ok" | "error" | "skipped" }>(
      `SELECT attempted_at, status FROM server_sync_log
        WHERE business_id = $1
        ORDER BY attempted_at DESC
        LIMIT 1`,
      [businessId],
    ),
  ]);

  const site = siteRes.rows[0];
  if (!site) return null;
  return {
    tokenSetAt: site.token_set_at,
    lastSeenAt: site.last_seen_at,
    lastSeenStatus: logRes.rows[0]?.status ?? null,
    deviceCount: Number(site.device_count),
    locationCount: Number(site.location_count),
  };
}

// ---------------------------------------------------------------------------
// Row type returned by sync_events queries
// ---------------------------------------------------------------------------

type SyncEventRow = {
  id: number;
  location_id: string;
  client_event_id: string;
  event_type: SyncEventType;
  payload: Record<string, unknown>;
  occurred_at: string;
  actor_user_id: string;
  actor_role: string;
  site_device_id: string | null;
  schema_version: number;
};

// ---------------------------------------------------------------------------
// Push: local → remote
// ---------------------------------------------------------------------------

export type PushResult =
  | { status: "disabled" }
  | { status: "ok"; pushed: number }
  | { status: "error"; error: string };

/**
 * Fetch unsynced rows from local sync_events and POST them to the remote.
 * Idempotent: the remote deduplicates on (location_id, client_event_id).
 */
export async function runServerPush(businessId: string): Promise<PushResult> {
  const config = await getServerSyncConfig(businessId);
  if (!config?.enabled || !config.remoteUrl?.trim() || !config.token?.trim()) {
    return { status: "disabled" };
  }

  const state = await getServerSyncState(businessId);
  const batchSize = config.batchSize ?? 100;
  const afterId = state.lastPushedEventId ?? 0;

  await setSetting(businessId, SETTING_KEYS.serverSyncState, {
    ...state,
    lastPushAttemptAt: new Date().toISOString(),
  } satisfies ServerSyncState);

  const fail = async (error: string): Promise<PushResult> => {
    const s = await getServerSyncState(businessId);
    await setSetting(businessId, SETTING_KEYS.serverSyncState, {
      ...s,
      lastPushError: error,
    } satisfies ServerSyncState);
    await query(
      `INSERT INTO server_sync_log (business_id, direction, status, events_count, error, last_event_id)
       VALUES ($1, 'push', 'error', 0, $2, $3)`,
      [businessId, error, afterId],
    );
    await recordSyncRun({ businessId, siteDeviceId: config.siteDeviceId ?? null, locationId: config.locationId ?? null,
      direction: "push", status: "error", startCursor: afterId, endCursor: afterId, errorCode: error.split(":")[0], errorDetail: error });
    return { status: "error", error };
  };

  // Fetch the next batch of local sync_events rows
  let rows: SyncEventRow[];
  try {
    const { rows: r } = await query<SyncEventRow>(
      `SELECT se.id, se.location_id, se.client_event_id, se.event_type,
              se.payload, se.occurred_at, se.actor_user_id, se.actor_role,
              se.site_device_id, se.schema_version
         FROM sync_events se
         JOIN locations l ON l.id = se.location_id
        WHERE l.business_id = $1
          AND se.id > $2
          AND se.applied_at IS NOT NULL
          AND se.error IS NULL
          AND (se.origin IS NULL OR se.origin = 'local')
          AND ($4::uuid IS NULL OR se.location_id = $4::uuid)
        ORDER BY se.id
        LIMIT $3`,
      [businessId, afterId, batchSize, config.locationId ?? null],
    );
    rows = r;
  } catch (err) {
    return fail(`query_failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (rows.length === 0) {
    const healthy = await getServerSyncState(businessId);
    await setSetting(businessId, SETTING_KEYS.serverSyncState, {
      ...healthy,
      lastPushSuccessAt: new Date().toISOString(),
      lastPushError: null,
    } satisfies ServerSyncState);
    await query(
      `INSERT INTO server_sync_log (business_id, direction, status, events_count, last_event_id)
       VALUES ($1, 'push', 'ok', 0, $2)`,
      [businessId, afterId],
    );
    await recordSyncRun({ businessId, siteDeviceId: config.siteDeviceId ?? null, locationId: config.locationId ?? null,
      direction: "push", status: "ok", startCursor: afterId, endCursor: afterId });
    return { status: "ok", pushed: 0 };
  }

  const events = rows.map((r) => ({
    clientEventId: r.client_event_id,
    type: r.event_type,
    occurredAt: typeof r.occurred_at === "string" ? r.occurred_at : new Date(r.occurred_at).toISOString(),
    payload: r.payload,
    locationId: r.location_id,
    actorUserId: r.actor_user_id,
    actorRole: r.actor_role,
    businessId,
    siteDeviceId: config.siteDeviceId ?? r.site_device_id,
    schemaVersion: r.schema_version,
    origin: "site",
  }));

  const url = `${config.remoteUrl.trim().replace(/\/+$/, "")}/api/server-sync/push`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.token.trim()}`,
      },
      body: JSON.stringify({ events }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      return fail(`remote_rejected: HTTP ${res.status}`);
    }
    const body = (await res.json()) as {
      results?: Array<{
        clientEventId?: string;
        ok?: boolean;
        conflict?: boolean;
        deferred?: boolean;
        deadLettered?: boolean;
        error?: string;
      }>;
    };
    if (!Array.isArray(body.results) || body.results.length !== rows.length) {
      return fail("remote_rejected: invalid result set");
    }
    for (let index = 0; index < rows.length; index += 1) {
      const result = body.results[index];
      if (result.clientEventId !== rows[index].client_event_id) {
        return fail("remote_rejected: mismatched result order");
      }
      // A conflict is a terminal, explicitly recorded outcome. Any other
      // apply failure (including an ambiguous in-progress outcome) must stop
      // the high-water mark rather than silently dropping a domain mutation.
      if (result.deferred) {
        return fail(`remote_dependency_deferred: ${result.error || "unknown"}`);
      }
      // A dead letter is a terminal, durable remote outcome. Advancing is safe:
      // the operator can inspect/reconcile it there and retries cannot apply it.
      if (!result.ok && !result.conflict && !result.deadLettered) {
        return fail(`remote_apply_failed: ${result.error || "unknown"}`);
      }
    }
  } catch (err) {
    return fail(`unreachable: ${err instanceof Error ? err.message : String(err)}`);
  }

  // PostgreSQL bigint values arrive from node-postgres as strings even though
  // the persisted settings contract uses JSON numbers.
  const lastId = Number(rows[rows.length - 1].id);
  const s = await getServerSyncState(businessId);
  await setSetting(businessId, SETTING_KEYS.serverSyncState, {
    ...s,
    lastPushedEventId: lastId,
    lastPushSuccessAt: new Date().toISOString(),
    lastPushError: null,
  } satisfies ServerSyncState);
  await query(
    `INSERT INTO server_sync_log (business_id, direction, status, events_count, last_event_id)
     VALUES ($1, 'push', 'ok', $2, $3)`,
    [businessId, rows.length, lastId],
  );
  await recordSyncRun({ businessId, siteDeviceId: config.siteDeviceId ?? null, locationId: config.locationId ?? null,
    direction: "push", status: "ok", startCursor: afterId, endCursor: lastId, eventsAttempted: rows.length, eventsApplied: rows.length });
  return { status: "ok", pushed: rows.length };
}

// ---------------------------------------------------------------------------
// Pull: remote → local
// ---------------------------------------------------------------------------

export type PullResult =
  | { status: "disabled" }
  | { status: "ok"; pulled: number }
  | { status: "error"; error: string };

interface RemoteEvent {
  id: number;
  clientEventId: string;
  type: string;
  occurredAt: string;
  payload: Record<string, unknown>;
  locationId: string;
  actorUserId: string;
  actorRole: string;
  businessId?: string;
  siteDeviceId?: string | null;
  schemaVersion?: number;
  origin?: string;
}

/**
 * Fetch events from the remote that we haven't seen yet and replay them
 * locally via applySyncEvent() — same engine as the client offline queue.
 */
export async function runServerPull(businessId: string): Promise<PullResult> {
  const config = await getServerSyncConfig(businessId);
  if (!config?.enabled || !config.remoteUrl?.trim() || !config.token?.trim()) {
    return { status: "disabled" };
  }

  const state = await getServerSyncState(businessId);
  const batchSize = config.batchSize ?? 100;
  const afterId = state.lastPulledEventId ?? 0;

  await setSetting(businessId, SETTING_KEYS.serverSyncState, {
    ...state,
    lastPullAttemptAt: new Date().toISOString(),
  } satisfies ServerSyncState);

  let eventsApplied = 0;
  let eventsDeferred = 0;
  let eventsConflicted = 0;
  let eventsDeadLettered = 0;

  const fail = async (error: string): Promise<PullResult> => {
    const s = await getServerSyncState(businessId);
    await setSetting(businessId, SETTING_KEYS.serverSyncState, {
      ...s,
      lastPullError: error,
    } satisfies ServerSyncState);
    await query(
      `INSERT INTO server_sync_log (business_id, direction, status, events_count, error, last_event_id)
       VALUES ($1, 'pull', 'error', 0, $2, $3)`,
      [businessId, error, afterId],
    );
    await recordSyncRun({ businessId, siteDeviceId: config.siteDeviceId ?? null, locationId: config.locationId ?? null,
      direction: "pull", status: "error", startCursor: afterId, endCursor: afterId,
      eventsApplied, eventsDeferred, eventsConflicted, eventsDeadLettered,
      errorCode: error.split(":")[0], errorDetail: error });
    return { status: "error", error };
  };

  // Fetch from remote
  const url = `${config.remoteUrl.trim().replace(/\/+$/, "")}/api/server-sync/pull?after=${afterId}&limit=${batchSize}`;
  let remoteEvents: RemoteEvent[];
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${config.token.trim()}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return fail(`remote_rejected: HTTP ${res.status}`);
    const body = (await res.json()) as { events: RemoteEvent[] };
    remoteEvents = body.events ?? [];
  } catch (err) {
    return fail(`unreachable: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (remoteEvents.length === 0) {
    const healthy = await getServerSyncState(businessId);
    await setSetting(businessId, SETTING_KEYS.serverSyncState, {
      ...healthy,
      lastPullSuccessAt: new Date().toISOString(),
      lastPullError: null,
    } satisfies ServerSyncState);
    await query(
      `INSERT INTO server_sync_log (business_id, direction, status, events_count, last_event_id)
       VALUES ($1, 'pull', 'ok', 0, $2)`,
      [businessId, afterId],
    );
    await recordSyncRun({ businessId, siteDeviceId: config.siteDeviceId ?? null, locationId: config.locationId ?? null,
      direction: "pull", status: "ok", startCursor: afterId, endCursor: afterId });
    return { status: "ok", pulled: 0 };
  }

  // Replay each event locally in order
  let lastAppliedRemoteId = afterId;
  for (const e of remoteEvents) {
    const input: SyncEventInput = {
      clientEventId: e.clientEventId,
      type: e.type,
      occurredAt: e.occurredAt,
      payload: e.payload,
    };
    try {
      const applied = await applySyncEvent(
        e.locationId,
        { userId: e.actorUserId, role: e.actorRole as import("./auth").Role },
        input,
        "remote",
        { siteDeviceId: e.siteDeviceId ?? null, schemaVersion: e.schemaVersion ?? 1 },
      );
      if (applied.ok) eventsApplied += 1;
      else if (applied.deferred) eventsDeferred += 1;
      else if (applied.conflict) eventsConflicted += 1;
      else if (applied.deadLettered) eventsDeadLettered += 1;
      else throw new Error(applied.error ?? "apply_failed");
    } catch (err) {
      // Don't abort the batch — a single bad event shouldn't block the rest —
      // but the high-water mark below still advances past it, so record it
      // as a dead letter rather than only logging: otherwise it's dropped
      // forever with nothing to show it happened.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`server-sync pull: failed to apply event ${e.clientEventId}: ${message}`);
      try {
        await query(
          `INSERT INTO server_sync_dead_letters
             (business_id, remote_event_id, location_id, client_event_id, event_type, payload, error)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [businessId, e.id, e.locationId, e.clientEventId, e.type, JSON.stringify(e.payload), message],
        );
      } catch (persistenceError) {
        // The cursor must never advance over an outcome that was not made
        // durable. Stop exactly before this remote event; the next run will
        // fetch it again and either persist its dead letter or apply it.
        const detail = persistenceError instanceof Error ? persistenceError.message : String(persistenceError);
        return fail(`dead_letter_persistence_failed: ${detail}`);
      }
      eventsDeadLettered += 1;
    }
    lastAppliedRemoteId = e.id;
  }

  const s = await getServerSyncState(businessId);
  await setSetting(businessId, SETTING_KEYS.serverSyncState, {
    ...s,
    lastPulledEventId: lastAppliedRemoteId,
    lastPullSuccessAt: new Date().toISOString(),
    lastPullError: null,
  } satisfies ServerSyncState);
  await query(
    `INSERT INTO server_sync_log (business_id, direction, status, events_count, last_event_id)
     VALUES ($1, 'pull', 'ok', $2, $3)`,
    [businessId, remoteEvents.length, lastAppliedRemoteId],
  );
  await recordSyncRun({ businessId, siteDeviceId: config.siteDeviceId ?? null, locationId: config.locationId ?? null,
    direction: "pull", status: "ok", startCursor: afterId, endCursor: lastAppliedRemoteId,
    eventsAttempted: remoteEvents.length, eventsApplied, eventsDeferred, eventsConflicted, eventsDeadLettered });
  return { status: "ok", pulled: remoteEvents.length };
}

/**
 * Pull a staged credential through the existing authenticated channel and
 * acknowledge it with the new credential.  The replacement token is encrypted
 * at rest on the cloud and never appears in owner-facing API responses.
 */
export async function refreshStagedSiteCredential(businessId: string): Promise<boolean> {
  const config = await getServerSyncConfig(businessId);
  if (!config?.remoteUrl || !config.token || !config.siteDeviceId) return true;
  const base = config.remoteUrl.trim().replace(/\/+$/, "");
  try {
    const response = await fetch(`${base}/api/server-sync/credential-rotation`, {
      headers: { Authorization: `Bearer ${config.token}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) return false;
    const handoff = await response.json() as { pending?: boolean; token?: string };
    let token = config.token;
    if (handoff.token) {
      token = handoff.token;
      await setServerSyncConfig(businessId, { ...config, token });
    }
    if (!handoff.pending) return true;
    const acknowledged = await fetch(`${base}/api/server-sync/credential-rotation/ack`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30_000),
    });
    return acknowledged.ok;
  } catch {
    return false;
  }
}

/** Acknowledge a committed local pairing snapshot until the cloud activates it. */
export async function activatePendingPairing(businessId: string): Promise<boolean> {
  const config = await getServerSyncConfig(businessId);
  if (!config?.pairingPending || !config.remoteUrl || !config.token || !config.siteDeviceId) return true;
  const url = `${config.remoteUrl.trim().replace(/\/+$/, "")}/api/pairing/activate`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.token}` },
      body: JSON.stringify({ siteDeviceId: config.siteDeviceId }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      await recordSyncRun({ businessId, siteDeviceId: config.siteDeviceId, locationId: config.locationId ?? null,
        direction: "activation", status: "error", httpStatus: response.status, errorCode: "activation_rejected" });
      return false;
    }
    await setServerSyncConfig(businessId, { ...config, pairingPending: false });
    await recordSyncRun({ businessId, siteDeviceId: config.siteDeviceId, locationId: config.locationId ?? null,
      direction: "activation", status: "ok", httpStatus: response.status });
    return true;
  } catch (error) {
    await recordSyncRun({ businessId, siteDeviceId: config.siteDeviceId, locationId: config.locationId ?? null,
      direction: "activation", status: "error", errorCode: "activation_unreachable",
      errorDetail: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

// ---------------------------------------------------------------------------
// Combined tick (push then pull)
// ---------------------------------------------------------------------------

export async function runServerSyncTick(): Promise<void> {
  // Discovery spans tenants; each business's sync then runs scoped to it.
  const rows = await withoutTenantScope("platform", async () => {
    const result = await query<{ business_id: string }>(
      `SELECT c.business_id FROM settings c
         JOIN settings p ON p.business_id=c.business_id AND p.location_id IS NULL
                        AND p.key=$2 AND p.value->>'profile'='hybrid'
        WHERE c.key=$1 AND c.location_id IS NULL`,
      [SETTING_KEYS.serverSyncConfig, SETTING_KEYS.deploymentProfile],
    );
    return result.rows;
  });

  for (const row of rows) {
    try {
      const activated = await withTenant(row.business_id, () => activatePendingPairing(row.business_id));
      if (!activated) continue;
      const credentialReady = await withTenant(row.business_id, () => refreshStagedSiteCredential(row.business_id));
      if (!credentialReady) continue;
      await withTenant(row.business_id, () => runServerPush(row.business_id));
    } catch (err) {
      console.error(`server-sync push failed for business ${row.business_id}:`, err);
    }
    try {
      await withTenant(row.business_id, async () => {
        await runServerPull(row.business_id);
        await reconcileDeferredSyncEvents(row.business_id);
      });
    } catch (err) {
      console.error(`server-sync pull/reconciliation failed for business ${row.business_id}:`, err);
    }
    try {
      // Dashboard visibility only — no credential involved. See app-update.ts.
      await withTenant(row.business_id, async () => {
        const config = await getServerSyncConfig(row.business_id);
        await refreshAppUpdateStatus(row.business_id, config);
      });
    } catch (err) {
      console.error(`app-update check failed for business ${row.business_id}:`, err);
    }
  }
}

export const SERVER_SYNC_INTERVAL_MS = 30_000; // 30 s
