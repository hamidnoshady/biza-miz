import { afterEach, describe, expect, it, vi } from "vitest";
import { LOCK_KEYS, lockIdsFor, lockIsHeld, tryAcquireLock, withDistributedLock } from "./db-locks";

/**
 * Issue #807 — cross-process locking, the part that needs no database.
 *
 * The key derivation must be identical in every process (that is the whole
 * point of an advisory lock), so it is pinned here; the actual mutual exclusion
 * against a second session is proven in
 * `integration/backup-locks.integration.test.ts`.
 */
describe("lock key derivation", () => {
  it("maps a key to a stable int4 pair, in every process and run", () => {
    const first = lockIdsFor(LOCK_KEYS.platformRestore);
    const again = lockIdsFor("restore:platform");
    expect(again).toEqual(first);
    expect(Number.isInteger(first.classId)).toBe(true);
    expect(Number.isInteger(first.objectId)).toBe(true);
    expect(first.classId).toBeGreaterThanOrEqual(-(2 ** 31));
    expect(first.classId).toBeLessThan(2 ** 31);
    // A stable literal, so a future refactor that changes the hash scheme is
    // caught by this test rather than by two instances failing to see each
    // other's locks in production.
    expect(first).toEqual({ classId: -2034055664, objectId: 1172252309 });
  });

  it("gives each namespaced key its own mutex", () => {
    const keys = [
      LOCK_KEYS.platformBackup,
      LOCK_KEYS.platformRestore,
      LOCK_KEYS.setupRestore,
      LOCK_KEYS.tenantPhysicalBackup("biz-1"),
      LOCK_KEYS.tenantSnapshot("biz-1"),
      LOCK_KEYS.tenantRestore("biz-1"),
      LOCK_KEYS.tenantPhysicalBackup("biz-2"),
    ];
    const seen = new Set(keys.map((key) => JSON.stringify(lockIdsFor(key))));
    expect(seen.size).toBe(keys.length);
    expect(LOCK_KEYS.tenantRestore("biz-1")).toBe("restore:tenant:biz-1");
    expect(LOCK_KEYS.tenantSnapshot("biz-1")).toBe("backup:tenant-snapshot:biz-1");
  });
});

describe("database failures are reported, never thrown", () => {
  const original = process.env.DATABASE_URL;

  afterEach(() => {
    if (original === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = original;
  });

  it("answers unavailable when the pool cannot be created", async () => {
    delete process.env.DATABASE_URL;
    const attempt = await tryAcquireLock(LOCK_KEYS.platformBackup);
    expect(attempt.acquired).toBe(false);
    expect(attempt.acquired ? "" : attempt.reason).toBe("unavailable");
    expect(attempt.acquired ? "" : attempt.error).toContain("DATABASE_URL");

    const locked = await withDistributedLock(LOCK_KEYS.platformBackup, async () => {
      throw new Error("the callback must not run without the lock");
    });
    expect(locked).toEqual({ ok: false, reason: "unavailable", error: "DATABASE_URL is not set" });

    // The status probe is a best-effort read: an unreachable database is not an
    // error the caller has to handle, it is "no lock observed".
    expect(await lockIsHeld(LOCK_KEYS.platformBackup)).toBe(false);
  });

  it("never runs the callback when the lock cannot be taken", async () => {
    delete process.env.DATABASE_URL;
    const fn = vi.fn(async () => "should not happen");
    const result = await withDistributedLock(LOCK_KEYS.tenantRestore("b"), fn);
    expect(result.ok).toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });
});
