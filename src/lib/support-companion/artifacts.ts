/**
 * Issue #984 — chunked diagnostic artifact upload.
 *
 * Large collector outputs (DB-integrity dumps, sync-journal excerpts) cannot
 * ride the findings JSON: the companion uploads them in ≤256 KiB chunks the
 * server reassembles and integrity-checks before marking `available`.
 *
 * Lifecycle: `beginArtifactUpload` (state `uploading`) → N ×
 * `uploadArtifactChunk` (idempotent per index) → `completeArtifactUpload`
 * (contiguity + size + sha256 verified, bytes moved to `payload`, chunks
 * deleted, state `available`). Any integrity failure moves the row to
 * `rejected` and deletes staged chunks — a half-assembled artifact is never
 * served.
 *
 * Auth is the caller's job: companion routes require a ticket-bound session
 * with `report.upload`; the service re-verifies run↔ticket↔business scope so
 * a session can never attach bytes to another ticket's run.
 */
import { createHash } from "node:crypto";
import { query, withTenant, withoutTenantScope } from "../db";

/** Max bytes per chunk (the 0229 CHECK caps an upload at 32 chunks). */
export const ARTIFACT_CHUNK_BYTES = 256 * 1024;
/** Max chunks per artifact — mirrors the CHECK in 0229. */
export const ARTIFACT_MAX_CHUNKS = 32;
/** Max total artifact bytes: 32 × 256 KiB. */
export const ARTIFACT_MAX_BYTES = ARTIFACT_MAX_CHUNKS * ARTIFACT_CHUNK_BYTES;
/** Abandoned `uploading` rows older than this are reaped as `rejected`. */
export const ARTIFACT_STALE_UPLOAD_MS = 24 * 60 * 60 * 1000;

export type ArtifactUploadState = "uploading" | "available" | "rejected";

export interface ArtifactMeta {
  id: string;
  businessId: string;
  runId: string;
  ticketId: string;
  name: string;
  kind: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  storageKey: string;
  chunkCount: number;
  uploadState: ArtifactUploadState;
  expiresAt: string | null;
  deletedAt: string | null;
  createdAt: string;
}

type ArtifactRow = {
  id: string;
  business_id: string;
  run_id: string;
  ticket_id: string;
  name: string;
  kind: string;
  mime_type: string;
  size_bytes: string | number;
  sha256: string;
  storage_key: string;
  chunk_count: string | number;
  upload_state: ArtifactUploadState;
  expires_at: string | null;
  deleted_at: string | null;
  created_at: string;
};

function toMeta(row: ArtifactRow): ArtifactMeta {
  return {
    id: row.id,
    businessId: row.business_id,
    runId: row.run_id,
    ticketId: row.ticket_id,
    name: row.name,
    kind: row.kind,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    sha256: row.sha256,
    storageKey: row.storage_key,
    chunkCount: Number(row.chunk_count),
    uploadState: row.upload_state,
    expiresAt: row.expires_at,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
  };
}

const META_COLUMNS = `id::text AS id, business_id::text AS business_id, run_id::text AS run_id,
  ticket_id::text AS ticket_id, name, kind, mime_type, size_bytes, sha256, storage_key,
  chunk_count, upload_state, expires_at, deleted_at, created_at`;

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isSha256(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

// ── Begin ────────────────────────────────────────────────────────────────────

export type BeginArtifactUploadResult =
  | { ok: true; artifact: ArtifactMeta }
  | {
      ok: false;
      error:
        | "run_not_found"
        | "invalid_size"
        | "invalid_chunk_count"
        | "invalid_hash"
        | "invalid_name";
    };

export async function beginArtifactUpload(input: {
  businessId: string;
  ticketId: string;
  runId: string;
  name: string;
  kind?: string;
  mimeType?: string;
  sha256: string;
  sizeBytes: number;
  chunkCount: number;
  expiresAt?: string | null;
}): Promise<BeginArtifactUploadResult> {
  const name = input.name.trim().slice(0, 255);
  if (!name) return { ok: false, error: "invalid_name" };
  if (!isSha256(input.sha256)) return { ok: false, error: "invalid_hash" };
  if (
    !Number.isInteger(input.sizeBytes) ||
    input.sizeBytes <= 0 ||
    input.sizeBytes > ARTIFACT_MAX_BYTES
  ) {
    return { ok: false, error: "invalid_size" };
  }
  const expectedChunks = Math.ceil(input.sizeBytes / ARTIFACT_CHUNK_BYTES);
  if (input.chunkCount !== expectedChunks) return { ok: false, error: "invalid_chunk_count" };

  return withTenant(input.businessId, async () => {
    // The run pins the scope: it must belong to this business AND this ticket.
    const { rows: runs } = await query<{ id: string }>(
      `SELECT id::text AS id FROM support_diagnostic_runs
        WHERE id = $1 AND business_id = $2 AND ticket_id = $3`,
      [input.runId, input.businessId, input.ticketId],
    );
    if (!runs[0]) return { ok: false, error: "run_not_found" };

    const kind = (input.kind ?? "report").trim().slice(0, 64) || "report";
    const mimeType = (input.mimeType ?? "application/json").trim().slice(0, 128) || "application/json";
    const { rows } = await query<ArtifactRow>(
      `INSERT INTO support_diagnostic_artifacts
         (business_id, run_id, ticket_id, name, kind, mime_type, size_bytes, sha256,
          storage_key, chunk_count, upload_state, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9, 'uploading', $10)
       RETURNING ${META_COLUMNS}`,
      [
        input.businessId,
        input.runId,
        input.ticketId,
        name,
        kind,
        mimeType,
        input.sizeBytes,
        input.sha256,
        input.chunkCount,
        input.expiresAt ?? null,
      ],
    );
    const artifact = toMeta(rows[0]);
    // Logical object key, derived from the assigned id (bytes live in `payload`
    // until an object store lands; the key shape is already store-compatible).
    await query(
      `UPDATE support_diagnostic_artifacts SET storage_key = $1 WHERE id = $2 AND business_id = $3`,
      [`support-artifacts/${input.businessId}/${artifact.id}`, artifact.id, input.businessId],
    );
    return { ok: true, artifact: { ...artifact, storageKey: `support-artifacts/${input.businessId}/${artifact.id}` } };
  });
}

// ── Chunk upload ─────────────────────────────────────────────────────────────

export type UploadArtifactChunkResult =
  | { ok: true; chunkIndex: number; chunkHash: string; received: number; expected: number }
  | {
      ok: false;
      error:
        | "artifact_not_found"
        | "not_uploading"
        | "bad_index"
        | "chunk_too_large"
        | "empty_chunk"
        | "chunk_conflict";
    };

export async function uploadArtifactChunk(input: {
  businessId: string;
  artifactId: string;
  chunkIndex: number;
  bytes: Buffer;
}): Promise<UploadArtifactChunkResult> {
  if (input.bytes.length === 0) return { ok: false, error: "empty_chunk" };
  if (input.bytes.length > ARTIFACT_CHUNK_BYTES) return { ok: false, error: "chunk_too_large" };
  if (!Number.isInteger(input.chunkIndex) || input.chunkIndex < 0) {
    return { ok: false, error: "bad_index" };
  }
  const chunkHash = sha256Hex(input.bytes);

  return withTenant(input.businessId, async () => {
    const { rows: arts } = await query<{ chunk_count: number; upload_state: ArtifactUploadState }>(
      `SELECT chunk_count, upload_state FROM support_diagnostic_artifacts
        WHERE id = $1 AND business_id = $2 FOR UPDATE`,
      [input.artifactId, input.businessId],
    );
    const art = arts[0];
    if (!art) return { ok: false, error: "artifact_not_found" };
    if (art.upload_state !== "uploading") return { ok: false, error: "not_uploading" };
    if (input.chunkIndex >= Number(art.chunk_count)) return { ok: false, error: "bad_index" };

    const { rows: existing } = await query<{ chunk_hash: string }>(
      `SELECT chunk_hash FROM support_artifact_chunks
        WHERE artifact_id = $1 AND business_id = $2 AND chunk_index = $3`,
      [input.artifactId, input.businessId, input.chunkIndex],
    );
    // Idempotent retry with identical bytes is fine; different bytes for the
    // same index signal a confused client — reject, never silently overwrite.
    if (existing[0] && existing[0].chunk_hash !== chunkHash) {
      return { ok: false, error: "chunk_conflict" };
    }
    if (!existing[0]) {
      await query(
        `INSERT INTO support_artifact_chunks (artifact_id, business_id, chunk_index, chunk_hash, bytes)
         VALUES ($1, $2, $3, $4, $5)`,
        [input.artifactId, input.businessId, input.chunkIndex, chunkHash, input.bytes],
      );
    }
    const { rows: counted } = await query<{ received: string }>(
      `SELECT COUNT(*)::text AS received FROM support_artifact_chunks
        WHERE artifact_id = $1 AND business_id = $2`,
      [input.artifactId, input.businessId],
    );
    return {
      ok: true,
      chunkIndex: input.chunkIndex,
      chunkHash,
      received: Number(counted[0].received),
      expected: Number(art.chunk_count),
    };
  });
}

// ── Complete / abort ─────────────────────────────────────────────────────────

export type CompleteArtifactUploadResult =
  | { ok: true; artifact: ArtifactMeta }
  | {
      ok: false;
      error: "artifact_not_found" | "not_uploading" | "incomplete" | "integrity_mismatch";
    };

export async function completeArtifactUpload(input: {
  businessId: string;
  artifactId: string;
}): Promise<CompleteArtifactUploadResult> {
  return withTenant(input.businessId, async () => {
    const { rows: arts } = await query<{
      size_bytes: number;
      sha256: string;
      chunk_count: number;
      upload_state: ArtifactUploadState;
    }>(
      `SELECT size_bytes, sha256, chunk_count, upload_state FROM support_diagnostic_artifacts
        WHERE id = $1 AND business_id = $2 FOR UPDATE`,
      [input.artifactId, input.businessId],
    );
    const art = arts[0];
    if (!art) return { ok: false, error: "artifact_not_found" };
    if (art.upload_state !== "uploading") return { ok: false, error: "not_uploading" };

    const expected = Number(art.chunk_count);
    const { rows: chunks } = await query<{ chunk_index: number; bytes: Buffer }>(
      `SELECT chunk_index, bytes FROM support_artifact_chunks
        WHERE artifact_id = $1 AND business_id = $2 ORDER BY chunk_index`,
      [input.artifactId, input.businessId],
    );
    const contiguous =
      chunks.length === expected &&
      chunks.every((c, i) => Number(c.chunk_index) === i);
    if (!contiguous) return { ok: false, error: "incomplete" };

    const assembled = Buffer.concat(chunks.map((c) => c.bytes));
    const failClosed = async () => {
      await query(
        `UPDATE support_diagnostic_artifacts SET upload_state = 'rejected', updated_at = now()
          WHERE id = $1 AND business_id = $2`,
        [input.artifactId, input.businessId],
      );
      await query(
        `DELETE FROM support_artifact_chunks WHERE artifact_id = $1 AND business_id = $2`,
        [input.artifactId, input.businessId],
      );
    };
    if (assembled.length !== Number(art.size_bytes) || sha256Hex(assembled) !== art.sha256) {
      await failClosed();
      return { ok: false, error: "integrity_mismatch" };
    }

    const { rows } = await query<ArtifactRow>(
      `UPDATE support_diagnostic_artifacts
          SET payload = $1, upload_state = 'available', updated_at = now()
        WHERE id = $2 AND business_id = $3
        RETURNING ${META_COLUMNS}`,
      [assembled, input.artifactId, input.businessId],
    );
    await query(
      `DELETE FROM support_artifact_chunks WHERE artifact_id = $1 AND business_id = $2`,
      [input.artifactId, input.businessId],
    );
    return { ok: true, artifact: toMeta(rows[0]) };
  });
}

export async function abortArtifactUpload(input: {
  businessId: string;
  artifactId: string;
}): Promise<{ ok: true; alreadyTerminal: boolean } | { ok: false; error: "artifact_not_found" }> {
  return withTenant(input.businessId, async () => {
    const { rows: arts } = await query<{ upload_state: ArtifactUploadState }>(
      `SELECT upload_state FROM support_diagnostic_artifacts
        WHERE id = $1 AND business_id = $2 FOR UPDATE`,
      [input.artifactId, input.businessId],
    );
    const art = arts[0];
    if (!art) return { ok: false, error: "artifact_not_found" };
    if (art.upload_state !== "uploading") return { ok: true, alreadyTerminal: true };
    await query(
      `UPDATE support_diagnostic_artifacts SET upload_state = 'rejected', updated_at = now()
        WHERE id = $1 AND business_id = $2`,
      [input.artifactId, input.businessId],
    );
    await query(
      `DELETE FROM support_artifact_chunks WHERE artifact_id = $1 AND business_id = $2`,
      [input.artifactId, input.businessId],
    );
    return { ok: true, alreadyTerminal: false };
  });
}

// ── Reads ────────────────────────────────────────────────────────────────────

export async function getArtifactMeta(
  businessId: string,
  artifactId: string,
): Promise<ArtifactMeta | null> {
  return withTenant(businessId, async () => {
    const { rows } = await query<ArtifactRow>(
      `SELECT ${META_COLUMNS} FROM support_diagnostic_artifacts
        WHERE id = $1 AND business_id = $2`,
      [artifactId, businessId],
    );
    return rows[0] ? toMeta(rows[0]) : null;
  });
}

export async function listRunArtifacts(businessId: string, runId: string): Promise<ArtifactMeta[]> {
  return withTenant(businessId, async () => {
    const { rows } = await query<ArtifactRow>(
      `SELECT ${META_COLUMNS} FROM support_diagnostic_artifacts
        WHERE business_id = $1 AND run_id = $2 AND deleted_at IS NULL
        ORDER BY created_at`,
      [businessId, runId],
    );
    return rows.map(toMeta);
  });
}

export type GetArtifactPayloadResult =
  | { ok: true; artifact: ArtifactMeta; payload: Buffer }
  | { ok: false; error: "artifact_not_found" | "not_available" | "expired" | "deleted" };

export async function getArtifactPayload(
  businessId: string,
  artifactId: string,
): Promise<GetArtifactPayloadResult> {
  return withTenant(businessId, async () => {
    const { rows } = await query<ArtifactRow & { payload: Buffer | null }>(
      `SELECT ${META_COLUMNS}, payload FROM support_diagnostic_artifacts
        WHERE id = $1 AND business_id = $2`,
      [artifactId, businessId],
    );
    const row = rows[0];
    if (!row) return { ok: false, error: "artifact_not_found" };
    if (row.deleted_at) return { ok: false, error: "deleted" };
    if (row.upload_state !== "available" || !row.payload) {
      return { ok: false, error: "not_available" };
    }
    if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
      return { ok: false, error: "expired" };
    }
    return { ok: true, artifact: toMeta(row), payload: row.payload };
  });
}

// ── Retention sweep ──────────────────────────────────────────────────────────
//
// Run periodically (same scheduler that drives other janitor jobs): expired
// artifacts lose their bytes, abandoned uploads are rejected, and spent
// single-use enrollment claims are hard-deleted. Counts are returned for the
// job log; the sweep is idempotent.

export interface SupportRetentionSweepResult {
  expiredArtifactBytesPurged: number;
  staleUploadsRejected: number;
  expiredEnrollmentsDeleted: number;
}

export async function runSupportRetentionSweep(now: Date = new Date()): Promise<SupportRetentionSweepResult> {
  // A cross-tenant janitor tick runs under the platform bypass (the same
  // shape as the data-transfer queue ticks): RLS must not hide other
  // tenants' expired bytes from their own purge. The sweep only deletes
  // expired bytes, abandoned staged chunks and spent claims — never live rows.
  return withoutTenantScope("platform", async () => {
    // Bytes of expired or soft-deleted artifacts are purged; the metadata row
    // stays so the ticket timeline keeps an honest tombstone.
    const purged = await query<{ count: string }>(
      `WITH gone AS (
         UPDATE support_diagnostic_artifacts
            SET payload = NULL, deleted_at = COALESCE(deleted_at, now()), updated_at = now()
          WHERE payload IS NOT NULL
            AND (deleted_at IS NOT NULL OR (expires_at IS NOT NULL AND expires_at <= $1))
          RETURNING id
       )
       SELECT COUNT(*)::text AS count FROM gone`,
      [now.toISOString()],
    );
    await query(
      `DELETE FROM support_artifact_chunks
        WHERE (artifact_id, business_id) IN (
          SELECT id, business_id FROM support_diagnostic_artifacts
          WHERE upload_state <> 'uploading'
        )`,
    );
    // Abandoned uploads: `uploading` rows (and their chunks via cascade) that
    // never completed within the stale window.
    const stale = await query<{ count: string }>(
      `WITH gone AS (
         UPDATE support_diagnostic_artifacts
            SET upload_state = 'rejected', updated_at = now()
          WHERE upload_state = 'uploading'
            AND created_at <= $1
          RETURNING id
       )
       SELECT COUNT(*)::text AS count FROM gone`,
      [new Date(now.getTime() - ARTIFACT_STALE_UPLOAD_MS).toISOString()],
    );
    const enrollments = await query<{ count: string }>(
      `WITH gone AS (
         DELETE FROM support_enrollments WHERE expires_at <= $1 RETURNING id
       )
       SELECT COUNT(*)::text AS count FROM gone`,
      [now.toISOString()],
    );
    return {
      expiredArtifactBytesPurged: Number(purged.rows[0].count),
      staleUploadsRejected: Number(stale.rows[0].count),
      expiredEnrollmentsDeleted: Number(enrollments.rows[0].count),
    };
  });
}
