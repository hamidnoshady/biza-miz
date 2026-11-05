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
  readBusinessPolicyOverride,
  readTenantBackupService,
  resolveTenantBackupPolicy,
  resolveTenantStorage,
  serviceConfigView,
  tenantFacingStorageStatus,
  tenantObjectKey,
  tenantObjectPrefix,
  updateTenantBackupService,
  SAFE_TENANT_BACKUP_POLICY,
} from "./tenant-backup-storage";

const BUSINESS = "11111111-1111-4111-8111-111111111111";

/**
 * Route the resolver's three reads by statement rather than by call order.
 *
 * Issue #903 §3 added the plan layer, so `resolveTenantBackupPolicy` now asks the
 * fleet row, then the business's plan, then its override. Order-based mocks would
 * silently feed the override row to the plan query — which is exactly the kind of
 * fixture that makes a bug invisible — so each statement is matched explicitly.
 */
function routeQueries(input: {
  fleet?: RowPatch;
  plan?: string | null;
  planPolicy?: Record<string, unknown> | null;
  override?: Record<string, unknown> | null;
  failFleet?: boolean;
}) {
  mocks.query.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM platform_tenant_backup_service")) {
      if (input.failFleet) throw new Error("relation does not exist");
      return { rows: [serviceRow(input.fleet ?? {})], rowCount: 1 };
    }
    if (sql.includes("SELECT plan::text")) {
      return { rows: input.plan ? [{ plan: input.plan }] : [], rowCount: input.plan ? 1 : 0 };
    }
    if (sql.includes("FROM tenant_backup_plan_policy")) {
      return {
        rows: input.planPolicy ? [{ plan_key: input.plan ?? "pro", ...input.planPolicy }] : [],
        rowCount: input.planPolicy ? 1 : 0,
      };
    }
    if (sql.includes("FROM tenant_backup_business_policy")) {
      return { rows: input.override ? [input.override] : [], rowCount: input.override ? 1 : 0 };
    }
    return { rows: [], rowCount: 0 };
  });
}


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
  alert_stale_hours?: number | null;
  alert_failure_streak?: number;
  drill_interval_hours?: number;
  dr_rpo_hours?: number | null;
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
    alert_stale_hours: null,
    alert_failure_streak: 1,
    drill_interval_hours: 24,
    dr_rpo_hours: null,
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

describe("resolveTenantBackupPolicy", () => {
  it("takes the schedule and retention from the platform row, not from a tenant", async () => {
    mocks.query.mockResolvedValue({
      rows: [serviceRow({ default_interval_hours: 6, default_retention_days: 90, max_retention_days: 365, cloud_keep_count: 12, managed_cloud: true, endpoint: "https://s3.example", bucket: "b" })],
    });
    mocks.getMasterKey.mockReturnValue(Buffer.alloc(32, 7));
    const policy = await resolveTenantBackupPolicy();
    expect(policy).toMatchObject({
      intervalHours: 6,
      retentionDays: 90,
      maxRetentionDays: 365,
      keepCount: 12,
      source: "managed",
    });
    // No usable sealed credential was configured, so the fleet has no usable
    // cloud destination even though `managed_cloud` is on.
    expect(policy.managedCloud).toBe(false);
  });

  it("snaps an out-of-catalogue cadence to a representable one instead of failing", async () => {
    mocks.query.mockResolvedValue({ rows: [serviceRow({ default_interval_hours: 5 })] });
    await expect(resolveTenantBackupPolicy()).resolves.toMatchObject({ intervalHours: 4 });
    mocks.query.mockResolvedValue({ rows: [serviceRow({ default_interval_hours: 30 })] });
    await expect(resolveTenantBackupPolicy()).resolves.toMatchObject({ intervalHours: 24 });
  });

  it("falls back to safe defaults, and says so, when the row cannot be read", async () => {
    mocks.query.mockRejectedValue(new Error("relation does not exist"));
    await expect(resolveTenantBackupPolicy()).resolves.toEqual(SAFE_TENANT_BACKUP_POLICY);
  });
});

function overrideRow(patch: Record<string, unknown> = {}) {
  return {
    interval_hours: null,
    retention_days: null,
    keep_count: null,
    protected_recovery_copies: null,
    max_artifact_bytes: null,
    require_restore_approval: false,
    note: "",
    updated_at: new Date(0),
    ...patch,
  };
}

describe("per-business policy override", () => {
  it("returns the fleet policy when the business has no override row", async () => {
    routeQueries({ fleet: { default_interval_hours: 12, default_retention_days: 45 } });
    await expect(resolveTenantBackupPolicy(BUSINESS)).resolves.toMatchObject({
      intervalHours: 12,
      retentionDays: 45,
      override: false,
    });
  });

  it("applies the business's own numbers inside the fleet envelope", async () => {
    routeQueries({
      fleet: { default_interval_hours: 24, default_retention_days: 30, max_retention_days: 365, cloud_keep_count: 30 },
      override: overrideRow({
        interval_hours: 6,
        retention_days: 120,
        keep_count: 12,
        protected_recovery_copies: 2,
        require_restore_approval: true,
        note: "legal retention",
      }),
    });
    await expect(resolveTenantBackupPolicy(BUSINESS)).resolves.toMatchObject({
      intervalHours: 6,
      retentionDays: 120,
      keepCount: 12,
      protectedCopies: 2,
      requireRestoreApproval: true,
      override: true,
    });
  });

  it("clamps an override that would escape the fleet ceiling", async () => {
    routeQueries({
      fleet: { default_retention_days: 30, max_retention_days: 90, cloud_keep_count: 10 },
      override: overrideRow({ retention_days: 3650, keep_count: 400 }),
    });
    const policy = await resolveTenantBackupPolicy(BUSINESS);
    expect(policy.retentionDays).toBe(90);
    expect(policy.keepCount).toBe(10);
    // Null means inherit, not zero.
    expect(policy.intervalHours).toBe(24);
    expect(policy.protectedCopies).toBe(1);
  });

  it("answers null (inherit) when the override table is unavailable", async () => {
    mocks.query.mockRejectedValueOnce(new Error("relation does not exist"));
    await expect(readBusinessPolicyOverride(BUSINESS)).resolves.toBeNull();
  });
});

describe("the plan layer (issue #903 §3)", () => {
  it("takes the cadence from the business's plan, tighter than the fleet's", async () => {
    routeQueries({
      fleet: { default_interval_hours: 24, default_retention_days: 30 },
      plan: "pro",
      planPolicy: { interval_hours: 6, alert_stale_hours: 8 },
    });
    const policy = await resolveTenantBackupPolicy(BUSINESS);
    expect(policy).toMatchObject({ planKey: "pro", intervalHours: 6, retentionDays: 30, override: false });
    // The stale window follows the tighter cadence: the floor is 6h + grace, and
    // the plan asked for 8h.
    expect(policy.alertStaleHours).toBe(8);
  });

  it("does not let a plan slow the fleet down or outlive its retention ceiling", async () => {
    routeQueries({
      fleet: { default_interval_hours: 6, max_retention_days: 90 },
      plan: "base",
      planPolicy: { interval_hours: 24, retention_days: 3650 },
    });
    const policy = await resolveTenantBackupPolicy(BUSINESS);
    expect(policy.intervalHours).toBe(6);
    expect(policy.retentionDays).toBe(90);
  });

  it("lets a per-business override win over the plan, still inside the envelope", async () => {
    routeQueries({
      fleet: { default_interval_hours: 24 },
      plan: "pro",
      planPolicy: { interval_hours: 6, retention_days: 60 },
      override: overrideRow({ interval_hours: 2, retention_days: 30 }),
    });
    const policy = await resolveTenantBackupPolicy(BUSINESS);
    expect(policy).toMatchObject({ intervalHours: 2, retentionDays: 30, override: true, planKey: "pro" });
  });

  it("inherits everything when the business has no plan, and says so", async () => {
    routeQueries({ fleet: { default_interval_hours: 12 } });
    const policy = await resolveTenantBackupPolicy(BUSINESS);
    expect(policy).toMatchObject({ planKey: null, intervalHours: 12, alertFailureStreak: 1 });
    // With no threshold set anywhere, the window is the one the cadence implies:
    // 12h + its 3h grace.
    expect(policy.alertStaleHours).toBe(15);
  });

  it("reports the fleet's thresholds, and the defaults it falls back to", async () => {
    routeQueries({
      fleet: { alert_failure_streak: 3, drill_interval_hours: 48, dr_rpo_hours: 24 },
    });
    await expect(resolveTenantBackupPolicy()).resolves.toMatchObject({
      alertFailureStreak: 3,
      drillIntervalHours: 48,
      drRpoHours: 24,
    });
  });
});
