import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  getMediaConfig: vi.fn(),
  streamMediaObject: vi.fn(),
}));

vi.mock("./db", () => ({ query: mocks.query }));
vi.mock("./media-service", () => ({
  getMediaConfig: mocks.getMediaConfig,
  streamMediaObject: mocks.streamMediaObject,
}));
vi.mock("./s3-lite", () => ({
  s3Delete: vi.fn(),
  s3GetToFile: vi.fn(),
  s3Head: vi.fn(),
  s3PutFile: vi.fn(),
}));

import { BACKUP_MAGIC } from "./backup-streams";
import {
  captureMediaSidecars,
  mediaSidecarDirectory,
  mediaSidecarName,
  removeLocalMediaSidecars,
  verifyMediaSidecars,
} from "./tenant-backup-media";

const SECRET = "artifact-secret-for-tests";

interface DbRow {
  id: string;
  storage_key: string;
  sha256: string;
  byte_size: string;
  mime_type: string;
  file_name: string;
}

function row(overrides: Partial<DbRow> & { byteSize?: number } = {}): DbRow {
  const byteSize = overrides.byteSize ?? 12;
  return {
    id: "asset-1",
    storage_key: "media/asset-1.png",
    mime_type: "image/png",
    file_name: "photo.png",
    sha256: "a".repeat(64),
    ...overrides,
    byte_size: String(byteSize),
  };
}

function bytesFor(size: number): Buffer {
  return Buffer.alloc(size, 7);
}

function serve(buffer: Buffer | null) {
  mocks.streamMediaObject.mockImplementation(async () =>
    buffer
      ? {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(buffer));
              controller.close();
            },
          }),
        }
      : null,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getMediaConfig.mockResolvedValue({ driver: "s3", bucket: "media" });
  mocks.query.mockResolvedValue({ rows: [] });
});

describe("sidecar naming", () => {
  it("keeps the artifact's name and gives each asset its own file", () => {
    expect(mediaSidecarDirectory("tenant-biz-1-2026-11-06.bkp")).toBe(
      "tenant-biz-1-2026-11-06.bkp.media",
    );
    expect(mediaSidecarName("2f1c-aa")).toBe("2f1c-aa.enc");
  });

});

describe("captureMediaSidecars", () => {
  it("writes an encrypted sidecar whose manifest entry describes the plaintext", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "media-capture-"));
    const plain = bytesFor(12);
    const sha = createHash("sha256").update(plain).digest("hex");
    mocks.query.mockResolvedValue({ rows: [row({ sha256: sha, byteSize: plain.byteLength })] });
    serve(plain);

    const capture = await captureMediaSidecars({
      businessId: "business-a",
      artifact: "artifact.bkp",
      directory: dir,
      secret: SECRET,
    });

    expect(capture.skipped).toBe(0);
    expect(capture.clipped).toBe(false);
    expect(capture.assets).toHaveLength(1);
    expect(capture.assets[0]).toMatchObject({
      assetId: "asset-1",
      sha256: sha,
      bytes: plain.byteLength,
      sidecar: "asset-1.enc",
    });

    // The bytes on disk are ciphertext — the magic is there, the plaintext is not.
    const stored = await fs.readFile(path.join(dir, "artifact.bkp.media", "asset-1.enc"));
    expect(stored.subarray(0, BACKUP_MAGIC.length)).toEqual(BACKUP_MAGIC);
    expect(stored.includes(plain)).toBe(false);
    // Billing counts what was written, which is the ciphertext size.
    expect(capture.storedBytes).toBe(stored.byteLength);

    // Nothing plaintext is left behind.
    const leftovers = await fs.readdir(path.join(dir, "artifact.bkp.media"));
    expect(leftovers.filter((name) => name.includes(".tmp"))).toEqual([]);
  });

  it("survives a row whose object is already gone, and says so", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "media-capture-"));
    mocks.query.mockResolvedValue({ rows: [row()] });
    serve(null);

    const capture = await captureMediaSidecars({
      businessId: "business-a",
      artifact: "artifact.bkp",
      directory: dir,
      secret: SECRET,
    });

    expect(capture.assets).toEqual([]);
    expect(capture.skipped).toBe(1);
    expect(capture.storedBytes).toBe(0);
  });

  it("skips an asset over the per-asset cap and marks the capture clipped", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "media-capture-"));
    mocks.query.mockResolvedValue({ rows: [row({ id: "big", byteSize: 5000 })] });
    serve(bytesFor(5000));

    const capture = await captureMediaSidecars({
      businessId: "business-a",
      artifact: "artifact.bkp",
      directory: dir,
      secret: SECRET,
      limits: { maxAssetBytes: 1000 },
    });

    expect(capture.assets).toEqual([]);
    expect(capture.skipped).toBe(1);
    expect(capture.clipped).toBe(true);
    expect(mocks.streamMediaObject).not.toHaveBeenCalled();
  });

  it("stops at the run budget and counts every remaining asset as skipped", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "media-capture-"));
    mocks.query.mockResolvedValue({
      rows: [
        row({ id: "a", byteSize: 10, storage_key: "k/a" }),
        row({ id: "b", byteSize: 10, storage_key: "k/b" }),
        row({ id: "c", byteSize: 10, storage_key: "k/c" }),
      ],
    });
    serve(bytesFor(10));

    const capture = await captureMediaSidecars({
      businessId: "business-a",
      artifact: "artifact.bkp",
      directory: dir,
      secret: SECRET,
      limits: { maxBytes: 1 },
    });

    // Not one byte fits in a one-byte budget: every asset is skipped, none silently dropped.
    expect(capture.assets).toEqual([]);
    expect(capture.skipped).toBe(3);
    expect(capture.clipped).toBe(true);
  });

  it("carries at most the asset cap and reports the rest", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "media-capture-"));
    mocks.query.mockResolvedValue({
      rows: [
        row({ id: "a", byteSize: 4, storage_key: "k/a" }),
        row({ id: "b", byteSize: 4, storage_key: "k/b" }),
        row({ id: "c", byteSize: 4, storage_key: "k/c" }),
      ],
    });
    serve(bytesFor(4));

    const capture = await captureMediaSidecars({
      businessId: "business-a",
      artifact: "artifact.bkp",
      directory: dir,
      secret: SECRET,
      limits: { maxAssets: 1 },
    });

    expect(capture.assets.map((asset) => asset.assetId)).toEqual(["a"]);
    expect(capture.skipped).toBe(2);
    expect(capture.clipped).toBe(true);
  });
});

describe("verifyMediaSidecars", () => {
  async function captureOne(): Promise<{
    directory: string;
    media: Awaited<ReturnType<typeof captureMediaSidecars>>;
  }> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "media-verify-"));
    const plain = bytesFor(16);
    mocks.query.mockResolvedValue({
      rows: [row({ sha256: createHash("sha256").update(plain).digest("hex"), byteSize: 16 })],
    });
    serve(plain);
    const media = await captureMediaSidecars({
      businessId: "business-a",
      artifact: "artifact.bkp",
      directory: dir,
      secret: SECRET,
    });
    return { directory: dir, media };
  }

  it("accepts sidecars that still decrypt to the signed bytes", async () => {
    const { directory, media } = await captureOne();
    await expect(
      verifyMediaSidecars({ media, directory, artifact: "artifact.bkp", secret: SECRET }),
    ).resolves.toEqual({ ok: true });
  });

  it("rejects a manifest entry whose checksum no longer matches", async () => {
    const { directory, media } = await captureOne();
    const tampered = {
      ...media,
      assets: [{ ...media.assets[0], sha256: "b".repeat(64) }],
    };
    await expect(
      verifyMediaSidecars({ media: tampered, directory, artifact: "artifact.bkp", secret: SECRET }),
    ).resolves.toEqual({ ok: false, error: "media_asset_checksum_mismatch" });
  });

  it("rejects a sidecar that is missing rather than calling the backup ready", async () => {
    const { directory, media } = await captureOne();
    await fs.rm(path.join(directory, "artifact.bkp.media", "asset-1.enc"));
    await expect(
      verifyMediaSidecars({ media, directory, artifact: "artifact.bkp", secret: SECRET }),
    ).resolves.toMatchObject({ ok: false });
  });

  it("rejects a sidecar opened with the wrong key", async () => {
    const { directory, media } = await captureOne();
    await expect(
      verifyMediaSidecars({ media, directory, artifact: "artifact.bkp", secret: "wrong-secret" }),
    ).resolves.toMatchObject({ ok: false });
  });

  it("treats an empty capture as nothing to verify", async () => {
    await expect(
      verifyMediaSidecars({ media: null, directory: "/nowhere", artifact: "x", secret: SECRET }),
    ).resolves.toEqual({ ok: true });
  });
});

describe("removeLocalMediaSidecars", () => {
  it("removes the sidecar directory and tolerates it already being gone", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "media-remove-"));
    await fs.mkdir(path.join(dir, mediaSidecarDirectory("artifact.bkp")), { recursive: true });
    await removeLocalMediaSidecars(dir, "artifact.bkp");
    await expect(fs.readdir(path.join(dir, mediaSidecarDirectory("artifact.bkp")))).rejects.toThrow();
    await expect(removeLocalMediaSidecars(dir, "artifact.bkp")).resolves.toBeUndefined();
  });
});
