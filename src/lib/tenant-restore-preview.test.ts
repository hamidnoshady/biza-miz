import { describe, expect, it } from "vitest";
import { buildBackupManifest, type BackupManifest } from "./backup-manifest";
import {
  guardTenantRestoreApply,
  previewTenantRestore,
  RESTORE_BLOCKER_LABELS,
  restoreConfirmationPhrase,
  type RestorePreviewInput,
} from "./tenant-restore-preview";

const BUSINESS = "0b6f3d9b-8bfa-4f7e-9b93-6a1d3c2f4a10";
const NOW = new Date("2026-10-28T12:00:00Z");

function manifest(overrides: Partial<Parameters<typeof buildBackupManifest>[0]> = {}): BackupManifest {
  return buildBackupManifest({
    artifactId: "artifact-1",
    businessId: BUSINESS,
    format: "logical_snapshot",
    origin: "scheduled",
    capturedAt: new Date("2026-10-27T03:30:00Z"),
    schemaVersion: 263,
    encryption: { scheme: "managed_envelope_v1", keyVersion: 1 },
    sizeBytes: 1_024,
    sha256: "b".repeat(64),
    components: [
      { key: "accounting.core", state: "included", rows: 4_000 },
      { key: "crm.core", state: "included", rows: 120 },
      { key: "growth.core", state: "included", rows: 0 },
      { key: "external.woocommerce", state: "external" },
    ],
    ...overrides,
  });
}

function input(overrides: Partial<RestorePreviewInput> = {}): RestorePreviewInput {
  return {
    businessId: BUSINESS,
    artifact: {
      ref: "ref-1",
      format: "logical_snapshot",
      origin: "scheduled",
      capturedAt: "2026-10-27T03:30:00Z",
      available: true,
      integrity: "verified",
      completeness: "complete",
      state: "ready",
      ownedByBusiness: true,
    },
    manifest: manifest(),
    manifestSignatureValid: true,
    deployment: { role: "central", profile: "cloud" },
    currentSchemaVersion: 263,
    currentCounts: {
      "accounting.core": 4_100,
      "crm.core": 90,
      "website.cms": 12,
    },
    actor: {
      canRestore: true,
      mfaSatisfied: true,
      reauthenticatedAt: "2026-10-28T11:55:00Z",
    },
    now: NOW,
    ...overrides,
  };
}

describe("previewTenantRestore", () => {
  it("describes a safe central logical restore without blocking it", () => {
    const preview = previewTenantRestore(input());
    expect(preview.canApply).toBe(true);
    expect(preview.blockers).toEqual([]);
    expect(preview.targetBusinessId).toBe(BUSINESS);
    expect(preview.lockKey).toBe(`tenant-restore:${BUSINESS}`);
    expect(preview.requiresCheckpoint).toBe(true);
    expect(preview.pausesTenantWrites).toBe(true);
    expect(preview.datasets.map((dataset) => dataset.component)).toEqual([
      "accounting.core",
      "crm.core",
      "growth.core",
    ]);
    expect(preview.datasets.find((dataset) => dataset.component === "growth.core")?.effect).toBe("create");
    expect(preview.datasets.find((dataset) => dataset.component === "crm.core")?.effect).toBe("replace");
    expect(preview.affectedRows).toBe(4_120);
    // A dataset the artifact does not contain is retained, not wiped.
    expect(preview.retained).toEqual([{ component: "website.cms", currentRows: 12 }]);
    expect(preview.missing).toEqual([{ component: "external.woocommerce", state: "external" }]);
    expect(preview.completeness).toBe("partial");
    // ~32.5 hours between the backup and "now".
    expect(preview.rpoHours).toBe(32.5);
    expect(preview.estimatedDowntimeMinutes).toBeGreaterThan(0);
    expect(preview.confirmationPhrase).toBe(restoreConfirmationPhrase(BUSINESS));
  });

  it("never previews a physical whole-database restore on central", () => {
    const physical = manifest({ format: "physical_dump" });
    const preview = previewTenantRestore(
      input({
        manifest: physical,
        artifact: { ...input().artifact, format: "physical_dump" },
      }),
    );
    expect(preview.canApply).toBe(false);
    expect(preview.blockers.map((blocker) => blocker.code)).toContain(
      "physical_tenant_restore_forbidden_on_central",
    );
    expect(preview.blockers[0].label).toBe(
      RESTORE_BLOCKER_LABELS.physical_tenant_restore_forbidden_on_central,
    );
  });

  it("blocks an unsigned, foreign, expired or unavailable artifact", () => {
    const unsigned = previewTenantRestore(input({ manifestSignatureValid: false }));
    expect(unsigned.blockers.map((blocker) => blocker.code)).toEqual(["artifact_signature_invalid"]);

    const foreign = previewTenantRestore(
      input({ artifact: { ...input().artifact, ownedByBusiness: false } }),
    );
    expect(foreign.blockers.map((blocker) => blocker.code)).toContain("artifact_not_owned_by_business");

    const expired = previewTenantRestore(input({ artifact: { ...input().artifact, state: "expired" } }));
    expect(expired.blockers.map((blocker) => blocker.code)).toContain("artifact_expired");

    const offline = previewTenantRestore(
      input({ artifact: { ...input().artifact, state: "unavailable_offline", available: false } }),
    );
    expect(offline.blockers.map((blocker) => blocker.code)).toContain("artifact_unavailable_offline");
  });

  it("blocks a missing manifest and a row/manifest disagreement", () => {
    const missing = previewTenantRestore(input({ manifest: null }));
    expect(missing.blockers.map((blocker) => blocker.code)).toEqual(["artifact_manifest_missing"]);
    expect(missing.datasets).toEqual([]);
    expect(missing.canApply).toBe(false);

    const disagreement = previewTenantRestore(
      input({ artifact: { ...input().artifact, format: "physical_dump" } }),
    );
    expect(disagreement.blockers.map((blocker) => blocker.code)).toContain("artifact_manifest_missing");
  });

  it("blocks a newer schema and an unverified upload", () => {
    const newer = previewTenantRestore(input({ currentSchemaVersion: 200 }));
    expect(newer.blockers.map((blocker) => blocker.code)).toContain(
      "artifact_schema_newer_than_installation",
    );

    const upload = previewTenantRestore(
      input({
        artifact: { ...input().artifact, origin: "uploaded", integrity: "unverified" },
      }),
    );
    expect(upload.blockers.map((blocker) => blocker.code)).toContain("artifact_unverified_upload");
  });

  it("requires permission, MFA, re-authentication and a free lock", () => {
    const preview = previewTenantRestore(
      input({
        actor: {
          canRestore: false,
          mfaSatisfied: false,
          reauthenticatedAt: null,
          restoreInProgress: true,
        },
      }),
    );
    expect(preview.blockers.map((blocker) => blocker.code).sort()).toEqual([
      "backup_restore_not_permitted",
      "mfa_required",
      "reauthentication_required",
      "restore_busy",
    ]);
  });

  it("reports every reason at once instead of only the first", () => {
    const preview = previewTenantRestore(
      input({
        manifestSignatureValid: false,
        actor: { canRestore: true, mfaSatisfied: false, reauthenticatedAt: null },
      }),
    );
    expect(preview.blockers.length).toBeGreaterThanOrEqual(3);
  });
});

describe("guardTenantRestoreApply", () => {
  const preview = previewTenantRestore(input());

  it("accepts a freshly authenticated Owner typing the exact phrase", () => {
    expect(
      guardTenantRestoreApply({
        preview,
        typedConfirmation: BUSINESS,
        minutesSinceReauthentication: 3,
      }),
    ).toEqual({ ok: true });
  });

  it("refuses a wrong phrase, a stale re-authentication and a missing platform approval", () => {
    expect(
      guardTenantRestoreApply({ preview, typedConfirmation: "yes", minutesSinceReauthentication: 3 }),
    ).toEqual({ ok: false, error: "confirmation_required" });

    expect(
      guardTenantRestoreApply({ preview, typedConfirmation: BUSINESS, minutesSinceReauthentication: 45 }),
    ).toEqual({ ok: false, error: "reauthentication_required" });

    expect(
      guardTenantRestoreApply({
        preview,
        typedConfirmation: BUSINESS,
        minutesSinceReauthentication: 1,
        appliesAsPlatformAdmin: true,
      }),
    ).toEqual({ ok: false, error: "backup_restore_not_permitted" });

    expect(
      guardTenantRestoreApply({
        preview,
        typedConfirmation: BUSINESS,
        minutesSinceReauthentication: 1,
        appliesAsPlatformAdmin: true,
        approvalRef: "approval-1",
      }),
    ).toEqual({ ok: true });
  });

  it("surfaces the preview's first blocker before any phrase check", () => {
    const blocked = previewTenantRestore(input({ manifestSignatureValid: false }));
    expect(
      guardTenantRestoreApply({
        preview: blocked,
        typedConfirmation: "whatever",
        minutesSinceReauthentication: 1,
      }),
    ).toEqual({ ok: false, error: "artifact_signature_invalid" });
  });
});
