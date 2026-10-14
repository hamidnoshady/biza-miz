import { describe, expect, it } from "vitest";
import {
  admitTenantArtifact,
  backupArchitectureFor,
  logicalSnapshotScopeTag,
  PHYSICAL_TENANT_BACKUP_FORBIDDEN,
  PHYSICAL_TENANT_RESTORE_FORBIDDEN,
  PLATFORM_BACKUP_FORBIDDEN_ON_SITE,
  platformPhysicalBackupAllowed,
  tenantPhysicalDumpAllowed,
  tenantPhysicalRestoreAllowed,
} from "./backup-policy";

/**
 * Issue #807 — the invariant that a central deployment never runs a tenant's
 * physical whole-database dump. The schedulers, services and routes all ask
 * this module, so these are the assertions that keep the audit's critical
 * finding from coming back.
 */
describe("the deployment-role backup architecture", () => {
  it("never lets central take, restore or admit a physical tenant dump", () => {
    expect(tenantPhysicalDumpAllowed("central")).toBe(false);
    expect(tenantPhysicalRestoreAllowed("central")).toBe(false);
    expect(backupArchitectureFor("central").tenantBackup).toBe("logical");
    expect(backupArchitectureFor("central").siteBackupWorker).toBe(false);
    expect(backupArchitectureFor("central").tenantSnapshotWorker).toBe(true);
  });

  it("keeps the site install's physical behaviour exactly as it was", () => {
    expect(tenantPhysicalDumpAllowed("site")).toBe(true);
    expect(tenantPhysicalRestoreAllowed("site")).toBe(true);
    expect(backupArchitectureFor("site").tenantBackup).toBe("physical");
    expect(backupArchitectureFor("site").siteBackupWorker).toBe(true);
    expect(backupArchitectureFor("site").tenantSnapshotWorker).toBe(false);
  });

  it("runs the whole-platform physical subsystem on central only", () => {
    expect(platformPhysicalBackupAllowed("central")).toBe(true);
    expect(platformPhysicalBackupAllowed("site")).toBe(false);
    expect(backupArchitectureFor("central").platformBackupScheduler).toBe(true);
    expect(backupArchitectureFor("site").platformBackupScheduler).toBe(false);
  });
});

describe("tenant artifact admission", () => {
  const businessId = "0b6e5a2c-1111-4222-8333-444455556666";
  const scope = logicalSnapshotScopeTag(businessId);

  it("refuses a physical .dump on central, encrypted or not", () => {
    const plain = admitTenantArtifact("central", businessId, "pos-backup-20260101-000000.dump", scope);
    expect(plain.ok).toBe(false);
    expect(plain.ok ? "" : plain.error).toBe(PHYSICAL_TENANT_BACKUP_FORBIDDEN);

    const enc = admitTenantArtifact(
      "central",
      businessId,
      "pos-backup-20260101-000000-abcdef01.dump.enc",
      scope,
    );
    expect(enc.ok).toBe(false);
  });

  it("admits a logical .sql only when its scope tag is the business's own", () => {
    const mine = admitTenantArtifact(
      "central",
      businessId,
      `pos-backup-${scope}-20260101-000000-abcdef01.sql`,
      scope,
    );
    expect(mine).toEqual({ ok: true, mode: "logical" });
    // The same name carrying another scope is refused — "it is a .sql" is not
    // the property that matters, "it is this tenant's" is.
    const theirs = admitTenantArtifact(
      "central",
      businessId,
      "pos-backup-9999999999999999-20260101-000000-abcdef01.sql",
      "9999999999999999",
    );
    expect(theirs.ok).toBe(false);
    expect(theirs.ok ? "" : theirs.error).toBe("artifact_scope_mismatch");
  });

  it("admits a site's own physical artifact and refuses unrecognised names", () => {
    const physical = admitTenantArtifact("site", businessId, "pos-backup-20260101-000000.dump", scope);
    expect(physical).toEqual({ ok: true, mode: "physical" });
    const weird = admitTenantArtifact("site", businessId, "notes.sql", scope);
    expect(weird.ok).toBe(false);
    expect(weird.ok ? "" : weird.error).toBe("unrecognized_artifact");
  });

  it("derives the scope tag from the business id alone, so it cannot be relabelled", () => {
    expect(logicalSnapshotScopeTag(businessId)).toBe("0b6e5a2c11114222");
    expect(logicalSnapshotScopeTag("A/B c!")).toBe("abc");
    expect(logicalSnapshotScopeTag("---")).toBe("default");
  });

  it("names the platform refusal on a site", () => {
    expect(PLATFORM_BACKUP_FORBIDDEN_ON_SITE).toBe("platform_backup_not_available_on_site");
    expect(PHYSICAL_TENANT_RESTORE_FORBIDDEN).toBe("physical_tenant_restore_forbidden_on_central");
  });
});
