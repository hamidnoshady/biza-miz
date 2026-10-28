/**
 * Issue #903 §5 — Hybrid correctness: the queue, the heartbeat and the fence.
 *
 * Hybrid means "local copy, plus a managed copy when the network cooperates".
 * Three failure modes make that promise dishonest if nothing is done:
 *
 *  • **Offline gaps.** The site finishes a backup, cannot reach the platform,
 *    and the run is forgotten. Here every artifact that failed to upload is
 *    enqueued (`tenant_backup_upload_queue`) and drained on later ticks, in
 *    order, with bounded exponential backoff and a dead-letter state.
 *  • **Imagined mirroring.** The tenant UI cannot tell "uploaded 2 minutes ago"
 *    from "the laptop has been off since Tuesday". A heartbeat row records the
 *    last contact, the queue depth at that moment and the install's generation;
 *    the inventory reports *that*, or `unknown` when there is no row — never a
 *    cheerful default.
 *  • **Zombie state.** A re-imaged laptop, or an old database restored onto a
 *    new machine, will happily upload a month-old artifact as if it were
 *    current. Every artifact carries its install's sync generation, and the
 *    platform records the highest generation it has accepted. An upload whose
 *    generation is older than the accepted one is refused as `stale_generation`
 *    and the queue row is marked `superseded` — the cloud copy never travels
 *    backwards.
 *
 * All three rules are pure functions here, so the state machine is testable
 * without a database; the I/O wrappers around them are thin on purpose.
 */
import { query } from "./db";

/** Attempts before a queued artifact is dead-lettered rather than retried. */
export const QUEUE_MAX_ATTEMPTS = 8;
/** First backoff step; doubles per attempt, capped. */
export const QUEUE_BASE_BACKOFF_MS = 60_000;
export const QUEUE_MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;
/** A heartbeat older than this is reported as stale, not as "online". */
export const HEARTBEAT_FRESH_MS = 15 * 60 * 1000;

export type QueueRowState = "queued" | "uploading" | "done" | "dead" | "superseded";

export interface QueueEntry {
  artifactName: string;
  generation: number;
  state: QueueRowState;
  attempts: number;
  nextAttemptAt: string;
}

export type Connectivity = "online" | "offline" | "unknown";

/** Exponential backoff with a cap: 1m, 2m, 4m, … 6h. */
export function queueBackoffMs(attempts: number): number {
  const exponent = Math.max(0, Math.min(15, Math.floor(attempts)));
  return Math.min(QUEUE_MAX_BACKOFF_MS, QUEUE_BASE_BACKOFF_MS * 2 ** exponent);
}

/**
 * What the drain loop should do with one entry, now.
 *
 * `superseded` is decided by the fence before this is called; this function is
 * only about time and attempts.
 */
export type DrainDecision =
  | { action: "upload" }
  | { action: "wait"; until: string }
  | { action: "dead"; reason: "too_many_attempts" }
  | { action: "skip"; reason: "already_done" | "superseded" };

export function planQueueEntry(entry: QueueEntry, now: Date = new Date()): DrainDecision {
  if (entry.state === "done") return { action: "skip", reason: "already_done" };
  if (entry.state === "superseded") return { action: "skip", reason: "superseded" };
  if (entry.state === "dead") return { action: "dead", reason: "too_many_attempts" };
  if (entry.attempts >= QUEUE_MAX_ATTEMPTS) return { action: "dead", reason: "too_many_attempts" };
  if (new Date(entry.nextAttemptAt).getTime() > now.getTime()) {
    return { action: "wait", until: entry.nextAttemptAt };
  }
  return { action: "upload" };
}

/**
 * The fence. An artifact may be uploaded only when its generation is not older
 * than the newest generation the platform has already accepted for this
 * business. Equal generations are allowed — that is the same install retrying.
 */
export type FenceDecision =
  | { ok: true }
  | { ok: false; reason: "stale_generation" | "generation_invalid" };

export function fenceDecision(input: { generation: number; acceptedGeneration: number }): FenceDecision {
  if (!Number.isSafeInteger(input.generation) || input.generation < 0) {
    return { ok: false, reason: "generation_invalid" };
  }
  if (input.generation < input.acceptedGeneration) return { ok: false, reason: "stale_generation" };
  return { ok: true };
}

/** Honest connectivity, from the last heartbeat alone. */
export function connectivityFromHeartbeat(
  lastSeenAt: string | null,
  now: Date = new Date(),
): Connectivity {
  if (!lastSeenAt) return "unknown";
  const seen = new Date(lastSeenAt).getTime();
  if (Number.isNaN(seen)) return "unknown";
  return now.getTime() - seen <= HEARTBEAT_FRESH_MS ? "online" : "offline";
}

// ---------------------------------------------------------------------------
// Queue I/O
// ---------------------------------------------------------------------------

interface QueueDbRow extends Record<string, unknown> {
  artifact_name: string;
  generation: string;
  state: QueueRowState;
  attempts: number;
  next_attempt_at: Date;
}

function mapQueueRow(row: QueueDbRow): QueueEntry {
  return {
    artifactName: row.artifact_name,
    generation: Number(row.generation),
    state: row.state,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at.toISOString(),
  };
}

/** Queue an artifact for upload. Re-enqueuing the same artifact is a no-op. */
export async function enqueueUpload(input: {
  businessId: string;
  artifactName: string;
  generation: number;
}): Promise<boolean> {
  const { rowCount } = await query(
    `INSERT INTO tenant_backup_upload_queue (business_id, artifact_name, generation)
     VALUES ($1, $2, $3)
     ON CONFLICT (business_id, artifact_name) DO UPDATE
       SET next_attempt_at = LEAST(tenant_backup_upload_queue.next_attempt_at, now()),
           updated_at = now()
     WHERE tenant_backup_upload_queue.state = 'queued'`,
    [input.businessId, input.artifactName, input.generation],
  );
  return (rowCount ?? 0) > 0;
}

/** The queue's due entries, oldest first — order is what makes catch-up sane. */
export async function pendingUploads(businessId: string, limit = 10): Promise<QueueEntry[]> {
  const { rows } = await query<QueueDbRow>(
    `SELECT artifact_name, generation, state, attempts, next_attempt_at
       FROM tenant_backup_upload_queue
      WHERE business_id = $1 AND state IN ('queued', 'uploading')
      ORDER BY enqueued_at ASC
      LIMIT $2`,
    [businessId, limit],
  );
  return rows.map(mapQueueRow);
}

export async function markUploadAttempt(
  businessId: string,
  artifactName: string,
  outcome: { ok: true } | { ok: false; errorCode: string; superseded?: boolean },
  now: Date = new Date(),
): Promise<void> {
  if (outcome.ok) {
    await query(
      `UPDATE tenant_backup_upload_queue
          SET state = 'done', completed_at = $3, updated_at = $3, last_error_code = NULL
        WHERE business_id = $1 AND artifact_name = $2`,
      [businessId, artifactName, now],
    );
    return;
  }
  await query(
    `UPDATE tenant_backup_upload_queue
        SET state = CASE
              WHEN $4 THEN 'superseded'
              WHEN attempts + 1 >= $5 THEN 'dead'
              ELSE 'queued'
            END,
            attempts = attempts + 1,
            next_attempt_at = $3::timestamptz + ($6::bigint || ' milliseconds')::interval,
            last_error_code = $7,
            updated_at = $3
      WHERE business_id = $1 AND artifact_name = $2`,
    [
      businessId,
      artifactName,
      now,
      outcome.superseded === true,
      QUEUE_MAX_ATTEMPTS,
      String(queueBackoffMs(0)),
      outcome.errorCode,
    ],
  );
}

/** Queue depth for the heartbeat and the tenant status line. */
export async function queueDepth(businessId: string): Promise<number> {
  const { rows } = await query<{ total: string }>(
    `SELECT count(*)::text AS total FROM tenant_backup_upload_queue
      WHERE business_id = $1 AND state IN ('queued', 'uploading')`,
    [businessId],
  );
  return Number(rows[0]?.total ?? 0);
}

// ---------------------------------------------------------------------------
// Heartbeat I/O
// ---------------------------------------------------------------------------

export interface Heartbeat {
  siteGeneration: number;
  acceptedGeneration: number;
  lastSeenAt: string;
  queueDepth: number;
  lastErrorCode: string | null;
  connectivity: Connectivity;
}

export async function recordHeartbeat(input: {
  businessId: string;
  siteGeneration: number;
  lastErrorCode?: string | null;
  appVersion?: string | null;
  now?: Date;
}): Promise<Heartbeat | null> {
  const now = input.now ?? new Date();
  const depth = await queueDepth(input.businessId);
  const { rows } = await query<{
    site_generation: string;
    accepted_generation: string;
    last_seen_at: Date;
    queue_depth: number;
    last_error_code: string | null;
  }>(
    `INSERT INTO tenant_backup_site_heartbeat
       (business_id, site_generation, last_seen_at, queue_depth, last_error_code, app_version, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $3)
     ON CONFLICT (business_id) DO UPDATE
       SET site_generation = GREATEST(tenant_backup_site_heartbeat.site_generation, EXCLUDED.site_generation),
           last_seen_at = EXCLUDED.last_seen_at,
           queue_depth = EXCLUDED.queue_depth,
           last_error_code = EXCLUDED.last_error_code,
           app_version = COALESCE(EXCLUDED.app_version, tenant_backup_site_heartbeat.app_version),
           updated_at = EXCLUDED.updated_at
     RETURNING site_generation, accepted_generation, last_seen_at, queue_depth, last_error_code`,
    [input.businessId, input.siteGeneration, now, depth, input.lastErrorCode ?? null, input.appVersion ?? null],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    siteGeneration: Number(row.site_generation),
    acceptedGeneration: Number(row.accepted_generation),
    lastSeenAt: row.last_seen_at.toISOString(),
    queueDepth: row.queue_depth,
    lastErrorCode: row.last_error_code,
    connectivity: connectivityFromHeartbeat(row.last_seen_at.toISOString(), now),
  };
}

export async function readHeartbeat(businessId: string, now: Date = new Date()): Promise<Heartbeat | null> {
  const { rows } = await query<{
    site_generation: string;
    accepted_generation: string;
    last_seen_at: Date;
    queue_depth: number;
    last_error_code: string | null;
  }>(
    `SELECT site_generation, accepted_generation, last_seen_at, queue_depth, last_error_code
       FROM tenant_backup_site_heartbeat WHERE business_id = $1`,
    [businessId],
  );
  const row = rows[0];
  if (!row) return null;
  const lastSeenAt = row.last_seen_at.toISOString();
  return {
    siteGeneration: Number(row.site_generation),
    acceptedGeneration: Number(row.accepted_generation),
    lastSeenAt,
    queueDepth: row.queue_depth,
    lastErrorCode: row.last_error_code,
    connectivity: connectivityFromHeartbeat(lastSeenAt, now),
  };
}

/**
 * Accept an upload's generation. Losing the fence after the bytes landed is not
 * an error the tenant needs to see; it only means the platform's watermark
 * moves forward to this generation, never backwards.
 */
export async function acceptGeneration(businessId: string, generation: number): Promise<void> {
  await query(
    `UPDATE tenant_backup_site_heartbeat
        SET accepted_generation = GREATEST(accepted_generation, $2), updated_at = now()
      WHERE business_id = $1`,
    [businessId, generation],
  );
}

/** The fence check a caller must run *before* uploading an artifact. */
export async function checkUploadFence(
  businessId: string,
  generation: number,
): Promise<FenceDecision> {
  const heartbeat = await readHeartbeat(businessId);
  return fenceDecision({ generation, acceptedGeneration: heartbeat?.acceptedGeneration ?? 0 });
}

/**
 * Drain the queue for one business: at most one artifact per call, in order.
 * Returns what happened so the tick can log honestly.
 */
export async function drainUploadQueue(
  businessId: string,
  upload: (artifactName: string, generation: number) => Promise<{ ok: true } | { ok: false; error: string }>,
  now: Date = new Date(),
): Promise<{ uploaded: number; waiting: number; dead: number; superseded: number }> {
  const result = { uploaded: 0, waiting: 0, dead: 0, superseded: 0 };
  const entries = await pendingUploads(businessId);
  for (const entry of entries) {
    const plan = planQueueEntry(entry, now);
    if (plan.action === "skip") continue;
    if (plan.action === "wait") {
      result.waiting += 1;
      continue;
    }
    if (plan.action === "dead") {
      await markUploadAttempt(businessId, entry.artifactName, { ok: false, errorCode: "too_many_attempts" }, now);
      result.dead += 1;
      continue;
    }
    const fence = await checkUploadFence(businessId, entry.generation);
    if (!fence.ok) {
      await markUploadAttempt(
        businessId,
        entry.artifactName,
        { ok: false, errorCode: fence.reason, superseded: fence.reason === "stale_generation" },
        now,
      );
      result.superseded += 1;
      continue;
    }
    const attempt = await upload(entry.artifactName, entry.generation);
    if (attempt.ok) {
      await acceptGeneration(businessId, entry.generation);
      await markUploadAttempt(businessId, entry.artifactName, { ok: true }, now);
      result.uploaded += 1;
      break;
    }
    await markUploadAttempt(businessId, entry.artifactName, { ok: false, errorCode: attempt.error }, now);
    break;
  }
  return result;
}
