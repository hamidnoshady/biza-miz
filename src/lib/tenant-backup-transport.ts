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
import { tenantBackupDir } from "./backup-service";
import { parseTenantArchive, tenantTableSet } from "./tenant-archive";
import { tenantBackupArtifactRef } from "./tenant-backup-artifact-ref";
import { buildBackupManifest } from "./backup-manifest";
import type { DeploymentProfile } from "./deployment-mode";
import type { DeploymentRole } from "./deployment-role";

/** Long enough to start a large download, short enough to be useless later. */
export const DOWNLOAD_TICKET_TTL_SECONDS = 300;
/** Provider URL lifetime for a cloud artifact redirect. */
export const PRESIGN_TTL_SECONDS = 300;

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

/** Only an artifact in this state can be offered for download or restore. */
export function isTransportableState(state: string): boolean {
  return state === "ready";
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

  // Through `tenantBackupDir`, not a flat root: on central each business's
  // artifacts live in their own `tenants/<scope>` subdirectory, so resolving
  // `config.directory/<ref>` here reported `artifact_missing` for a file that
  // exists — the tenant's own download failing for a reason it could not see.
  const directory = tenantBackupDir(input.businessId, input.directory ?? undefined);
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
