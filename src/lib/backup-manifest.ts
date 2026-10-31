/**
 * Issue #903 — the typed manifest every managed tenant backup artifact carries.
 *
 * A file name alone cannot answer the questions a recovery decision actually
 * asks: *which* business is inside, *what* is inside, was any of it left out,
 * which encryption generation protects it, and which schema produced it? A
 * name-and-size pair that pretends to answer those is how a SQL export gets
 * mistaken for a restorable backup — the exact failure mode #807 and this epic
 * both call out.
 *
 * So an artifact now has a manifest: a small, versioned, JSON-typed record that
 * is **signed** with a platform key (the key-encryption key, never a tenant
 * secret) and stored next to the artifact. Everything that consumes a backup —
 * tenant inventory, the download gate, the central tenant-only restore preview,
 * the Superadmin business panel — reads the manifest instead of guessing from a
 * filename.
 *
 * Three properties are deliberate:
 *
 *  • **Signed, not trusted.** `validateBackupManifest` validates *shape*;
 *    `verifyBackupManifestSignature` proves the platform wrote it and nobody
 *    edited the business id, the scope or the component list afterwards. A
 *    manifest without a valid signature is never treated as restorable.
 *  • **Honest about gaps.** A component can be `included`, `external` (lives in
 *    an external system such as WooCommerce and was not captured), `excluded`
 *    (deliberately out of scope) or `unavailable` (should have been captured but
 *    was not). Any of the last three makes the artifact `partial`, in the API
 *    and in the UI, rather than a "complete backup" with a footnote.
 *  • **Scope-bound.** The business id in the manifest is derived into the same
 *    scope tag the artifact name carries, so a manifest cannot be glued onto
 *    another tenant's artifact to make it look like theirs.
 *
 * This module is pure: no database, no filesystem, no network. The service layer
 * persists what it returns; the tests below in `backup-manifest.test.ts` are the
 * contract.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { logicalSnapshotScopeTag } from "./backup-policy";

/** Bumped only when the manifest shape changes incompatibly. */
export const BACKUP_MANIFEST_VERSION = 1;
/** Older versions we still know how to read (and refuse to sign). */
export const MIN_SUPPORTED_MANIFEST_VERSION = 1;

/**
 * The components a complete business backup can be made of. Stable keys, not
 * Persian labels: the UI decides how to name them, so a rename of the CMS never
 * orphans a stored manifest.
 */
export const BACKUP_COMPONENT_KEYS = [
  "accounting.core",
  "crm.core",
  "growth.core",
  "website.cms",
  "website.wp",
  "shared.settings",
  "media.metadata",
  "media.attachments",
  /**
   * Everything else the tenant owns that has no narrower home — app modules
   * (AEC, agency, cosmetics, …) that are *captured* in the archive but were never
   * one of the named business areas. It exists so no captured table has to be
   * filed under a component whose name would be a lie.
   */
  "app.data",
  "external.woocommerce",
  "external.eshobe_assets",
] as const;
export type BackupComponentKey = (typeof BACKUP_COMPONENT_KEYS)[number];

export type BackupFormat = "physical_dump" | "logical_snapshot";
/**
 * What the payload bytes actually are. `tenant_archive_v1` is the typed
 * JSON archive (`tenant-archive.ts`) a managed logical backup writes;
 * `logical_sql_v1` is the historic `INSERT`-script export, kept labelled so a
 * restore can refuse it by name instead of trusting it. Only the physical
 * payload is ever handed to `pg_restore`.
 */
export const BACKUP_PAYLOAD_FORMATS = [
  "physical_dump_v1",
  "logical_sql_v1",
  "tenant_archive_v1",
] as const;
export type BackupPayloadFormat = (typeof BACKUP_PAYLOAD_FORMATS)[number];
export type BackupOrigin = "scheduled" | "manual" | "uploaded";
export type BackupComponentState = "included" | "external" | "excluded" | "unavailable";
export type BackupEncryptionScheme = "managed_envelope_v1" | "legacy_passphrase_v1";

export interface BackupComponent {
  key: BackupComponentKey;
  state: BackupComponentState;
  /** Bytes this component contributed to the payload, when known. */
  bytes: number | null;
  /** Rows this component contributed, when known. */
  rows: number | null;
}

export interface BackupManifest {
  manifestVersion: number;
  /** The `tenant_backup_artifacts` row id this manifest belongs to. */
  artifactId: string;
  businessId: string;
  scope: {
    /** Physical = whole install database (site only); logical = one tenant. */
    kind: "physical" | "logical";
    /** The scope tag the artifact name carries, derived from `businessId`. */
    businessTag: string;
  };
  format: BackupFormat;
  payloadFormat: BackupPayloadFormat;
  origin: BackupOrigin;
  /** ISO instant the snapshot was captured. */
  capturedAt: string;
  /** Migration/application schema the payload was produced under. */
  schemaVersion: number;
  appVersion: string | null;
  encryption: {
    scheme: BackupEncryptionScheme;
    /** Custody generation; null for legacy passphrase artifacts. */
    keyVersion: number | null;
  };
  payload: {
    /** Bytes of the artifact as stored (ciphertext on cloud/local). */
    sizeBytes: number;
    /** sha256 of the stored artifact. */
    sha256: string;
  };
  components: BackupComponent[];
}

export interface BuildManifestInput {
  artifactId: string;
  businessId: string;
  format: BackupFormat;
  payloadFormat?: BackupPayloadFormat;
  origin: BackupOrigin;
  capturedAt: Date;
  schemaVersion: number;
  appVersion?: string | null;
  encryption: BackupManifest["encryption"];
  sizeBytes: number;
  sha256: string;
  components: { key: BackupComponentKey; state: BackupComponentState; bytes?: number | null; rows?: number | null }[];
}

export function businessScopeTag(businessId: string): string {
  return logicalSnapshotScopeTag(businessId);
}

const FORMATS: readonly BackupFormat[] = ["physical_dump", "logical_snapshot"];
const ORIGINS: readonly BackupOrigin[] = ["scheduled", "manual", "uploaded"];
const STATES: readonly BackupComponentState[] = ["included", "external", "excluded", "unavailable"];
const SCHEMES: readonly BackupEncryptionScheme[] = ["managed_envelope_v1", "legacy_passphrase_v1"];
const SHA256_RE = /^[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Build a manifest from known facts. Throws only on a programming error. */
export function buildBackupManifest(input: BuildManifestInput): BackupManifest {
  const manifest: BackupManifest = {
    manifestVersion: BACKUP_MANIFEST_VERSION,
    artifactId: input.artifactId,
    businessId: input.businessId,
    scope: {
      kind: input.format === "physical_dump" ? "physical" : "logical",
      businessTag: businessScopeTag(input.businessId),
    },
    format: input.format,
    payloadFormat:
      input.payloadFormat ?? (input.format === "physical_dump" ? "physical_dump_v1" : "tenant_archive_v1"),
    origin: input.origin,
    capturedAt: input.capturedAt.toISOString(),
    schemaVersion: input.schemaVersion,
    appVersion: input.appVersion ?? null,
    encryption: {
      scheme: input.encryption.scheme,
      keyVersion: input.encryption.keyVersion,
    },
    payload: { sizeBytes: input.sizeBytes, sha256: input.sha256 },
    components: input.components.map((component) => ({
      key: component.key,
      state: component.state,
      bytes: component.bytes ?? null,
      rows: component.rows ?? null,
    })),
  };
  const validated = validateBackupManifest(manifest);
  if (!validated.ok) throw new Error(`invalid_backup_manifest:${validated.error}`);
  return validated.manifest;
}

export type ManifestValidation =
  | { ok: true; manifest: BackupManifest }
  | { ok: false; error: string };

/**
 * Strict shape validation. Unknown top-level keys and unknown component keys are
 * rejected rather than ignored: a manifest is signed content, and silently
 * dropping a field we did not understand is how a future "restore everything"
 * flag would be introduced without a code change here.
 */
export function validateBackupManifest(value: unknown): ManifestValidation {
  if (!isRecord(value)) return { ok: false, error: "manifest_not_an_object" };

  const allowed = [
    "manifestVersion", "artifactId", "businessId", "scope", "format", "payloadFormat", "origin",
    "capturedAt", "schemaVersion", "appVersion", "encryption", "payload", "components",
  ];
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    return { ok: false, error: "manifest_unknown_field" };
  }

  const version = value.manifestVersion;
  if (!isNonNegativeInteger(version) || version < MIN_SUPPORTED_MANIFEST_VERSION) {
    return { ok: false, error: "manifest_version_unsupported" };
  }
  if (version > BACKUP_MANIFEST_VERSION) {
    // Forward-compatible refusal: a newer writer may have added semantics this
    // build would silently ignore. The operator upgrades, the data survives.
    return { ok: false, error: "manifest_version_too_new" };
  }
  if (typeof value.artifactId !== "string" || !value.artifactId) {
    return { ok: false, error: "manifest_artifact_id_missing" };
  }
  if (typeof value.businessId !== "string" || !value.businessId) {
    return { ok: false, error: "manifest_business_id_missing" };
  }
  if (typeof value.capturedAt !== "string" || Number.isNaN(Date.parse(value.capturedAt))) {
    return { ok: false, error: "manifest_captured_at_invalid" };
  }
  if (!isNonNegativeInteger(value.schemaVersion) || value.schemaVersion < 1) {
    return { ok: false, error: "manifest_schema_version_invalid" };
  }
  if (typeof value.appVersion !== "string" && value.appVersion !== null) {
    return { ok: false, error: "manifest_app_version_invalid" };
  }
  if (!FORMATS.includes(value.format as BackupFormat)) {
    return { ok: false, error: "manifest_format_invalid" };
  }
  if (!ORIGINS.includes(value.origin as BackupOrigin)) {
    return { ok: false, error: "manifest_origin_invalid" };
  }
  if (!BACKUP_PAYLOAD_FORMATS.includes(value.payloadFormat as BackupPayloadFormat)) {
    return { ok: false, error: "manifest_payload_format_invalid" };
  }
  // A physical artifact is a `pg_dump` image or it is not a physical artifact;
  // a logical one is never a dump. A mismatched pair is a manifest that cannot
  // decide what its own bytes are, so it is refused.
  const expectedPhysical = value.format === "physical_dump";
  if (expectedPhysical !== (value.payloadFormat === "physical_dump_v1")) {
    return { ok: false, error: "manifest_payload_format_mismatch" };
  }

  const scope = value.scope;
  if (!isRecord(scope)) return { ok: false, error: "manifest_scope_invalid" };
  const expectedKind = value.format === "physical_dump" ? "physical" : "logical";
  if (scope.kind !== expectedKind) return { ok: false, error: "manifest_scope_mismatch" };
  if (typeof scope.businessTag !== "string" || scope.businessTag !== businessScopeTag(value.businessId as string)) {
    return { ok: false, error: "manifest_scope_mismatch" };
  }

  const encryption = value.encryption;
  if (!isRecord(encryption)) return { ok: false, error: "manifest_encryption_invalid" };
  if (!SCHEMES.includes(encryption.scheme as BackupEncryptionScheme)) {
    return { ok: false, error: "manifest_encryption_invalid" };
  }
  if (encryption.scheme === "managed_envelope_v1") {
    if (!isNonNegativeInteger(encryption.keyVersion) || encryption.keyVersion < 1) {
      return { ok: false, error: "manifest_key_version_invalid" };
    }
  } else if (encryption.keyVersion !== null) {
    return { ok: false, error: "manifest_key_version_invalid" };
  }

  const payload = value.payload;
  if (!isRecord(payload)) return { ok: false, error: "manifest_payload_invalid" };
  if (!isNonNegativeInteger(payload.sizeBytes)) return { ok: false, error: "manifest_size_invalid" };
  if (typeof payload.sha256 !== "string" || !SHA256_RE.test(payload.sha256)) {
    return { ok: false, error: "manifest_checksum_invalid" };
  }

  const components = value.components;
  if (!Array.isArray(components) || components.length === 0) {
    return { ok: false, error: "manifest_components_missing" };
  }
  const seen = new Set<string>();
  const normalised: BackupComponent[] = [];
  for (const entry of components) {
    if (!isRecord(entry)) return { ok: false, error: "manifest_component_invalid" };
    const key = entry.key;
    if (typeof key !== "string" || !(BACKUP_COMPONENT_KEYS as readonly string[]).includes(key)) {
      return { ok: false, error: "manifest_component_unknown" };
    }
    if (seen.has(key)) return { ok: false, error: "manifest_component_duplicate" };
    seen.add(key);
    if (!STATES.includes(entry.state as BackupComponentState)) {
      return { ok: false, error: "manifest_component_invalid" };
    }
    if (entry.bytes !== null && !isNonNegativeInteger(entry.bytes)) {
      return { ok: false, error: "manifest_component_invalid" };
    }
    if (entry.rows !== null && !isNonNegativeInteger(entry.rows)) {
      return { ok: false, error: "manifest_component_invalid" };
    }
    normalised.push({
      key: key as BackupComponentKey,
      state: entry.state as BackupComponentState,
      bytes: (entry.bytes as number | null) ?? null,
      rows: (entry.rows as number | null) ?? null,
    });
  }

  return {
    ok: true,
    manifest: {
      manifestVersion: version,
      artifactId: value.artifactId,
      businessId: value.businessId,
      scope: { kind: expectedKind, businessTag: scope.businessTag as string },
      format: value.format as BackupFormat,
      payloadFormat: value.payloadFormat as BackupPayloadFormat,
      origin: value.origin as BackupOrigin,
      capturedAt: value.capturedAt,
      schemaVersion: value.schemaVersion,
      appVersion: (value.appVersion as string | null) ?? null,
      encryption: {
        scheme: encryption.scheme as BackupEncryptionScheme,
        keyVersion: (encryption.keyVersion as number | null) ?? null,
      },
      payload: { sizeBytes: payload.sizeBytes as number, sha256: payload.sha256 as string },
      components: normalised,
    },
  };
}

/**
 * Stable JSON for signing: every object's keys are emitted in sorted order and
 * no whitespace survives, so re-serialising the manifest cannot invalidate the
 * signature depending on which JSON writer touched it first.
 */
export function canonicalManifestJson(value: unknown): string {
  const canonical = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonical);
    if (isRecord(input)) {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(input).sort()) out[key] = canonical(input[key]);
      return out;
    }
    return input;
  };
  return JSON.stringify(canonical(value));
}

/** Purpose-bound signing key: the KEK never signs anything else directly. */
export function manifestSigningKey(masterKey: Buffer): Buffer {
  return createHmac("sha256", masterKey).update("tenant-backup-manifest-signing-v1").digest();
}

export function signBackupManifest(manifest: BackupManifest, masterKey: Buffer): string {
  return createHmac("sha256", manifestSigningKey(masterKey))
    .update(canonicalManifestJson(manifest))
    .digest("hex");
}

export function verifyBackupManifestSignature(
  manifest: BackupManifest,
  signature: string,
  masterKey: Buffer,
): boolean {
  if (!SHA256_RE.test(signature)) return false;
  const expected = Buffer.from(signBackupManifest(manifest, masterKey), "hex");
  const actual = Buffer.from(signature, "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export interface ManifestCompleteness {
  status: "complete" | "partial";
  included: BackupComponentKey[];
  external: BackupComponentKey[];
  excluded: BackupComponentKey[];
  unavailable: BackupComponentKey[];
}

/**
 * `partial` unless every declared component was actually captured. An external
 * website's state is never implied: it is listed as `external` and the backup is
 * partial until the integration offers a supported capture method.
 */
export function manifestCompleteness(manifest: BackupManifest): ManifestCompleteness {
  const result: ManifestCompleteness = {
    status: "complete",
    included: [],
    external: [],
    excluded: [],
    unavailable: [],
  };
  for (const component of manifest.components) {
    if (component.state === "included") result.included.push(component.key);
    if (component.state === "external") result.external.push(component.key);
    if (component.state === "excluded") result.excluded.push(component.key);
    if (component.state === "unavailable") result.unavailable.push(component.key);
  }
  if (result.external.length || result.excluded.length || result.unavailable.length) {
    result.status = "partial";
  }
  return result;
}

/** The business the manifest may be restored to, or null when it is not ours. */
export function manifestMatchesBusiness(manifest: BackupManifest, businessId: string): boolean {
  return manifest.businessId === businessId && manifest.scope.businessTag === businessScopeTag(businessId);
}

export type ManifestRestorability =
  | { ok: true; mode: "physical" | "logical" }
  | { ok: false; error: string };

/**
 * Compatibility gate consulted by both the tenant preview and any future apply
 * path. It never inspects a file; it answers whether this *manifest* describes
 * something this deployment/build is allowed to restore.
 */
export function manifestRestorability(
  manifest: BackupManifest,
  options: { businessId: string; currentSchemaVersion: number; allowPhysical: boolean },
): ManifestRestorability {
  if (!manifestMatchesBusiness(manifest, options.businessId)) {
    return { ok: false, error: "artifact_not_owned_by_business" };
  }
  if (manifest.manifestVersion > BACKUP_MANIFEST_VERSION) {
    return { ok: false, error: "manifest_version_too_new" };
  }
  if (manifest.format === "physical_dump") {
    if (!options.allowPhysical) return { ok: false, error: "physical_tenant_restore_forbidden_on_central" };
    return { ok: true, mode: "physical" };
  }
  if (manifest.payloadFormat === "logical_sql_v1") {
    // Historic SQL exports are data exports, not restorable artifacts — the
    // epic's rule. The typed archive supersedes them.
    return { ok: false, error: "artifact_format_not_restorable" };
  }
  if (manifest.schemaVersion > options.currentSchemaVersion) {
    // Newer payload than this build knows how to read: migrating forward in
    // place would write half-understood rows.
    return { ok: false, error: "artifact_schema_newer_than_installation" };
  }
  return { ok: true, mode: "logical" };
}
