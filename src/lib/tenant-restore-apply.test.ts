import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  withTenantTransaction: vi.fn(),
  lockIsHeld: vi.fn(),
  withDistributedLock: vi.fn(),
  resolveOwnedArtifact: vi.fn(),
  tryAppendRestoreJournal: vi.fn(),
  exportTenantData: vi.fn(),
  installedSchemaVersion: vi.fn(),
  applyTenantArchive: vi.fn(),
  loadArchive: vi.fn(),
}));

vi.mock("./db", () => ({
  query: mocks.query,
  withTenantTransaction: mocks.withTenantTransaction,
}));
vi.mock("./db-locks", () => ({
  LOCK_KEYS: { tenantRestore: (businessId: string) => `restore:tenant:${businessId}` },
  lockIsHeld: mocks.lockIsHeld,
  withDistributedLock: mocks.withDistributedLock,
}));
vi.mock("./restore-journal", () => ({
  newRestoreJournalId: () => "journal-1",
  restoreJournalDir: () => "/tmp/journal",
  tryAppendRestoreJournal: mocks.tryAppendRestoreJournal,
}));
vi.mock("./tenant-backup-artifacts-service", () => ({
  resolveOwnedArtifact: mocks.resolveOwnedArtifact,
  markArtifactStateByRef: vi.fn(async () => true),
  installedSchemaVersion: mocks.installedSchemaVersion,
}));
vi.mock("./tenant-export", () => ({ exportTenantData: mocks.exportTenantData }));
vi.mock("./tenant-tables", () => ({
  tenantTablesInDependencyOrder: vi.fn(async () => ["accounts", "orders"]),
  // The archive allowlist is the tenant export set; `businesses` is exported but
  // is the identity row an archive never carries.
  listTenantTables: vi.fn(async () => ["businesses", "accounts", "orders"]),
}));
vi.mock("./tenant-archive", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tenant-archive")>();
  return { ...actual, applyTenantArchive: mocks.applyTenantArchive };
});
vi.mock("./tenant-backup-runner", () => ({ decryptionSecretFor: vi.fn(async () => ({ ok: true, secret: "k" })) }));
vi.mock("./tenant-backup-storage", () => ({
  ensureStagingDir: vi.fn(async () => "/tmp/staging"),
  cleanupStagingDir: vi.fn(),
}));
vi.mock("./tenant-backup-transport", () => ({
  fetchCloudArtifact: vi.fn(),
  planArtifactDownload: vi.fn(async () => ({ kind: "stream", path: "/backups/x.enc", sizeBytes: 10, encryption: "managed" })),
}));
vi.mock("./backup-streams", () => ({ decryptFileToFile: vi.fn(async () => undefined) }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const promises = {
    ...actual.promises,
    readFile: vi.fn(async () => ARCHIVE_JSON),
    writeFile: vi.fn(async () => undefined),
    copyFile: vi.fn(async () => undefined),
    rm: vi.fn(async () => undefined),
    mkdir: vi.fn(async () => undefined),
  };
  return { ...actual, promises };
});

import {
  APPLY_REFUSALS,
  RESTORE_PROTECTED_TABLES,
  applyTenantRestore,
  checkRestorableTables,
  mapApplyError,
  restoreTableOrder,
} from "./tenant-restore-apply";
import type { RestorePreview } from "./tenant-restore-preview";

const BUSINESS = "11111111-1111-4111-8111-111111111111";

const ARCHIVE_JSON = JSON.stringify({
  magic: "POSTARC1",
  version: 1,
  businessId: BUSINESS,
  capturedAt: "2026-10-27T00:00:00.000Z",
  schemaVersion: 268,
  tables: [{ name: "accounts", columns: ["id"], rows: [{ id: "a1" }] }],
});

/** A managed artifact row healthy enough to be loaded and applied. */
function readyArtifact() {
  return {
    businessId: BUSINESS,
    state: "ready",
    format: "logical_snapshot",
    manifest: { payloadFormat: "tenant_archive_v1", schemaVersion: 268 },
    destination: "local",
    storageRef: "x.archive.enc",
    encryption: "managed_envelope_v1",
    keyVersion: 1,
    origin: "scheduled",
    capturedAt: "2026-10-27T00:00:00.000Z",
    retentionUntil: null,
  };
}

function preview(patch: Partial<RestorePreview> = {}): RestorePreview {
  return {
    artifactRef: "ref-1",
    capturedAt: "2026-10-27T00:00:00.000Z",
    format: "logical_snapshot",
    targetBusinessId: BUSINESS,
    datasets: [],
    retained: [],
    missing: [],
    affectedRows: 10,
    currentRows: 10,
    rpoHours: 1,
    estimatedDowntimeMinutes: 1,
    completeness: "complete",
    requiresCheckpoint: true,
    pausesTenantWrites: true,
    lockKey: "restore:tenant",
    confirmationPhrase: "کافه نمونه",
    blockers: [],
    canApply: true,
    ...patch,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.lockIsHeld.mockResolvedValue(false);
  mocks.withDistributedLock.mockImplementation(async (_key: string, fn: () => Promise<unknown>) => ({ ok: true, value: await fn() }));
  mocks.tryAppendRestoreJournal.mockResolvedValue(true);
  mocks.exportTenantData.mockResolvedValue([
    { name: "accounts", columns: ["id"], rows: [{ id: "a1" }] },
  ]);
  mocks.installedSchemaVersion.mockResolvedValue(268);
  mocks.applyTenantArchive.mockResolvedValue({ deleted: 1, inserted: 1, tables: 1 });
  mocks.resolveOwnedArtifact.mockResolvedValue(readyArtifact());
  mocks.withTenantTransaction.mockImplementation(async (_businessId: string, fn: (client: unknown) => Promise<unknown>) =>
    fn({ query: vi.fn(async () => ({ rows: [{ total: "1" }] })) }),
  );
  // `tenantTableSet()` asks information_schema which tables are tenant tables;
  // everything else this module reads in a happy path is bookkeeping.
  mocks.query.mockImplementation(async (text: string) => {
    if (text.includes("information_schema")) return { rows: [{ table_name: "accounts" }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  });
});

describe("checkRestorableTables", () => {
  it("accepts tables the installation can order", () => {
    expect(checkRestorableTables(["accounts"], ["accounts", "orders"])).toEqual({ ok: true });
  });

  it("refuses a protected table even if the archive is otherwise valid", () => {
    expect(checkRestorableTables(["businesses"], ["businesses", "accounts"])).toEqual({
      ok: false,
      error: "archive_table_not_allowed:businesses",
    });
    expect(RESTORE_PROTECTED_TABLES.has("businesses")).toBe(true);
  });

  it("refuses a table it cannot place in dependency order", () => {
    expect(checkRestorableTables(["mystery"], ["accounts"])).toEqual({
      ok: false,
      error: "archive_table_order_incomplete",
    });
  });
});

describe("restoreTableOrder", () => {
  it("never offers a protected table for deletion", async () => {
    const order = await restoreTableOrder();
    expect(order).toEqual(["accounts", "orders"]);
  });
});

describe("mapApplyError", () => {
  it("keeps known refusals and collapses everything else", () => {
    expect(mapApplyError("restore_busy")).toBe("restore_busy");
    expect(mapApplyError("ECONNREFUSED 10.0.0.5:5432")).toBe("restore_failed");
    for (const code of APPLY_REFUSALS) expect(mapApplyError(code)).toBe(code);
  });
});

describe("applyTenantRestore", () => {
  const request = {
    businessId: BUSINESS,
    ref: "ref-1",
    deployment: { role: "central", profile: "cloud" } as const,
    preview: preview(),
    typedConfirmation: "کافه نمونه",
    minutesSinceReauthentication: 2,
    journalDir: "/tmp/journal",
  };

  it("refuses without the typed phrase and writes nothing", async () => {
    const outcome = await applyTenantRestore({ ...request, typedConfirmation: "yes" });
    expect(outcome).toEqual({ ok: false, error: "confirmation_required" });
    expect(mocks.withDistributedLock).not.toHaveBeenCalled();
    expect(mocks.applyTenantArchive).not.toHaveBeenCalled();
  });

  it("refuses without a fresh re-authentication", async () => {
    const outcome = await applyTenantRestore({ ...request, minutesSinceReauthentication: 60 });
    expect(outcome).toEqual({ ok: false, error: "reauthentication_required" });
  });

  it("refuses when a preview is blocked, even with the right phrase", async () => {
    const blocked = preview({
      canApply: false,
      blockers: [{ code: "restore_busy", label: "…" }],
    }) as RestorePreview;
    const outcome = await applyTenantRestore({ ...request, preview: blocked });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toBe("restore_busy");
  });

  it("refuses while another restore holds the lock", async () => {
    mocks.lockIsHeld.mockResolvedValue(true);
    const outcome = await applyTenantRestore(request);
    expect(outcome).toEqual({ ok: false, error: "restore_busy" });
  });

  it("reports contention from the lock layer as busy rather than failing open", async () => {
    mocks.withDistributedLock.mockResolvedValue({ ok: false, reason: "busy" });
    const outcome = await applyTenantRestore(request);
    expect(outcome).toEqual({ ok: false, error: "restore_busy" });
  });

  it("journals the verify phase, and aborts before reading anything if it cannot", async () => {
    mocks.tryAppendRestoreJournal.mockResolvedValue(false);
    const outcome = await applyTenantRestore(request);
    expect(outcome.ok).toBe(false);
    expect(mocks.applyTenantArchive).not.toHaveBeenCalled();
    expect(mocks.tryAppendRestoreJournal).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "verify_started", scope: BUSINESS, mode: "apply" }),
      "/tmp/journal",
    );
  });

  it("applies inside one tenant transaction and journals each phase in order", async () => {
    mocks.exportTenantData.mockResolvedValue([
      { name: "accounts", columns: ["id"], rows: [{ id: "a1" }] },
    ]);
    const outcome = await applyTenantRestore(request);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.tables).toBe(1);
      expect(outcome.checkpointFile).toContain("checkpoint");
      expect(outcome.verified).toBe(true);
    }
    expect(mocks.withTenantTransaction).toHaveBeenCalledWith(BUSINESS, expect.any(Function));
    expect(mocks.applyTenantArchive).toHaveBeenCalledTimes(1);
    const phases = mocks.tryAppendRestoreJournal.mock.calls.map(
      (call) => (call[0] as { phase: string }).phase,
    );
    expect(phases).toEqual(["verify_started", "verify_succeeded", "apply_started", "apply_succeeded"]);
  });

  it("rolls back and records a failed apply when the transaction throws", async () => {
    mocks.withTenantTransaction.mockRejectedValue(new Error("deadlock detected"));
    const outcome = await applyTenantRestore(request);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toBe("restore_failed");
    const phases = mocks.tryAppendRestoreJournal.mock.calls.map(
      (call) => (call[0] as { phase: string }).phase,
    );
    expect(phases).toContain("apply_failed_before_swap");
    // The internal message never becomes the tenant-facing code.
    expect(JSON.stringify(outcome)).not.toContain("deadlock");
  });

  it("refuses when the archive's row counts do not survive the write", async () => {
    mocks.withTenantTransaction.mockImplementation(async (_businessId: string, fn: (client: unknown) => Promise<unknown>) =>
      fn({ query: vi.fn(async () => ({ rows: [{ total: "0" }] })) }),
    );
    const outcome = await applyTenantRestore(request);
    expect(outcome.ok).toBe(false);
  });

  it("refuses a physical dump on a central deployment", async () => {
    mocks.resolveOwnedArtifact.mockResolvedValue({
      businessId: BUSINESS,
      state: "ready",
      format: "physical_dump",
      manifest: { payloadFormat: "physical_dump_v1" },
      destination: "local",
      storageRef: "x.dump.enc",
    });
    const outcome = await applyTenantRestore(request);
    expect(outcome).toMatchObject({ ok: false, error: "physical_tenant_restore_forbidden_on_central" });
  });

  it("refuses the historic SQL export by name", async () => {
    mocks.resolveOwnedArtifact.mockResolvedValue({
      businessId: BUSINESS,
      state: "ready",
      format: "logical_snapshot",
      manifest: { payloadFormat: "logical_sql_v1" },
      destination: "local",
      storageRef: "x.sql.enc",
    });
    const outcome = await applyTenantRestore(request);
    expect(outcome).toMatchObject({ ok: false, error: "artifact_is_logical_sql" });
  });

  it("refuses an artifact that is not ready", async () => {
    mocks.resolveOwnedArtifact.mockResolvedValue({
      businessId: BUSINESS,
      state: "verifying",
      format: "logical_snapshot",
      manifest: { payloadFormat: "tenant_archive_v1" },
      destination: "local",
      storageRef: "x.enc",
    });
    const outcome = await applyTenantRestore(request);
    expect(outcome).toMatchObject({ ok: false, error: "artifact_not_ready" });
  });
});
