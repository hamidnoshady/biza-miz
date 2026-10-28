/**
 * Issue #903 §1/§3 — wiring a managed backup from "bytes on disk" to
 * "a registered, signed, verifiable artifact".
 *
 * `backup-service.ts` owns the *pipeline* (dump/snapshot → encrypt → upload → prune)
 * and keeps doing so. This module owns the decisions the managed service adds
 * around it, in the order they must happen:
 *
 * ```text
 * 1. custody     which key protects this artifact (managed secret or legacy passphrase)
 * 2. payload     typed tenant archive (never a text SQL script) or a physical dump
 * 3. manifest    build + sign, naming scope, schema, encryption generation and
 *                every component, including the ones it does NOT contain
 * 4. register    one row per destination, sharing one artifact id
 * 5. verify      checksum + signature + (for logical) archive parse
 * 6. settle      charge only now, and only for a verified artifact
 * ```
 *
 * Everything that can be unit-tested is pure and lives in the modules this one
 * calls; what remains here is I/O against the database, the filesystem and the
 * provider — the same split the rest of the backup code uses.
 */
import { createHash } from "node:crypto";
import { query } from "./db";
import { promises as fs } from "node:fs";
import path from "node:path";
import { getMasterKey } from "./master-key";
import { logicalSnapshotScopeTag } from "./backup-policy";
import { decryptFileToFile, encryptFileToFile, sha256File } from "./backup-streams";
import { exportTenantData, type TenantExportTable } from "./tenant-export";
import {
  buildTenantArchive,
  parseTenantArchive,
  serializeTenantArchive,
  tenantTableSet,
} from "./tenant-archive";
import {
  buildBackupManifest,
  signBackupManifest,
  type BackupComponent,
  type BackupComponentKey,
  type BackupComponentState,
  type BackupManifest,
  type BackupPayloadFormat,
} from "./backup-manifest";
import {
  artifactSecretForVersion,
  currentArtifactCustodyKey,
  installedSchemaVersion,
  recordTenantArtifact,
  resolveOwnedArtifact,
} from "./tenant-backup-artifacts-service";
import { cleanupStagingDir, ensureStagingDir } from "./tenant-backup-storage";
import type { TenantBackupMode } from "./backup-policy";

/**
 * Which component a captured table belongs to. Ordered: the first match wins, so
 * `media_assets` is media, not website, and `website_orders` is the CMS rather
 * than accounting. Anything not named here is `app.data` — captured, and
 * labelled as "other application data" instead of being filed under a component
 * whose name would mislead the tenant.
 */
const COMPONENT_PREFIXES: [BackupComponentKey, string[]][] = [
  ["media.metadata", ["media_assets", "media_folders", "media_"]],
  ["website.cms", ["website_", "cms_"]],
  ["website.wp", ["wp_", "woocommerce_"]],
  ["crm.core", ["crm_", "customer", "lead", "ticket"]],
  ["growth.core", ["loyalty_", "growth_", "campaign", "gift_card", "store_credit", "referral"]],
  ["shared.settings", ["settings", "business_", "app_", "feature_", "integration"]],
  [
    "accounting.core",
    [
      "accounts", "journal_entries", "journal_lines", "orders", "order_items", "payments",
      "expenses", "inventory_items", "inventory_lots", "stock_movements", "purchases",
      "suppliers", "parties", "locations", "users", "shifts", "cheques", "tax_invoices",
      "vouchers", "fiscal_",
    ],
  ],
];

/**
 * Declared but not captured, with the honest reason. External website state is
 * the important one: a WooCommerce store's products and orders live in
 * WordPress, and no supported capture exists here, so claiming them would be the
 * lie §6 forbids.
 */
const EXTERNAL_COMPONENTS: [BackupComponentKey, BackupComponentState][] = [
  ["external.woocommerce", "external"],
  ["external.eshobe_assets", "external"],
];

function componentForTable(table: string): BackupComponentKey {
  for (const [key, prefixes] of COMPONENT_PREFIXES) {
    for (const prefix of prefixes) {
      if (table === prefix || table.startsWith(prefix.endsWith("_") ? prefix : `${prefix}_`)) return key;
    }
  }
  return "app.data";
}

/**
 * Turn the exported tables into the manifest's component list.
 *
 * The table set is real — it comes from the archive that was just written — so a
 * component is `included` only when a table of that component was captured, and
 * its `rows` are the rows those tables actually carried. Everything else is
 * declared explicitly rather than omitted, which is what lets the tenant UI say
 * "partial" truthfully.
 *
 * `mediaAttachments` is the number of binary attachments the business holds
 * (from `media_assets`): the database rows are captured, the bytes are not, so
 * the component is `excluded` with that count rather than silently absent. When
 * the count is zero the component is dropped — there is nothing to warn about.
 */
export function buildComponentInventory(
  tables: { name: string; rows: number }[],
  mediaAttachments = 0,
): { key: BackupComponentKey; state: BackupComponentState; rows: number }[] {
  const byComponent = new Map<BackupComponentKey, number>();
  for (const table of tables) {
    const key = componentForTable(table.name);
    byComponent.set(key, (byComponent.get(key) ?? 0) + table.rows);
  }
  const components: { key: BackupComponentKey; state: BackupComponentState; rows: number }[] = [];
  for (const [key, rows] of byComponent) {
    // A component with tables but no rows is still *captured* — an empty CRM is
    // a captured empty CRM, not a missing one.
    components.push({ key, state: "included", rows });
  }
  if (mediaAttachments > 0 && !components.some((component) => component.key === "media.attachments")) {
    components.push({ key: "media.attachments", state: "excluded", rows: mediaAttachments });
  }
  for (const [key, state] of EXTERNAL_COMPONENTS) {
    if (!components.some((component) => component.key === key)) components.push({ key, state, rows: 0 });
  }
  if (components.length === 0) components.push({ key: "shared.settings", state: "included", rows: 0 });
  return components;
}

/**
 * How many binary attachments this business holds. Read inside the tenant scope
 * by the caller, so RLS decides the count; a missing table (an install without
 * media) is zero, not an error.
 */
export async function mediaAttachmentCount(businessId: string): Promise<number> {
  try {
    const { rows } = await query<{ total: string }>(
      `SELECT count(*)::text AS total FROM media_assets WHERE business_id = $1 AND deleted_at IS NULL`,
      [businessId],
    );
    return Number(rows[0]?.total ?? 0);
  } catch {
    void businessId;
    return 0;
  }
}

/**
 * What a *physical* dump contains: the whole local database, every app of the
 * one business this install holds. Rows are unknown here (a dump is opaque), so
 * they are reported as 0 rather than guessed — the artifact's completeness is
 * still honest because the only declared gaps are the external ones.
 */
export function physicalComponentInventory(): { key: BackupComponentKey; state: BackupComponentState; rows: number }[] {
  return [
    { key: "accounting.core", state: "included", rows: 0 },
    { key: "crm.core", state: "included", rows: 0 },
    { key: "growth.core", state: "included", rows: 0 },
    { key: "website.cms", state: "included", rows: 0 },
    { key: "website.wp", state: "included", rows: 0 },
    { key: "shared.settings", state: "included", rows: 0 },
    { key: "media.metadata", state: "included", rows: 0 },
    { key: "app.data", state: "included", rows: 0 },
    ...EXTERNAL_COMPONENTS.map(([key, state]) => ({ key, state, rows: 0 })),
  ];
}

export type ArtifactEncryption =
  | { scheme: "managed_envelope_v1"; keyVersion: number; secret: string }
  | { scheme: "legacy_passphrase_v1"; keyVersion: null; secret: string };

/**
 * Which key protects a new artifact.
 *
 * Managed custody wins whenever the platform holds a key: that is the whole
 * point of the service, and it is what makes a tenant-independent recovery
 * possible. The Owner's passphrase is the fallback for a self-hosted install
 * with no platform key, so existing customers are not broken by the rollout.
 */
export async function artifactEncryptionFor(
  businessId: string,
  legacyPassphrase: string,
): Promise<{ ok: true; encryption: ArtifactEncryption } | { ok: false; error: string }> {
  const custody = await currentArtifactCustodyKey(businessId);
  if (custody.ok) {
    return {
      ok: true,
      encryption: { scheme: "managed_envelope_v1", keyVersion: custody.version, secret: custody.secret },
    };
  }
  if (legacyPassphrase.length > 0) {
    return {
      ok: true,
      encryption: { scheme: "legacy_passphrase_v1", keyVersion: null, secret: legacyPassphrase },
    };
  }
  // Neither: refusing here is what stops a plaintext artifact being written and
  // then advertised as a backup.
  return { ok: false, error: custody.error === "backup_encryption_unconfigured" ? "backup_encryption_unconfigured" : custody.error };
}

/** The secret that opens a *stored* artifact, resolved from its own manifest. */
export async function decryptionSecretFor(
  businessId: string,
  artifact: { encryption: "managed_envelope_v1" | "legacy_passphrase_v1"; keyVersion: number | null; manifest: BackupManifest | null },
  legacyPassphrase: string,
): Promise<{ ok: true; secret: string } | { ok: false; error: string }> {
  if (artifact.encryption === "legacy_passphrase_v1") {
    if (!legacyPassphrase) return { ok: false, error: "passphrase_required" };
    return { ok: true, secret: legacyPassphrase };
  }
  const version = artifact.keyVersion ?? artifact.manifest?.encryption.keyVersion ?? null;
  if (!version) return { ok: false, error: "backup_key_missing" };
  const opened = await artifactSecretForVersion(businessId, version);
  if (!opened.ok) return { ok: false, error: opened.error };
  return { ok: true, secret: opened.secret };
}

export interface LogicalArtifactResult {
  ok: true;
  payloadBytes: number;
  payloadFormat: BackupPayloadFormat;
  /** Rows per captured table, for the manifest and the restore preview. */
  tables: { name: string; rows: number }[];
  schemaVersion: number;
}

/**
 * Write the **typed archive** for a business to `outPath`.
 *
 * `exportTenantData` runs under RLS for this business, so the content is scoped
 * by the database rather than by this code. The archive is JSON, not SQL: the
 * restore path parses and re-inserts parameters, so an archive can never be
 * executed as a script.
 */
export async function writeTenantArchive(
  businessId: string,
  outPath: string,
  capturedAt: Date,
): Promise<LogicalArtifactResult> {
  const [tables, schemaVersion] = await Promise.all([exportTenantData(businessId), installedSchemaVersion()]);
  const archive = buildTenantArchive({
    businessId,
    capturedAt,
    schemaVersion,
    tables: tables as TenantExportTable[],
  });
  const serialized = serializeTenantArchive(archive);
  await fs.writeFile(outPath, serialized, { mode: 0o600 });
  return {
    ok: true,
    payloadBytes: Buffer.byteLength(serialized),
    payloadFormat: "tenant_archive_v1",
    tables: archive.tables.map((table) => ({ name: table.name, rows: table.rows.length })),
    schemaVersion,
  };
}

export interface FinalizeArtifactInput {
  businessId: string;
  /** Path of the encrypted artifact as it will be stored. */
  artifactPath: string;
  artifactName: string;
  destination: "local" | "cloud";
  origin: "scheduled" | "manual" | "uploaded";
  mode: TenantBackupMode;
  payloadFormat: BackupPayloadFormat;
  sizeBytes: number;
  sha256: string;
  encryption: ArtifactEncryption;
  capturedAt: Date;
  components: { key: BackupComponentKey; state: BackupComponentState; rows: number }[];
  schemaVersion: number;
  appVersion?: string | null;
  runId?: string | null;
  createdBy?: string | null;
  retentionUntil?: Date | null;
}

export type FinalizeResult =
  | { ok: true; artifactId: string; ref: string; manifest: BackupManifest }
  | { ok: false; error: string };

/**
 * Register a finished artifact: build and sign its manifest, then write the
 * inventory row. A missing KEK is a hard refusal — an unsigned manifest is not a
 * claim about anything, and registering one would let the inventory offer a
 * "restore" that no gate could verify.
 */
export async function registerFinishedArtifact(input: FinalizeArtifactInput): Promise<FinalizeResult> {
  const masterKey = getMasterKey();
  if (!masterKey) return { ok: false, error: "backup_encryption_unconfigured" };

  // The artifact id is derived from the stored artifact's identity, so the local
  // and cloud rows of one run collapse into one logical backup.
  const artifactId = createHash("sha256")
    .update(JSON.stringify(["tenant-backup-artifact-v1", input.businessId, input.artifactName]))
    .digest("hex")
    .slice(0, 32);

  const manifestInput = {
    artifactId,
    businessId: input.businessId,
    format: input.mode === "physical" ? ("physical_dump" as const) : ("logical_snapshot" as const),
    payloadFormat: input.payloadFormat,
    origin: input.origin,
    capturedAt: input.capturedAt,
    schemaVersion: input.schemaVersion,
    appVersion: input.appVersion ?? null,
    encryption: {
      scheme: input.encryption.scheme,
      keyVersion: input.encryption.keyVersion,
    } as BackupManifest["encryption"],
    sizeBytes: input.sizeBytes,
    sha256: input.sha256,
    components: input.components.map((component) => ({
      key: component.key,
      state: component.state,
      rows: component.rows,
    })) as Pick<BackupComponent, "key" | "state" | "rows">[],
  };

  let manifest: BackupManifest;
  try {
    manifest = buildBackupManifest(manifestInput as Parameters<typeof buildBackupManifest>[0]);
  } catch {
    return { ok: false, error: "invalid_backup_manifest" };
  }
  const signature = signBackupManifest(manifest, masterKey);

  const recorded = await recordTenantArtifact({
    businessId: input.businessId,
    artifactId,
    destination: input.destination,
    format: manifest.format,
    origin: input.origin,
    // Registered as `verifying`; `verifyRegisteredArtifact` promotes it. An
    // artifact is not "ready" until its checksum and signature have been
    // re-checked from the bytes that were actually stored.
    state: "verifying",
    payloadBytes: input.sizeBytes,
    storedBytes: input.sizeBytes,
    sha256: input.sha256,
    manifest,
    encryption: input.encryption.scheme,
    keyVersion: input.encryption.keyVersion,
    storageRef: input.artifactName,
    capturedAt: input.capturedAt,
    retentionUntil: input.retentionUntil ?? null,
    runId: input.runId ?? null,
    createdBy: input.createdBy ?? null,
    manifestSignature: signature,
  });
  if (!recorded.ok) return { ok: false, error: recorded.error };
  return { ok: true, artifactId, ref: recorded.ref, manifest };
}

export type VerificationResult =
  | { ok: true; tables: number }
  | { ok: false; error: string };

/**
 * Re-read the stored bytes and prove three things: the checksum matches, the
 * manifest's signature verifies against the platform key, and a logical payload
 * parses as an archive this build understands. Only then is the row `ready`.
 *
 * `stagedPath` is a local copy of the artifact (the local file, or a download).
 * Returns a provider-neutral error code — never a path, key or stack trace.
 */
export async function verifyStoredArtifact(
  businessId: string,
  options: { ref: string; stagedPath: string; schemaVersion: number },
): Promise<VerificationResult> {
  const row = await resolveOwnedArtifact(businessId, options.ref);
  if (!row) return { ok: false, error: "artifact_not_found" };
  if (!row.manifest || !row.manifestSignature) return { ok: false, error: "artifact_manifest_missing" };
  const masterKey = getMasterKey();
  if (!masterKey) return { ok: false, error: "backup_encryption_unconfigured" };

  // Imported lazily so this module stays loadable without the crypto path in a
  // client-ish context (it is server-only, but the import cost is real).
  const { verifyBackupManifestSignature } = await import("./backup-manifest");
  if (!verifyBackupManifestSignature(row.manifest, row.manifestSignature, masterKey)) {
    return { ok: false, error: "artifact_signature_invalid" };
  }

  const actual = await sha256File(options.stagedPath);
  if (row.manifest.payload?.sha256 && actual !== row.manifest.payload.sha256) {
    return { ok: false, error: "artifact_checksum_mismatch" };
  }

  if (row.manifest.payloadFormat === "tenant_archive_v1") {
    const decryptedPath = `${options.stagedPath}.verify.json`;
    try {
      const secret = await decryptionSecretFor(businessId, row, legacyPassphraseFromEnv());
      if (!secret.ok) return { ok: false, error: secret.error };
      await decryptFileToFile(options.stagedPath, decryptedPath, secret.secret);
      const raw = await fs.readFile(decryptedPath, "utf8");
      const allowed = await tenantTableSet();
      const parsed = parseTenantArchive(raw, {
        allowedTables: allowed,
        businessId,
        maxSchemaVersion: options.schemaVersion,
      });
      if (!parsed.ok) return { ok: false, error: parsed.error };
      return { ok: true, tables: parsed.archive.tables.length };
    } catch {
      // Wrong key, truncated file or a corrupt archive — indistinguishable to a
      // caller on purpose, and all of them mean "not restorable".
      return { ok: false, error: "artifact_unreadable" };
    } finally {
      await fs.rm(decryptedPath, { force: true }).catch(() => {});
    }
  }
  return { ok: true, tables: 0 };
}

/** The legacy passphrase for a self-hosted install, when the service has none. */
function legacyPassphraseFromEnv(): string {
  return process.env.BACKUP_PASSPHRASE?.trim() ?? "";
}

/**
 * Encrypt a plaintext payload with the chosen key, into `dir`. Shared by the
 * logical and physical paths so the envelope is always the one
 * `backup-streams.ts` defines.
 */
export async function encryptPayload(
  plainPath: string,
  dir: string,
  artifactName: string,
  secret: string,
): Promise<{ path: string; sizeBytes: number; sha256: string }> {
  const stagingDir = `${dir}.tmp`;
  await fs.mkdir(stagingDir, { recursive: true, mode: 0o700 });
  const tmpPath = path.join(stagingDir, artifactName);
  const streamed = await encryptFileToFile(plainPath, tmpPath, secret);
  const finalPath = path.join(dir, artifactName);
  await fs.rename(tmpPath, finalPath);
  await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  return { path: finalPath, sizeBytes: streamed.sizeBytes, sha256: streamed.sha256 };
}

/**
 * A transient workspace for one logical run, removed on every exit path. The
 * payload file lives here and never next to the encrypted artifact: a plaintext
 * archive left beside a ciphertext one is the mistake this exists to prevent.
 */
export async function withLogicalStaging<T>(
  businessId: string,
  runToken: string,
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await ensureStagingDir(businessId, `run-${runToken}`);
  try {
    return await fn(dir);
  } finally {
    await cleanupStagingDir(businessId, `run-${runToken}`);
  }
}

/** The artifact name's own UTC timestamp is the capture time of the payload. */
export function capturedAtOf(artifactName: string): Date {
  const stamp = /(\d{8})-(\d{6})/.exec(artifactName);
  if (!stamp) return new Date();
  const [, date, time] = stamp;
  const isoLike = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}Z`;
  const parsedDate = new Date(isoLike);
  return Number.isNaN(parsedDate.getTime()) ? new Date() : parsedDate;
}

/** The scope tag this deployment writes tenant artifacts under. */
export function artifactScopeTag(businessId: string): string {
  return logicalSnapshotScopeTag(businessId);
}

/** Retention expiry for a run, from the service's defaults. */
export async function retentionUntilFor(businessId: string, from: Date): Promise<Date | null> {
  void businessId;
  const { readTenantBackupService } = await import("./tenant-backup-storage");
  const config = await readTenantBackupService();
  const days = Math.min(Math.max(1, config.defaultRetentionDays), Math.max(1, config.maxRetentionDays));
  return new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
}
