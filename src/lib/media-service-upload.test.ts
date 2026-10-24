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
import { dedupeOrStoreMediaAsset, migrateMediaStorage, rollbackMediaStorage } from "./media-service";

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
  query.mockResolvedValue({ rows: [] });
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
