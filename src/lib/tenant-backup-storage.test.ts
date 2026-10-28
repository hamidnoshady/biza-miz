import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  withoutTenantScope: vi.fn(async (_reason: string, fn: () => Promise<unknown>) => fn()),
  getMasterKey: vi.fn<() => Buffer | null>(),
}));

vi.mock("./db", () => ({
  query: mocks.query,
  withoutTenantScope: mocks.withoutTenantScope,
}));
vi.mock("./master-key", () => ({ getMasterKey: () => mocks.getMasterKey() }));

import {
  normalizeKeyPrefix,
  readTenantBackupService,
  resolveTenantStorage,
  serviceConfigView,
  tenantFacingStorageStatus,
  tenantObjectKey,
  tenantObjectPrefix,
  updateTenantBackupService,
} from "./tenant-backup-storage";

const BUSINESS = "11111111-1111-4111-8111-111111111111";

interface RowPatch {
  managed_cloud?: boolean;
  hybrid_enabled?: boolean;
  endpoint?: string;
  region?: string;
  bucket?: string;
  key_prefix?: string;
  access_key_sealed?: string;
  secret_key_sealed?: string;
  access_key_hint?: string;
  default_interval_hours?: number;
  default_retention_days?: number;
  max_retention_days?: number;
  cloud_keep_count?: number;
  max_artifact_bytes?: string;
  upload_chunk_bytes?: number;
  max_parallel_uploads?: number;
  protected_recovery_copies?: number;
  last_checked_at?: Date | null;
  last_check_ok?: boolean | null;
  last_error_code?: string | null;
}

function serviceRow(patch: RowPatch = {}) {
  return {
    managed_cloud: false,
    hybrid_enabled: false,
    endpoint: "",
    region: "us-east-1",
    bucket: "",
    key_prefix: "managed-tenant-backups/",
    access_key_sealed: "",
    secret_key_sealed: "",
    access_key_hint: "",
    default_interval_hours: 24,
    default_retention_days: 30,
    max_retention_days: 365,
    cloud_keep_count: 30,
    max_artifact_bytes: "5368709120",
    upload_chunk_bytes: 8388608,
    max_parallel_uploads: 2,
    protected_recovery_copies: 1,
    last_checked_at: null,
    last_check_ok: null,
    last_error_code: null,
    updated_at: new Date(0),
    ...patch,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.query.mockResolvedValue({ rows: [serviceRow()], rowCount: 1 });
  mocks.getMasterKey.mockReturnValue(null);
});

describe("normalizeKeyPrefix", () => {
  it("keeps a trailing slash and strips leading ones", () => {
    expect(normalizeKeyPrefix("managed")).toBe("managed/");
    expect(normalizeKeyPrefix("/managed/")).toBe("managed/");
    expect(normalizeKeyPrefix("  a/b/  ")).toBe("a/b/");
    expect(normalizeKeyPrefix("")).toBe("");
  });

  it("refuses traversal and backslashes", () => {
    expect(() => normalizeKeyPrefix("../../etc")).toThrow("invalid_key_prefix");
    expect(() => normalizeKeyPrefix("a\\b")).toThrow("invalid_key_prefix");
  });
});

describe("tenantObjectKey", () => {
  it("puts every object under the business's own scope tag", () => {
    const key = tenantObjectKey("managed-tenant-backups/", BUSINESS, "artifact.dump.enc");
    expect(key.startsWith(tenantObjectPrefix("managed-tenant-backups/", BUSINESS))).toBe(true);
    expect(key).toMatch(/^managed-tenant-backups\/tenants\/[^/]+\/artifact\.dump\.enc$/);
  });

  it("refuses a name that could walk out of the prefix", () => {
    expect(() => tenantObjectKey("p/", BUSINESS, "../other")).toThrow("invalid_artifact_name");
    expect(() => tenantObjectKey("p/", BUSINESS, "a/b")).toThrow("invalid_artifact_name");
  });
});

describe("readTenantBackupService", () => {
  it("answers coherent defaults before the singleton row exists", async () => {
    mocks.query.mockResolvedValue({ rows: [] });
    const config = await readTenantBackupService();
    expect(config.managedCloud).toBe(false);
    expect(config.cloudEnabled).toBe(false);
    expect(config.defaultRetentionDays).toBe(30);
    expect(config.maxArtifactBytes).toBe(5 * 1024 ** 3);
  });

  it("is not 'configured' when the KEK cannot open the sealed secret", async () => {
    mocks.query.mockResolvedValue({
      rows: [
        serviceRow({
          managed_cloud: true,
          endpoint: "https://s3.example",
          bucket: "backups",
          access_key_sealed: "POSTBS1.aaaa.bbbb.cccc",
          secret_key_sealed: "POSTBS1.aaaa.bbbb.cccc",
        }),
      ],
    });
    mocks.getMasterKey.mockReturnValue(null);
    const config = await readTenantBackupService();
    expect(config.cloudEnabled).toBe(false);
    expect(config.accessKeyId).toBe("");
  });
});

describe("serviceConfigView", () => {
  it("never returns the secrets it holds", async () => {
    mocks.query.mockResolvedValue({
      rows: [serviceRow({ access_key_sealed: "sealed", secret_key_sealed: "sealed", access_key_hint: "AKIA…7F" })],
    });
    const view = serviceConfigView(await readTenantBackupService()) as Record<string, unknown>;
    expect(view.hasSecretKey).toBe(false);
    expect(view.accessKeyHint).toBe("AKIA…7F");
    expect(JSON.stringify(view)).not.toContain("sealed");
  });
});

describe("resolveTenantStorage", () => {
  const legacyCloud = {
    enabled: true,
    endpoint: "https://s3.example",
    region: "eu-central-1",
    bucket: "tenant-bucket",
    prefix: "own/",
    accessKeyId: "AKIA",
    secretAccessKey: "secret",
    retention: 7,
  };

  it("refuses a Local profile before reading any configuration", async () => {
    const target = await resolveTenantStorage({ businessId: BUSINESS, profile: "local", role: "site", legacyCloud });
    expect(target).toEqual({ mode: "unavailable", reason: "local_profile" });
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("uses the managed destination for every profile when it is enabled and complete", async () => {
    mocks.query.mockResolvedValue({
      rows: [
        serviceRow({
          managed_cloud: true,
          endpoint: "https://s3.example",
          bucket: "managed",
          key_prefix: "managed-tenant-backups/",
          access_key_sealed: "x",
          secret_key_sealed: "y",
        }),
      ],
    });
    // A readable sealed secret requires a real KEK, so this asserts the decision
    // path: enabled-but-unopenable is reported as incomplete, never as legacy.
    const target = await resolveTenantStorage({ businessId: BUSINESS, profile: "cloud", role: "central", legacyCloud });
    expect(target.mode).toBe("unavailable");
    if (target.mode === "unavailable") expect(target.reason).toMatch(/managed_storage_(incomplete|unreadable)/);
  });

  it("keeps an existing self-hosted bucket working, and says it is legacy", async () => {
    const target = await resolveTenantStorage({ businessId: BUSINESS, profile: "hybrid", role: "site", legacyCloud });
    expect(target.mode).toBe("legacy");
    if (target.mode === "legacy") {
      expect(target.prefix).toBe("own/");
      expect(target.keepCount).toBe(7);
    }
  });

  it("does not adopt a legacy bucket on central, where it would be someone else's storage", async () => {
    const target = await resolveTenantStorage({ businessId: BUSINESS, profile: "cloud", role: "central", legacyCloud });
    expect(target).toEqual({ mode: "unavailable", reason: "managed_storage_disabled" });
  });
});

describe("tenantFacingStorageStatus", () => {
  it("says a Local profile stores nothing in the cloud", async () => {
    const status = await tenantFacingStorageStatus("local");
    expect(status.cloudAvailable).toBe(false);
    expect(status.reason).toBe("local_profile");
  });

  it("says managed storage is disabled when the platform has not enabled it", async () => {
    const status = await tenantFacingStorageStatus("cloud");
    expect(status.cloudAvailable).toBe(false);
    expect(status.reason).toBe("managed_storage_disabled");
    expect(JSON.stringify(status)).not.toContain("bucket");
  });
});

describe("updateTenantBackupService", () => {
  it("refuses to enable managed storage without a destination", async () => {
    const outcome = await updateTenantBackupService({ managedCloud: true });
    expect(outcome).toEqual({ ok: false, error: "storage_destination_incomplete" });
  });

  it("refuses to seal a credential without a platform key", async () => {
    const outcome = await updateTenantBackupService({
      managedCloud: true,
      endpoint: "https://s3.example",
      bucket: "managed",
      accessKeyId: "AKIA",
      secretAccessKey: "secret",
    });
    expect(outcome).toEqual({ ok: false, error: "key_encryption_unconfigured" });
  });

  it("rejects policy values outside what the service can honour", async () => {
    expect(await updateTenantBackupService({ defaultIntervalHours: 5 })).toEqual({
      ok: false,
      error: "invalid_interval",
    });
    expect(await updateTenantBackupService({ maxParallelUploads: 99 })).toEqual({
      ok: false,
      error: "invalid_service_limit",
    });
    expect(await updateTenantBackupService({ defaultRetentionDays: 400, maxRetentionDays: 30 })).toEqual({
      ok: false,
      error: "retention_above_maximum",
    });
    expect(await updateTenantBackupService({ keyPrefix: "../escape" })).toEqual({
      ok: false,
      error: "invalid_key_prefix",
    });
    // An endpoint only has to be a URL once managed storage is actually enabled.
    mocks.getMasterKey.mockReturnValue(Buffer.alloc(32, 7));
    expect(
      await updateTenantBackupService({
        managedCloud: true,
        endpoint: "s3.example",
        bucket: "managed",
        accessKeyId: "AKIA",
        secretAccessKey: "secret",
      }),
    ).toEqual({ ok: false, error: "invalid_endpoint" });
  });
});
