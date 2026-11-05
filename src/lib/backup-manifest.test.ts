import { describe, expect, it } from "vitest";
import {
  BACKUP_MANIFEST_VERSION,
  buildBackupManifest,
  canonicalManifestJson,
  manifestCompleteness,
  manifestMatchesBusiness,
  manifestRestorability,
  manifestSigningKey,
  signBackupManifest,
  validateBackupManifest,
  verifyBackupManifestSignature,
  type BackupManifest,
} from "./backup-manifest";

const BUSINESS = "0b6f3d9b-8bfa-4f7e-9b93-6a1d3c2f4a10";
const OTHER = "aa11bb22-cc33-dd44-ee55-ff6677889900";
const SHA = "a".repeat(64);
const KEY = Buffer.alloc(32, 7);

function manifest(overrides: Partial<Parameters<typeof buildBackupManifest>[0]> = {}): BackupManifest {
  return buildBackupManifest({
    artifactId: "artifact-1",
    businessId: BUSINESS,
    format: "logical_snapshot",
    origin: "scheduled",
    capturedAt: new Date("2026-10-20T03:30:00Z"),
    schemaVersion: 263,
    appVersion: "1.0.113",
    encryption: { scheme: "managed_envelope_v1", keyVersion: 2 },
    sizeBytes: 4096,
    sha256: SHA,
    components: [
      { key: "accounting.core", state: "included", rows: 1200 },
      { key: "crm.core", state: "included", rows: 30 },
      { key: "external.woocommerce", state: "external" },
    ],
    ...overrides,
  });
}

describe("buildBackupManifest / validateBackupManifest", () => {
  it("builds a signed-ready manifest bound to its business scope tag", () => {
    const built = manifest();
    expect(built.manifestVersion).toBe(BACKUP_MANIFEST_VERSION);
    expect(built.scope).toEqual({
      kind: "logical",
      businessTag: BUSINESS.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 16),
    });
    expect(validateBackupManifest(built)).toEqual({ ok: true, manifest: built });
  });

  it("labels a physical artifact as physical scope and refuses a mismatched kind", () => {
    const physical = manifest({ format: "physical_dump", origin: "manual" });
    expect(physical.scope.kind).toBe("physical");
    const tampered = { ...physical, scope: { kind: "logical", businessTag: physical.scope.businessTag } };
    expect(validateBackupManifest(tampered)).toEqual({ ok: false, error: "manifest_scope_mismatch" });
  });

  it("rejects a manifest whose scope tag was relabelled for another business", () => {
    const built = manifest();
    const moved = { ...built, businessId: OTHER };
    expect(validateBackupManifest(moved)).toEqual({ ok: false, error: "manifest_scope_mismatch" });
  });

  it("rejects unknown fields instead of ignoring them", () => {
    expect(validateBackupManifest({ ...manifest(), restoreEverything: true })).toEqual({
      ok: false,
      error: "manifest_unknown_field",
    });
  });

  it("rejects a newer manifest version and unknown components", () => {
    expect(validateBackupManifest({ ...manifest(), manifestVersion: 99 })).toEqual({
      ok: false,
      error: "manifest_version_too_new",
    });
    const badComponent = structuredClone(manifest());
    badComponent.components.push({ key: "not.a.component" as never, state: "included", bytes: null, rows: null });
    expect(validateBackupManifest(badComponent)).toEqual({ ok: false, error: "manifest_component_unknown" });
  });

  it("rejects a malformed checksum, duplicate components and a legacy key version", () => {
    expect(validateBackupManifest({ ...manifest(), payload: { sizeBytes: 1, sha256: "abc" } })).toEqual({
      ok: false,
      error: "manifest_checksum_invalid",
    });
    const duplicate = structuredClone(manifest());
    duplicate.components.push({ key: "accounting.core", state: "included", bytes: null, rows: null });
    expect(validateBackupManifest(duplicate)).toEqual({ ok: false, error: "manifest_component_duplicate" });
    expect(
      validateBackupManifest({
        ...manifest(),
        encryption: { scheme: "legacy_passphrase_v1", keyVersion: 3 },
      }),
    ).toEqual({ ok: false, error: "manifest_key_version_invalid" });
  });
});

describe("signatures", () => {
  it("verifies its own signature and rejects a different key", () => {
    const built = manifest();
    const signature = signBackupManifest(built, KEY);
    expect(verifyBackupManifestSignature(built, signature, KEY)).toBe(true);
    expect(verifyBackupManifestSignature(built, signature, Buffer.alloc(32, 9))).toBe(false);
    expect(verifyBackupManifestSignature(built, "not-hex", KEY)).toBe(false);
  });

  it("rejects an edited payload or component list", () => {
    const built = manifest();
    const signature = signBackupManifest(built, KEY);
    const edited = structuredClone(built);
    edited.components[0].rows = 99_999;
    expect(verifyBackupManifestSignature(edited, signature, KEY)).toBe(false);
    const resized = structuredClone(built);
    resized.payload.sizeBytes += 1;
    expect(verifyBackupManifestSignature(resized, signature, KEY)).toBe(false);
  });

  it("canonicalises key order so a re-serialised manifest still verifies", () => {
    const built = manifest();
    const reverseKeys = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(reverseKeys);
      if (value && typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(value).sort().reverse()) {
          out[key] = reverseKeys((value as Record<string, unknown>)[key]);
        }
        return out;
      }
      return value;
    };
    const reordered = reverseKeys(built) as BackupManifest;
    expect(Object.keys(reordered)).not.toEqual(Object.keys(built));
    expect(canonicalManifestJson(reordered)).toBe(canonicalManifestJson(built));
    expect(verifyBackupManifestSignature(reordered, signBackupManifest(built, KEY), KEY)).toBe(true);
  });

  it("derives a purpose-bound signing key distinct from the raw master key", () => {
    expect(manifestSigningKey(KEY).equals(KEY)).toBe(false);
    expect(manifestSigningKey(KEY).length).toBe(32);
  });
});

describe("completeness and restorability", () => {
  it("reports complete only when every component was captured", () => {
    const complete = manifest({
      components: [{ key: "accounting.core", state: "included", rows: 10 }],
    });
    expect(manifestCompleteness(complete)).toMatchObject({ status: "complete", included: ["accounting.core"] });

    const partial = manifestCompleteness(manifest());
    expect(partial.status).toBe("partial");
    expect(partial.external).toEqual(["external.woocommerce"]);
  });

  it("matches only the owning business", () => {
    const built = manifest();
    expect(manifestMatchesBusiness(built, BUSINESS)).toBe(true);
    expect(manifestMatchesBusiness(built, OTHER)).toBe(false);
  });

  it("refuses a physical tenant restore on central", () => {
    const physical = manifest({ format: "physical_dump" });
    expect(
      manifestRestorability(physical, { businessId: BUSINESS, currentSchemaVersion: 300, allowPhysical: false }),
    ).toEqual({ ok: false, error: "physical_tenant_restore_forbidden_on_central" });
    expect(
      manifestRestorability(physical, { businessId: BUSINESS, currentSchemaVersion: 300, allowPhysical: true }),
    ).toEqual({ ok: true, mode: "physical" });
  });

  it("refuses a payload written by a newer schema and a foreign artifact", () => {
    const built = manifest({ schemaVersion: 300 });
    expect(
      manifestRestorability(built, { businessId: BUSINESS, currentSchemaVersion: 263, allowPhysical: false }),
    ).toEqual({ ok: false, error: "artifact_schema_newer_than_installation" });
    expect(
      manifestRestorability(built, { businessId: OTHER, currentSchemaVersion: 400, allowPhysical: false }),
    ).toEqual({ ok: false, error: "artifact_not_owned_by_business" });
  });

  it("accepts a logical snapshot for the owning business", () => {
    expect(
      manifestRestorability(manifest(), {
        businessId: BUSINESS,
        currentSchemaVersion: 263,
        allowPhysical: false,
      }),
    ).toEqual({ ok: true, mode: "logical" });
  });
});
