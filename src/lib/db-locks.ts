/**
 * Issue #807 — cross-process locks for backup and restore.
 *
 * The audit found the existing guards were JS state in one process
 * (`new Set<string>()`, `let restoreInFlight = false`). On a multi-instance
 * central deployment two Node processes can each believe they own the same
 * backup or the same restore — and the restore one is the dangerous case: two
 * instances both renaming and dropping the same database.
 *
 * This module uses PostgreSQL **session-level advisory locks**, which are the
 * right primitive here: they are owned by one database session, visible to
 * every connection in the cluster's database, released automatically when that
 * session ends (so a crashed process cannot leave a dead lease behind), and
 * they need no table, no migration and no clock.
 *
 * Deliberately *not* a plain `SELECT ... FOR UPDATE` row: a row lock needs a
 * transaction that outlives the whole backup (minutes), pinning a connection
 * and a snapshot open the entire time, and any read-committed retry can be
 * defeated. An advisory lock is a single named mutex.
 *
 * The lock key is a stable hash of a namespaced string, so the same
 * `restore:platform` names one mutex on every instance and in every process.
 */
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { getPool, query } from "./db";

/** The namespaces every caller must go through — no ad-hoc lock names. */
export const LOCK_KEYS = {
  /** one whole-platform backup at a time, cluster-wide */
  platformBackup: "backup:platform",
  /** one whole-platform restore at a time, cluster-wide */
  platformRestore: "restore:platform",
  /** a site's physical tenant dump (per business) */
  tenantPhysicalBackup: (businessId: string) => `backup:tenant-physical:${businessId}`,
  /** a tenant-facing restore (per business) */
  tenantRestore: (businessId: string) => `restore:tenant:${businessId}`,
  /** the first-run restore on a site install */
  setupRestore: "restore:setup",
  /** the central logical tenant snapshot (per business) */
  tenantSnapshot: (businessId: string) => `backup:tenant-snapshot:${businessId}`,
} as const;

export interface LockHandle {
  key: string;
  /** the two int4 halves the advisory lock is taken with (for diagnostics) */
  classId: number;
  objectId: number;
  release: () => Promise<void>;
}

export type LockAttempt =
  | { acquired: true; lock: LockHandle }
  | { acquired: false; reason: "busy" | "unavailable"; error?: string };

/** Deterministic int4 pair for a lock key (stable across processes and restarts). */
export function lockIdsFor(key: string): { classId: number; objectId: number } {
  const digest = createHash("sha256").update(`pos-lock\0${key}`).digest();
  return { classId: digest.readInt32BE(0), objectId: digest.readInt32BE(4) };
}

/**
 * Try to take the lock. Never waits: a backup or restore that has to queue is a
 * backup or restore the operator thinks is running and is not, and both callers
 * treat "busy" as a first-class answer to show.
 */
export async function tryAcquireLock(key: string): Promise<LockAttempt> {
  const { classId, objectId } = lockIdsFor(key);
  let client: PoolClient;
  try {
    client = await getPool().connect();
  } catch (error) {
    return {
      acquired: false,
      reason: "unavailable",
      error: error instanceof Error ? error.message : String(error),
    };
  }
  try {
    // The advisory lock belongs to the *session*, so it must be taken on the
    // same client we hold open — not through the pooled `query()` helper,
    // which may run it on a different connection (and release it immediately).
    const result = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1::int, $2::int) AS locked",
      [classId, objectId],
    );
    if (!result.rows[0]?.locked) {
      client.release();
      return { acquired: false, reason: "busy" };
    }
  } catch (error) {
    client.release();
    return {
      acquired: false,
      reason: "unavailable",
      error: error instanceof Error ? error.message : String(error),
    };
  }
  let released = false;
  return {
    acquired: true,
    lock: {
      key,
      classId,
      objectId,
      release: async () => {
        if (released) return;
        released = true;
        try {
          await client.query("SELECT pg_advisory_unlock($1::int, $2::int)", [classId, objectId]);
        } catch {
          // A connection that died releases its advisory locks anyway.
        } finally {
          client.release();
        }
      },
    },
  };
}

export type WithLockResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "busy" | "unavailable"; error?: string };

/**
 * Run `fn` while holding `key` across processes; `busy` when another instance
 * (or another request in this one) holds it.
 *
 * The lock is released in a `finally`, so a thrown error cannot leak it, and it
 * is released even if the caller forgets — the process-wide handle is the only
 * reference.
 */
export async function withDistributedLock<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<WithLockResult<T>> {
  const attempt = await tryAcquireLock(key);
  if (!attempt.acquired) return { ok: false, reason: attempt.reason, error: attempt.error };
  try {
    return { ok: true, value: await fn() };
  } finally {
    await attempt.lock.release();
  }
}

/** Whether another session currently holds the lock — for the console's status line. */
export async function lockIsHeld(key: string): Promise<boolean> {
  const { classId, objectId } = lockIdsFor(key);
  try {
    const { rows } = await query<{ held: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_locks
          WHERE locktype = 'advisory'
            AND classid = $1::int AND objid = $2::int AND objsubid = 2
       ) AS held`,
      [classId, objectId],
    );
    return Boolean(rows[0]?.held);
  } catch {
    return false;
  }
}
