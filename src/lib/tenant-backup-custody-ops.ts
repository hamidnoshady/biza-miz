/**
 * Issue #903 §8 — custody operations: rotation, loss recovery, legacy unlock
 * and the portable recovery envelope.
 *
 * Custody is the part of a managed backup service that must keep working on the
 * worst day: a key generation is lost, the platform's key-encryption key had to
 * be replaced, or a customer arrives with artifacts from before managed custody
 * existed and only their own passphrase.
 *
 * Four operations, each with one honest answer:
 *
 *  • **Rotation** (`rotateArtifactCustodyKey`, from the artifacts service) mints
 *    the next generation and retires the current one. Nothing is re-encrypted:
 *    every artifact names its generation, so old artifacts keep opening.
 *  • **Loss assessment** (`custodyCoverageReport`) answers "what could I still
 *    open?". A generation with no `backup_key_versions` row, or one whose sealed
 *    key no longer unwraps under the current KEK, is reported per artifact — not
 *    discovered at restore time.
 *  • **Legacy unlock** (`unlockLegacyArtifact`) takes the Owner's passphrase
 *    *once*, proves it opens the artifact, re-encrypts the same payload under
 *    managed custody, verifies the new copy and marks the old row `superseded`.
 *    The old row is kept — it is still the customer's key, and deleting it would
 *    destroy the only copy if the new one were somehow wrong.
 *  • **Portable envelope** (`exportRecoveryEnvelope` / `openRecoveryEnvelopeFile`)
 *    wraps the artifact secrets under a passphrase only the tenant holds, so a
 *    downloaded backup survives the platform itself being unavailable.
 *
 * Nothing in this module logs, returns or serializes a key. The report carries
 * version numbers and counts; the envelope is returned exactly once, to the
 * operator who asked for it, and is never written to the database.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { query, withoutTenantScope } from "./db";
import { getMasterKey } from "./master-key";
import { decryptFileToFile, encryptFileToFile } from "./backup-streams";
import { openPortableRecoveryEnvelope, sealPortableRecoveryEnvelope } from "./backup-key-custody";
import { parseTenantArchive, tenantTableSet } from "./tenant-archive";
import {
  artifactSecretForVersion,
  installedSchemaVersion,
  markArtifactStateByRef,
  resolveOwnedArtifact,
} from "./tenant-backup-artifacts-service";
import { cleanupStagingDir, ensureStagingDir, readTenantBackupService } from "./tenant-backup-storage";
import { registerFinishedArtifact, verifyStoredArtifact } from "./tenant-backup-runner";
import { planArtifactDownload } from "./tenant-backup-transport";
import { getBackupConfig } from "./backup-service";
import type { DeploymentProfile } from "./deployment-mode";
import type { DeploymentRole } from "./deployment-role";

export interface CustodyArtifact {
  ref: string;
  keyVersion: number | null;
  encryption: "managed_envelope_v1" | "legacy_passphrase_v1";
  state: string;
  storageRef: string;
}

export type CustodyCoverage = {
  /** Versions an artifact names but the platform does not hold. */
  missingVersions: number[];
  /** Artifacts that cannot be opened right now, by opaque ref. */
  unreadableRefs: string[];
  /** Legacy artifacts, which need the Owner's passphrase rather than a key. */
  legacyRefs: string[];
  /** True only when every artifact can be opened with what the platform holds. */
  complete: boolean;
};

/**
 * Pure coverage arithmetic: what can be opened, given the artifacts and the
 * generations the platform actually holds and could unwrap.
 */
export function assessCustodyCoverage(input: {
  artifacts: CustodyArtifact[];
  readableVersions: readonly number[];
  kekAvailable: boolean;
}): CustodyCoverage {
  const readable = new Set(input.readableVersions);
  const missing = new Set<number>();
  const unreadable: string[] = [];
  const legacy: string[] = [];
  for (const artifact of input.artifacts) {
    if (artifact.state === "superseded" || artifact.state === "expired") continue;
    if (artifact.encryption === "legacy_passphrase_v1") {
      legacy.push(artifact.ref);
      continue;
    }
    const version = artifact.keyVersion;
    if (version === null || !readable.has(version)) {
      if (version !== null) missing.add(version);
      unreadable.push(artifact.ref);
    }
  }
  return {
    missingVersions: [...missing].sort((a, b) => a - b),
    unreadableRefs: unreadable,
    legacyRefs: legacy,
    // A legacy artifact is not "unreadable" — the Owner can still open it — but
    // the platform itself cannot, so coverage is only complete when there are
    // none of either kind.
    complete: input.kekAvailable && unreadable.length === 0 && legacy.length === 0,
  };
}

interface CustodyRow extends Record<string, unknown> {
  storage_ref: string;
  destination: "local" | "cloud";
  state: string;
  encryption_scheme: CustodyArtifact["encryption"];
  key_version: number | null;
}

/**
 * The operator's loss report for one business. It reads custody rows under the
 * documented platform bypass (they are platform-only material), then attempts to
 * unwrap each generation it finds — a generation that exists but no longer
 * unwraps is as lost as one that never existed, and reporting it as present
 * would be the worst kind of wrong.
 */
export async function custodyCoverageReport(
  businessId: string,
  refFor: (businessId: string, destination: "local" | "cloud", storageRef: string) => string,
): Promise<CustodyCoverage> {
  const rows = await query<CustodyRow>(
    `SELECT storage_ref, state, encryption_scheme, key_version, destination
       FROM tenant_backup_artifacts
      WHERE business_id = $1 AND state NOT IN ('superseded', 'expired')`,
    [businessId],
  );
  const artifacts: CustodyArtifact[] = rows.rows.map((row) => ({
    ref: refFor(businessId, row.destination, row.storage_ref),
    keyVersion: row.key_version,
    encryption: row.encryption_scheme,
    state: row.state,
    storageRef: row.storage_ref,
  }));

  const versions = [...new Set(artifacts.map((artifact) => artifact.keyVersion).filter((v): v is number => v !== null))];
  const readableVersions: number[] = [];
  for (const version of versions) {
    const opened = await artifactSecretForVersion(businessId, version);
    if (opened.ok) readableVersions.push(version);
  }

  return assessCustodyCoverage({
    artifacts,
    readableVersions,
    kekAvailable: getMasterKey() !== null,
  });
}

// ---------------------------------------------------------------------------
// Legacy unlock
// ---------------------------------------------------------------------------

export type UnlockResult =
  | { ok: true; ref: string; keyVersion: number }
  | { ok: false; error: string };

/**
 * Re-encrypt a legacy passphrase artifact under managed custody.
 *
 * The passphrase is used only to read the artifact once; it is never stored, and
 * the new artifact says nothing about where it came from beyond its manifest.
 * The result is verified exactly like a fresh backup — checksum, signature and
 * archive parse — before the old row is marked `superseded`.
 */
export async function unlockLegacyArtifact(input: {
  businessId: string;
  ref: string;
  passphrase: string;
  deployment: { role: DeploymentRole; profile: DeploymentProfile };
  directory?: string | null;
  createdBy?: string | null;
}): Promise<UnlockResult> {
  if (!getMasterKey()) return { ok: false, error: "backup_encryption_unconfigured" };
  const row = await resolveOwnedArtifact(input.businessId, input.ref);
  if (!row) return { ok: false, error: "artifact_not_found" };
  if (row.encryption !== "legacy_passphrase_v1") return { ok: false, error: "artifact_already_managed" };
  if (row.state !== "ready") return { ok: false, error: "artifact_not_ready" };
  if (!input.passphrase) return { ok: false, error: "passphrase_required" };

  const plan = await planArtifactDownload({
    businessId: input.businessId,
    ref: input.ref,
    destination: row.destination,
    profile: input.deployment.profile,
    role: input.deployment.role,
    directory: input.directory ?? (await getBackupConfig(input.businessId)).directory,
  });
  if (plan.kind === "error") return { ok: false, error: plan.error };
  if (plan.kind === "redirect") {
    // A cloud artifact must be fetched, not redirected, for a server-side
    // re-encryption; refusing here keeps this path local-only rather than
    // pretending.
    return { ok: false, error: "artifact_not_local" };
  }

  const staging = await ensureStagingDir(input.businessId, `unlock-${input.ref.slice(0, 8)}`);
  const plainPath = path.join(staging, "payload.plain");
  try {
    try {
      await decryptFileToFile(plan.path, plainPath, input.passphrase);
    } catch {
      return { ok: false, error: "passphrase_invalid" };
    }
    // Prove the plaintext is an archive for *this* business before re-encrypting
    // it: unlocking must not launder an arbitrary file into a managed artifact.
    const parsed = parseTenantArchive(await fs.readFile(plainPath, "utf8"), {
      allowedTables: await tenantTableSet(),
      businessId: input.businessId,
      maxSchemaVersion: await installedSchemaVersion(),
    });
    if (!parsed.ok) return { ok: false, error: "archive_unreadable" };

    const { currentArtifactCustodyKey } = await import("./tenant-backup-artifacts-service");
    const custody = await currentArtifactCustodyKey(input.businessId);
    if (!custody.ok) return { ok: false, error: custody.error };

    const targetName = `${row.storageRef.replace(/\.enc$/, "")}.managed.enc`;
    const targetPath = path.join(staging, targetName);
    const streamed = await encryptFileToFile(plainPath, targetPath, custody.secret);

    const capturedAt = new Date(row.capturedAt);
    const registered = await registerFinishedArtifact({
      businessId: input.businessId,
      artifactPath: targetPath,
      artifactName: targetName,
      destination: "local",
      origin: row.origin,
      mode: "logical",
      payloadFormat: "tenant_archive_v1",
      sizeBytes: streamed.sizeBytes,
      sha256: streamed.sha256,
      encryption: { scheme: "managed_envelope_v1", keyVersion: custody.version, secret: custody.secret },
      capturedAt,
      components: row.manifest?.components.map((component) => ({
        key: component.key,
        state: component.state,
        rows: component.rows ?? 0,
      })) ?? [{ key: "shared.settings" as const, state: "included" as const, rows: 0 }],
      schemaVersion: row.manifest?.schemaVersion ?? parsed.archive.schemaVersion,
      createdBy: input.createdBy ?? null,
      retentionUntil: row.retentionUntil ? new Date(row.retentionUntil) : null,
    });
    if (!registered.ok) return { ok: false, error: registered.error };

    const verified = await verifyStoredArtifact(input.businessId, {
      ref: registered.ref,
      stagedPath: targetPath,
      schemaVersion: row.manifest?.schemaVersion ?? parsed.archive.schemaVersion,
    });
    if (!verified.ok) {
      await markArtifactStateByRef(input.businessId, registered.ref, { state: "failed", failureCode: verified.error });
      return { ok: false, error: verified.error };
    }
    await markArtifactStateByRef(input.businessId, registered.ref, { state: "ready" });

    // Only now is the old row superseded: the successor exists and is proven.
    await withoutTenantScope("tenant-backup-custody", async () => {
      await query(
        `UPDATE tenant_backup_artifacts
            SET state = 'superseded', superseded_by = $3, updated_at = now()
          WHERE business_id = $1 AND storage_ref = $2 AND state = 'ready'`,
        [input.businessId, row.storageRef, targetName],
      );
    });

    return { ok: true, ref: registered.ref, keyVersion: custody.version };
  } finally {
    await fs.rm(plainPath, { force: true }).catch(() => {});
    await cleanupStagingDir(input.businessId, `unlock-${input.ref.slice(0, 8)}`).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Portable recovery envelope
// ---------------------------------------------------------------------------

/**
 * Seal this business's active artifact secret under a passphrase the tenant
 * supplies, so a downloaded artifact is openable without the platform.
 *
 * Returns the envelope to the caller and stores nothing: a recovery envelope is
 * a credential, and a stored copy would be a second key with the platform's
 * fingerprints on it.
 */
export async function exportRecoveryEnvelope(input: {
  businessId: string;
  recoveryPassphrase: string;
}): Promise<{ ok: true; envelope: string; keyVersion: number } | { ok: false; error: string }> {
  if (input.recoveryPassphrase.trim().length < 12) return { ok: false, error: "recovery_passphrase_weak" };
  const { currentArtifactCustodyKey } = await import("./tenant-backup-artifacts-service");
  const custody = await currentArtifactCustodyKey(input.businessId);
  if (!custody.ok) return { ok: false, error: custody.error };
  try {
    const { envelope } = sealPortableRecoveryEnvelope(custody.secret, input.recoveryPassphrase, input.businessId);
    return { ok: true, envelope, keyVersion: custody.version };
  } catch {
    return { ok: false, error: "recovery_envelope_failed" };
  }
}

/**
 * Prove that an envelope and passphrase open the secret an artifact names.
 * Used by the drill (`scripts/backup-drill.ts`) and by an operator recovering a
 * business whose platform custody is gone.
 */
export async function openRecoveryEnvelope(input: {
  businessId: string;
  envelope: string;
  recoveryPassphrase: string;
  keyVersion: number;
}): Promise<{ ok: true; keyVersion: number } | { ok: false; error: string }> {
  const opened = openPortableRecoveryEnvelope(input.envelope, input.recoveryPassphrase, input.businessId);
  if (!opened.ok) return { ok: false, error: opened.error };
  const custody = await artifactSecretForVersion(input.businessId, input.keyVersion);
  if (!custody.ok) return { ok: false, error: custody.error };
  const { sameSecret } = await import("./backup-key-custody");
  if (!sameSecret(custody.secret, opened.secret)) return { ok: false, error: "recovery_secret_mismatch" };
  return { ok: true, keyVersion: input.keyVersion };
}

/** Run-time sanity: the service must hold a usable seal before any custody op. */
export async function custodyOperatorReady(): Promise<boolean> {
  if (!getMasterKey()) return false;
  const service = await readTenantBackupService();
  return service.maxArtifactBytes > 0;
}
