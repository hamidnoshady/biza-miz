import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  role: vi.fn(),
  profile: vi.fn(),
  config: vi.fn(),
  runNow: vi.fn(),
  cloudUpload: vi.fn(),
  s3Delete: vi.fn(),
  rows: vi.fn(),
  resolveOwned: vi.fn(),
  markState: vi.fn(),
  schemaVersion: vi.fn(),
  includedBytes: vi.fn(),
  custody: vi.fn(),
  drain: vi.fn(),
  queueDepth: vi.fn(),
  heartbeat: vi.fn(),
  fetchCloud: vi.fn(),
  verify: vi.fn(),
  policy: vi.fn(),
  storage: vi.fn(),
  fsStat: vi.fn(),
  fsRm: vi.fn(),
}));

vi.mock("./deployment-role", () => ({ deploymentRole: mocks.role }));
vi.mock("./deployment-mode", () => ({ readDeploymentProfile: mocks.profile }));
vi.mock("./backup-service", () => ({
  getBackupConfig: mocks.config,
  runBackupNow: mocks.runNow,
  runCloudUpload: mocks.cloudUpload,
}));
vi.mock("./s3-lite", () => ({ s3Delete: mocks.s3Delete }));
vi.mock("./tenant-backup-artifacts-service", () => ({
  listStoredArtifactRows: mocks.rows,
  resolveOwnedArtifact: mocks.resolveOwned,
  markArtifactStateByRef: mocks.markState,
  installedSchemaVersion: mocks.schemaVersion,
  storageIncludedBytes: mocks.includedBytes,
  businessCustodySummary: mocks.custody,
}));
vi.mock("./tenant-backup-hybrid", () => ({
  drainUploadQueue: mocks.drain,
  queueDepth: mocks.queueDepth,
  readHeartbeat: mocks.heartbeat,
}));
vi.mock("./tenant-backup-transport", () => ({ fetchCloudArtifact: mocks.fetchCloud }));
vi.mock("./tenant-backup-runner", () => ({ verifyStoredArtifact: mocks.verify }));
vi.mock("./tenant-backup-storage", () => ({
  resolveTenantBackupPolicy: mocks.policy,
  resolveTenantStorage: mocks.storage,
}));
vi.mock("node:fs", () => ({
  promises: { stat: mocks.fsStat, rm: mocks.fsRm },
}));

import {
  catchUpBusinessUploads,
  deleteBusinessArtifact,
  diagnoseBusinessBackup,
  runBusinessBackup,
  verifyBusinessArtifact,
} from "./platform-tenant-backup-ops";

const BUSINESS = "11111111-1111-4111-8111-111111111111";

function policy(patch: Record<string, unknown> = {}) {
  return {
    intervalHours: 24,
    retentionDays: 30,
    maxRetentionDays: 365,
    keepCount: 30,
    protectedCopies: 1,
    source: "managed",
    managedCloud: true,
    ...patch,
  };
}

function artifactRow(patch: Record<string, unknown> = {}) {
  return {
    id: "row-1",
    artifactId: "artifact-1",
    businessId: BUSINESS,
    destination: "local",
    format: "logical_snapshot",
    origin: "scheduled",
    state: "ready",
    payloadBytes: 1024,
    storedBytes: 1024,
    capturedAt: new Date().toISOString(),
    verifiedAt: null,
    retentionUntil: null,
    lastRestoreAt: null,
    completeness: "complete",
    encryption: "managed_envelope_v1",
    keyVersion: 1,
    storageRef: "artifact-1.dump.enc",
    failureCode: null,
    sha256: "sha",
    manifest: null,
    manifestSignature: null,
    runId: null,
    createdBy: null,
    ...patch,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.role.mockReturnValue("central");
  mocks.profile.mockResolvedValue({ profile: "cloud" });
  mocks.config.mockResolvedValue({ directory: "", cloud: { enabled: false } });
  mocks.rows.mockResolvedValue([artifactRow()]);
  mocks.includedBytes.mockResolvedValue(4096);
  mocks.custody.mockResolvedValue({ scheme: "managed_envelope_v1", activeVersion: 3, kekAvailable: true });
  mocks.queueDepth.mockResolvedValue(0);
  mocks.heartbeat.mockResolvedValue(null);
  mocks.policy.mockResolvedValue(policy());
  mocks.storage.mockResolvedValue({ mode: "managed", prefix: "p/", s3: {}, keepCount: 30 });
  mocks.schemaVersion.mockResolvedValue(268);
  mocks.fsStat.mockResolvedValue({ size: 10 });
  mocks.fsRm.mockResolvedValue(undefined);
});

describe("diagnoseBusinessBackup", () => {
  it("reports a healthy business without inventing problems", async () => {
    const diagnosis = await diagnoseBusinessBackup(BUSINESS);
    expect(diagnosis.destination).toEqual({ mode: "managed", reason: null });
    expect(diagnosis.artifacts.ready).toBe(1);
    expect(diagnosis.actions).toEqual([]);
    expect(diagnosis.custody).toEqual({ keyVersion: 3, kekAvailable: true });
  });

  it("names every real gap an operator has to act on", async () => {
    mocks.storage.mockResolvedValue({ mode: "unavailable", reason: "managed_storage_disabled" });
    mocks.custody.mockResolvedValue({ scheme: "unconfigured", activeVersion: null });
    mocks.rows.mockResolvedValue([
      artifactRow({ id: "row-1", state: "failed" }),
      artifactRow({ id: "row-2", artifactId: "artifact-2", state: "pending_upload" }),
    ]);
    mocks.queueDepth.mockResolvedValue(2);
    mocks.heartbeat.mockResolvedValue({
      connectivity: "offline",
      lastSeenAt: new Date(0).toISOString(),
      siteGeneration: 4,
      acceptedGeneration: 2,
      lastErrorCode: "upload_failed",
    });

    const diagnosis = await diagnoseBusinessBackup(BUSINESS);
    expect(diagnosis.artifacts).toMatchObject({ failed: 1, pending_upload: 1, ready: 0, total: 2 });
    expect(diagnosis.queue.pending).toBe(2);
    expect(diagnosis.device).toMatchObject({ connectivity: "offline", siteGeneration: 4 });
    expect(diagnosis.actions).toEqual(
      expect.arrayContaining([
        "destination_not_configured",
        "custody_unavailable",
        "artifacts_failed",
        "artifacts_never_verified",
        "uploads_pending",
        "uploads_dead",
        "device_offline",
      ]),
    );
  });

  it("says a business has nothing yet instead of implying it is protected", async () => {
    mocks.rows.mockResolvedValue([]);
    const diagnosis = await diagnoseBusinessBackup(BUSINESS);
    expect(diagnosis.artifacts.total).toBe(0);
    expect(diagnosis.actions).toContain("no_artifact_yet");
  });
});

describe("runBusinessBackup", () => {
  it("returns the run's destinations when it worked", async () => {
    mocks.runNow.mockResolvedValue({
      local: { status: "ok", runId: "run-1", sizeBytes: 10, mode: "logical" },
      cloud: { status: "ok" },
    });
    await expect(runBusinessBackup(BUSINESS)).resolves.toMatchObject({
      ok: true,
      local: { status: "ok", runId: "run-1" },
      cloud: { status: "ok" },
    });
  });

  it("reduces a failure to a code so no path or key leaves the server", async () => {
    mocks.runNow.mockResolvedValue({
      local: { status: "failed", error: "/srv/secret/path.dump: permission denied" },
      cloud: { status: "disabled" },
    });
    await expect(runBusinessBackup(BUSINESS)).resolves.toEqual({
      ok: false,
      error: "backup_run_failed",
    });
  });

  it("treats a busy install as an outcome, not a failure", async () => {
    mocks.runNow.mockResolvedValue({ local: { status: "busy" }, cloud: { status: "disabled" } });
    const result = await runBusinessBackup(BUSINESS);
    expect(result.ok).toBe(true);
    expect(result.ok && "local" in result && result.local.status).toBe("busy");
  });
});

describe("catchUpBusinessUploads", () => {
  it("drains the same queue the device filled and reports what is left", async () => {
    mocks.drain.mockImplementation(async (_id: string, handle: (name: string) => Promise<unknown>) => {
      await handle("a.dump.enc");
      await handle("b.dump.enc");
    });
    mocks.cloudUpload
      .mockResolvedValueOnce({ status: "ok" })
      .mockResolvedValueOnce({ status: "disabled" });
    mocks.queueDepth.mockResolvedValue(1);

    await expect(catchUpBusinessUploads(BUSINESS)).resolves.toEqual({
      attempted: 2,
      uploaded: 1,
      failed: 1,
      remaining: 1,
    });
  });
});

describe("verifyBusinessArtifact", () => {
  it("promotes an artifact only after the bytes proved themselves", async () => {
    mocks.resolveOwned.mockResolvedValue(artifactRow({ state: "failed" }));
    mocks.fsStat.mockResolvedValue({ size: 10 });
    mocks.verify.mockResolvedValue({ ok: true, tables: 12 });

    await expect(verifyBusinessArtifact(BUSINESS, "ref-1")).resolves.toEqual({
      ok: true,
      state: "ready",
      tables: 12,
    });
    expect(mocks.markState).toHaveBeenCalledWith(BUSINESS, "ref-1", { state: "ready", failureCode: null });
  });

  it("marks a re-failed artifact failed with the provider-neutral code", async () => {
    mocks.resolveOwned.mockResolvedValue(artifactRow());
    mocks.verify.mockResolvedValue({ ok: false, error: "artifact_checksum_mismatch" });

    await expect(verifyBusinessArtifact(BUSINESS, "ref-1")).resolves.toEqual({
      ok: false,
      error: "artifact_checksum_mismatch",
    });
    expect(mocks.markState).toHaveBeenCalledWith(BUSINESS, "ref-1", {
      state: "failed",
      failureCode: "artifact_checksum_mismatch",
    });
  });

  it("never verifies a reference belonging to another business", async () => {
    mocks.resolveOwned.mockResolvedValue(null);
    await expect(verifyBusinessArtifact(BUSINESS, "foreign-ref")).resolves.toEqual({
      ok: false,
      error: "artifact_not_found",
    });
    expect(mocks.verify).not.toHaveBeenCalled();
  });
});

describe("deleteBusinessArtifact", () => {
  it("refuses to destroy the last protected recovery copy", async () => {
    mocks.resolveOwned.mockResolvedValue(artifactRow());
    await expect(deleteBusinessArtifact(BUSINESS, "ref-1")).resolves.toEqual({
      ok: false,
      error: "protected_copies",
    });
    expect(mocks.fsRm).not.toHaveBeenCalled();
    expect(mocks.markState).not.toHaveBeenCalled();
  });

  it("counts logical backups, not rows, when deciding what is protected", async () => {
    // One logical backup mirrored to two destinations: deleting one row still
    // leaves one restorable backup, so the floor of 1 is respected.
    mocks.rows.mockResolvedValue([
      artifactRow({ id: "row-1", destination: "local" }),
      artifactRow({ id: "row-2", destination: "cloud" }),
      artifactRow({ id: "row-3", artifactId: "artifact-2" }),
    ]);
    mocks.resolveOwned.mockResolvedValue(artifactRow({ id: "row-2", destination: "cloud" }));

    await expect(deleteBusinessArtifact(BUSINESS, "ref-2")).resolves.toEqual({
      ok: true,
      state: "expired",
      deletedBytes: true,
    });
    expect(mocks.markState).toHaveBeenCalledWith(BUSINESS, "ref-2", {
      state: "expired",
      failureCode: "deleted_by_operator",
    });
  });

  it("does not claim a deletion it could not perform", async () => {
    mocks.rows.mockResolvedValue([
      artifactRow({ id: "row-1" }),
      artifactRow({ id: "row-2", artifactId: "artifact-2" }),
    ]);
    mocks.resolveOwned.mockResolvedValue(artifactRow({ destination: "cloud" }));
    mocks.s3Delete.mockRejectedValue(new Error("AccessDenied"));

    await expect(deleteBusinessArtifact(BUSINESS, "ref-1")).resolves.toEqual({
      ok: false,
      error: "storage_delete_failed",
    });
    expect(mocks.markState).not.toHaveBeenCalled();
  });
});
