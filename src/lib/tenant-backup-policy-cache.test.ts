/**
 * Issue #903 §3 — cached policy + reconciliation.
 *
 * These cases use a real file in the OS temp directory (the cache is a file by
 * design, and the atomic write/rename is worth exercising) and stub the database
 * layer only, so `resolveTenantBackupPolicy` runs for real.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ service: vi.fn(), override: vi.fn() }));

vi.mock("./db", () => ({
  query: vi.fn(),
  // The resolver wraps its reads in the documented "platform-only" helper; the
  // mock has to run the callback, otherwise the simulated failure never happens.
  withoutTenantScope: vi.fn(async (_tag: string, fn: () => Promise<unknown>) => fn()),
  withTenantScope: vi.fn(),
}));

import {
  POLICY_CACHE_MAX_AGE_MS,
  clearCachedPolicy,
  readCachedPolicy,
  writeCachedPolicy,
} from "./tenant-backup-policy-cache";
import { SAFE_TENANT_BACKUP_POLICY, resolveTenantBackupPolicy } from "./tenant-backup-storage";

let cacheFile: string;

beforeEach(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "policy-cache-"));
  cacheFile = path.join(dir, "tenant-backup-policy-cache.json");
  process.env.TENANT_BACKUP_POLICY_CACHE_FILE = cacheFile;
  db.service.mockReset();
  db.override.mockReset();
});

afterEach(async () => {
  await fs.rm(path.dirname(cacheFile), { recursive: true, force: true });
  delete process.env.TENANT_BACKUP_POLICY_CACHE_FILE;
});

const managed = {
  intervalHours: 6,
  retentionDays: 90,
  maxRetentionDays: 30,
  keepCount: 12,
  protectedCopies: 3,
  maxParallelUploads: 4,
  source: "managed" as const,
  managedCloud: true,
  override: false,
  requireRestoreApproval: false,
};

describe("policy cache", () => {
  it("round-trips a policy the platform actually answered with", async () => {
    expect(await writeCachedPolicy(managed, { now: new Date("2026-10-28T00:00:00Z") })).toBe(true);
    const cached = await readCachedPolicy(undefined, new Date("2026-10-29T00:00:00Z"));
    expect(cached).toMatchObject({
      intervalHours: 6,
      retentionDays: 90,
      keepCount: 12,
      maxParallelUploads: 4,
      source: "cached",
      cachedAt: "2026-10-28T00:00:00.000Z",
    });
  });

  it("refuses to cache a guess", async () => {
    expect(await writeCachedPolicy({ ...SAFE_TENANT_BACKUP_POLICY })).toBe(false);
    expect(await readCachedPolicy()).toBeNull();
  });

  it("ignores a cache older than the reconciliation window", async () => {
    await writeCachedPolicy(managed, { now: new Date("2026-01-01T00:00:00Z") });
    const stale = new Date(Date.parse("2026-01-01T00:00:00Z") + POLICY_CACHE_MAX_AGE_MS + 1000);
    expect(await readCachedPolicy(undefined, stale)).toBeNull();
  });

  it("treats a corrupt file as no cache, rather than throwing into a backup", async () => {
    await fs.writeFile(cacheFile, "{not json", "utf8");
    expect(await readCachedPolicy()).toBeNull();
  });

  it("rejects a cache whose numbers are outside what the fleet could have said", async () => {
    await fs.writeFile(
      cacheFile,
      JSON.stringify({
        version: 2,
        entries: {
          "*": {
            cachedAt: new Date().toISOString(),
            intervalHours: 5,
            retentionDays: 99999,
          },
        },
      }),
      "utf8",
    );
    expect(await readCachedPolicy()).toBeNull();
  });

  it("never hands one business another business's override", async () => {
    await writeCachedPolicy({ ...managed, retentionDays: 90 }, { businessId: "business-a" });
    await writeCachedPolicy({ ...managed, retentionDays: 7 }, { businessId: "business-b" });

    expect((await readCachedPolicy("business-a"))?.retentionDays).toBe(90);
    expect((await readCachedPolicy("business-b"))?.retentionDays).toBe(7);
    // The fleet-level answer is a separate entry, not "whichever was last".
    expect(await readCachedPolicy(undefined)).toBeNull();
  });

  it("clears on request", async () => {
    await writeCachedPolicy(managed);
    await clearCachedPolicy();
    expect(await readCachedPolicy()).toBeNull();
  });
});

describe("resolveTenantBackupPolicy with a device cache", () => {
  it("falls back to the remembered policy when the fleet row is unreachable", async () => {
    await writeCachedPolicy(managed, { businessId: "business-a" });

    const policy = await resolveWithBrokenFleet();
    expect(policy.source).toBe("cached");
    expect(policy.intervalHours).toBe(6);
    expect(policy.retentionDays).toBe(90);
  });

  it("replaces the cache when the platform answers again (reconciliation)", async () => {
    // Yesterday's answer, then a fleet row that has since changed.
    await writeCachedPolicy({ ...managed, retentionDays: 90 }, { businessId: "business-a", now: new Date(Date.now() - 86_400_000) });

    const { query } = await import("./db");
    vi.mocked(query).mockImplementation(async (sql: string) => {
      if (sql.includes("platform_tenant_backup_service")) {
        return {
          rows: [{
            managed_cloud: true,
            hybrid_enabled: false,
            endpoint: "https://s3.example",
            region: "us-east-1",
            bucket: "managed",
            key_prefix: "backups/",
            access_key_sealed: null,
            secret_key_sealed: null,
            access_key_hint: null,
            default_interval_hours: 12,
            default_retention_days: 14,
            max_retention_days: 365,
            cloud_keep_count: 30,
            max_artifact_bytes: 1_000_000,
            upload_chunk_bytes: 1_000_000,
            max_parallel_uploads: 3,
            protected_recovery_copies: 1,
            last_checked_at: null,
            last_check_ok: null,
            last_error_code: null,
            updated_at: new Date().toISOString(),
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });

    const policy = await resolveTenantBackupPolicy("business-a");
    expect(policy.source).toBe("managed");
    expect(policy.retentionDays).toBe(14);

    const cached = await readCachedPolicy("business-a");
    expect(cached).toMatchObject({ retentionDays: 14, intervalHours: 12, source: "cached" });
  });

  it("reports the hard-coded defaults when there is nothing remembered either", async () => {
    const policy = await resolveWithBrokenFleet();
    expect(policy.source).toBe("default");
    expect(policy).toMatchObject({
      intervalHours: SAFE_TENANT_BACKUP_POLICY.intervalHours,
      retentionDays: SAFE_TENANT_BACKUP_POLICY.retentionDays,
    });
  });
});

async function resolveWithBrokenFleet() {
  // `readTenantBackupService` talks to `query` from ./db; an unmatched call
  // throws, which is exactly the unreachable-platform path.
  const { query } = await import("./db");
  vi.mocked(query).mockRejectedValue(new Error("connect ECONNREFUSED"));
  return resolveTenantBackupPolicy("business-a");
}
