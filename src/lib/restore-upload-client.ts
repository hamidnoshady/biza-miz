/**
 * Browser half of a chunked restore upload (see ./restore-upload.ts for why the
 * file travels in pieces). Framework-free so both the dashboard's restore card
 * and the first-run screen use one copy.
 */

/** Must stay ≤ the server's RESTORE_UPLOAD_MAX_CHUNK_BYTES. */
export const CLIENT_CHUNK_BYTES = 4 * 1024 * 1024;

function newUploadId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export type UploadResult = { ok: true; uploadId: string } | { ok: false; error: string };

/**
 * Send `file` to `endpoint` in order, resuming from the server's size when it
 * answers `offset_mismatch` (a retried piece that had in fact arrived).
 * `onProgress` receives 0..1.
 */
export async function uploadRestoreFile(
  endpoint: string,
  file: Blob,
  onProgress?: (fraction: number) => void,
): Promise<UploadResult> {
  const uploadId = newUploadId();
  let offset = 0;
  let retries = 0;
  onProgress?.(0);
  while (offset < file.size) {
    const piece = file.slice(offset, Math.min(offset + CLIENT_CHUNK_BYTES, file.size));
    let res: Response;
    try {
      res = await fetch(`${endpoint}?id=${uploadId}&offset=${offset}`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: piece,
      });
    } catch {
      if (++retries > 3) return { ok: false, error: "upload_network" };
      continue;
    }
    const data = (await res.json().catch(() => ({}))) as { size?: number; error?: string };
    if (res.ok && typeof data.size === "number") {
      offset = data.size;
      retries = 0;
    } else if (res.status === 409 && data.error === "offset_mismatch" && typeof data.size === "number") {
      if (++retries > 3) return { ok: false, error: "upload_offset" };
      offset = data.size;
    } else {
      return { ok: false, error: data.error ?? "upload_failed" };
    }
    onProgress?.(file.size === 0 ? 1 : offset / file.size);
  }
  if (file.size === 0) return { ok: false, error: "empty_chunk" };
  return { ok: true, uploadId };
}
