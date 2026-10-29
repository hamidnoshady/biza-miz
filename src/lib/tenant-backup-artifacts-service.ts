/**
 * Issue #903 — the database half of the managed tenant backup surface.
 *
 * The *policy* lives in four pure modules (`tenant-backup-inventory.ts`,
 * `backup-manifest.ts`, `backup-key-custody.ts`, `tenant-restore-preview.ts`) and
 * is unit-tested there. This file is deliberately thin: it reads and writes the
 * four tables migration 0264 adds, opens the platform key, and hands the facts to
 * those pure functions. Anything that decides something — what a tenant may see,
 * when an artifact is restorable, what a restore would change, what may be
 * charged — is decided outside this file, so it cannot drift between the tenant
 * API, the Superadmin panel and the worker.
 *
 * Two boundaries are load-bearing here:
 *
 *  • `storage_ref` (an object key or local file name) never leaves the server.
 *    Every read path that crosses into a response goes through
 *    `tenantBackupArtifactRef`, and every write path re-resolves that opaque ref
 *    against the caller's own business before touching bytes.
 *  • Key custody is read under the documented platform bypass, because
 *    `backup_key_versions` is platform-only by design. The bypass is scoped to
 *    one SELECT by business id, never wrapped around a request body.
 */
import { createHash } from "node:crypto";
import { query, withoutTenantScope } from "./db";
import { listBackupRuns, type BackupRunRow } from "./backup-service";
import { getMasterKey } from "./master-key";
import { tenantBackupArtifactRef } from "./tenant-backup-artifact-ref";
import {
  buildBackupManifest,
  manifestCompleteness,
  signBackupManifest,
  validateBackupManifest,
  verifyBackupManifestSignature,
  type BackupComponentKey,
  type BackupManifest,
} from "./backup-manifest";
import {
  buildTenantInventory,
  queryInventory,
  summarizeInventory,
  type BackupArtifactEntry,
  type InventoryContext,
  type InventoryQuery,
  type InventorySummary,
  type TenantArtifactRow,
} from "./tenant-backup-inventory";
import {
  BACKUP_STORAGE_METER_KEY,
  cloudStorageByteDays,
  settlementKey,
  uniqueArtifactIds,
} from "./backup-billing-settlement";
import {
  custodySummary,
  openArtifactKey,
  planKeyRotation,
  sealArtifactKey,
  selectCustodyKey,
  type ArtifactKeyRecord,
  type CustodySummary,
} from "./backup-key-custody";
import {
  previewTenantRestore,
  type RestoreActorFacts,
  type RestorePreview,
} from "./tenant-restore-preview";
import type { DeploymentProfile } from "./deployment-mode";
import type { DeploymentRole } from "./deployment-role";
import { appendUsageEvent } from "./billing/runtime";

/** Internal row: carries what the tenant DTO must never contain. */
export interface StoredArtifactRow extends TenantArtifactRow {
  id: string;
  manifest: BackupManifest | null;
  manifestSignature: string | null;
}

interface ArtifactDbRow extends Record<string, unknown> {
  id: string;
  business_id: string;
  artifact_id: string;
  destination: "local" | "cloud";
  format: TenantArtifactRow["format"];
  origin: TenantArtifactRow["origin"];
  state: TenantArtifactRow["state"];
  payload_bytes: string | null;
  stored_bytes: string | null;
  manifest: unknown;
  manifest_signature: string | null;
  encryption_scheme: TenantArtifactRow["encryption"];
  key_version: number | null;
  completeness: "complete" | "partial";
  storage_ref: string;
  captured_at: Date;
  verified_at: Date | null;
  retention_until: Date | null;
  last_restore_at: Date | null;
  failure_code: string | null;
}

const ARTIFACT_COLUMNS = `
  id, business_id, artifact_id, destination, format, origin, state,
  payload_bytes, stored_bytes, manifest, manifest_signature, encryption_scheme,
  key_version, completeness, storage_ref, captured_at, verified_at, retention_until,
  last_restore_at, failure_code
`;

function toNumberOrNull(value: string | null): number | null {
  return value === null ? null : Number(value);
}

function toStoredRow(row: ArtifactDbRow): StoredArtifactRow {
  // A stored manifest is re-validated on read: a hand-edited jsonb column must
  // degrade to "no manifest" (which blocks restore) rather than to trust.
  const validated = row.manifest ? validateBackupManifest(row.manifest) : null;
  return {
    id: row.id,
    artifactId: row.artifact_id,
    businessId: row.business_id,
    destination: row.destination,
    format: row.format,
    origin: row.origin,
    state: row.state,
    payloadBytes: toNumberOrNull(row.payload_bytes),
    storedBytes: toNumberOrNull(row.stored_bytes),
    capturedAt: row.captured_at.toISOString(),
    verifiedAt: row.verified_at ? row.verified_at.toISOString() : null,
    retentionUntil: row.retention_until ? row.retention_until.toISOString() : null,
    lastRestoreAt: row.last_restore_at ? row.last_restore_at.toISOString() : null,
    completeness: row.completeness,
    encryption: row.encryption_scheme,
    keyVersion: row.key_version,
    storageRef: row.storage_ref,
    failureCode: row.failure_code,
    manifest: validated?.ok ? validated.manifest : null,
    manifestSignature: row.manifest_signature,
  };
}

/** Every artifact row for this business. RLS is the real filter; the predicate is defence in depth. */
export async function listStoredArtifactRows(businessId: string, limit = 500): Promise<StoredArtifactRow[]> {
  const { rows } = await query<ArtifactDbRow>(
    `SELECT ${ARTIFACT_COLUMNS}
       FROM tenant_backup_artifacts
      WHERE business_id = $1
      ORDER BY captured_at DESC
      LIMIT ${Math.max(1, Math.min(2_000, Math.floor(limit)))}`,
    [businessId],
  );
  return rows.map(toStoredRow);
}

/**
 * Artifact rows recovered from the pre-#903 run history.
 *
 * `backup_runs` already records what was produced, when, and for which
 * destination; what it cannot record is a signed manifest, a checksum-backed
 * verification or a custody generation. So these entries appear in the tenant
 * inventory as `legacy_passphrase_v1`, `unverified` and `partial` — honestly, as
 * the epic requires — and they are **not** restorable until something verifies
 * them. They are never written back into `tenant_backup_artifacts`: reclassifying
 * a historical SQL export as a managed artifact is exactly the mistake §4 warns
 * about.
 */
export function legacyArtifactRowsFromRuns(
  businessId: string,
  runs: BackupRunRow[],
): StoredArtifactRow[] {
  const seen = new Set<string>();
  const rows: StoredArtifactRow[] = [];
  for (const run of runs) {
    if (run.status !== "success" || !run.artifact) continue;
    // The local and cloud rows of one upload share the artifact file name, so
    // grouping on it keeps a mirror one logical backup in the inventory.
    const identity = createHash("sha256").update(`${businessId}:${run.artifact}`).digest("hex");
    const storageRef = `${run.kind === "cloud" ? "cloud" : "local"}:${run.artifact}`;
    if (seen.has(storageRef)) continue;
    seen.add(storageRef);
    rows.push({
      id: `legacy-${run.id}`,
      artifactId: identity,
      businessId,
      destination: run.kind === "cloud" ? "cloud" : "local",
      format: run.scope === "physical" ? "physical_dump" : "logical_snapshot",
      origin: run.trigger,
      state: "ready",
      payloadBytes: run.sizeBytes,
      storedBytes: run.sizeBytes,
      capturedAt: (run.finishedAt ?? run.startedAt),
      verifiedAt: null,
      retentionUntil: null,
      lastRestoreAt: null,
      // Unknown coverage is partial, not "complete by default".
      completeness: "partial",
      encryption: "legacy_passphrase_v1",
      keyVersion: null,
      storageRef,
      failureCode: null,
      manifest: null,
      manifestSignature: null,
    });
  }
  return rows;
}

async function legacyArtifactRows(businessId: string): Promise<StoredArtifactRow[]> {
  return legacyArtifactRowsFromRuns(businessId, await listBackupRuns(businessId));
}

export interface TenantInventoryResponse {
  profile: DeploymentProfile;
  connectivity: InventoryContext["connectivity"];
  items: BackupArtifactEntry[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
  summary: InventorySummary;
  /** Plan inclusion for `backup.storage_byte_day`, in bytes; 0 = no inclusion. */
  includedBytes: number;
}

/**
 * The tenant's inventory page. Callers pass the deployment profile and
 * connectivity they already resolved server-side; nothing here reads a request
 * body to decide what a tenant may see.
 */
export async function tenantBackupInventory(
  businessId: string,
  options: {
    profile: DeploymentProfile;
    connectivity: InventoryContext["connectivity"];
    query?: InventoryQuery;
    now?: Date;
  },
): Promise<TenantInventoryResponse> {
  const [registered, legacy, includedBytes] = await Promise.all([
    listStoredArtifactRows(businessId),
    legacyArtifactRows(businessId),
    storageIncludedBytes(businessId),
  ]);
  // A run that has since been registered as a managed artifact must not appear
  // twice: the registered row is the authoritative one (it carries the manifest).
  const registeredRefs = new Set(
    registered.map((row) => tenantBackupArtifactRef(businessId, row.destination, row.storageRef)),
  );
  const rows = [
    ...registered,
    ...legacy.filter(
      (row) => !registeredRefs.has(tenantBackupArtifactRef(businessId, row.destination, row.storageRef)),
    ),
  ];
  const entries = buildTenantInventory(rows, businessId, {
    profile: options.profile,
    connectivity: options.connectivity,
    now: options.now,
  });
  const page = queryInventory(entries, options.query ?? {});
  return {
    profile: options.profile,
    connectivity: options.connectivity,
    items: page.items,
    total: page.total,
    page: page.page,
    pageSize: page.pageSize,
    pages: page.pages,
    summary: summarizeInventory(entries, { includedBytes }),
    includedBytes,
  };
}

/**
 * Plan inclusion for the storage meter. A missing allowance means "nothing
 * included" (every managed cloud byte is overage), never "unlimited" — a silent
 * unlimited default is how a pricing bug becomes a free service.
 */
export async function storageIncludedBytes(businessId: string): Promise<number> {
  const { rows } = await query<{ included: string | null }>(
    `SELECT al.included_quantity::text AS included
       FROM businesses b
       LEFT JOIN billing_plans p ON p.key = b.plan
       LEFT JOIN billing_plan_meter_allowances al
              ON al.plan_key = p.key AND al.meter_key = $2
      WHERE b.id = $1`,
    [businessId, BACKUP_STORAGE_METER_KEY],
  );
  const raw = rows[0]?.included ?? null;
  if (raw === null) return 0;
  const bytes = Number(raw);
  return Number.isFinite(bytes) && bytes > 0 ? Math.floor(bytes) : 0;
}

/**
 * Resolve the opaque reference a browser holds back to a row this business owns.
 * Refs from another business, a stale tab or a tampered request simply do not
 * match — the comparison happens against refs recomputed here, never against a
 * ref supplied in the request.
 */
export async function resolveOwnedArtifact(businessId: string, ref: string): Promise<StoredArtifactRow | null> {
  if (typeof ref !== "string" || ref.length === 0) return null;
  const rows = await listStoredArtifactRows(businessId);
  const match = rows.find(
    (row) => tenantBackupArtifactRef(businessId, row.destination, row.storageRef) === ref,
  );
  return match ?? null;
}

export type RecordArtifactResult =
  | { ok: true; id: string; artifactId: string; ref: string }
  | { ok: false; error: string };

export interface RecordArtifactInput {
  businessId: string;
  /** Shared by the local and cloud rows of one logical backup. */
  artifactId: string;
  destination: TenantArtifactRow["destination"];
  format: TenantArtifactRow["format"];
  origin: TenantArtifactRow["origin"];
  state: TenantArtifactRow["state"];
  payloadBytes: number | null;
  storedBytes: number | null;
  sha256: string | null;
  manifest: BackupManifest | null;
  /** Signature over the manifest, produced by the caller with the platform key. */
  manifestSignature?: string | null;
  encryption: TenantArtifactRow["encryption"];
  keyVersion: number | null;
  storageRef: string;
  capturedAt: Date;
  retentionUntil: Date | null;
  runId?: string | null;
  createdBy?: string | null;
}

/**
 * Upsert one destination row. The unique `(business_id, destination,
 * storage_ref)` constraint makes a retried publish idempotent, and a mirror's
 * second row updates rather than duplicates.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function recordTenantArtifact(input: RecordArtifactInput): Promise<RecordArtifactResult> {
  // Fail loudly here rather than letting Postgres reject the insert: an
  // artifact id that is not a UUID is a caller bug, and the error code must say
  // so instead of surfacing as a generic write failure.
  if (!UUID.test(input.artifactId)) return { ok: false, error: "invalid_artifact_id" };
  if (!input.storageRef) return { ok: false, error: "storage_ref_required" };
  if (input.encryption === "managed_envelope_v1" && !input.keyVersion) {
    return { ok: false, error: "key_version_required" };
  }
  const manifest = input.manifest;
  if (manifest && manifest.businessId !== input.businessId) {
    return { ok: false, error: "manifest_business_mismatch" };
  }
  const completeness = manifest ? manifestCompleteness(manifest).status : "partial";
  const { rows } = await query<{ id: string; artifact_id: string }>(
    `INSERT INTO tenant_backup_artifacts
       (business_id, artifact_id, destination, format, origin, state,
        payload_bytes, stored_bytes, sha256, manifest, manifest_signature,
        encryption_scheme, key_version, completeness, storage_ref, captured_at,
        retention_until, run_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15,$16,$17,$18,$19)
     ON CONFLICT (business_id, destination, storage_ref) DO UPDATE SET
       state = EXCLUDED.state,
       payload_bytes = EXCLUDED.payload_bytes,
       stored_bytes = EXCLUDED.stored_bytes,
       sha256 = EXCLUDED.sha256,
       manifest = EXCLUDED.manifest,
       manifest_signature = EXCLUDED.manifest_signature,
       key_version = EXCLUDED.key_version,
       completeness = EXCLUDED.completeness,
       retention_until = EXCLUDED.retention_until,
       updated_at = now()
     RETURNING id, artifact_id`,
    [
      input.businessId,
      input.artifactId,
      input.destination,
      input.format,
      input.origin,
      input.state,
      input.payloadBytes,
      input.storedBytes,
      input.sha256,
      manifest ? JSON.stringify(manifest) : null,
      input.manifestSignature ??
        (manifest && input.keyVersion !== null && manifest.encryption.scheme === "managed_envelope_v1"
          ? signStoredManifest(manifest)
          : null),
      input.encryption,
      input.keyVersion,
      completeness,
      input.storageRef,
      input.capturedAt.toISOString(),
      input.retentionUntil ? input.retentionUntil.toISOString() : null,
      input.runId ?? null,
      input.createdBy ?? null,
    ],
  );
  const row = rows[0];
  if (!row) return { ok: false, error: "artifact_write_failed" };
  return {
    ok: true,
    id: row.id,
    artifactId: row.artifact_id,
    ref: tenantBackupArtifactRef(input.businessId, input.destination, input.storageRef),
  };
}

function signStoredManifest(manifest: BackupManifest): string | null {
  const key = getMasterKey();
  // No KEK: the artifact is not certifiable, so it is stored without a
  // signature and every consumer treats it as unrestorable rather than trusted.
  return key ? signBackupManifest(manifest, key) : null;
}

/**
 * Build and sign a manifest for a finished artifact. Returns `null` when the
 * platform has no key-encryption key: an unsigned manifest is not a claim about
 * anything, and callers must treat the artifact as unverified.
 */
export function buildSignedManifest(input: {
  artifactId: string;
  businessId: string;
  format: TenantArtifactRow["format"];
  origin: TenantArtifactRow["origin"];
  capturedAt: Date;
  schemaVersion: number;
  encryption: BackupManifest["encryption"];
  sizeBytes: number;
  sha256: string;
  components: { key: BackupComponentKey; state: BackupManifest["components"][number]["state"]; bytes?: number | null; rows?: number | null }[];
}): { manifest: BackupManifest; signature: string } | null {
  const key = getMasterKey();
  if (!key) return null;
  const manifest = buildBackupManifest(input);
  return { manifest, signature: signBackupManifest(manifest, key) };
}

/** Mark a row verified (checksum + signature) or failed, without echoing an internal error. */
export async function markArtifactState(
  businessId: string,
  id: string,
  update: { state: TenantArtifactRow["state"]; failureCode?: string | null },
): Promise<boolean> {
  const { rowCount } = await query(
    `UPDATE tenant_backup_artifacts
        SET state = $3,
            verified_at = CASE WHEN $3 = 'ready' THEN now() ELSE verified_at END,
            failure_code = $4,
            updated_at = now()
      WHERE business_id = $1 AND id = $2`,
    [businessId, id, update.state, update.failureCode ?? null],
  );
  return (rowCount ?? 0) > 0;
}

/** Mark a row by its opaque reference, re-resolving it against this business. */
export async function markArtifactStateByRef(
  businessId: string,
  ref: string,
  update: { state: TenantArtifactRow["state"]; failureCode?: string | null },
): Promise<boolean> {
  const row = await resolveOwnedArtifact(businessId, ref);
  if (!row) return false;
  return markArtifactState(businessId, row.id, update);
}

// ---------------------------------------------------------------------------
// Managed key custody
// ---------------------------------------------------------------------------

interface KeyDbRow extends Record<string, unknown> {
  version: number;
  status: ArtifactKeyRecord["status"];
  wrapped: string;
  nonce: string;
  auth_tag: string;
  kek_source: string;
  created_at: Date;
  retired_at: Date | null;
}

function toKeyRecord(row: KeyDbRow, businessId: string): ArtifactKeyRecord {
  return {
    businessId,
    version: row.version,
    status: row.status,
    wrapped: row.wrapped,
    nonce: row.nonce,
    tag: row.auth_tag,
    createdAt: row.created_at.toISOString(),
    retiredAt: row.retired_at ? row.retired_at.toISOString() : null,
    kekSource: row.kek_source,
  };
}

async function keyRecords(businessId: string): Promise<ArtifactKeyRecord[]> {
  // Documented bypass: `backup_key_versions` is platform-only custody material.
  return withoutTenantScope("tenant-backup-custody", async () => {
    const { rows } = await query<KeyDbRow>(
      `SELECT version, status, wrapped, nonce, auth_tag, kek_source, created_at, retired_at
         FROM backup_key_versions
        WHERE subject_business_id = $1
        ORDER BY version ASC`,
      [businessId],
    );
    return rows.map((row) => toKeyRecord(row, businessId));
  });
}

export type ArtifactCustody =
  | { ok: true; version: number; secret: string }
  | { ok: false; error: string };

/**
 * The secret a new artifact should be encrypted with. The first call mints a
 * managed generation; later calls reuse the active one. A missing platform KEK
 * is a hard failure — never a plaintext artifact.
 */
export async function currentArtifactCustodyKey(businessId: string): Promise<ArtifactCustody> {
  const masterKey = getMasterKey();
  if (!masterKey) return { ok: false, error: "backup_encryption_unconfigured" };
  const records = await keyRecords(businessId);
  const selected = selectCustodyKey(records);
  if (selected.ok) {
    const opened = openArtifactKey(masterKey, selected.record);
    if (!opened.ok) return { ok: false, error: opened.error };
    return { ok: true, version: selected.record.version, secret: opened.secret };
  }

  const rotation = planKeyRotation(records);
  const sealed = sealArtifactKey(masterKey, {
    businessId,
    version: rotation.nextVersion,
    kekSource: "platform",
  });
  await withoutTenantScope("tenant-backup-custody", async () => {
    await query(
      `INSERT INTO backup_key_versions
         (subject_business_id, version, status, wrapped, nonce, auth_tag, kek_source)
       VALUES ($1,$2,'active',$3,$4,$5,$6)
       ON CONFLICT (subject_business_id, version) DO NOTHING`,
      [businessId, sealed.record.version, sealed.record.wrapped, sealed.record.nonce, sealed.record.tag, sealed.record.kekSource],
    );
  });
  // A concurrent writer may have won the unique-active race; re-read and use the
  // stored generation rather than the one we just failed to persist.
  const confirmed = selectCustodyKey(await keyRecords(businessId));
  if (!confirmed.ok) return { ok: false, error: confirmed.error };
  const opened = openArtifactKey(masterKey, confirmed.record);
  if (!opened.ok) return { ok: false, error: opened.error };
  return { ok: true, version: confirmed.record.version, secret: opened.secret };
}

/** Unwrap the secret protecting one artifact, by the version its manifest names. */
export async function artifactSecretForVersion(businessId: string, version: number): Promise<ArtifactCustody> {
  const masterKey = getMasterKey();
  if (!masterKey) return { ok: false, error: "backup_encryption_unconfigured" };
  const record = (await keyRecords(businessId)).find((candidate) => candidate.version === version);
  if (!record) return { ok: false, error: "backup_key_missing" };
  const opened = openArtifactKey(masterKey, record);
  if (!opened.ok) return { ok: false, error: opened.error };
  return { ok: true, version: record.version, secret: opened.secret };
}

/**
 * Rotate custody: retire the active generation and mint the next one. Old
 * artifacts keep decrypting because they name their version, and nothing is
 * re-encrypted or deleted.
 */
export async function rotateArtifactCustodyKey(businessId: string): Promise<{ ok: true; version: number } | { ok: false; error: string }> {
  const masterKey = getMasterKey();
  if (!masterKey) return { ok: false, error: "backup_encryption_unconfigured" };
  const records = await keyRecords(businessId);
  const next = planKeyRotation(records);
  const sealed = sealArtifactKey(masterKey, { businessId, version: next.nextVersion, kekSource: "platform" });
  await withoutTenantScope("tenant-backup-custody", async () => {
    await query(
      `UPDATE backup_key_versions
          SET status = 'retired', retired_at = now()
        WHERE subject_business_id = $1 AND status = 'active'`,
      [businessId],
    );
    await query(
      `INSERT INTO backup_key_versions
         (subject_business_id, version, status, wrapped, nonce, auth_tag, kek_source)
       VALUES ($1,$2,'active',$3,$4,$5,$6)`,
      [businessId, sealed.record.version, sealed.record.wrapped, sealed.record.nonce, sealed.record.tag, sealed.record.kekSource],
    );
  });
  return { ok: true, version: sealed.record.version };
}

/** Operator-only custody readout; contains no key material. */
export async function businessCustodySummary(
  businessId: string,
  options: { legacyArtifacts: boolean },
): Promise<CustodySummary> {
  return custodySummary(await keyRecords(businessId), {
    kekAvailable: getMasterKey() !== null,
    legacyArtifacts: options.legacyArtifacts,
  });
}

// ---------------------------------------------------------------------------
// Restore preview (central tenant-only logical restore), dry run only
// ---------------------------------------------------------------------------

/** Highest applied migration number — what a manifest's `schemaVersion` is compared to. */
export async function installedSchemaVersion(): Promise<number> {
  const { rows } = await query<{ version: string | null }>(
    `SELECT max(split_part(filename, '_', 1)::int)::text AS version FROM schema_migrations`,
  );
  const value = Number(rows[0]?.version ?? 0);
  return Number.isFinite(value) ? value : 0;
}

/**
 * Components this build can count from the live database. Only the datasets the
 * preview actually needs; a component with no mapping is reported with `null`
 * counts rather than a fabricated zero.
 */
const COMPONENT_TABLES: Partial<Record<BackupComponentKey, string[]>> = {
  "accounting.core": ["journal_entries"],
  "crm.core": ["crm_deals", "crm_leads"],
  "growth.core": ["growth_campaigns", "loyalty_programs"],
};

export async function currentComponentCounts(
  businessId: string,
): Promise<Partial<Record<BackupComponentKey, number>>> {
  const counts: Partial<Record<BackupComponentKey, number>> = {};
  for (const [component, tables] of Object.entries(COMPONENT_TABLES) as [BackupComponentKey, string[]][]) {
    let total = 0;
    let measured = false;
    for (const table of tables) {
      const { rows } = await query<{ present: string | null; total: string }>(
        // A table that does not exist on this build is skipped, not counted as
        // zero rows: "unknown" and "empty" mean different things to a restore.
        `SELECT to_regclass($2)::text AS present,
                CASE WHEN to_regclass($2) IS NULL THEN '0'
                     ELSE (SELECT count(*)::text FROM ${table}) END AS total`,
        [businessId, `public.${table}`],
      );
      if (rows[0]?.present) {
        measured = true;
        total += Number(rows[0].total ?? 0);
      }
    }
    if (measured) counts[component] = total;
  }
  return counts;
}

export interface RestorePreviewResponse {
  preview: RestorePreview;
  /** Recorded in `tenant_backup_restore_jobs`; proof the preview happened. */
  jobId: string | null;
}

/**
 * Compute (and journal) the dry-run preview for one artifact this business owns.
 * The apply path is intentionally not exposed here: this slice delivers the
 * preview, its journal and its guards, not an executor.
 */
export async function previewOwnedRestore(
  businessId: string,
  ref: string,
  options: {
    role: DeploymentRole;
    profile: DeploymentProfile;
    actor: RestoreActorFacts;
    /** users.id of the actor, for the preview journal. */
    actorUserId?: string | null;
    now?: Date;
  },
): Promise<RestorePreviewResponse | { error: string }> {
  const artifact = await resolveOwnedArtifact(businessId, ref);
  if (!artifact) return { error: "artifact_not_found" };

  const masterKey = getMasterKey();
  const signatureValid = Boolean(
    masterKey &&
      artifact.manifest &&
      artifact.manifestSignature &&
      verifyBackupManifestSignature(artifact.manifest, artifact.manifestSignature, masterKey),
  );
  const [schemaVersion, currentCounts] = await Promise.all([
    installedSchemaVersion(),
    currentComponentCounts(businessId),
  ]);

  const preview = previewTenantRestore({
    businessId,
    artifact: {
      ref,
      format: artifact.format,
      origin: artifact.origin,
      capturedAt: artifact.capturedAt,
      available: artifact.state === "ready",
      integrity: artifact.verifiedAt ? "verified" : "unverified",
      completeness: artifact.completeness,
      state: artifact.state,
      ownedByBusiness: true,
    },
    manifest: artifact.manifest,
    manifestSignatureValid: signatureValid,
    deployment: { role: options.role, profile: options.profile },
    currentSchemaVersion: schemaVersion,
    currentCounts,
    actor: options.actor,
    now: options.now,
  });

  const { rows } = await query<{ id: string }>(
    `INSERT INTO tenant_backup_restore_jobs
       (business_id, artifact_ref, artifact_row_id, mode, phase, blockers, preview, actor_user_id)
     VALUES ($1,$2,$3,'preview','previewed',$4::jsonb,$5::jsonb,$6)
     RETURNING id`,
    [
      businessId,
      ref,
      artifact.id,
      JSON.stringify(preview.blockers.map((blocker) => blocker.code)),
      JSON.stringify(preview),
      options.actorUserId ?? null,
    ],
  );
  return { preview, jobId: rows[0]?.id ?? null };
}

// ---------------------------------------------------------------------------
// Storage evidence for the byte-day meter
// ---------------------------------------------------------------------------

/** Snapshot retained managed-cloud bytes. Local copies are never sampled. */
export async function recordStorageSample(
  businessId: string,
  at: Date = new Date(),
): Promise<{ cloudBytes: number; artifactCount: number }> {
  const { rows } = await query<{ cloud_bytes: string; artifact_count: string }>(
    `SELECT COALESCE(sum(stored_bytes), 0)::text AS cloud_bytes, count(*)::text AS artifact_count
       FROM tenant_backup_artifacts
      WHERE business_id = $1 AND destination = 'cloud' AND state <> 'pending_upload'`,
    [businessId],
  );
  const cloudBytes = Number(rows[0]?.cloud_bytes ?? 0);
  const artifactCount = Number(rows[0]?.artifact_count ?? 0);
  await query(
    `INSERT INTO tenant_backup_storage_samples (business_id, sampled_at, cloud_bytes, artifact_count)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (business_id, sampled_at) DO NOTHING`,
    [businessId, at.toISOString(), cloudBytes, artifactCount],
  );
  return { cloudBytes, artifactCount };
}

/** Byte-days retained over a window, from the samples the tenant can also see. */
export async function storageByteDays(
  businessId: string,
  window: { from: Date; to: Date },
): Promise<number> {
  const { rows } = await query<{ sampled_at: Date; cloud_bytes: string }>(
    `SELECT sampled_at, cloud_bytes
       FROM tenant_backup_storage_samples
      WHERE business_id = $1 AND sampled_at >= $2::timestamptz
      ORDER BY sampled_at ASC`,
    [businessId, window.from.toISOString()],
  );
  return cloudStorageByteDays(
    rows.map((row) => ({ at: row.sampled_at, cloudBytes: Number(row.cloud_bytes) })),
    window,
  );
}

/**
 * Emit the `backup.storage_byte_day` usage event for a window. The event id is
 * the settlement key plus the window, so a retried settlement is a duplicate
 * rather than a second charge. Local-only storage produces no event at all.
 */
export async function emitBackupStorageUsage(
  businessId: string,
  window: { from: Date; to: Date },
): Promise<{ status: string; byteDays: number }> {
  const rows = await listStoredArtifactRows(businessId);
  const cloudRows = rows.filter((row) => row.destination === "cloud");
  const byteDays = await storageByteDays(businessId, window);
  if (cloudRows.length === 0 || byteDays === 0) return { status: "skipped", byteDays: 0 };
  const artifactIds = uniqueArtifactIds(
    cloudRows.map((row) => ({ artifactId: row.artifactId, destination: row.destination })),
  );
  const result = await appendUsageEvent({
    eventId: `${settlementKey(businessId, artifactIds, "storage")}:${window.from.toISOString()}`,
    businessId,
    meterKey: BACKUP_STORAGE_METER_KEY,
    source: "platform",
    quantity: byteDays,
    unit: "byte_day",
    occurredAt: window.to.toISOString(),
    periodStart: window.from.toISOString(),
    periodEnd: window.to.toISOString(),
    resource: "tenant_backup",
    dimensions: { destination: "cloud", artifacts: artifactIds.length },
  });
  return { status: result.status, byteDays };
}
