/**
 * Issue #903 §7 / §8 — media **binaries** in a tenant backup.
 *
 * Until now a backup carried the media *rows* and nothing else: every manifest
 * said `media.attachments` was `excluded` and marked the backup `partial`. That
 * was honest, and it was also the last thing standing between a business and a
 * real recovery — a restored invoice whose photo is gone is not a restored
 * invoice, and a product catalogue without its images is not a recovered
 * catalogue.
 *
 * The design is sidecars, not a fatter archive:
 *
 *   • the payload stays **one** signed file of known size, so verification,
 *     transport, import and retention keep their shape;
 *   • each captured asset becomes **one encrypted sidecar object** beside it,
 *     named deterministically from the asset id, so a restore can find it and an
 *     operator can see exactly what exists;
 *   • the list of sidecars lives in the **signed manifest** (`media.assets[]`,
 *     manifest v2), so it is tamper-evident: an object added to or removed from
 *     the bucket cannot change what the backup claims to hold.
 *
 * Everything is encrypted with the artifact's own custody secret before it
 * leaves the process, because the whole point of §6 is that a bucket is not a
 * trust boundary. A sidecar's `sha256` is the **plaintext** hash the media
 * library already records, so a restore proves the bytes it wrote back are the
 * bytes the row describes.
 *
 * Caps are real and they are visible: `BACKUP_MEDIA_MAX_BYTES` (per run),
 * `BACKUP_MEDIA_MAX_ASSET_BYTES` (per asset) and `BACKUP_MEDIA_MAX_ASSETS`
 * (count). A run that stops early records `skipped`/`clipped` in the manifest and
 * the backup is labelled `partial` — a budget is allowed to lose a video, it is
 * never allowed to lie about having captured it.
 */
import { createHash } from "node:crypto";
import { createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { query } from "./db";
import { decryptFileToFile, encryptFileToFile } from "./backup-streams";
import type { BackupMediaAsset, BackupMediaCapture } from "./backup-manifest";
import { getMediaConfig, streamMediaObject, type ExtendedMediaStorageConfig } from "./media-service";
import { s3Delete, s3GetToFile, s3Head, s3PutFile, type S3Config } from "./s3-lite";

/** Bytes a single run may spend on media, across all assets. */
export const MEDIA_MAX_BYTES_PER_RUN = envInt("BACKUP_MEDIA_MAX_BYTES", 2 * 1024 * 1024 * 1024);
/** Largest single asset captured. A bigger one is skipped, not truncated. */
export const MEDIA_MAX_ASSET_BYTES = envInt("BACKUP_MEDIA_MAX_ASSET_BYTES", 512 * 1024 * 1024);
/** How many assets one run may capture. */
export const MEDIA_MAX_ASSETS_PER_RUN = envInt("BACKUP_MEDIA_MAX_ASSETS", 300);

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** The directory (or object prefix) an artifact's sidecars live in. */
export function mediaSidecarDirectory(artifact: string): string {
  return `${artifact}.media`;
}

/** A sidecar is named by the asset it holds, so a restore needs no index file. */
export function mediaSidecarName(assetId: string): string {
  return `${assetId}.enc`;
}

interface CapturableAsset {
  id: string;
  storageKey: string;
  sha256: string;
  byteSize: number;
  mimeType: string;
  fileName: string;
}

/**
 * The business's media, smallest first.
 *
 * Smallest first is deliberate: when a budget stops a run, the business keeps
 * the images that make up most of a catalogue rather than one long video that
 * happened to be newest.
 */
export async function listCapturableMedia(businessId: string): Promise<CapturableAsset[]> {
  const { rows } = await query<{
    id: string;
    storage_key: string;
    sha256: string;
    byte_size: string;
    mime_type: string;
    file_name: string;
  }>(
    `SELECT id::text, storage_key, sha256, byte_size::text, mime_type, file_name
       FROM media_assets
      WHERE business_id = $1 AND deleted_at IS NULL
      ORDER BY byte_size ASC, created_at ASC`,
    [businessId],
  );
  return rows.map((row) => ({
    id: row.id,
    storageKey: row.storage_key,
    sha256: row.sha256,
    byteSize: Number(row.byte_size),
    mimeType: row.mime_type,
    fileName: row.file_name,
  }));
}

function s3ConfigOf(config: ExtendedMediaStorageConfig): S3Config {
  return {
    endpoint: config.endpoint,
    region: config.region,
    bucket: config.bucket,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
  };
}

/**
 * Copy the business's media next to an artifact being written.
 *
 * Returns the manifest inventory plus the encrypted bytes stored, and **never
 * throws for a missing asset**: media deleted between the row read and the copy
 * is a `skipped` count, because a backup that refuses to be taken is worse than
 * one that says what it could not reach.
 */
export async function captureMediaSidecars(input: {
  businessId: string;
  artifact: string;
  /** Local directory the artifact is being written to. */
  directory: string;
  /** The artifact's own encryption secret — sidecars are never plaintext. */
  secret: string;
  limits?: { maxBytes?: number; maxAssetBytes?: number; maxAssets?: number };
}): Promise<BackupMediaCapture> {
  const maxBytes = input.limits?.maxBytes ?? MEDIA_MAX_BYTES_PER_RUN;
  const maxAssetBytes = input.limits?.maxAssetBytes ?? MEDIA_MAX_ASSET_BYTES;
  const maxAssets = input.limits?.maxAssets ?? MEDIA_MAX_ASSETS_PER_RUN;

  const config = await getMediaConfig();
  const assets = await listCapturableMedia(input.businessId);
  const sidecarDir = path.join(input.directory, mediaSidecarDirectory(input.artifact));
  const captured: BackupMediaAsset[] = [];
  let storedBytes = 0;
  let skipped = 0;
  let clipped = false;

  for (const asset of assets) {
    if (captured.length >= maxAssets) {
      skipped += assets.length - captured.length;
      clipped = true;
      break;
    }
    if (asset.byteSize > maxAssetBytes || storedBytes + asset.byteSize > maxBytes) {
      // Over a cap: this asset is not carried, and the manifest says so.
      skipped += 1;
      clipped = true;
      continue;
    }
    const sidecar = mediaSidecarName(asset.id);
    const storedPath = path.join(sidecarDir, sidecar);
    const plainPath = path.join(sidecarDir, `${asset.id}.plain.tmp`);
    await fs.mkdir(sidecarDir, { recursive: true });
    try {
      const streamed = await streamMediaObject(input.businessId, asset.storageKey, config);
      if (!streamed) {
        // The object is already gone. The row still exists, so this is exactly
        // the case a backup has to survive rather than report as a failure.
        skipped += 1;
        continue;
      }
      await pipeline(Readable.fromWeb(streamed.stream as never), createWriteStream(plainPath, { mode: 0o600 }));
      const encrypted = await encryptFileToFile(plainPath, storedPath, input.secret);
      storedBytes += encrypted.sizeBytes;
      captured.push({
        assetId: asset.id,
        key: asset.storageKey,
        sha256: asset.sha256,
        bytes: asset.byteSize,
        mimeType: asset.mimeType,
        fileName: asset.fileName,
        sidecar,
      });
    } catch {
      skipped += 1;
    } finally {
      await fs.rm(plainPath, { force: true }).catch(() => undefined);
    }
  }

  return { assets: captured, skipped, storedBytes, clipped };
}

/** Remove an artifact's sidecars from a local directory. */
export async function removeLocalMediaSidecars(directory: string, artifact: string): Promise<void> {
  await fs.rm(path.join(directory, mediaSidecarDirectory(artifact)), { recursive: true, force: true });
}

/**
 * Re-read every sidecar and prove it is still the asset the manifest signed.
 *
 * Runs after the payload verifies: a backup is `ready` only when the bytes it
 * claims beside the payload are there and open to the same key. Missing or
 * altered media is a verification failure with a code the console can show,
 * never a silent partial restore later.
 */
export async function verifyMediaSidecars(input: {
  media: BackupMediaCapture | null | undefined;
  directory: string;
  artifact: string;
  secret: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!input.media || input.media.assets.length === 0) return { ok: true };
  const sidecarDir = path.join(input.directory, mediaSidecarDirectory(input.artifact));
  for (const asset of input.media.assets) {
    const sidecarPath = path.join(sidecarDir, asset.sidecar);
    const plainPath = `${sidecarPath}.verify.tmp`;
    try {
      const decrypted = await decryptFileToFile(sidecarPath, plainPath, input.secret);
      if (decrypted.sizeBytes !== asset.bytes) return { ok: false, error: "media_asset_size_mismatch" };
      if ((await sha256File(plainPath)) !== asset.sha256) {
        return { ok: false, error: "media_asset_checksum_mismatch" };
      }
    } catch (error) {
      const code = error instanceof Error && /bad magic/.test(error.message) ? "media_asset_unreadable" : "media_asset_missing";
      return { ok: false, error: code };
    } finally {
      await fs.rm(plainPath, { force: true }).catch(() => undefined);
    }
  }
  return { ok: true };
}

/** Upload an artifact's captured sidecars to the destination the payload went to. */
export async function uploadMediaSidecars(input: {
  s3: S3Config;
  prefix: string;
  artifact: string;
  directory: string;
  media: BackupMediaCapture | null | undefined;
}): Promise<{ uploaded: number; failed: number }> {
  if (!input.media || input.media.assets.length === 0) return { uploaded: 0, failed: 0 };
  const sidecarDir = path.join(input.directory, mediaSidecarDirectory(input.artifact));
  let uploaded = 0;
  let failed = 0;
  for (const asset of input.media.assets) {
    const localPath = path.join(sidecarDir, asset.sidecar);
    const key = `${input.prefix}${mediaSidecarDirectory(input.artifact)}/${asset.sidecar}`;
    try {
      const sizeBytes = (await fs.stat(localPath)).size;
      const payloadHash = await sha256File(localPath);
      await s3PutFile(input.s3, key, localPath, { payloadHash, sizeBytes });
      uploaded += 1;
    } catch {
      failed += 1;
    }
  }
  return { uploaded, failed };
}

/** Delete an artifact's sidecars from a destination, when the artifact is deleted. */
export async function deleteMediaSidecars(input: {
  s3: S3Config;
  prefix: string;
  artifact: string;
  media: BackupMediaCapture | null | undefined;
}): Promise<void> {
  if (!input.media) return;
  for (const asset of input.media.assets) {
    const key = `${input.prefix}${mediaSidecarDirectory(input.artifact)}/${asset.sidecar}`;
    await s3Delete(input.s3, key).catch(() => undefined);
  }
}

/**
 * Write a backup's media back into the media library after a restore.
 *
 * The rule is *revert*, which is what a restore means, but never silently: an
 * object that already exists and differs is copied to
 * `_restore-quarantine/<artifact>/<assetId>` first, so the bytes this restore
 * replaced are still there for the operator who needs them. Objects that already
 * match are left alone — rewriting 300 identical images would spend an hour to
 * change nothing.
 */
export async function restoreMediaSidecars(input: {
  businessId: string;
  artifact: string;
  /** Where the sidecars can be read from: a local artifact directory. */
  directory: string;
  secret: string;
  media: BackupMediaCapture | null | undefined;
  quarantinePrefix?: string;
}): Promise<{ restored: number; unchanged: number; quarantined: number; failed: number }> {
  const result = { restored: 0, unchanged: 0, quarantined: 0, failed: 0 };
  if (!input.media || input.media.assets.length === 0) return result;
  const config = await getMediaConfig();
  const s3 = s3ConfigOf(config);
  const sidecarDir = path.join(input.directory, mediaSidecarDirectory(input.artifact));
  const quarantinePrefix =
    input.quarantinePrefix ?? `_restore-quarantine/${input.artifact}/`;

  for (const asset of input.media.assets) {
    const sidecarPath = path.join(sidecarDir, asset.sidecar);
    const plainPath = path.join(sidecarDir, `${asset.assetId}.restore.tmp`);
    try {
      await decryptFileToFile(sidecarPath, plainPath, input.secret);
      if ((await sha256File(plainPath)) !== asset.sha256) {
        result.failed += 1;
        continue;
      }
      const existing = await s3Head(s3, asset.key);
      if (existing) {
        const existingHash = await hashRemote(s3, asset.key);
        if (existingHash === asset.sha256) {
          result.unchanged += 1;
          continue;
        }
        // Keep what this restore is about to overwrite.
        const quarantineKey = `${quarantinePrefix}${asset.assetId}`;
        const copy = path.join(sidecarDir, `${asset.assetId}.previous.tmp`);
        try {
          const fetched = await s3GetToFile(s3, asset.key, copy, { maxBytes: MEDIA_MAX_ASSET_BYTES });
          await s3PutFile(s3, quarantineKey, copy, {
            payloadHash: fetched.sha256,
            sizeBytes: fetched.sizeBytes,
          });
          result.quarantined += 1;
        } finally {
          await fs.rm(copy, { force: true }).catch(() => undefined);
        }
      }
      const sizeBytes = (await fs.stat(plainPath)).size;
      const payloadHash = await sha256File(plainPath);
      await s3PutFile(s3, asset.key, plainPath, { payloadHash, sizeBytes });
      result.restored += 1;
    } catch {
      result.failed += 1;
    } finally {
      await fs.rm(plainPath, { force: true }).catch(() => undefined);
    }
  }
  return result;
}

async function hashRemote(s3: S3Config, key: string): Promise<string | null> {
  const tmp = path.join(process.cwd(), ".data", "backup-media-hash.tmp");
  try {
    await fs.mkdir(path.dirname(tmp), { recursive: true });
    const fetched = await s3GetToFile(s3, key, tmp, { maxBytes: MEDIA_MAX_ASSET_BYTES });
    return fetched.sha256;
  } catch {
    return null;
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  const handle = await fs.open(filePath, "r");
  try {
    const stream = handle.createReadStream();
    for await (const chunk of stream) hash.update(chunk as Buffer);
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

/**
 * Put an artifact's sidecars where `restoreMediaSidecars` can read them.
 *
 * A local artifact already has them beside it. A cloud artifact's sidecars are
 * objects of their own, so they are downloaded into a temporary directory and
 * removed afterwards — bounded by the manifest, which is the only source of what
 * to fetch.
 */
export async function stageMediaForRestore(input: {
  businessId: string;
  artifact: string;
  destination: "local" | "cloud";
  media: BackupMediaCapture | null | undefined;
}): Promise<{ directory: string; cleanup: () => Promise<void> } | null> {
  if (!input.media || input.media.assets.length === 0) return null;
  // Loaded lazily: `backup-service` imports this module, and a static cycle
  // would make either side's module initialisation depend on import order.
  const { getBackupConfig, tenantBackupDir } = await import("./backup-service");
  const { logicalSnapshotScopeTag } = await import("./backup-policy");
  const { readDeploymentProfile } = await import("./deployment-mode");
  const { deploymentRole } = await import("./deployment-role");
  const { resolveTenantStorage } = await import("./tenant-backup-storage");

  const directory = tenantBackupDir(input.businessId);
  if (input.destination === "local") return { directory, cleanup: async () => {} };

  const profile = (await readDeploymentProfile(input.businessId)).profile;
  const backupConfig = await getBackupConfig(input.businessId);
  const storage = await resolveTenantStorage({
    businessId: input.businessId,
    profile,
    role: deploymentRole(),
    legacyCloud: backupConfig.cloud,
  });
  if (storage.mode === "unavailable") return null;
  const prefix =
    storage.mode === "managed"
      ? `${storage.prefix}tenants/${logicalSnapshotScopeTag(input.businessId)}/`
      : storage.prefix;
  const target = path.join(directory, mediaSidecarDirectory(input.artifact));
  await fs.mkdir(target, { recursive: true });
  for (const asset of input.media.assets) {
    const key = `${prefix}${mediaSidecarDirectory(input.artifact)}/${asset.sidecar}`;
    await s3GetToFile(storage.s3, key, path.join(target, asset.sidecar), {
      maxBytes: MEDIA_MAX_ASSET_BYTES + 4096,
    });
  }
  return {
    directory,
    cleanup: async () => {
      await fs.rm(target, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}
