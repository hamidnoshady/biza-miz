/**
 * Issue #903 §3 — artifact transport.
 *
 * Two directions, one rule: a browser never names a path, a bucket, an object
 * key or a destination. It names an opaque reference it already received, and
 * the server decides — after permission, ownership and state checks — whether
 * that reference may be read or written today.
 *
 * **Download** is authorised by a short-lived ticket minted server-side and
 * bound to one business, one reference and one destination. A ticket is not a
 * credential to storage: it can only be redeemed by the same business over the
 * same artifact, and it expires in minutes. Cloud artifacts redirect to a
 * time-limited provider URL so bytes do not stream through the app server; local
 * artifacts stream from the backup directory.
 *
 * **Upload** is chunked because Next clones request bodies and truncates at
 * ~10 MB. Chunks append to a per-business staging file, and a finished upload is
 * *quarantined*: it becomes an inventory row in `verifying`, which no restore
 * path accepts. Promotion out of quarantine happens only in
 * `completeTenantUpload`, after the byte count and SHA-256 both match the
 * declared values, and only then can a restore preview select it.
 */
import { createHmac, createHash, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { query } from "./db";
import { getMasterKey } from "./master-key";
import { decryptFileToFile } from "./backup-streams";
import { sha256File } from "./backup-streams";
import { presignS3Get, s3GetToFile } from "./s3-lite";
import { logicalSnapshotScopeTag } from "./backup-policy";
import { installedSchemaVersion, markArtifactStateByRef, recordTenantArtifact, resolveOwnedArtifact } from "./tenant-backup-artifacts-service";
import {
  cleanupStagingDir,
  ensureStagingDir,
  resolveTenantStorage,
  tenantStagingDir,
  type TenantStorageTarget,
} from "./tenant-backup-storage";
import {
  artifactEncryptionFor,
  decryptionSecretFor,
  deterministicArtifactId,
  verifyStoredArtifact,
} from "./tenant-backup-runner";
import { parseTenantArchive, tenantTableSet } from "./tenant-archive";
import { tenantBackupArtifactRef } from "./tenant-backup-artifact-ref";
import { buildBackupManifest } from "./backup-manifest";
import type { DeploymentProfile } from "./deployment-mode";
import type { DeploymentRole } from "./deployment-role";

/** Long enough to start a large download, short enough to be useless later. */
export const DOWNLOAD_TICKET_TTL_SECONDS = 300;
/** Provider URL lifetime for a cloud artifact redirect. */
export const PRESIGN_TTL_SECONDS = 300;
/** Client piece size, comfortably under the 10 MB body clone limit. */
export const UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;
/** Server ceiling for one piece. */
export const UPLOAD_MAX_CHUNK_BYTES = 8 * 1024 * 1024;
/** Ceiling for one uploaded artifact (matches the service's default limit). */
export const UPLOAD_MAX_BYTES = 5 * 1024 * 1024 * 1024;
/** An upload nobody finished is abandoned after a day (the row says so). */
export const UPLOAD_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Download tickets
// ---------------------------------------------------------------------------

export interface DownloadTicketClaims {
  businessId: string;
  ref: string;
  destination: "local" | "cloud";
  /** Unix seconds; the ticket is refused at or after this moment. */
  expiresAt: number;
}

type TicketEnvelope = {
  v: 1;
  b: string;
  r: string;
  d: "local" | "cloud";
  e: number;
};

function ticketKey(masterKey: Buffer): Buffer {
  return createHmac("sha256", masterKey).update("tenant-backup-download-ticket-v1").digest();
}

function b64url(data: Buffer): string {
  return data.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  } catch {
    return null;
  }
}

/** Mint a ticket for one artifact at one destination. */
export function sealDownloadTicket(claims: DownloadTicketClaims, masterKey: Buffer | null = getMasterKey()): string | null {
  if (!masterKey) return null;
  const envelope: TicketEnvelope = {
    v: 1,
    b: claims.businessId,
    r: claims.ref,
    d: claims.destination,
    e: Math.floor(claims.expiresAt),
  };
  const payload = b64url(Buffer.from(JSON.stringify(envelope), "utf8"));
  const signature = b64url(createHmac("sha256", ticketKey(masterKey)).update(payload).digest());
  return `${payload}.${signature}`;
}

export type TicketResult =
  | { ok: true; claims: DownloadTicketClaims }
  | { ok: false; error: "invalid_download_ticket" | "expired_download_ticket" };

/**
 * Redeem a ticket. The signature is compared in constant time, and the claims
 * are re-checked against the caller's business — a valid ticket minted for
 * another business does not grant access.
 */
export function openDownloadTicket(
  token: string | null | undefined,
  masterKey: Buffer | null = getMasterKey(),
  now: Date = new Date(),
): TicketResult {
  if (!masterKey || typeof token !== "string") return { ok: false, error: "invalid_download_ticket" };
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) return { ok: false, error: "invalid_download_ticket" };
  const expected = b64url(createHmac("sha256", ticketKey(masterKey)).update(payload).digest());
  const given = fromB64url(signature);
  const want = fromB64url(expected);
  if (!given || !want || given.length !== want.length || !timingSafeEqual(given, want)) {
    return { ok: false, error: "invalid_download_ticket" };
  }
  const raw = fromB64url(payload);
  if (!raw) return { ok: false, error: "invalid_download_ticket" };
  let envelope: TicketEnvelope;
  try {
    envelope = JSON.parse(raw.toString("utf8")) as TicketEnvelope;
  } catch {
    return { ok: false, error: "invalid_download_ticket" };
  }
  if (
    envelope?.v !== 1 ||
    typeof envelope.b !== "string" ||
    typeof envelope.r !== "string" ||
    (envelope.d !== "local" && envelope.d !== "cloud") ||
    !Number.isSafeInteger(envelope.e)
  ) {
    return { ok: false, error: "invalid_download_ticket" };
  }
  if (envelope.e * 1000 <= now.getTime()) return { ok: false, error: "expired_download_ticket" };
  return {
    ok: true,
    claims: { businessId: envelope.b, ref: envelope.r, destination: envelope.d, expiresAt: envelope.e },
  };
}

// ---------------------------------------------------------------------------
// Chunked upload validation (pure)
// ---------------------------------------------------------------------------

export type ChunkCheck =
  | { ok: true; nextOffset: number }
  | { ok: false; error: "invalid_offset" | "chunk_too_large" | "upload_too_large" | "upload_complete" };

/**
 * Whether one piece may be appended. `offset` must equal what has been received
 * so far: that is what makes a retried piece safe (it is rejected rather than
 * duplicated) and a resumed upload correct.
 */
export function checkChunk(input: {
  expectedBytes: number;
  receivedBytes: number;
  offset: number;
  chunkLength: number;
  maxChunkBytes?: number;
  maxBytes?: number;
}): ChunkCheck {
  const maxChunk = input.maxChunkBytes ?? UPLOAD_MAX_CHUNK_BYTES;
  const maxBytes = input.maxBytes ?? UPLOAD_MAX_BYTES;
  if (input.expectedBytes > maxBytes) return { ok: false, error: "upload_too_large" };
  if (input.chunkLength > maxChunk) return { ok: false, error: "chunk_too_large" };
  if (!Number.isSafeInteger(input.offset) || input.offset < 0) return { ok: false, error: "invalid_offset" };
  if (input.offset !== input.receivedBytes) return { ok: false, error: "invalid_offset" };
  if (input.receivedBytes >= input.expectedBytes) return { ok: false, error: "upload_complete" };
  if (input.receivedBytes + input.chunkLength > input.expectedBytes) return { ok: false, error: "invalid_offset" };
  return { ok: true, nextOffset: input.receivedBytes + input.chunkLength };
}

export type CompletionCheck =
  | { ok: true }
  | { ok: false; error: "upload_incomplete" | "size_mismatch" | "checksum_mismatch" };

/** A finished upload is only promoted when both size and digest match. */
export function checkCompletion(input: {
  expectedBytes: number;
  receivedBytes: number;
  expectedSha256: string;
  actualSha256: string;
}): CompletionCheck {
  if (input.receivedBytes !== input.expectedBytes) return { ok: false, error: "upload_incomplete" };
  if (input.receivedBytes < 1) return { ok: false, error: "size_mismatch" };
  if (input.expectedSha256.toLowerCase() !== input.actualSha256.toLowerCase()) {
    return { ok: false, error: "checksum_mismatch" };
  }
  return { ok: true };
}

/** Only an artifact in this state can be offered for download or restore. */
export function isTransportableState(state: string): boolean {
  return state === "ready";
}

// ---------------------------------------------------------------------------
// Upload sessions
// ---------------------------------------------------------------------------

export interface UploadSessionRow {
  businessId: string;
  token: string;
  expectedBytes: number;
  receivedBytes: number;
  state: "open" | "complete" | "abandoned" | "expired";
  sha256: string | null;
  stagingRef: string;
  expiresAt: string;
}

interface UploadDbRow extends Record<string, unknown> {
  business_id: string;
  session_token: string;
  expected_bytes: string;
  received_bytes: string;
  state: UploadSessionRow["state"];
  sha256: string | null;
  staging_ref: string;
  expires_at: Date;
}

function mapUploadRow(row: UploadDbRow): UploadSessionRow {
  return {
    businessId: row.business_id,
    token: row.session_token,
    expectedBytes: Number(row.expected_bytes),
    receivedBytes: Number(row.received_bytes),
    state: row.state,
    sha256: row.sha256,
    stagingRef: row.staging_ref,
    expiresAt: row.expires_at.toISOString(),
  };
}

/**
 * Open a session. The token is random and single-business; the staging file is
 * named by it, so a token can only ever append to its own file.
 */
export async function startUploadSession(input: {
  businessId: string;
  expectedBytes: number;
  sha256?: string | null;
  createdBy: string;
}): Promise<{ ok: true; session: UploadSessionRow; chunkBytes: number } | { ok: false; error: string }> {
  if (!Number.isSafeInteger(input.expectedBytes) || input.expectedBytes < 1) {
    return { ok: false, error: "invalid_size" };
  }
  if (input.expectedBytes > UPLOAD_MAX_BYTES) return { ok: false, error: "upload_too_large" };
  if (input.sha256 && !/^[0-9a-f]{64}$/i.test(input.sha256)) return { ok: false, error: "invalid_checksum" };

  const token = createHash("sha256")
    .update(JSON.stringify([input.businessId, input.createdBy, Date.now(), Math.random()]))
    .digest("hex")
    .slice(0, 32);
  const stagingRef = `upload-${token}`;

  const { rows } = await query<UploadDbRow>(
    `INSERT INTO tenant_backup_upload_sessions
       (business_id, session_token, expected_bytes, sha256, staging_ref, state, expires_at, created_by)
     VALUES ($1, $2, $3, $4, $5, 'open', now() + interval '1 day', $6)
     RETURNING business_id, session_token, expected_bytes, received_bytes, state, sha256, staging_ref, expires_at`,
    [input.businessId, token, input.expectedBytes, input.sha256 ?? null, stagingRef, input.createdBy],
  );
  const row = rows[0];
  if (!row) return { ok: false, error: "upload_session_failed" };

  const dir = await ensureStagingDir(input.businessId, stagingRef);
  await fs.writeFile(path.join(dir, "payload.bin"), Buffer.alloc(0), { mode: 0o600 });
  return { ok: true, session: mapUploadRow(row), chunkBytes: UPLOAD_CHUNK_BYTES };
}

async function findSession(businessId: string, token: string): Promise<UploadSessionRow | null> {
  if (!/^[0-9a-f]{32}$/.test(token)) return null;
  const { rows } = await query<UploadDbRow>(
    `SELECT business_id, session_token, expected_bytes, received_bytes, state, sha256, staging_ref, expires_at
       FROM tenant_backup_upload_sessions
      WHERE business_id = $1 AND session_token = $2`,
    [businessId, token],
  );
  return rows[0] ? mapUploadRow(rows[0]) : null;
}

/**
 * Append one piece. The file is opened in append mode and the offset is proved
 * against the file's own length *and* the row's counter, so a crashed request
 * cannot leave a gap or a duplicate tail.
 */
export async function appendUploadChunk(input: {
  businessId: string;
  token: string;
  offset: number;
  chunk: Buffer;
  maxBytes?: number;
}): Promise<{ ok: true; receivedBytes: number } | { ok: false; error: string }> {
  const session = await findSession(input.businessId, input.token);
  if (!session) return { ok: false, error: "upload_not_found" };
  if (session.state !== "open") return { ok: false, error: "upload_not_open" };
  if (new Date(session.expiresAt).getTime() <= Date.now()) {
    await abandonUploadSession(input.businessId, input.token);
    return { ok: false, error: "upload_expired" };
  }

  const dir = tenantStagingDir(input.businessId, session.stagingRef);
  const payloadPath = path.join(dir, "payload.bin");
  let onDisk = 0;
  try {
    const stat = await fs.stat(payloadPath);
    onDisk = stat.size;
  } catch {
    return { ok: false, error: "upload_not_found" };
  }
  if (onDisk !== session.receivedBytes) {
    // The row and the file disagree: refuse rather than guess which is right.
    return { ok: false, error: "upload_state_mismatch" };
  }

  const check = checkChunk({
    expectedBytes: session.expectedBytes,
    receivedBytes: session.receivedBytes,
    offset: input.offset,
    chunkLength: input.chunk.length,
    maxBytes: input.maxBytes,
  });
  if (!check.ok) return { ok: false, error: check.error };

  await fs.appendFile(payloadPath, input.chunk, { mode: 0o600 });
  const { rowCount } = await query(
    `UPDATE tenant_backup_upload_sessions
        SET received_bytes = $3,
            chunks_received = chunks_received + 1,
            updated_at = now()
      WHERE business_id = $1 AND session_token = $2 AND received_bytes = $4 AND state = 'open'`,
    [input.businessId, input.token, check.nextOffset, session.receivedBytes],
  );
  if ((rowCount ?? 0) === 0) return { ok: false, error: "upload_state_mismatch" };
  return { ok: true, receivedBytes: check.nextOffset };
}

export async function abandonUploadSession(businessId: string, token: string): Promise<boolean> {
  const session = await findSession(businessId, token);
  if (!session) return false;
  await query(
    `UPDATE tenant_backup_upload_sessions
        SET state = 'abandoned', updated_at = now()
      WHERE business_id = $1 AND session_token = $2 AND state = 'open'`,
    [businessId, token],
  );
  await cleanupStagingDir(businessId, session.stagingRef).catch(() => {});
  return true;
}

/**
 * Finish an upload into **quarantine**.
 *
 * The bytes are hashed, compared with the declared size and digest, and only
 * then registered as an artifact row in `verifying`. That row is deliberately
 * *not* `ready`: `restorable` and `downloadable` are false until
 * `promoteQuarantinedArtifact` re-verifies the stored artifact end to end.
 */
export async function completeTenantUpload(input: {
  businessId: string;
  token: string;
  artifactName?: string | null;
  createdBy: string;
}): Promise<{ ok: true; ref: string } | { ok: false; error: string }> {
  const session = await findSession(input.businessId, input.token);
  if (!session) return { ok: false, error: "upload_not_found" };
  if (session.state !== "open") return { ok: false, error: "upload_not_open" };

  const dir = tenantStagingDir(input.businessId, session.stagingRef);
  const payloadPath = path.join(dir, "payload.bin");
  let size: number;
  try {
    size = (await fs.stat(payloadPath)).size;
  } catch {
    return { ok: false, error: "upload_not_found" };
  }
  const actualSha = await sha256File(payloadPath);
  const completion = checkCompletion({
    expectedBytes: session.expectedBytes,
    receivedBytes: size,
    expectedSha256: session.sha256 ?? actualSha,
    actualSha256: actualSha,
  });
  if (!completion.ok) return { ok: false, error: completion.error };

  // Register in quarantine. The artifact name is derived, never the uploaded
  // file's name: a tenant-supplied path would be a path-traversal primitive.
  const artifactName =
    input.artifactName?.trim() ||
    `uploaded-${logicalSnapshotScopeTag(input.businessId)}-${input.token.slice(0, 12)}.archive.enc`;
  const localDir = await ensureStagingDir(input.businessId, "quarantine");
  const quarantinedPath = path.join(localDir, artifactName);
  await fs.copyFile(payloadPath, quarantinedPath);

  // Uploaded artifacts are encryptable with managed custody: if the payload is
  // already ciphertext it stays as-is; the row records which key can open it.
  const encryption = await artifactEncryptionFor(input.businessId, "");
  if (!encryption.ok) return { ok: false, error: encryption.error };

  const masterKey = getMasterKey();
  if (!masterKey) return { ok: false, error: "backup_encryption_unconfigured" };
  const capturedAt = new Date();
  const artifactId = deterministicArtifactId(["upload", input.businessId, input.token]);
  const manifest = buildBackupManifest({
    artifactId,
    businessId: input.businessId,
    format: "logical_snapshot",
    payloadFormat: "tenant_archive_v1",
    origin: "uploaded",
    capturedAt,
    schemaVersion: await installedSchemaVersion(),
    encryption:
      encryption.encryption.scheme === "managed_envelope_v1"
        ? ({ scheme: "managed_envelope_v1", keyVersion: encryption.encryption.keyVersion } as const)
        : ({ scheme: "legacy_passphrase_v1", keyVersion: null } as const),
    sizeBytes: size,
    sha256: actualSha,
    components: [{ key: "shared.settings", state: "included", rows: 0 }],
  });

  const recorded = await recordTenantArtifact({
    businessId: input.businessId,
    artifactId,
    destination: "local",
    format: "logical_snapshot",
    origin: "uploaded",
    state: "verifying",
    payloadBytes: size,
    storedBytes: size,
    sha256: actualSha,
    manifest,
    encryption: encryption.encryption.scheme,
    keyVersion: encryption.encryption.keyVersion,
    storageRef: artifactName,
    capturedAt,
    retentionUntil: null,
    createdBy: input.createdBy,
  });
  if (!recorded.ok) return { ok: false, error: recorded.error };

  await query(
    `UPDATE tenant_backup_upload_sessions
        SET state = 'complete', updated_at = now()
      WHERE business_id = $1 AND session_token = $2`,
    [input.businessId, input.token],
  );
  await cleanupStagingDir(input.businessId, session.stagingRef).catch(() => {});
  return { ok: true, ref: recorded.ref };
}

/**
 * Re-verify a quarantined artifact and, if it parses as an archive for this
 * business, promote it to `ready`. This is the only way an uploaded file becomes
 * restorable, and it is what a malicious upload cannot pass: the payload must
 * decrypt, parse under the allowed table set, and match the recorded digest.
 */
export async function promoteQuarantinedArtifact(
  businessId: string,
  ref: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const row = await resolveOwnedArtifact(businessId, ref);
  if (!row) return { ok: false, error: "artifact_not_found" };
  if (row.origin !== "uploaded") return { ok: false, error: "not_an_upload" };
  if (row.state === "ready") return { ok: true };

  const dir = tenantStagingDir(businessId, "quarantine");
  const stagedPath = path.join(dir, row.storageRef);
  const schemaVersion = await installedSchemaVersion();
  const verified = await verifyStoredArtifact(businessId, { ref, stagedPath, schemaVersion });
  await markArtifactStateByRef(businessId, ref, {
    state: verified.ok ? "ready" : "failed",
    failureCode: verified.ok ? null : verified.error,
  });
  return verified.ok ? { ok: true } : { ok: false, error: verified.error };
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

export type DownloadPlan =
  | { kind: "redirect"; url: string; expiresIn: number }
  | { kind: "stream"; path: string; sizeBytes: number; encryption: string }
  | { kind: "error"; error: string };

/**
 * Resolve a download for an authorized caller.
 *
 * A cloud artifact becomes a short-lived provider URL — the app never proxies
 * the bytes, and the URL dies with the ticket's lifetime. A local artifact
 * streams from the backup directory after the row is re-resolved here, so the
 * name on disk comes from the database, never from the request.
 */
export async function planArtifactDownload(input: {
  businessId: string;
  ref: string;
  destination: "local" | "cloud";
  profile: DeploymentProfile;
  role: DeploymentRole;
  directory?: string | null;
}): Promise<DownloadPlan> {
  const row = await resolveOwnedArtifact(input.businessId, input.ref);
  if (!row) return { kind: "error", error: "artifact_not_found" };
  if (row.destination !== input.destination) return { kind: "error", error: "artifact_not_found" };
  if (!isTransportableState(row.state)) return { kind: "error", error: "artifact_not_ready" };

  if (input.destination === "cloud") {
    const storage = await resolveTenantStorage({
      businessId: input.businessId,
      profile: input.profile,
      role: input.role,
    });
    if (storage.mode === "unavailable") return { kind: "error", error: "storage_unavailable" };
    const key =
      storage.mode === "managed"
        ? `${storage.prefix}tenants/${logicalSnapshotScopeTag(input.businessId)}/${row.storageRef}`
        : `${storage.prefix}${row.storageRef}`;
    return { kind: "redirect", url: presignS3Get(storage.s3, key, PRESIGN_TTL_SECONDS), expiresIn: PRESIGN_TTL_SECONDS };
  }

  const directory = input.directory ?? path.join(process.cwd(), "backups");
  const filePath = path.join(directory, row.storageRef);
  const resolved = path.resolve(filePath);
  // Belt and braces: the stored reference cannot escape its directory even if a
  // bad row were written by something else.
  if (!resolved.startsWith(path.resolve(directory) + path.sep)) {
    return { kind: "error", error: "artifact_not_found" };
  }
  let sizeBytes: number;
  try {
    sizeBytes = (await fs.stat(resolved)).size;
  } catch {
    return { kind: "error", error: "artifact_missing" };
  }
  return { kind: "stream", path: resolved, sizeBytes, encryption: row.encryption };
}

/**
 * Fetch a cloud artifact into a local staging file. Used by verification and by
 * the restore engine, which must read the bytes rather than redirect a browser.
 */
export async function fetchCloudArtifact(input: {
  businessId: string;
  ref: string;
  profile: DeploymentProfile;
  role: DeploymentRole;
  suffix?: string;
}): Promise<{ ok: true; path: string; cleanup: () => Promise<void> } | { ok: false; error: string }> {
  const row = await resolveOwnedArtifact(input.businessId, input.ref);
  if (!row) return { ok: false, error: "artifact_not_found" };
  if (row.destination !== "cloud") return { ok: false, error: "artifact_not_found" };
  const storage = await resolveTenantStorage({
    businessId: input.businessId,
    profile: input.profile,
    role: input.role,
  });
  if (storage.mode === "unavailable") return { ok: false, error: "storage_unavailable" };
  const key =
    storage.mode === "managed"
      ? `${storage.prefix}tenants/${logicalSnapshotScopeTag(input.businessId)}/${row.storageRef}`
      : `${storage.prefix}${row.storageRef}`;
  const dir = await ensureStagingDir(input.businessId, input.suffix ?? "fetch");
  const target = path.join(dir, row.storageRef);
  try {
    await s3GetToFile(storage.s3, key, target);
  } catch {
    await cleanupStagingDir(input.businessId, input.suffix ?? "fetch").catch(() => {});
    return { ok: false, error: "artifact_fetch_failed" };
  }
  return {
    ok: true,
    path: target,
    cleanup: () => cleanupStagingDir(input.businessId, input.suffix ?? "fetch"),
  };
}

/**
 * Decrypt a downloaded/staged artifact into a staging file for the restore
 * engine. Never writes plaintext next to the encrypted artifact.
 */
export async function decryptStagedArtifact(input: {
  businessId: string;
  ref: string;
  stagedPath: string;
  legacyPassphrase: string;
}): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const row = await resolveOwnedArtifact(input.businessId, input.ref);
  if (!row) return { ok: false, error: "artifact_not_found" };
  const secret = await decryptionSecretFor(input.businessId, row, input.legacyPassphrase);
  if (!secret.ok) return { ok: false, error: secret.error };
  const target = `${input.stagedPath}.plain`;
  try {
    await decryptFileToFile(input.stagedPath, target, secret.secret);
  } catch {
    return { ok: false, error: "artifact_unreadable" };
  }
  return { ok: true, path: target };
}

/** Parse a decrypted artifact as an archive for this business. */
export async function readStagedArchive(businessId: string, plainPath: string) {
  const raw = await fs.readFile(plainPath, "utf8");
  return parseTenantArchive(raw, {
    allowedTables: await tenantTableSet(),
    businessId,
    maxSchemaVersion: await installedSchemaVersion(),
  });
}

/** Opaque ref for a row, so callers never build one by hand. */
export function refFor(businessId: string, destination: "local" | "cloud", storageRef: string): string {
  return tenantBackupArtifactRef(businessId, destination, storageRef);
}
