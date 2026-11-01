/**
 * Issue #903 §2 item 4 and §6 — restoring a business from a **backup file the
 * Owner downloaded earlier**.
 *
 * Everything else in the managed service starts from an inventory row. This
 * module starts from bytes: a file on the Owner's laptop, a copy on a USB stick,
 * the artifact they saved before the server was reimaged. Nothing in this
 * database names it, so the platform cannot resolve a reference — it has to
 * accept the file, decide whether it is genuinely one of *this* business's
 * backups, and only then let the ordinary preview/apply path take over.
 *
 * The rules that make that safe:
 *
 *   • **Data, never code.** The payload is decrypted and parsed as a typed
 *     `tenant_archive_v1` archive (`verifyStoredArtifact`). An uploaded `.sql`
 *     dump is refused by name — the engine that consumes this never executes
 *     text from a file.
 *   • **Signed, not asserted.** The accompanying manifest is only believed if
 *     its signature verifies under the platform key. A tenant can upload a
 *     manifest; it cannot author one the platform will trust, which is what stops
 *     an edited manifest from claiming different components, a different capture
 *     time or a different business.
 *   • **One business.** The manifest must name the business doing the import and
 *     the payload's checksum must be the one the manifest signed, so a file
 *     belonging to another tenant is useless even if it is genuine.
 *   • **Not newer than this build.** A `schemaVersion` above the installed one
 *     is refused (the restore could not replay it faithfully).
 *   • **Nothing is trusted before it is verified.** The row is registered as
 *     `verifying`; only a full checksum + signature + archive parse promotes it
 *     to `ready`, and only `ready` artifacts are offered for restore. A failed
 *     import removes the file and leaves a `failed` row with a provider-neutral
 *     code.
 *
 * The file the Owner needs is therefore **two** files, both downloadable:
 * the encrypted payload and the signed manifest (`GET
 * /api/backup/artifacts/[ref]/manifest`). That is stated plainly in the rollout
 * doc rather than promised as a single-file, self-contained bundle.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { getMasterKey } from "./master-key";
import { logicalSnapshotScopeTag } from "./backup-policy";
import { makeArtifactName } from "./backup";
import { getBackupConfig, tenantBackupDir } from "./backup-service";
import { sha256File } from "./backup-streams";
import {
  BACKUP_PAYLOAD_FORMATS,
  validateBackupManifest,
  verifyBackupManifestSignature,
  type BackupManifest,
} from "./backup-manifest";
import {
  markArtifactStateByRef,
  recordTenantArtifact,
  resolveOwnedArtifact,
  installedSchemaVersion,
} from "./tenant-backup-artifacts-service";
import { deterministicArtifactId, verifyStoredArtifact } from "./tenant-backup-runner";
import type { DeploymentProfile } from "./deployment-mode";

/**
 * The recovery file a tenant saves beside the payload.
 *
 * A tiny envelope rather than the bare manifest: it carries what the platform
 * needs to check the file (`manifest` + its `manifestSignature`) and nothing
 * else. The payload's own checksum lives *inside* the signed manifest, so this
 * file cannot be edited to match a different payload.
 */
export interface RecoveryManifestFile {
  kind: "biza-miz-backup-manifest";
  manifestVersion: number;
  manifest: BackupManifest;
  manifestSignature: string;
}

export function recoveryManifestFileName(ref: string): string {
  // The reference is already opaque and URL-safe; a short prefix keeps two
  // downloads of the same backup from overwriting each other.
  return `${ref.slice(0, 24)}.manifest.json`;
}

export function buildRecoveryManifestFile(
  manifest: BackupManifest,
  manifestSignature: string,
): RecoveryManifestFile {
  return {
    kind: "biza-miz-backup-manifest",
    manifestVersion: manifest.manifestVersion,
    manifest,
    manifestSignature,
  };
}

export function serializeRecoveryManifestFile(file: RecoveryManifestFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** Why an import is refused. Every code is safe to show a tenant as-is. */
export const IMPORT_REFUSALS = [
  /** The uploaded file or the manifest file is missing/empty. */
  "recovery_file_missing",
  /** The manifest file is not the shape this build writes. */
  "recovery_manifest_unreadable",
  /** The manifest does not carry a valid signature under the platform key. */
  "recovery_manifest_signature_invalid",
  /** The file belongs to another business. */
  "recovery_file_not_owned_by_business",
  /** A physical dump or a text SQL payload: both are refused on central. */
  "recovery_file_not_importable",
  /** Written by a newer build than this installation runs. */
  "recovery_file_schema_too_new",
  /** The payload's checksum is not the one the manifest signed. */
  "recovery_checksum_mismatch",
  /** Managed custody is configured on neither side (no platform key). */
  "backup_encryption_unconfigured",
  /** A legacy passphrase artifact imported without its passphrase. */
  "recovery_passphrase_required",
  /** Decryption or archive parse failed: wrong key, truncated or not an archive. */
  "recovery_file_unreadable",
  /** Storage or database failure while importing. */
  "recovery_import_failed",
] as const;

export type ImportRefusal = (typeof IMPORT_REFUSALS)[number];

/** Fail closed: an unknown internal failure never reaches a tenant as text. */
export function mapImportError(error: string): ImportRefusal {
  return (IMPORT_REFUSALS as readonly string[]).includes(error) ? (error as ImportRefusal) : "recovery_import_failed";
}

export interface ManifestEnvelopeCheck {
  ok: true;
  manifest: BackupManifest;
  manifestSignature: string;
}

export type ManifestFileCheck = ManifestEnvelopeCheck | { ok: false; error: ImportRefusal };

/**
 * Parse and authenticate the manifest file, then apply every rule that can be
 * decided without touching the payload. Pure apart from reading the platform
 * key, so the policy is testable on its own.
 */
export function checkRecoveryManifest(input: {
  text: string;
  businessId: string;
  currentSchemaVersion: number;
  masterKey: Buffer | null;
}): ManifestFileCheck {
  if (!input.masterKey) return { ok: false, error: "backup_encryption_unconfigured" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.text);
  } catch {
    return { ok: false, error: "recovery_manifest_unreadable" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, error: "recovery_manifest_unreadable" };
  }
  const envelope = parsed as Partial<RecoveryManifestFile>;
  if (envelope.kind !== "biza-miz-backup-manifest" || typeof envelope.manifestSignature !== "string") {
    return { ok: false, error: "recovery_manifest_unreadable" };
  }
  const validated = validateBackupManifest(envelope.manifest);
  if (!validated.ok) return { ok: false, error: "recovery_manifest_unreadable" };
  const manifest = validated.manifest;

  // The signature is checked before anything the manifest *claims* is used, so a
  // hand-written manifest cannot direct the rest of this function.
  if (!verifyBackupManifestSignature(manifest, envelope.manifestSignature, input.masterKey)) {
    return { ok: false, error: "recovery_manifest_signature_invalid" };
  }
  if (manifest.businessId !== input.businessId) {
    return { ok: false, error: "recovery_file_not_owned_by_business" };
  }
  // A physical dump is a whole database, and a text SQL payload is executable
  // script: neither is a tenant archive, and both are refused on every role this
  // import exists for (Cloud and Hybrid).
  if (manifest.format !== "logical_snapshot" || manifest.payloadFormat === "logical_sql_v1") {
    return { ok: false, error: "recovery_file_not_importable" };
  }
  if (!(BACKUP_PAYLOAD_FORMATS as readonly string[]).includes(manifest.payloadFormat)) {
    return { ok: false, error: "recovery_file_not_importable" };
  }
  if (manifest.schemaVersion > input.currentSchemaVersion) {
    return { ok: false, error: "recovery_file_schema_too_new" };
  }
  return { ok: true, manifest, manifestSignature: envelope.manifestSignature };
}

export type ImportedRecoveryFile =
  | { ok: true; ref: string; capturedAt: string; payloadBytes: number }
  | { ok: false; error: ImportRefusal };

export interface ImportRecoveryInput {
  businessId: string;
  /** The staged ciphertext, already uploaded in chunks. */
  uploadPath: string;
  /** The `.manifest.json` content the Owner saved beside the payload. */
  manifestText: string;
  /** One-time legacy passphrase, only for a `legacy_passphrase_v1` artifact. */
  legacyPassphrase?: string;
  createdBy?: string | null;
}

/**
 * Turn an uploaded recovery file into a `ready` artifact of this business.
 *
 * The stored payload goes into the tenant's own backup directory (never a
 * tenant-chosen path), under a server-derived artifact name so retention sees
 * it like any other local copy. The row is `uploaded`/`verifying` until
 * `verifyStoredArtifact` has re-read the bytes it just wrote.
 */
export async function importRecoveryFile(input: ImportRecoveryInput): Promise<ImportedRecoveryFile> {
  const masterKey = getMasterKey();
  const checked = checkRecoveryManifest({
    text: input.manifestText,
    businessId: input.businessId,
    currentSchemaVersion: await installedSchemaVersion(),
    masterKey,
  });
  if (!checked.ok) return checked;
  const manifest = checked.manifest;

  const expected = manifest.payload;

  let size: number;
  try {
    size = (await fs.stat(input.uploadPath)).size;
  } catch {
    return { ok: false, error: "recovery_file_missing" };
  }
  if (size === 0) return { ok: false, error: "recovery_file_missing" };
  // Checksum the staged bytes before copying them anywhere: a file that is not
  // the one the manifest signed is not this business's backup.
  if ((await sha256File(input.uploadPath)) !== expected.sha256) {
    return { ok: false, error: "recovery_checksum_mismatch" };
  }

  const legacy = manifest.encryption.scheme === "legacy_passphrase_v1";
  if (legacy && !input.legacyPassphrase) {
    return { ok: false, error: "recovery_passphrase_required" };
  }

  // The tenant's own backup directory: the same place a local logical artifact
  // of this business lives, resolved server-side from configuration this
  // request cannot influence.
  const dir = tenantBackupDir(input.businessId, (await getBackupConfig(input.businessId)).directory);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const storedName = makeArtifactName(new Date(), {
    scope: logicalSnapshotScopeTag(input.businessId),
    runId: deterministicArtifactId([input.businessId, "import", expected.sha256]),
    format: "sql",
    encrypted: true,
  });
  const storedPath = path.join(dir, storedName);
  try {
    await fs.copyFile(input.uploadPath, storedPath);
    await fs.chmod(storedPath, 0o600);
  } catch {
    return { ok: false, error: "recovery_import_failed" };
  }

  const recorded = await recordTenantArtifact({
    businessId: input.businessId,
    artifactId: deterministicArtifactId([input.businessId, "import", expected.sha256]),
    destination: "local",
    format: "logical_snapshot",
    origin: "uploaded",
    state: "verifying",
    payloadBytes: size,
    storedBytes: size,
    sha256: expected.sha256,
    manifest,
    manifestSignature: checked.manifestSignature,
    encryption: manifest.encryption.scheme,
    keyVersion: manifest.encryption.keyVersion,
    storageRef: storedName,
    capturedAt: new Date(manifest.capturedAt),
    // An imported file is not a service-kept backup: the service never charges
    // for it and does not promise an expiry it cannot enforce. Local retention
    // still caps how many copies the directory holds.
    retentionUntil: null,
    createdBy: input.createdBy ?? null,
  });
  if (!recorded.ok) {
    await fs.rm(storedPath, { force: true }).catch(() => {});
    return { ok: false, error: mapImportError(recorded.error) };
  }

  const verified = await verifyStoredArtifact(input.businessId, {
    ref: recorded.ref,
    stagedPath: storedPath,
    schemaVersion: manifest.schemaVersion,
    legacyPassphrase: input.legacyPassphrase,
  });
  if (!verified.ok) {
    // Unreadable is unreadable: keep no copy of a file this build cannot open,
    // and leave the row in `failed` so the tenant sees the attempt, not silence.
    await markArtifactStateByRef(input.businessId, recorded.ref, {
      state: "failed",
      failureCode: verified.error,
    }).catch(() => {});
    await fs.rm(storedPath, { force: true }).catch(() => {});
    return { ok: false, error: mapImportError(verified.error) };
  }
  await markArtifactStateByRef(input.businessId, recorded.ref, { state: "ready" });

  const row = await resolveOwnedArtifact(input.businessId, recorded.ref);
  return {
    ok: true,
    ref: recorded.ref,
    capturedAt: row?.capturedAt ?? manifest.capturedAt,
    payloadBytes: size,
  };
}

/**
 * Whether this installation offers file import at all.
 *
 * Only the managed profiles do: a Local install restores from its own physical
 * dump through the single-business restore path (issue #807), which is a
 * different engine with its own scratch verification.
 */
export function recoveryImportAvailable(profile: DeploymentProfile): boolean {
  return profile === "cloud" || profile === "hybrid";
}

/** The signed manifest of an artifact this business owns, for a fresh download. */
export async function recoveryManifestFor(
  businessId: string,
  ref: string,
): Promise<{ ok: true; text: string; fileName: string } | { ok: false; error: "artifact_not_found" | "artifact_manifest_missing" | "artifact_not_ready" }> {
  const row = await resolveOwnedArtifact(businessId, ref);
  if (!row) return { ok: false, error: "artifact_not_found" };
  if (row.state !== "ready") return { ok: false, error: "artifact_not_ready" };
  if (!row.manifest || !row.manifestSignature) return { ok: false, error: "artifact_manifest_missing" };
  return {
    ok: true,
    text: serializeRecoveryManifestFile(buildRecoveryManifestFile(row.manifest, row.manifestSignature)),
    fileName: recoveryManifestFileName(ref),
  };
}
