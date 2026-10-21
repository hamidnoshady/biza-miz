import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import { query } from "./db";
import { getServerSyncConfig } from "./server-sync";

const UUID = /^[0-9a-f-]{36}$/i;

function cacheRoot(): string {
  return process.env.MEDIA_MIRROR_DIR?.trim() || path.join(process.cwd(), ".data", "media-mirror");
}

function cachePath(businessId: string, assetId: string): string {
  if (!UUID.test(businessId) || !UUID.test(assetId)) throw new Error("invalid_media_identity");
  return path.join(cacheRoot(), businessId, assetId);
}

interface MirrorAsset extends Record<string, unknown> {
  id: string;
  file_name: string;
  mime_type: string;
  byte_size: string;
  sha256: string;
  kind: string;
}

async function queryActiveMirrorAsset(businessId: string, assetId: string): Promise<MirrorAsset | null> {
  const result = await query<MirrorAsset>(
    `SELECT id::text, file_name, mime_type, byte_size::text, sha256, kind
       FROM media_assets
      WHERE id = $1 AND business_id = $2 AND deleted_at IS NULL`,
    [assetId, businessId],
  );
  return result.rows[0] ?? null;
}

async function verifyFileOnDisk(filePath: string, expectedBytes: number, expectedSha256: string): Promise<boolean> {
  try {
    const info = await stat(filePath);
    if (info.size !== expectedBytes) return false;
    const hash = createHash("sha256");
    await pipeline(createReadStream(filePath), new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        callback();
      },
    }));
    return hash.digest("hex") === expectedSha256;
  } catch {
    return false;
  }
}

async function ensureMirroredFileOnDisk(
  businessId: string,
  asset: MirrorAsset,
  signal?: AbortSignal,
): Promise<string | null> {
  const target = cachePath(businessId, asset.id);
  const expectedBytes = Number(asset.byte_size);
  if (await verifyFileOnDisk(target, expectedBytes, asset.sha256)) {
    return target;
  }

  const config = await getServerSyncConfig(businessId);
  if (!config?.remoteUrl || !config.token) return null;
  const timeoutSignal = AbortSignal.timeout(30_000);
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const response = await fetch(`${config.remoteUrl.replace(/\/+$/, "")}/api/server-sync/media/${asset.id}`, {
    headers: { authorization: `Bearer ${config.token}` },
    signal: combinedSignal,
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    return null;
  }

  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  const hash = createHash("sha256");
  let received = 0;

  try {
    await pipeline(
      Readable.fromWeb(response.body as unknown as NodeWebReadableStream<Uint8Array>),
      new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          received += chunk.byteLength;
          if (received > expectedBytes) {
            callback(new Error("media_mirror_integrity_failed"));
            return;
          }
          hash.update(chunk);
          callback(null, chunk);
        },
      }),
      createWriteStream(temporary, { mode: 0o600 }),
    );
    if (received !== expectedBytes || hash.digest("hex") !== asset.sha256) {
      throw new Error("media_mirror_integrity_failed");
    }
    await rename(temporary, target);
    return target;
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

/** Remove any locally cached mirror file immediately upon soft-delete, purge, or sync deletion. */
export async function purgeMirroredMediaObject(businessId: string, assetId: string): Promise<void> {
  if (!UUID.test(businessId) || !UUID.test(assetId)) return;
  await unlink(cachePath(businessId, assetId)).catch(() => {});
}

/** Reads a verified local mirror, fetching it over the existing site credential once when absent. */
export async function readMirroredMediaObject(
  businessId: string,
  assetId: string,
): Promise<{
  asset: { kind: string; fileName: string; mimeType: string };
  bytes: Buffer;
} | null> {
  const asset = await queryActiveMirrorAsset(businessId, assetId);
  if (!asset) return null;
  const target = await ensureMirroredFileOnDisk(businessId, asset);
  if (!target) return null;
  const bytes = await readFile(target);
  return {
    asset: { kind: asset.kind, fileName: asset.file_name, mimeType: asset.mime_type },
    bytes,
  };
}

/**
 * Stream a verified local mirror (full file or RFC 9110 byte range) directly
 * from disk with zero full-file RAM buffering and immediate abort cleanup.
 * Never serves soft-deleted (`deleted_at IS NOT NULL`) assets.
 */
export async function openMirroredMediaStream(
  businessId: string,
  assetId: string,
  options: { range?: { start: number; end: number }; signal?: AbortSignal } = {},
): Promise<{
  asset: { kind: string; fileName: string; mimeType: string; byteSize: number; sha256: string };
  stream: ReadableStream<Uint8Array>;
  contentLength: number;
} | null> {
  const asset = await queryActiveMirrorAsset(businessId, assetId);
  if (!asset) return null;
  const target = await ensureMirroredFileOnDisk(businessId, asset, options.signal);
  if (!target) return null;
  const byteSize = Number(asset.byte_size);
  const start = options.range ? options.range.start : 0;
  const end = options.range ? options.range.end : Math.max(0, byteSize - 1);
  if (byteSize === 0) {
    return {
      asset: {
        kind: asset.kind,
        fileName: asset.file_name,
        mimeType: asset.mime_type,
        byteSize: 0,
        sha256: asset.sha256,
      },
      stream: new ReadableStream<Uint8Array>({ start(c) { c.close(); } }),
      contentLength: 0,
    };
  }
  const nodeStream = createReadStream(target, { start, end });
  const onAbort = () => nodeStream.destroy();
  options.signal?.addEventListener("abort", onAbort, { once: true });

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      nodeStream.on("data", (chunk: Buffer | string) => {
        const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        controller.enqueue(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
        if ((controller.desiredSize ?? 1) <= 0) {
          nodeStream.pause();
        }
      });
      nodeStream.on("end", () => {
        options.signal?.removeEventListener("abort", onAbort);
        controller.close();
      });
      nodeStream.on("error", (err) => {
        options.signal?.removeEventListener("abort", onAbort);
        controller.error(err);
      });
    },
    pull() {
      nodeStream.resume();
    },
    cancel() {
      options.signal?.removeEventListener("abort", onAbort);
      nodeStream.destroy();
    },
  });

  return {
    asset: {
      kind: asset.kind,
      fileName: asset.file_name,
      mimeType: asset.mime_type,
      byteSize,
      sha256: asset.sha256,
    },
    stream,
    contentLength: end - start + 1,
  };
}
