/**
 * Issue #903 §5 — managed encryption custody for tenant backup artifacts.
 *
 * Today a tenant's backup is encrypted with a passphrase the Owner typed into
 * `/dashboard/backup`. That is a reasonable design for a self-hosted café, and a
 * bad one for a managed service: the tenant ends up custodian of the only key to
 * its own safety net, the key gets lost, and "we have your backup" quietly means
 * "we have a file nobody can open".
 *
 * The fix is not a new file format. The artifact envelope
 * (`POSBKP1 | salt | IV | ciphertext | tag`, see `backup-streams.ts`) is exactly
 * what a random 32-byte secret produces, so managed custody **replaces the
 * passphrase with a generated per-business secret** and stores that secret
 * encrypted at rest under the platform key-encryption key (`master-key.ts`).
 * Consequences that matter:
 *
 *  • Every existing artifact keeps decrypting through the same streaming code —
 *    there is no format fork and no re-encryption of historic backups.
 *  • A `managed_envelope_v1` artifact names the *key version* that protects it,
 *    so rotation never makes an old archive unreadable.
 *  • Historic passphrase artifacts are labelled `legacy_passphrase_v1` and stay
 *    openable only by their passphrase. They are never silently "migrated" into
 *    a managed label, because the ciphertext was not written under a managed
 *    key.
 *  • Nothing here returns key material to a tenant. The wrapped record lives in
 *    a platform-only table; unwrapping happens on a server path that also
 *    authorizes a specific business and artifact.
 *
 * Pure crypto, injected KEK: unit-testable without a database, and incapable of
 * reading the environment by itself.
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { deriveBackupKey } from "./backup-streams";

/** AES-256 keys are 32 bytes; the artifact envelope scrypts whatever string we give it. */
export const ARTIFACT_KEY_BYTES = 32;
export const MANAGED_KEY_SCHEME = "managed_envelope_v1" as const;
export const LEGACY_KEY_SCHEME = "legacy_passphrase_v1" as const;

/** A 12-byte GCM nonce; fixed so a stored record is self-describing. */
const WRAP_IV_BYTES = 12;
const WRAP_TAG_BYTES = 16;

export type CustodyStatus = "active" | "retired" | "revoked";

export interface ArtifactKeyRecord {
  businessId: string;
  /** Monotonic per business: 1, 2, 3… A retired version still opens old artifacts. */
  version: number;
  status: CustodyStatus;
  /** Base64 AES-256-GCM ciphertext of the artifact secret. */
  wrapped: string;
  nonce: string;
  tag: string;
  createdAt: string;
  retiredAt: string | null;
  /** Which KEK source wrapped it — diagnostics only, never key material. */
  kekSource: string;
}

export interface SealedArtifactKey {
  /** The secret handed to the artifact envelope. Never persisted in plaintext. */
  secret: string;
  record: ArtifactKeyRecord;
}

/** Purpose-bound wrapping key: the KEK signs elsewhere and wraps here, never both. */
export function artifactKeyWrappingKey(masterKey: Buffer): Buffer {
  return createHmac("sha256", masterKey).update("tenant-backup-artifact-key-wrap-v1").digest();
}

/**
 * Additional authenticated data. Binding the business id and version into the
 * GCM tag is what stops a wrapped key from being moved onto another business's
 * row (or relabelled as another version) and still decrypting.
 */
export function artifactKeyAad(businessId: string, version: number): Buffer {
  return Buffer.from(`tenant-backup-artifact-key-v1|${businessId}|${version}`, "utf8");
}

/** The secret an artifact envelope is given — full entropy, not a human phrase. */
export function generateArtifactSecret(): string {
  return randomBytes(ARTIFACT_KEY_BYTES).toString("base64url");
}

export function sealArtifactKey(
  masterKey: Buffer,
  input: { businessId: string; version: number; now?: Date; kekSource?: string },
): SealedArtifactKey {
  if (!Number.isSafeInteger(input.version) || input.version < 1) {
    throw new Error("artifact key version must be a positive integer");
  }
  const secret = generateArtifactSecret();
  const nonce = randomBytes(WRAP_IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", artifactKeyWrappingKey(masterKey), nonce, {
    authTagLength: WRAP_TAG_BYTES,
  });
  cipher.setAAD(artifactKeyAad(input.businessId, input.version));
  const wrapped = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return {
    secret,
    record: {
      businessId: input.businessId,
      version: input.version,
      status: "active",
      wrapped: wrapped.toString("base64"),
      nonce: nonce.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      createdAt: (input.now ?? new Date()).toISOString(),
      retiredAt: null,
      kekSource: input.kekSource ?? "environment",
    },
  };
}

export type OpenArtifactKeyResult =
  | { ok: true; secret: string }
  | { ok: false; error: "backup_key_revoked" | "backup_key_unreadable" | "backup_key_mismatch" };

/**
 * Unwrap a stored key. `backup_key_mismatch` (wrong KEK, moved record, wrong
 * version) is deliberately distinct from `backup_key_unreadable` (corrupt or
 * truncated record) so an operator can tell a failed rotation from a bad copy.
 */
export function openArtifactKey(
  masterKey: Buffer,
  record: ArtifactKeyRecord,
  expected: { businessId: string; version: number } = { businessId: record.businessId, version: record.version },
): OpenArtifactKeyResult {
  if (record.status === "revoked") return { ok: false, error: "backup_key_revoked" };
  if (expected.businessId !== record.businessId || expected.version !== record.version) {
    return { ok: false, error: "backup_key_mismatch" };
  }
  let nonce: Buffer;
  let tag: Buffer;
  let wrapped: Buffer;
  try {
    nonce = Buffer.from(record.nonce, "base64");
    tag = Buffer.from(record.tag, "base64");
    wrapped = Buffer.from(record.wrapped, "base64");
  } catch {
    return { ok: false, error: "backup_key_unreadable" };
  }
  if (nonce.length !== WRAP_IV_BYTES || tag.length !== WRAP_TAG_BYTES || wrapped.length === 0) {
    return { ok: false, error: "backup_key_unreadable" };
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", artifactKeyWrappingKey(masterKey), nonce, {
      authTagLength: WRAP_TAG_BYTES,
    });
    decipher.setAAD(artifactKeyAad(expected.businessId, expected.version));
    decipher.setAuthTag(tag);
    const secret = Buffer.concat([decipher.update(wrapped), decipher.final()]).toString("utf8");
    if (!secret) return { ok: false, error: "backup_key_unreadable" };
    return { ok: true, secret };
  } catch {
    return { ok: false, error: "backup_key_mismatch" };
  }
}

export type CustodySelection =
  | { ok: true; record: ArtifactKeyRecord }
  | { ok: false; error: "backup_key_missing" | "backup_key_revoked" };

/** The version that protects *new* artifacts: the highest active one. */
export function selectCustodyKey(records: ArtifactKeyRecord[]): CustodySelection {
  const active = records.filter((record) => record.status === "active");
  if (active.length === 0) {
    return {
      ok: false,
      error: records.length > 0 ? "backup_key_revoked" : "backup_key_missing",
    };
  }
  return { ok: true, record: active.reduce((best, record) => (record.version > best.version ? record : best)) };
}

export interface RotationPlan {
  nextVersion: number;
  /** Versions that stay usable for reading old artifacts. */
  retained: number[];
  /** Versions a caller must never seal new artifacts under. */
  blocked: number[];
}

/**
 * Rotation never deletes or renumbers. A retired version still opens everything
 * written while it was active; a revoked one is refused by `openArtifactKey`
 * (which is what "crypto-shred this key" means in a managed service).
 */
export function planKeyRotation(records: ArtifactKeyRecord[]): RotationPlan {
  const highest = records.reduce((max, record) => Math.max(max, record.version), 0);
  const revoked = records.filter((record) => record.status === "revoked").map((record) => record.version);
  const retained = records.filter((record) => record.status !== "revoked").map((record) => record.version);
  return { nextVersion: highest + 1, retained, blocked: revoked };
}

export interface CustodySummary {
  scheme: typeof MANAGED_KEY_SCHEME | typeof LEGACY_KEY_SCHEME | "unconfigured";
  /** Server-side diagnostics for the Superadmin console; never a tenant DTO. */
  activeVersion: number | null;
  versions: { version: number; status: CustodyStatus; createdAt: string; retiredAt: string | null }[];
  /** True when a legacy passphrase still protects at least one artifact. */
  legacyArtifacts: boolean;
}

/**
 * One honest readout for the operator console. `unconfigured` means the platform
 * has no KEK, so managed custody cannot be used at all — it never means
 * "plaintext is fine". Artifact creation must refuse in that state.
 */
export function custodySummary(
  records: ArtifactKeyRecord[],
  options: { kekAvailable: boolean; legacyArtifacts?: boolean },
): CustodySummary {
  const active = selectCustodyKey(records);
  const scheme = !options.kekAvailable
    ? "unconfigured"
    : records.length > 0
      ? MANAGED_KEY_SCHEME
      : options.legacyArtifacts
        ? LEGACY_KEY_SCHEME
        : "unconfigured";
  return {
    scheme,
    activeVersion: active.ok ? active.record.version : null,
    versions: [...records]
      .sort((a, b) => a.version - b.version)
      .map((record) => ({
        version: record.version,
        status: record.status,
        createdAt: record.createdAt,
        retiredAt: record.retiredAt,
      })),
    legacyArtifacts: Boolean(options.legacyArtifacts),
  };
}

/**
 * A portable recovery envelope: the artifact secret wrapped under a secret the
 * *tenant* holds, so a downloaded backup is still openable if Bizia-Miz itself
 * is unavailable. It is opt-in per download and is not the platform's custody
 * record — losing this passphrase loses only the portable copy.
 */
export function sealPortableRecoveryEnvelope(
  artifactSecret: string,
  recoveryPassphrase: string,
  businessId: string,
): { envelope: string } {
  if (recoveryPassphrase.trim().length < 12) {
    throw new Error("recovery passphrase must be at least 12 characters");
  }
  const salt = randomBytes(16);
  const nonce = randomBytes(WRAP_IV_BYTES);
  // The envelope's own KDF is the same scrypt the artifact format uses, reached
  // through backup-streams so both halves cannot drift.
  const key = deriveBackupKey(recoveryPassphrase, salt);
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: WRAP_TAG_BYTES });
  cipher.setAAD(portableEnvelopeAad(businessId));
  const body = Buffer.concat([cipher.update(artifactSecret, "utf8"), cipher.final()]);
  return {
    envelope: [
      "POSRKY1",
      salt.toString("base64"),
      nonce.toString("base64"),
      cipher.getAuthTag().toString("base64"),
      body.toString("base64"),
    ].join("."),
  };
}

function portableEnvelopeAad(businessId: string): Buffer {
  return Buffer.from(`tenant-backup-portable-recovery-v1|${businessId}`, "utf8");
}

export type PortableOpenResult = { ok: true; secret: string } | { ok: false; error: string };

export function openPortableRecoveryEnvelope(
  envelope: string,
  recoveryPassphrase: string,
  businessId: string,
): PortableOpenResult {
  const parts = envelope.split(".");
  if (parts.length !== 5 || parts[0] !== "POSRKY1") return { ok: false, error: "recovery_envelope_invalid" };
  try {
    const salt = Buffer.from(parts[1], "base64");
    const nonce = Buffer.from(parts[2], "base64");
    const tag = Buffer.from(parts[3], "base64");
    const body = Buffer.from(parts[4], "base64");
    if (salt.length !== 16 || nonce.length !== WRAP_IV_BYTES || tag.length !== WRAP_TAG_BYTES) {
      return { ok: false, error: "recovery_envelope_invalid" };
    }
    const key = deriveBackupKey(recoveryPassphrase, salt);
    const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: WRAP_TAG_BYTES });
    decipher.setAAD(portableEnvelopeAad(businessId));
    decipher.setAuthTag(tag);
    const secret = Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
    if (!secret) return { ok: false, error: "recovery_envelope_invalid" };
    return { ok: true, secret };
  } catch {
    // Wrong passphrase and a tampered envelope are indistinguishable by design.
    return { ok: false, error: "recovery_passphrase_invalid" };
  }
}

/** Constant-time compare used by custody tests and rotation checks. */
export function sameSecret(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
