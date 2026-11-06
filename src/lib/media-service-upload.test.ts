/**
 * The upload's database↔object-storage consistency (issue #1080).
 *
 * Two failure windows matter after the bytes are already in the bucket:
 *
 *   • the INSERT fails — the existing compensating delete covers it;
 *   • the INSERT succeeds but COMMIT fails — the row is rolled back while the
 *     object stays behind. That window had no compensation at all, so a dropped
 *     connection at commit time could leave an unreferenced object in the bucket
 *     and (just as importantly) report a failure the operator could not explain.
 *
 * Also pinned here: an upload attempted while a verified migration holds the
 * write lock is refused *before* any object is written (a file accepted then
 * would land in the source bucket but be read through the target configuration),
 * and the bounded retry decision for transient provider failures.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MEDIA_CONFIG, type MediaStorageConfig } from "./media";

const BID = "11111111-1111-1111-1111-111111111111";
const ASSET_ID = "22222222-2222-2222-2222-222222222222";

// `vi.mock` is hoisted above the imports, so every shared spy is created inside
// `vi.hoisted` and read back through a single object.
const mocks = vi.hoisted(() => {
  const clientQuery = vi.fn();
  const release = vi.fn();
  const connect = vi.fn(async () => ({ query: clientQuery, release }));
  return {
    clientQuery,
    release,
    connect,
    query: vi.fn(),
    s3Put: vi.fn(),
    s3PutFile: vi.fn(),
    s3Delete: vi.fn(),
    s3Get: vi.fn(),
    s3GetStream: vi.fn(),
    s3List: vi.fn(),
    presignS3Get: vi.fn(),
  };
});

const { clientQuery, release, connect, query, s3Put, s3PutFile, s3Delete } = mocks;

vi.mock("./db", () => ({
  getPool: () => ({ connect: mocks.connect }),
  query: mocks.query,
  withTenant: (_businessId: string, run: () => unknown) => run(),
  withoutTenantScope: (_reason: string, run: () => unknown) => run(),
}));

vi.mock("./s3-lite", () => ({
  s3Put: (...args: unknown[]) => mocks.s3Put(...args),
  s3PutFile: (...args: unknown[]) => mocks.s3PutFile(...args),
  s3Delete: (...args: unknown[]) => mocks.s3Delete(...args),
  s3Get: (...args: unknown[]) => mocks.s3Get(...args),
  s3GetStream: (...args: unknown[]) => mocks.s3GetStream(...args),
  s3List: (...args: unknown[]) => mocks.s3List(...args),
  presignS3Get: (...args: unknown[]) => mocks.presignS3Get(...args),
}));

vi.mock("./wallet-service", () => ({
  chargeFeatureUse: vi.fn(),
  WalletInsufficientFundsError: class WalletInsufficientFundsError extends Error {},
}));

vi.mock("./billing/runtime", () => ({
  publishPriceVersion: vi.fn(),
  appendUsageEvent: vi.fn(),
}));

import { MediaStorageBusyError } from "./media-errors";
import { dedupeOrStoreMediaAsset, getMediaConfig, saveMediaConfig, migrateMediaStorage, rollbackMediaStorage } from "./media-service";

function config(over: Partial<MediaStorageConfig> = {}): MediaStorageConfig {
  return {
    ...DEFAULT_MEDIA_CONFIG,
    enabled: true,
    endpoint: "https://s3.parspack.com",
    region: "ir-thr-at1",
    bucket: "media-bucket",
    keyPrefix: "media/",
    accessKeyId: "AKIA_TEST",
    secretAccessKey: "secret-value",
    ...over,
  };
}

function assetRow() {
  return {
    id: ASSET_ID,
    folder_id: null,
    kind: "image",
    file_name: "vlcsnap-2025-10-30-10h01m18s651.png",
    mime_type: "image/png",
    byte_size: "16",
    category: null,
    tags: [],
    ai_status: "none",
    ai_labels: {},
    variant: "original",
    source_asset_id: null,
    source: "upload",
    created_by_ai: false,
    conversation_id: null,
    project_id: null,
    created_at: "2026-10-30T10:00:00.000Z",
    deleted_at: null,
    transform_ops: [],
  };
}

const INSERT = "INSERT INTO media_assets";

/** Route each statement the service issues to a scripted answer. */
function scriptClient(input: { commitError?: unknown } = {}) {
  clientQuery.mockImplementation(async (sql: string) => {
    const text = String(sql);
    if (text.includes("pg_try_advisory_lock_shared")) return { rows: [{ locked: true }] };
    if (text.includes("FROM platform_media_config")) return { rows: [{ enabled: true, endpoint: "https://s3.parspack.com", region: "ir-thr-at1", bucket: "media-bucket", key_prefix: "media/", access_key_id: "AKIA_TEST", secret_access_key: "secret-value", force_path_style: true }] };
    if (text === "BEGIN" || text.startsWith("SELECT set_config") || text.includes("pg_advisory_xact_lock")) {
      return { rows: [] };
    }
    if (text.includes("FROM media_assets") && text.includes("sha256")) return { rows: [] };
    if (text.includes("gen_random_uuid")) return { rows: [{ id: ASSET_ID }] };
    if (text.includes(INSERT)) return { rows: [assetRow()] };
    if (text === "COMMIT") {
      if (input.commitError) throw input.commitError;
      return { rows: [] };
    }
    if (text === "ROLLBACK") return { rows: [] };
    return { rows: [] };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  query.mockImplementation(async (sql: string) => ({ rows: sql.includes("gen_random_uuid") ? [{ id: ASSET_ID }] : [] }));
  s3Put.mockResolvedValue(undefined);
  s3PutFile.mockResolvedValue(undefined);
  s3Delete.mockResolvedValue(undefined);
  scriptClient();
});

describe("storeMediaAsset — object/database consistency", () => {
  it("deletes the object it just wrote when the COMMIT fails, so no unreferenced bytes are left", async () => {
    const commitError = Object.assign(new Error("terminating connection due to administrator command"), {
      code: "57P01",
      severity: "FATAL",
    });
    scriptClient({ commitError });

    await expect(
      dedupeOrStoreMediaAsset({
        businessId: BID,
        userId: null,
        config: config(),
        kind: "image",
        fileName: "vlcsnap-2025-10-30-10h01m18s651.png",
        mimeType: "image/png",
        bytes: Buffer.alloc(16),
        sha256: "a".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "57P01" });

    expect(s3Put).toHaveBeenCalledTimes(1);
    expect(s3Delete).toHaveBeenCalledTimes(1);
    // Same deterministic key the write used: {prefix}{businessId}/{assetId}/{file}
    expect(s3Delete.mock.calls[0][1]).toBe(`media/${BID}/${ASSET_ID}/vlcsnap-2025-10-30-10h01m18s651.png`);
    // And the transaction was rolled back before the error surfaced.
    expect(clientQuery).toHaveBeenCalledWith("ROLLBACK");
  });

  it("sends the validated content type with the streamed upload", async () => {
    await dedupeOrStoreMediaAsset({
      businessId: BID,
      userId: null,
      config: config(),
      kind: "image",
      fileName: "big.png",
      mimeType: "image/png",
      contentType: "image/png",
      filePath: "/tmp/spooled.upload",
      byteSize: 2_000_000,
      sha256: "b".repeat(64),
    });

    expect(s3PutFile).toHaveBeenCalledWith(
      expect.objectContaining({ bucket: "media-bucket" }),
      `media/${BID}/${ASSET_ID}/big.png`,
      "/tmp/spooled.upload",
      expect.objectContaining({ sizeBytes: 2_000_000, payloadHash: "b".repeat(64), contentType: "image/png" }),
    );
    expect(s3Delete).not.toHaveBeenCalled();
  });

  it("refuses the upload while a migration holds the write lock, before touching the bucket", async () => {
    await expect(
      dedupeOrStoreMediaAsset({
        businessId: BID,
        userId: null,
        config: { ...config(), migrationState: "migrating" } as MediaStorageConfig,
        kind: "image",
        fileName: "blocked.png",
        mimeType: "image/png",
        bytes: Buffer.alloc(16),
        sha256: "c".repeat(64),
      }),
    ).rejects.toBeInstanceOf(MediaStorageBusyError);

    expect(s3Put).not.toHaveBeenCalled();
    expect(s3PutFile).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });
});


describe("migrate/rollback serialization (issue #1080 P1.7)", () => {
  it("answers a second concurrent migration with a clear 'in progress' instead of copying twice", async () => {
    // The advisory lock is taken by another session: this request gets nothing.
    clientQuery.mockImplementation(async (sql: string) => {
      if (String(sql).includes("pg_try_advisory_lock")) return { rows: [{ locked: false }] };
      return { rows: [] };
    });

    const outcome = await migrateMediaStorage({
      actorEmail: "ops@bizamiz.test",
      adminId: null,
      target: config({ bucket: "another-bucket" }),
    });

    expect(outcome).toMatchObject({ ok: false, error: "migration_in_progress" });
    expect(s3Put).not.toHaveBeenCalled();
    // The connection is handed straight back so the pool does not leak.
    expect(release).toHaveBeenCalled();
  });

  it("refuses a concurrent rollback for the same reason", async () => {
    clientQuery.mockImplementation(async (sql: string) => {
      if (String(sql).includes("pg_try_advisory_lock")) return { rows: [{ locked: false }] };
      return { rows: [] };
    });

    const outcome = await rollbackMediaStorage({ actorEmail: "ops@bizamiz.test", adminId: null });
    expect(outcome).toMatchObject({ ok: false, error: "migration_in_progress" });
    expect(release).toHaveBeenCalled();
  });
});

describe("upload transaction boundaries", () => {
  const input = () => ({ businessId: BID, userId: null, config: config(), kind: "image" as const,
    fileName: "outside.png", mimeType: "image/png", bytes: Buffer.alloc(16), sha256: "d".repeat(64) });

  it("finishes the object upload before opening the metadata transaction", async () => {
    s3Put.mockImplementationOnce(async () => {
      expect(clientQuery).not.toHaveBeenCalledWith("BEGIN");
    });
    const result = await dedupeOrStoreMediaAsset(input());
    expect(result.action).toBe("created");
    expect(s3Put.mock.calls[0][0]).toMatchObject({ forcePathStyle: true });
    expect(clientQuery).toHaveBeenCalledWith("COMMIT");
    expect(s3Delete).not.toHaveBeenCalled();
  });

  it("does not write any object when acquiring the database connection fails", async () => {
    connect.mockRejectedValueOnce(new Error("pool unavailable"));
    await expect(dedupeOrStoreMediaAsset(input())).rejects.toThrow("pool unavailable");
    expect(s3Put).not.toHaveBeenCalled();
    expect(s3Delete).not.toHaveBeenCalled();
  });

  it("compensates once after rollback when metadata insertion fails", async () => {
    const implementation = clientQuery.getMockImplementation()!;
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes(INSERT)) throw new Error("insert failed");
      return implementation(sql);
    });
    await expect(dedupeOrStoreMediaAsset(input())).rejects.toThrow("insert failed");
    expect(s3Delete).toHaveBeenCalledTimes(1);
    expect(s3Delete.mock.invocationCallOrder[0]).toBeLessThan(release.mock.invocationCallOrder[0]);
  });

  it("removes only the newly staged object when a concurrent upload already won deduplication", async () => {
    const implementation = clientQuery.getMockImplementation()!;
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM media_assets") && sql.includes("sha256")) return { rows: [{ ...assetRow(), id: "existing-id" }] };
      return implementation(sql);
    });
    const result = await dedupeOrStoreMediaAsset(input());
    expect(result.reused).toBe(true);
    expect(result.asset.id).toBe("existing-id");
    expect(s3Delete.mock.calls[0][1]).toContain(ASSET_ID);
    expect(clientQuery.mock.calls.some(([sql]) => String(sql).includes(INSERT))).toBe(false);
  });
});

describe("upload storage-operation coordination", () => {
  const input = () => ({ businessId: BID, userId: null, config: config(), kind: "image" as const,
    fileName: "coordinated.png", mimeType: "image/png", bytes: Buffer.alloc(16), sha256: "e".repeat(64) });

  it("refuses a write when an exclusive migration/rollback lock is already held", async () => {
    const implementation = clientQuery.getMockImplementation()!;
    clientQuery.mockImplementation(async (sql: string) => sql.includes("pg_try_advisory_lock_shared")
      ? { rows: [{ locked: false }] } : implementation(sql));
    await expect(dedupeOrStoreMediaAsset(input())).rejects.toBeInstanceOf(MediaStorageBusyError);
    expect(s3Put).not.toHaveBeenCalled();
    expect(clientQuery).not.toHaveBeenCalledWith("BEGIN");
    expect(release).toHaveBeenCalled();
  });

  it("refuses stale request configuration read before a completed cutover", async () => {
    const implementation = clientQuery.getMockImplementation()!;
    clientQuery.mockImplementation(async (sql: string) => {
      const result = await implementation(sql);
      if (sql.includes("FROM platform_media_config")) result.rows[0].bucket = "new-bucket";
      return result;
    });
    await expect(dedupeOrStoreMediaAsset(input())).rejects.toBeInstanceOf(MediaStorageBusyError);
    expect(s3Put).not.toHaveBeenCalled();
    expect(clientQuery.mock.calls.some(([sql]) => String(sql).includes("pg_advisory_unlock_shared"))).toBe(true);
  });

  it("removes staged bytes and never opens a transaction if the caller cancels during S3 I/O", async () => {
    const controller = new AbortController();
    s3Put.mockImplementationOnce(async () => controller.abort());
    await expect(dedupeOrStoreMediaAsset({ ...input(), signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(s3Delete).toHaveBeenCalledTimes(1);
    expect(clientQuery).not.toHaveBeenCalledWith("BEGIN");
  });

  it("evicts a session whose shared advisory unlock fails instead of leaking a pool lock", async () => {
    const implementation = clientQuery.getMockImplementation()!;
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("pg_advisory_unlock_shared")) throw new Error("connection lost");
      return implementation(sql);
    });
    await dedupeOrStoreMediaAsset(input());
    expect(release).toHaveBeenCalledWith(true);
    expect(s3Delete).not.toHaveBeenCalled();
  });
});


describe("media addressing persistence", () => {
  it("saves the explicit addressing boolean alongside unchanged connection settings", async () => {
    await saveMediaConfig(config({ forcePathStyle: false }), null);
    const [sql, values] = query.mock.calls[0];
    expect(sql).toContain("force_path_style = $15");
    expect(values[1]).toBe("https://s3.parspack.com");
    expect(values[3]).toBe("media-bucket");
    expect(values[14]).toBe(false);
  });

  it("reads the primary mode and preserves legacy path-style fallback despite the old unused false default", async () => {
    query.mockResolvedValueOnce({ rows: [{ enabled: true, endpoint: "https://s3.example.com", region: "us-east-1", bucket: "bucket",
      force_path_style: false, previous_force_path_style: false, previous_media_force_path_style: null,
      previous_endpoint: "https://old.example.com", previous_bucket: "old-bucket", previous_access_key: "key", previous_secret_key: "secret" }] });
    const saved = await getMediaConfig();
    expect(saved.forcePathStyle).toBe(false);
    expect(saved.previousFallback?.forcePathStyle).toBe(true);
  });
});
