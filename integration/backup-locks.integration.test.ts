/**
 * Issue #807 — cross-process locking, proved with two real PostgreSQL sessions.
 *
 * The audit found the old guards were process-local JavaScript (`new Set`,
 * `let restoreInFlight = false`), so a second Node instance on a central
 * deployment could start a second whole-platform restore — two processes
 * renaming and dropping the same database. The fix is a session-level
 * `pg_try_advisory_lock`, and this file proves the two properties that matter:
 *
 *   1. exclusion is *between connections*, not inside one process (the second
 *      session here is a plain `pg.Client`, standing in for the other instance);
 *   2. the lock is released by the session ending, so a crashed process cannot
 *      leave the deployment permanently unable to back up.
 *
 * Advisory locks live in a database, and nothing else about this test needs the
 * schema, so it runs against the maintenance database rather than creating (and
 * migrating) another one.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let dbLib: typeof import("../src/lib/db");
let locks: typeof import("../src/lib/db-locks");
/** A second, independent session — the other instance of the deployment. */
let other: Client;

function otherUrl(): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = "/postgres";
  url.searchParams.set("application_name", `pos-lock-test-${randomUUID().slice(0, 8)}`);
  return url.toString();
}

beforeAll(async () => {
  process.env.DATABASE_URL = otherUrl();
  dbLib = await import("../src/lib/db");
  locks = await import("../src/lib/db-locks");
  other = new Client({ connectionString: otherUrl() });
  await other.connect();
});

afterAll(async () => {
  await other?.end().catch(() => {});
  await dbLib?.closeDatabasePool().catch(() => {});
});

/** `pg_try_advisory_lock` as the other session sees it. */
async function otherHolds(key: string): Promise<boolean> {
  const { classId, objectId } = locks.lockIdsFor(key);
  const { rows } = await other.query<{ locked: boolean }>(
    "SELECT pg_try_advisory_lock($1::int, $2::int) AS locked",
    [classId, objectId],
  );
  const locked = Boolean(rows[0]?.locked);
  if (locked) {
    await other.query("SELECT pg_advisory_unlock($1::int, $2::int)", [classId, objectId]);
  }
  return locked;
}

describe("one mutex per lock key across sessions", () => {
  it("refuses a second holder and hands the key over on release", async () => {
    const key = locks.LOCK_KEYS.platformRestore;
    const attempt = await locks.tryAcquireLock(key);
    expect(attempt.acquired).toBe(true);
    if (!attempt.acquired) return;
    try {
      // The other session cannot take it while we hold it…
      expect(await otherHolds(key)).toBe(false);
      expect(await locks.lockIsHeld(key)).toBe(true);
    } finally {
      await attempt.lock.release();
    }
    // …and can, once released.
    expect(await otherHolds(key)).toBe(true);
    expect(await locks.lockIsHeld(key)).toBe(false);
  });

  it("releases the lock when the holding session goes away", async () => {
    const key = locks.LOCK_KEYS.platformBackup;
    const session = new Client({ connectionString: otherUrl() });
    await session.connect();
    const { classId, objectId } = locks.lockIdsFor(key);
    await session.query("SELECT pg_try_advisory_lock($1::int, $2::int)", [classId, objectId]);

    const busy = await locks.tryAcquireLock(key);
    expect(busy.acquired).toBe(false);
    expect(busy.acquired ? "" : busy.reason).toBe("busy");

    // A crashed process is an ended session — no lease to expire, no cleanup
    // job, no dead key that blocks tonight's backup.
    await session.end();

    const attempt = await locks.tryAcquireLock(key);
    expect(attempt.acquired).toBe(true);
    if (attempt.acquired) await attempt.lock.release();
  });

  it("reports busy rather than queueing, and never runs the callback", async () => {
    const key = locks.LOCK_KEYS.platformBackup;
    const held = await locks.tryAcquireLock(key);
    expect(held.acquired).toBe(true);
    if (!held.acquired) return;
    let ran = false;
    try {
      const result = await locks.withDistributedLock(key, async () => {
        ran = true;
        return "should not run";
      });
      expect(result).toEqual({ ok: false, reason: "busy" });
      expect(ran).toBe(false);
    } finally {
      await held.lock.release();
    }
  });

  it("lets exactly one of several concurrent attempts win", async () => {
    const key = locks.LOCK_KEYS.tenantRestore("11111111-2222-3333-4444-555555555555");
    // The callback has to still be running when the other attempts arrive: the
    // lock is a mutex, not a queue, so a callback that finishes instantly is
    // followed by a *successful* second attempt rather than a "busy" one.
    const results = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        locks.withDistributedLock(key, async () => {
          await new Promise((resolve) => setTimeout(resolve, 150));
          return `ran-${index}`;
        }),
      ),
    );
    expect(results.filter((r) => r.ok).length).toBe(1);
    expect(results.filter((r) => !r.ok).length).toBe(3);
    for (const result of results) {
      if (!result.ok) expect(result.reason).toBe("busy");
    }
  });

  it("keeps unrelated keys independent (a tenant restore is not a platform restore)", async () => {
    const tenant = await locks.tryAcquireLock(locks.LOCK_KEYS.tenantRestore("biz-a"));
    const platform = await locks.tryAcquireLock(locks.LOCK_KEYS.platformRestore);
    expect(tenant.acquired).toBe(true);
    expect(platform.acquired).toBe(true);
    expect(await otherHolds(locks.LOCK_KEYS.tenantPhysicalBackup("biz-a"))).toBe(true);
    if (tenant.acquired) await tenant.lock.release();
    if (platform.acquired) await platform.lock.release();
  });

  it("always releases, even when the locked work throws", async () => {
    const key = locks.LOCK_KEYS.setupRestore;
    await expect(
      locks.withDistributedLock(key, async () => {
        throw new Error("restore exploded");
      }),
    ).rejects.toThrow("restore exploded");
    // A leaked lock would make every later attempt busy.
    const attempt = await locks.tryAcquireLock(key);
    expect(attempt.acquired).toBe(true);
    if (attempt.acquired) await attempt.lock.release();
  });

  it("double-release is harmless", async () => {
    const attempt = await locks.tryAcquireLock(locks.LOCK_KEYS.platformBackup);
    expect(attempt.acquired).toBe(true);
    if (!attempt.acquired) return;
    await attempt.lock.release();
    await expect(attempt.lock.release()).resolves.toBeUndefined();
  });
});
