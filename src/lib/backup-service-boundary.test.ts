import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ local: vi.fn(), query: vi.fn(), getSetting: vi.fn(), s3List: vi.fn(), s3Get: vi.fn(), s3Put: vi.fn(), role: vi.fn() }));
vi.mock("./deployment-mode", () => ({ isLocalOnly: mocks.local }));
vi.mock("./deployment-role", () => ({ deploymentRole: mocks.role }));
vi.mock("./db", () => ({ query: mocks.query, withTenant: (_id: string, fn: () => unknown) => fn(), withoutTenantScope: (_reason: string, fn: () => unknown) => fn() }));
vi.mock("./settings", async (importOriginal) => ({ ...await importOriginal<typeof import("./settings")>(), getSetting: mocks.getSetting }));
vi.mock("./s3-lite", () => ({ s3List: mocks.s3List, s3GetToFile: mocks.s3Get, s3PutFile: mocks.s3Put, s3Delete: vi.fn() }));
vi.mock("./db-locks", () => ({ LOCK_KEYS: { tenantRestore: (id: string) => id }, withDistributedLock: async (_key: string, fn: () => unknown) => ({ ok: true, value: await fn() }) }));
import { DEFAULT_BACKUP_CONFIG } from "./backup";
import { aliasedBackupDestination, getBackupConfig, listRestorableArtifacts, restoreFromArtifact, runCloudUpload } from "./backup-service";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.role.mockReturnValue("site");
  mocks.local.mockResolvedValue(true);
  mocks.getSetting.mockResolvedValue({ ...DEFAULT_BACKUP_CONFIG, cloud: { ...DEFAULT_BACKUP_CONFIG.cloud, enabled: true, endpoint: "https://private", bucket: "bucket", accessKeyId: "key", secretAccessKey: "secret" } });
  mocks.query.mockResolvedValue({ rows: [] });
});
it("Local cloud upload exits before even reading historical provider config", async () => {
  expect(await runCloudUpload("business-a", "anything", "manual")).toEqual({ status: "disabled" });
  expect(mocks.getSetting).not.toHaveBeenCalled();
  expect(mocks.s3Put).not.toHaveBeenCalled();
});
it("Local inventory never lists remote storage, even with old enabled settings", async () => {
  mocks.query.mockResolvedValue({ rows: [{ kind: "cloud", scope: "physical", artifact: null, cloud_key: "other/key", size_bytes: "10", started_at: new Date() }] });
  expect(await listRestorableArtifacts("business-a")).toEqual({ local: [], cloud: [] });
  expect(mocks.s3List).not.toHaveBeenCalled();
  expect(mocks.query.mock.calls[0][1]).toEqual(["business-a"]);
});
it("Local cloud restore refuses before fetching any object", async () => {
  mocks.query.mockResolvedValue({ rows: [{ n: 1 }] });
  expect(await restoreFromArtifact("business-a", { source: "cloud", artifact: "other/key", apply: false })).toEqual({ status: "failed", error: "cloud_backup_unavailable_local" });
  expect(mocks.s3Get).not.toHaveBeenCalled();
});
it("direct service restore cannot fetch an unowned key", async () => {
  mocks.local.mockResolvedValue(false);
  mocks.query.mockResolvedValueOnce({ rows: [{ n: 1 }] }).mockResolvedValueOnce({ rows: [] });
  expect(await restoreFromArtifact("business-a", { source: "cloud", artifact: "business-b/key", apply: false })).toEqual({ status: "failed", error: "artifact_not_found" });
  expect(mocks.query.mock.calls[1][1]).toEqual(["business-a", "cloud", "business-b/key"]);
  expect(mocks.s3Get).not.toHaveBeenCalled();
});
it("central physical restore still refuses before storage or ownership reads", async () => {
  mocks.role.mockReturnValue("central");
  expect(await restoreFromArtifact("business-a", { source: "cloud", artifact: "key", apply: true })).toEqual({ status: "failed", error: "physical_tenant_restore_forbidden_on_central" });
  expect(mocks.query).not.toHaveBeenCalled();
  expect(mocks.s3Get).not.toHaveBeenCalled();
});

it("enables backups by default only for a site with no saved configuration", async () => {
  mocks.getSetting.mockResolvedValue(null);
  await expect(getBackupConfig("business-a")).resolves.toMatchObject({ enabled: true, directory: "" });
  mocks.role.mockReturnValue("central");
  await expect(getBackupConfig("business-a")).resolves.toMatchObject({ enabled: false });
});

it("preserves an explicitly disabled site configuration", async () => {
  mocks.getSetting.mockResolvedValue({ ...DEFAULT_BACKUP_CONFIG, enabled: false });
  await expect(getBackupConfig("business-a")).resolves.toMatchObject({ enabled: false });
});

it("rejects a secondary alias of the canonical empty-primary destination", () => {
  const original = process.env.BACKUP_DIR;
  process.env.BACKUP_DIR = "D:\\\\Backups";
  try {
    expect(aliasedBackupDestination({ directory: "", secondaryDirectory: "d:\\\\backups\\\\" })).toBe(true);
    expect(aliasedBackupDestination({ directory: "", secondaryDirectory: "E:\\\\Backups" })).toBe(false);
  } finally {
    if (original === undefined) delete process.env.BACKUP_DIR;
    else process.env.BACKUP_DIR = original;
  }
});
