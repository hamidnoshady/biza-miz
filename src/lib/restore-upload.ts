import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Staging for a backup file the Owner *uploads* to restore from — the case the
 * artifact list cannot cover: a fresh install (or a reinstalled desktop) has an
 * empty `backup_runs`, so the `.dump`/`.dump.enc` the old install wrote is on
 * disk, or on a USB stick, but nothing in this database names it.
 *
 * The file arrives in chunks rather than one multipart body because Next's
 * middleware clones every request body up to `middlewareClientMaxBodySize`
 * (10 MB by default) and silently *truncates* anything longer. Raising that
 * limit would raise it for every route on a public server; sending ≤ 4 MB
 * pieces keeps every request under it and keeps memory flat.
 *
 * Each upload lives under a per-scope directory (the business id, or `setup`
 * for the first-run screen) so one scope can never name another's file, and is
 * removed after an apply, on discard, or by the stale sweep.
 */

/** Client-side piece size; comfortably under the 10 MB middleware clone limit. */
export const RESTORE_UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;
/** Server-side ceiling for one piece (the client's size plus headroom). */
export const RESTORE_UPLOAD_MAX_CHUNK_BYTES = 8 * 1024 * 1024;
/** A dump bigger than this is not a single-business desktop database. */
export const RESTORE_UPLOAD_MAX_BYTES = 2 * 1024 * 1024 * 1024;
/** An upload nobody finished or applied is removed after this long. */
export const RESTORE_UPLOAD_TTL_MS = 6 * 60 * 60 * 1000;

const UPLOAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SCOPE = /^[A-Za-z0-9_-]{1,64}$/;

export function isRestoreUploadId(value: unknown): value is string {
  return typeof value === "string" && UPLOAD_ID.test(value);
}

export type ChunkParams =
  | { ok: true; id: string; offset: number }
  | { ok: false; error: "invalid_upload_id" | "invalid_offset" };

/** Validate the `?id=&offset=` pair a chunk request carries. */
export function parseChunkParams(id: string | null, offset: string | null): ChunkParams {
  if (!isRestoreUploadId(id)) return { ok: false, error: "invalid_upload_id" };
  if (offset === null || !/^\d{1,12}$/.test(offset)) return { ok: false, error: "invalid_offset" };
  const value = Number(offset);
  if (!Number.isSafeInteger(value) || value > RESTORE_UPLOAD_MAX_BYTES) {
    return { ok: false, error: "invalid_offset" };
  }
  return { ok: true, id, offset: value };
}

/** The display name the summary shows — never used as a path. */
export function uploadSourceName(fileName: unknown): string {
  const raw = typeof fileName === "string" ? fileName : "";
  const base = raw.split(/[\\/]/).at(-1)?.trim() ?? "";
  const clean = base.replace(/[^\p{L}\p{N}._ -]/gu, "").slice(0, 120);
  return clean || "uploaded-backup.dump";
}

export function restoreUploadRoot(): string {
  return path.join(os.tmpdir(), "pos-restore-uploads");
}

function uploadPath(scope: string, id: string, root: string): string {
  if (!SCOPE.test(scope)) throw new Error("invalid_upload_scope");
  if (!isRestoreUploadId(id)) throw new Error("invalid_upload_id");
  return path.join(root, scope, `${id}.part`);
}

export type AppendOutcome =
  | { ok: true; size: number }
  | { ok: false; error: "offset_mismatch"; size: number }
  | { ok: false; error: "chunk_too_large" | "upload_too_large" | "empty_chunk" };

/**
 * Append one piece at `offset`. The offset must equal the bytes already
 * staged, so a retried or out-of-order piece is refused (with the size the
 * client should resume from) instead of corrupting the dump.
 */
export async function appendRestoreChunk(
  scope: string,
  id: string,
  offset: number,
  bytes: Uint8Array,
  root = restoreUploadRoot(),
): Promise<AppendOutcome> {
  if (bytes.byteLength === 0) return { ok: false, error: "empty_chunk" };
  if (bytes.byteLength > RESTORE_UPLOAD_MAX_CHUNK_BYTES) return { ok: false, error: "chunk_too_large" };
  if (offset + bytes.byteLength > RESTORE_UPLOAD_MAX_BYTES) return { ok: false, error: "upload_too_large" };

  const file = uploadPath(scope, id, root);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  if (offset === 0) {
    // A fresh start for this id replaces whatever a previous attempt left.
    await fs.writeFile(file, bytes, { mode: 0o600 });
    return { ok: true, size: bytes.byteLength };
  }
  let size: number;
  try {
    size = (await fs.stat(file)).size;
  } catch {
    return { ok: false, error: "offset_mismatch", size: 0 };
  }
  if (size !== offset) return { ok: false, error: "offset_mismatch", size };
  await fs.appendFile(file, bytes);
  return { ok: true, size: size + bytes.byteLength };
}

/** The staged bytes, or null when there is no such upload in this scope. */
export async function readRestoreUpload(
  scope: string,
  id: string,
  root = restoreUploadRoot(),
): Promise<Buffer | null> {
  try {
    return await fs.readFile(uploadPath(scope, id, root));
  } catch {
    return null;
  }
}

export async function discardRestoreUpload(
  scope: string,
  id: string,
  root = restoreUploadRoot(),
): Promise<void> {
  await fs.rm(uploadPath(scope, id, root), { force: true });
}

/** Remove uploads older than the TTL, in every scope. Best-effort. */
export async function sweepStaleRestoreUploads(
  now = Date.now(),
  root = restoreUploadRoot(),
): Promise<number> {
  let removed = 0;
  let scopes: string[];
  try {
    scopes = await fs.readdir(root);
  } catch {
    return 0;
  }
  for (const scope of scopes) {
    const dir = path.join(root, scope);
    let files: string[];
    try {
      files = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const name of files) {
      const file = path.join(dir, name);
      try {
        const stat = await fs.stat(file);
        if (now - stat.mtimeMs > RESTORE_UPLOAD_TTL_MS) {
          await fs.rm(file, { force: true });
          removed += 1;
        }
      } catch {
        // raced with a discard — nothing to do
      }
    }
  }
  return removed;
}
