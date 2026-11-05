/**
 * Issue #903 §1 / §7 — artifact lifecycle.
 *
 * These cases use a real temporary directory (the local-copy rules are about
 * files, and a mocked `fs` would prove nothing) and stub only the database, the
 * provider and the other services.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  scope: vi.fn(),
  tenantScope: vi.fn(async (_businessId: string, fn: () => Promise<unknown>) => fn()),
  config: vi.fn(),
  tenantDir: vi.fn(),
  profile: vi.fn(),
  deleteObject: vi.fn(),
  markState: vi.fn(),
  schemaVersion: vi.fn(),
  verify: vi.fn(),
  fetch: vi.fn(),
  policy: vi.fn(),
  storage: vi.fn(),
}));

vi.mock("./db", () => ({
  query: mocks.query,
  withoutTenantScope: mocks.scope,
  withTenant: mocks.tenantScope,
}));
vi.mock("./backup-service", () => ({
  getBackupConfig: mocks.config,
  tenantBackupDir: mocks.tenantDir,
}));
vi.mock("./deployment-mode", () => ({ readDeploymentProfile: mocks.profile }));
vi.mock("./deployment-role", () => ({ deploymentRole: () => "central" }));
vi.mock("./s3-lite", () => ({ s3Delete: mocks.deleteObject }));
vi.mock("./tenant-backup-artifacts-service", () => ({
  installedSchemaVersion: mocks.schemaVersion,
  markArtifactState: mocks.markState,
}));
vi.mock("./tenant-backup-runner", () => ({ verifyStoredArtifact: mocks.verify }));
vi.mock("./tenant-backup-transport", () => ({ fetchCloudArtifact: mocks.fetch }));
vi.mock("./tenant-backup-storage", () => ({
  resolveTenantBackupPolicy: mocks.policy,
  resolveTenantStorage: mocks.storage,
}));

import { logicalSnapshotScopeTag } from "./backup-policy";
import {
  REVERIFY_AFTER_MS,
  REVERIFY_BATCH,
  VERIFY_BATCH,
  expireDueArtifacts,
  localArtifactPath,
  reclaimCloudStagedLocalCopies,
  removeArtifactBytes,
  reverifyReadyCloudCopies,
  runBackupLifecycleTick,
  verifyPendingCloudCopies,
} from "./tenant-backup-lifecycle";

const now = new Date("2026-10-30T12:00:00Z");
let root: string;
let tenantDir: string;

interface Row {
  id: string;
  artifactId: string;
  destination: "local" | "cloud";
  storageRef: string;
  state: string;
  retentionUntil: string | null;
  storedBytes: number | null;
  verifiedAt: string | null;
}

function row(patch: Partial<Row> = {}): Row {
  return {
    id: "row-1",
    artifactId: "artifact-1",
    destination: "local",
    storageRef: "a.dump.enc",
    state: "ready",
    retentionUntil: null,
    storedBytes: 1024,
    verifiedAt: null,
    ...patch,
  };
}

function serve(rows: Row[]) {
  mocks.query.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (sql.includes("FROM tenant_backup_artifacts") && sql.includes("SELECT id, artifact_id")) {
      return {
        rows: rows.map((entry) => ({
          id: entry.id,
          artifact_id: entry.artifactId,
          destination: entry.destination,
          storage_ref: entry.storageRef,
          state: entry.state,
          retention_until: entry.retentionUntil ? new Date(entry.retentionUntil) : null,
          stored_bytes: entry.storedBytes === null ? null : String(entry.storedBytes),
          verified_at: entry.verifiedAt ? new Date(entry.verifiedAt) : null,
        })),
        rowCount: rows.length,
      };
    }
    if (sql.includes("DELETE FROM tenant_backup_artifacts")) {
      return { rows: [], rowCount: 1, params };
    }
    return { rows: [], rowCount: 0 };
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  root = await fs.mkdtemp(path.join(os.tmpdir(), "backup-lifecycle-"));
  tenantDir = path.join(root, "tenants", "scope-tag");
  await fs.mkdir(tenantDir, { recursive: true });

  mocks.scope.mockImplementation(async (_tag: string, fn: () => Promise<unknown>) => fn());
  mocks.tenantDir.mockReturnValue(tenantDir);
  mocks.config.mockResolvedValue({ directory: null, cloud: { enabled: true } });
  mocks.profile.mockResolvedValue({ profile: "cloud" });
  mocks.deleteObject.mockResolvedValue(undefined);
  mocks.markState.mockResolvedValue(true);
  mocks.schemaVersion.mockResolvedValue(7);
  mocks.verify.mockResolvedValue({ ok: true, tables: 3 });
  mocks.policy.mockResolvedValue({ protectedCopies: 1, retentionDays: 30 });
  mocks.storage.mockResolvedValue({ mode: "managed", prefix: "backups/", s3: {}, keepCount: 30 });
  mocks.fetch.mockResolvedValue({
    ok: true,
    path: path.join(tenantDir, "a.dump.enc"),
    cleanup: async () => {},
  });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function put(file: string) {
  await fs.writeFile(file, "ciphertext");
}

async function exists(file: string) {
  try {
    await fs.stat(file);
    return true;
  } catch {
    return false;
  }
}

describe("localArtifactPath", () => {
  it("finds a tenant artifact in its own subdirectory, not the flat backup root", async () => {
    await put(path.join(tenantDir, "a.dump.enc"));
    // The same name at the deployment root is a different file that must not be
    // mistaken for this tenant's (central keeps one directory per business).
    await put(path.join(root, "a.dump.enc"));

    const located = await localArtifactPath("business-a", "a.dump.enc");
    expect(located).toEqual({ ok: true, path: path.join(tenantDir, "a.dump.enc") });
  });

  it("refuses a name that escapes the tenant directory", async () => {
    await expect(localArtifactPath("business-a", "../secret")).resolves.toEqual({
      ok: false,
      error: "artifact_not_found",
    });
  });

  it("reports a missing file rather than a path", async () => {
    await expect(localArtifactPath("business-a", "gone.enc")).resolves.toEqual({
      ok: false,
      error: "artifact_missing",
    });
  });
});

describe("removeArtifactBytes", () => {
  it("removes a local file and is safe to retry", async () => {
    const file = path.join(tenantDir, "a.dump.enc");
    await put(file);

    await expect(removeArtifactBytes("business-a", row())).resolves.toEqual({ ok: true, removed: true });
    expect(await exists(file)).toBe(false);
    await expect(removeArtifactBytes("business-a", row())).resolves.toEqual({ ok: true, removed: false });
  });

  it("deletes the managed object at the tenant prefix", async () => {
    await expect(
      removeArtifactBytes("business-a", row({ destination: "cloud", storageRef: "b.dump.enc" })),
    ).resolves.toEqual({ ok: true, removed: true });
    expect(mocks.deleteObject).toHaveBeenCalledWith(
      {},
      `backups/tenants/${logicalSnapshotScopeTag("business-a")}/b.dump.enc`,
    );
  });

  it("reports a provider failure instead of pretending the object is gone", async () => {
    mocks.deleteObject.mockRejectedValue(new Error("AccessDenied"));
    await expect(
      removeArtifactBytes("business-a", row({ destination: "cloud" })),
    ).resolves.toEqual({ ok: false, error: "AccessDenied" });
  });
});

describe("expireDueArtifacts", () => {
  const due = { retentionUntil: "2026-01-01T00:00:00.000Z" };

  it("removes the bytes of an artifact past retention and records it", async () => {
    await put(path.join(tenantDir, "a.dump.enc"));
    serve([row(due), row({ id: "row-2", artifactId: "artifact-2", storageRef: "b.dump.enc", state: "ready" })]);
    await put(path.join(tenantDir, "b.dump.enc"));

    const result = await expireDueArtifacts("business-a", now);

    expect(result).toEqual({ expired: 1, protectedSkipped: 0, failedRemovals: 0 });
    expect(await exists(path.join(tenantDir, "a.dump.enc"))).toBe(false);
    // The other backup is untouched.
    expect(await exists(path.join(tenantDir, "b.dump.enc"))).toBe(true);
    expect(mocks.markState).toHaveBeenCalledWith("business-a", "row-1", {
      state: "expired",
      failureCode: "retention_expired",
    });
  });

  it("leaves an artifact inside its retention window alone", async () => {
    serve([row({ retentionUntil: "2026-12-01T00:00:00.000Z" })]);
    const result = await expireDueArtifacts("business-a", now);
    expect(result.expired).toBe(0);
    expect(mocks.markState).not.toHaveBeenCalled();
  });

  it("never crosses the protected-copy floor", async () => {
    mocks.policy.mockResolvedValue({ protectedCopies: 1 });
    await put(path.join(tenantDir, "a.dump.enc"));
    serve([row(due)]);

    const result = await expireDueArtifacts("business-a", now);

    expect(result).toEqual({ expired: 0, protectedSkipped: 1, failedRemovals: 0 });
    expect(await exists(path.join(tenantDir, "a.dump.enc"))).toBe(true);
  });

  it("expires the oldest backup first when the floor allows only some", async () => {
    mocks.policy.mockResolvedValue({ protectedCopies: 1 });
    await put(path.join(tenantDir, "a.dump.enc"));
    await put(path.join(tenantDir, "b.dump.enc"));
    serve([
      row({ ...due, retentionUntil: "2026-01-02T00:00:00.000Z" }),
      row({ id: "row-2", artifactId: "artifact-2", storageRef: "b.dump.enc", ...due }),
    ]);

    const result = await expireDueArtifacts("business-a", now);

    expect(result).toEqual({ expired: 1, protectedSkipped: 1, failedRemovals: 0 });
    // artifact-2 (retention 2026-01-01) went; artifact-1 (2026-01-02) stayed.
    expect(await exists(path.join(tenantDir, "b.dump.enc"))).toBe(false);
    expect(await exists(path.join(tenantDir, "a.dump.enc"))).toBe(true);
  });

  it("expires a mirror's two rows as one backup, without tripping its own floor", async () => {
    mocks.policy.mockResolvedValue({ protectedCopies: 1 });
    await put(path.join(tenantDir, "a.dump.enc"));
    serve([
      row(due),
      row({ id: "row-cloud", destination: "cloud", ...due }),
      row({ id: "row-3", artifactId: "artifact-2", storageRef: "new.dump.enc", state: "ready" }),
    ]);

    const result = await expireDueArtifacts("business-a", now);

    expect(result.expired).toBe(1);
    expect(result.protectedSkipped).toBe(0);
    expect(mocks.markState).toHaveBeenCalledWith("business-a", "row-1", expect.anything());
    expect(mocks.markState).toHaveBeenCalledWith("business-a", "row-cloud", expect.anything());
    expect(mocks.deleteObject).toHaveBeenCalledTimes(1);
  });

  it("does not record a removal whose bytes could not be deleted", async () => {
    mocks.deleteObject.mockRejectedValue(new Error("Timeout"));
    serve([row({ destination: "cloud", ...due }), row({ id: "row-2", artifactId: "artifact-2", state: "ready" })]);

    const result = await expireDueArtifacts("business-a", now);

    expect(result).toEqual({ expired: 0, protectedSkipped: 0, failedRemovals: 1 });
    expect(mocks.markState).not.toHaveBeenCalled();
  });

  it("leaves already-expired and superseded rows out of the sweep", async () => {
    serve([
      row({ id: "row-x", state: "expired", ...due }),
      row({ id: "row-y", artifactId: "artifact-2", state: "superseded", ...due }),
      row({ id: "row-z", artifactId: "artifact-3", state: "ready" }),
    ]);
    const result = await expireDueArtifacts("business-a", now);
    expect(result.expired).toBe(0);
    expect(mocks.markState).not.toHaveBeenCalled();
  });
});

describe("verifyPendingCloudCopies", () => {
  const cloud = (patch: Partial<Row> = {}) =>
    row({ destination: "cloud", state: "verifying", retentionUntil: "2027-01-01T00:00:00.000Z", ...patch });

  it("promotes an uploaded cloud copy only after re-reading the object", async () => {
    serve([cloud()]);
    const result = await verifyPendingCloudCopies("business-a", now);
    expect(result).toEqual({ verified: 1, verifyFailed: 0 });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.markState).toHaveBeenCalledWith("business-a", "row-1", { state: "ready", failureCode: null });
  });

  it("leaves the row `verifying` when the provider cannot be read", async () => {
    mocks.fetch.mockResolvedValue({ ok: false, error: "artifact_fetch_failed" });
    serve([cloud()]);
    const result = await verifyPendingCloudCopies("business-a", now);
    expect(result).toEqual({ verified: 0, verifyFailed: 0 });
    expect(mocks.markState).not.toHaveBeenCalled();
  });

  it("marks a row failed when the bytes arrived and failed their own checks", async () => {
    mocks.verify.mockResolvedValue({ ok: false, error: "archive_signature_invalid" });
    serve([cloud()]);
    const result = await verifyPendingCloudCopies("business-a", now);
    expect(result).toEqual({ verified: 0, verifyFailed: 1 });
    expect(mocks.markState).toHaveBeenCalledWith("business-a", "row-1", {
      state: "failed",
      failureCode: "archive_signature_invalid",
    });
  });

  it("bounds how much it downloads per tick", async () => {
    serve([
      cloud({ id: "r1", artifactId: "a1" }),
      cloud({ id: "r2", artifactId: "a2" }),
      cloud({ id: "r3", artifactId: "a3" }),
    ]);
    await verifyPendingCloudCopies("business-a", now);
    expect(mocks.fetch).toHaveBeenCalledTimes(VERIFY_BATCH);
  });

  it("skips a copy that retention is about to remove anyway", async () => {
    serve([cloud({ retentionUntil: "2026-01-01T00:00:00.000Z" })]);
    const result = await verifyPendingCloudCopies("business-a", now);
    expect(result.verified).toBe(0);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});

describe("reverifyReadyCloudCopies", () => {
  const cloud = (patch: Partial<Row> = {}) =>
    row({ destination: "cloud", state: "ready", retentionUntil: "2027-01-01T00:00:00.000Z", ...patch });

  it("re-reads a ready copy that has not been proved in a week, and keeps it ready", async () => {
    serve([cloud({ verifiedAt: new Date(now.getTime() - REVERIFY_AFTER_MS - 1000).toISOString() })]);
    const result = await reverifyReadyCloudCopies("business-a", now);
    expect(result).toEqual({ reverified: 1, driftDetected: 0 });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    // Still `ready` — but re-marking it moves `verified_at`, which is what takes
    // the row out of the queue for another week.
    expect(mocks.markState).toHaveBeenCalledWith("business-a", "row-1", { state: "ready", failureCode: null });
  });

  it("leaves a copy alone until a week has passed", async () => {
    serve([cloud({ verifiedAt: new Date(now.getTime() - 60 * 60 * 1000).toISOString() })]);
    const result = await reverifyReadyCloudCopies("business-a", now);
    expect(result).toEqual({ reverified: 0, driftDetected: 0 });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("treats a copy that was never proved as due", async () => {
    serve([cloud({ verifiedAt: null })]);
    const result = await reverifyReadyCloudCopies("business-a", now);
    expect(result.reverified).toBe(1);
  });

  it("takes a drifted copy out of the restorable set with the verifier's own code", async () => {
    mocks.verify.mockResolvedValue({ ok: false, error: "artifact_checksum_mismatch" });
    serve([cloud({ verifiedAt: new Date(now.getTime() - REVERIFY_AFTER_MS - 1000).toISOString() })]);
    const result = await reverifyReadyCloudCopies("business-a", now);
    expect(result).toEqual({ reverified: 0, driftDetected: 1 });
    expect(mocks.markState).toHaveBeenCalledWith("business-a", "row-1", {
      state: "failed",
      failureCode: "artifact_checksum_mismatch",
    });
  });

  it("leaves the row alone when the provider cannot be read, so one outage does not fail the fleet", async () => {
    mocks.fetch.mockResolvedValue({ ok: false, error: "artifact_fetch_failed" });
    serve([cloud({ verifiedAt: new Date(now.getTime() - REVERIFY_AFTER_MS - 1000).toISOString() })]);
    const result = await reverifyReadyCloudCopies("business-a", now);
    expect(result).toEqual({ reverified: 0, driftDetected: 0 });
    expect(mocks.markState).not.toHaveBeenCalled();
  });

  it("reads the least recently proved copies first, and only a batch of them", async () => {
    const old = new Date(now.getTime() - REVERIFY_AFTER_MS - 10_000).toISOString();
    const older = new Date(now.getTime() - REVERIFY_AFTER_MS - 90_000).toISOString();
    serve([
      cloud({ id: "r1", artifactId: "a1", verifiedAt: old }),
      cloud({ id: "r2", artifactId: "a2", verifiedAt: older }),
      cloud({ id: "r3", artifactId: "a3", verifiedAt: old }),
    ]);
    await reverifyReadyCloudCopies("business-a", now);
    expect(mocks.fetch).toHaveBeenCalledTimes(REVERIFY_BATCH);
    expect(mocks.markState.mock.calls[0][1]).toBe("r2");
  });

  it("does not re-download a copy retention is about to delete", async () => {
    serve([cloud({ verifiedAt: null, retentionUntil: "2026-01-01T00:00:00.000Z" })]);
    const result = await reverifyReadyCloudCopies("business-a", now);
    expect(result.reverified).toBe(0);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("never touches a local copy — there is no drift to catch without a bucket", async () => {
    serve([row({ destination: "local", state: "ready", verifiedAt: null })]);
    const result = await reverifyReadyCloudCopies("business-a", now);
    expect(result.reverified).toBe(0);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});

describe("reclaimCloudStagedLocalCopies", () => {
  it("removes the staged local twin once the cloud copy is ready", async () => {
    await put(path.join(tenantDir, "a.dump.enc"));
    serve([
      row({ id: "row-local" }),
      row({ id: "row-cloud", destination: "cloud", state: "ready" }),
    ]);

    const result = await reclaimCloudStagedLocalCopies("business-a");

    expect(result).toEqual({ reclaimed: 1, reclaimedBytes: 1024 });
    expect(await exists(path.join(tenantDir, "a.dump.enc"))).toBe(false);
    const deleted = mocks.query.mock.calls.find(([sql]) => String(sql).includes("DELETE FROM tenant_backup_artifacts"));
    expect(deleted?.[1]).toEqual(["business-a", "row-local"]);
  });

  it("keeps the local copy on Hybrid, where it is an approved destination", async () => {
    mocks.profile.mockResolvedValue({ profile: "hybrid" });
    await put(path.join(tenantDir, "a.dump.enc"));
    serve([row({ id: "row-local" }), row({ id: "row-cloud", destination: "cloud", state: "ready" })]);

    expect(await reclaimCloudStagedLocalCopies("business-a")).toEqual({ reclaimed: 0, reclaimedBytes: 0 });
    expect(await exists(path.join(tenantDir, "a.dump.enc"))).toBe(true);
  });

  it("keeps the local copy when the destination is a legacy bucket, not managed storage", async () => {
    mocks.storage.mockResolvedValue({ mode: "legacy", prefix: "", s3: {} });
    await put(path.join(tenantDir, "a.dump.enc"));
    serve([row({ id: "row-local" }), row({ id: "row-cloud", destination: "cloud", state: "ready" })]);

    expect((await reclaimCloudStagedLocalCopies("business-a")).reclaimed).toBe(0);
    expect(await exists(path.join(tenantDir, "a.dump.enc"))).toBe(true);
  });

  it("never removes the last readable copy before the cloud one is proved", async () => {
    await put(path.join(tenantDir, "a.dump.enc"));
    serve([row({ id: "row-local" }), row({ id: "row-cloud", destination: "cloud", state: "verifying" })]);

    expect((await reclaimCloudStagedLocalCopies("business-a")).reclaimed).toBe(0);
    expect(await exists(path.join(tenantDir, "a.dump.enc"))).toBe(true);
  });

  it("keeps the row when the file could not be removed", async () => {
    // A directory where the file should be makes `rm` fail without `recursive`.
    await fs.mkdir(path.join(tenantDir, "a.dump.enc", "child"), { recursive: true });
    serve([row({ id: "row-local" }), row({ id: "row-cloud", destination: "cloud", state: "ready" })]);

    expect((await reclaimCloudStagedLocalCopies("business-a")).reclaimed).toBe(0);
    expect(
      mocks.query.mock.calls.some(([sql]) => String(sql).includes("DELETE FROM tenant_backup_artifacts")),
    ).toBe(false);
  });
});

describe("runBackupLifecycleTick", () => {
  it("walks every business that holds artifacts", async () => {
    await put(path.join(tenantDir, "a.dump.enc"));
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT DISTINCT business_id")) {
        return { rows: [{ business_id: "business-a" }, { business_id: "business-b" }], rowCount: 2 };
      }
      return { rows: [], rowCount: 0 };
    });

    const outcome = await runBackupLifecycleTick(now);
    expect(outcome.reclaimed + outcome.expired + outcome.verified).toBe(0);
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("SELECT DISTINCT business_id"));
    // Each business's passes read tenant-scoped rows, so they must run inside
    // that business's RLS scope — the fleet query alone is a bypass.
    expect(mocks.tenantScope.mock.calls.map(([businessId]) => businessId)).toEqual([
      "business-a",
      "business-b",
    ]);
  });

  it("does not let one broken business stop the others", async () => {
    let call = 0;
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT DISTINCT business_id")) {
        return { rows: [{ business_id: "business-a" }, { business_id: "business-b" }], rowCount: 2 };
      }
      call += 1;
      if (call === 1) throw new Error("relation does not exist");
      return { rows: [], rowCount: 0 };
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(runBackupLifecycleTick(now)).resolves.toBeTruthy();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("business-a"),
      expect.stringContaining("relation does not exist"),
    );
    errorSpy.mockRestore();
  });
});
