/**
 * Issue #903 §2 item 4 / §6 — importing a backup file the Owner brought back.
 *
 * The tests here pin the refusals, because the import path is the one place a
 * tenant hands the platform bytes and a document, and only one of them can be
 * signed. Everything the platform *believes* comes from the signed manifest; the
 * file is only ever data.
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildBackupManifest,
  signBackupManifest,
  type BackupManifest,
} from "./backup-manifest";
import {
  buildRecoveryManifestFile,
  checkRecoveryManifest,
  mapImportError,
  recoveryImportAvailable,
  recoveryManifestFileName,
  serializeRecoveryManifestFile,
  IMPORT_REFUSALS,
} from "./tenant-backup-import";

const BUSINESS = "0b6f3d9b-8bfa-4f7e-9b93-6a1d3c2f4a10";
const OTHER = "7d2a8bd4-1f3c-4a6e-8f5b-9c0d1e2f3a4b";
const MASTER = randomBytes(32);

function manifest(overrides: Partial<Parameters<typeof buildBackupManifest>[0]> = {}): BackupManifest {
  return buildBackupManifest({
    artifactId: "artifact-1",
    businessId: BUSINESS,
    format: "logical_snapshot",
    payloadFormat: "tenant_archive_v1",
    origin: "scheduled",
    capturedAt: new Date("2026-10-27T03:30:00Z"),
    schemaVersion: 400,
    encryption: { scheme: "managed_envelope_v1", keyVersion: 3 },
    sizeBytes: 4_096,
    sha256: "a".repeat(64),
    components: [{ key: "accounting.core", state: "included", rows: 4_000 }],
    ...overrides,
  } as Parameters<typeof buildBackupManifest>[0]);
}

function file(overrides: { manifest?: BackupManifest; signature?: string } = {}) {
  const value = overrides.manifest ?? manifest();
  return serializeRecoveryManifestFile(
    buildRecoveryManifestFile(value, overrides.signature ?? signBackupManifest(value, MASTER)),
  );
}

function check(text: string, extra: { businessId?: string; schemaVersion?: number; masterKey?: Buffer | null } = {}) {
  return checkRecoveryManifest({
    text,
    businessId: extra.businessId ?? BUSINESS,
    currentSchemaVersion: extra.schemaVersion ?? 455,
    masterKey: extra.masterKey === undefined ? MASTER : extra.masterKey,
  });
}

describe("checkRecoveryManifest", () => {
  it("accepts this business's own signed logical archive", () => {
    const result = check(file());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.businessId).toBe(BUSINESS);
      // The signature travels with the file, so the caller can store it beside
      // the artifact without re-signing anything.
      expect(result.manifestSignature).toBe(signBackupManifest(manifest(), MASTER));
    }
  });

  it("refuses a manifest file that is not JSON", () => {
    expect(check("{not json").ok).toBe(false);
    expect(check("{not json")).toEqual({ ok: false, error: "recovery_manifest_unreadable" });
  });

  it("refuses a manifest envelope of the wrong shape", () => {
    expect(check(JSON.stringify({ manifest: manifest(), manifestSignature: "x".repeat(64) }))).toEqual({
      ok: false,
      error: "recovery_manifest_unreadable",
    });
    expect(check(JSON.stringify({ kind: "biza-miz-backup-manifest", manifest: manifest() }))).toEqual({
      ok: false,
      error: "recovery_manifest_unreadable",
    });
  });

  it("refuses an unsigned or edited manifest — the file cannot author trust", () => {
    const edited = manifest({ capturedAt: new Date("2026-01-01T00:00:00Z") });
    // A tenant can write any manifest; only the signature decides.
    expect(check(file({ manifest: edited, signature: signBackupManifest(manifest(), MASTER) }))).toEqual({
      ok: false,
      error: "recovery_manifest_signature_invalid",
    });
    expect(check(file({ signature: "b".repeat(64) }))).toEqual({
      ok: false,
      error: "recovery_manifest_signature_invalid",
    });
  });

  it("refuses another business's genuine backup", () => {
    const other = manifest({ businessId: OTHER });
    expect(check(file({ manifest: other }))).toEqual({
      ok: false,
      error: "recovery_file_not_owned_by_business",
    });
  });

  it("refuses a physical dump and a text SQL payload on the logical import path", () => {
    const physical = manifest({ format: "physical_dump", payloadFormat: "physical_dump_v1" });
    expect(check(file({ manifest: physical }))).toEqual({ ok: false, error: "recovery_file_not_importable" });

    const sql = manifest({ payloadFormat: "logical_sql_v1" });
    expect(check(file({ manifest: sql }))).toEqual({ ok: false, error: "recovery_file_not_importable" });
  });

  it("refuses a file written by a newer build", () => {
    const newer = manifest({ schemaVersion: 999 });
    expect(check(file({ manifest: newer }))).toEqual({ ok: false, error: "recovery_file_schema_too_new" });
  });

  it("reports an installation with no platform key instead of pretending", () => {
    expect(check(file(), { masterKey: null })).toEqual({
      ok: false,
      error: "backup_encryption_unconfigured",
    });
  });

  it("accepts a legacy passphrase artifact; the passphrase is demanded at import", () => {
    const legacy = manifest({ encryption: { scheme: "legacy_passphrase_v1", keyVersion: null } });
    const result = check(file({ manifest: legacy }));
    // The manifest check is about provenance, not custody: the missing
    // passphrase is reported by the import step, which is where it is used.
    expect(result.ok).toBe(true);
  });

  it("checks the signature before it uses anything the manifest claims", () => {
    // An unsigned manifest naming another business must fail as a *signature*
    // problem: otherwise the refusal itself would confirm which business a file
    // belongs to.
    const other = manifest({ businessId: OTHER });
    expect(check(file({ manifest: other, signature: "c".repeat(64) }))).toEqual({
      ok: false,
      error: "recovery_manifest_signature_invalid",
    });
  });
});

describe("recovery file helpers", () => {
  it("names the manifest file after the artifact reference, never a path", () => {
    const name = recoveryManifestFileName("abc123def456");
    expect(name).toBe("abc123def456.manifest.json");
    expect(name).not.toContain("/");
  });

  it("round-trips through the serialized envelope", () => {
    const text = file();
    const parsed = JSON.parse(text) as { manifest: BackupManifest;
      manifestVersion: number;
      kind: string };
    expect(parsed.kind).toBe("biza-miz-backup-manifest");
    expect(parsed.manifestVersion).toBe(parsed.manifest.manifestVersion);
    expect(text.endsWith("\n")).toBe(true);
  });

  it("offers file import on the managed profiles only", () => {
    expect(recoveryImportAvailable("cloud")).toBe(true);
    expect(recoveryImportAvailable("hybrid")).toBe(true);
    // A Local install restores its own physical dump through the #807 path.
    expect(recoveryImportAvailable("local")).toBe(false);
  });

  it("fails closed on an unknown internal error", () => {
    expect(mapImportError("ENOENT: /var/lib/secret/path")).toBe("recovery_import_failed");
    for (const code of IMPORT_REFUSALS) expect(mapImportError(code)).toBe(code);
  });
});
