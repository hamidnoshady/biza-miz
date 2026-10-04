/**
 * Issue #807 — the deployment-role boundary for every backup and restore path.
 *
 * The audit found the tenant backup pipeline running a privileged whole-database
 * `pg_dump` on a **central** deployment, where one physical dump necessarily
 * contains every tenant. The fix is architectural, and this module is where the
 * architecture is stated once, purely, so it can be unit-tested and so the
 * schedulers, services, routes and CLI can all ask the same question:
 *
 * ```text
 * central   tenant   → logical tenant-only snapshot (RLS-scoped export), never pg_dump
 *           platform → the one whole-database physical subsystem (super-admin)
 * site      tenant   → physical local pg_dump (desktop/laptop: the DB *is* one tenant)
 *           platform → not applicable (the console is not served there)
 * ```
 *
 * Nothing here reads the database, environment or filesystem: the caller passes
 * the role it already resolved (`deployment-role.ts`). That keeps the invariant
 * unit-testable and keeps a security boundary from depending on request data,
 * UI state, feature flags or business configuration — the issue's explicit
 * requirement.
 */

import { parseArtifactName } from "./backup";
import type { DeploymentRole } from "./deployment-role";

export type TenantBackupMode = "physical" | "logical";

export type TenantRestoreMode = "physical" | "none";

export interface BackupArchitecture {
  /** How this deployment backs a tenant up. */
  tenantBackup: TenantBackupMode;
  /** Whether a tenant physical `pg_dump` may ever run here. */
  tenantPhysicalDump: boolean;
  /** Whether a whole-database tenant restore (drop + recreate) may run here. */
  tenantPhysicalRestore: boolean;
  /** Whether the super-admin whole-platform physical subsystem runs here at all. */
  platformPhysicalBackup: boolean;
  /** Whether the *scheduled* platform whole-system worker runs here. */
  platformBackupScheduler: boolean;
  /** Whether the site physical backup worker (tenant tick) runs here. */
  siteBackupWorker: boolean;
  /** Whether the central logical tenant snapshot worker runs here. */
  tenantSnapshotWorker: boolean;
}

const CENTRAL: BackupArchitecture = {
  tenantBackup: "logical",
  tenantPhysicalDump: false,
  tenantPhysicalRestore: false,
  platformPhysicalBackup: true,
  platformBackupScheduler: true,
  siteBackupWorker: false,
  tenantSnapshotWorker: true,
};

const SITE: BackupArchitecture = {
  tenantBackup: "physical",
  tenantPhysicalDump: true,
  tenantPhysicalRestore: true,
  platformPhysicalBackup: false,
  platformBackupScheduler: false,
  siteBackupWorker: true,
  tenantSnapshotWorker: false,
};

const ARCHITECTURE: Record<DeploymentRole, BackupArchitecture> = {
  central: CENTRAL,
  site: SITE,
};

export function backupArchitectureFor(role: DeploymentRole): BackupArchitecture {
  return ARCHITECTURE[role] ?? SITE;
}

/** The refusal code every caller surfaces verbatim, so the reason is greppable. */
export const PHYSICAL_TENANT_BACKUP_FORBIDDEN = "physical_tenant_backup_forbidden_on_central";
export const PHYSICAL_TENANT_RESTORE_FORBIDDEN = "physical_tenant_restore_forbidden_on_central";
export const PLATFORM_BACKUP_FORBIDDEN_ON_SITE = "platform_backup_not_available_on_site";

/**
 * May a privileged whole-database `pg_dump` be taken *for a tenant* on this
 * deployment? Central: never. This is the single predicate the dump path, the
 * cloud upload guard and the API gate all consult.
 */
export function tenantPhysicalDumpAllowed(role: DeploymentRole): boolean {
  return backupArchitectureFor(role).tenantPhysicalDump;
}

/** May a tenant-facing restore drop and recreate this deployment's database? Central: never. */
export function tenantPhysicalRestoreAllowed(role: DeploymentRole): boolean {
  return backupArchitectureFor(role).tenantPhysicalRestore;
}

/** Whether the whole-platform physical subsystem may run here (super-admin only, central). */
export function platformPhysicalBackupAllowed(role: DeploymentRole): boolean {
  return backupArchitectureFor(role).platformPhysicalBackup;
}

/**
 * The invariant a tenant artifact must satisfy *before* it is written, uploaded
 * or restored: on central the name must be a logical (`.sql`) snapshot for the
 * requested business, never a `.dump`, and site artifacts must stay in their own
 * scope.
 */
export type ArtifactAdmission =
  | { ok: true; mode: TenantBackupMode }
  | { ok: false; error: string };

export function admitTenantArtifact(
  role: DeploymentRole,
  businessId: string,
  artifactName: string,
  scopeTag: string,
): ArtifactAdmission {
  const architecture = backupArchitectureFor(role);
  // The full artifact grammar, not just the extension: a file called
  // `notes.sql` is not one of ours and must not be uploadable as if it were.
  const parsed = parseArtifactName(artifactName);
  if (!parsed) return { ok: false, error: "unrecognized_artifact" };
  if (parsed.format === "dump") {
    if (!architecture.tenantPhysicalDump) {
      return { ok: false, error: PHYSICAL_TENANT_BACKUP_FORBIDDEN };
    }
    // A site's own dump is still *scoped* to the one business this install
    // holds, so the name must agree with the business it is uploaded for.
    if (parsed.scope !== null && parsed.scope !== artifactScopeTagForBusiness(businessId)) {
      return { ok: false, error: "artifact_scope_mismatch" };
    }
    return { ok: true, mode: "physical" };
  }
  if (!isLogicalSnapshotScopeMatches(businessId, scopeTag)) {
    // A logical snapshot must be namespaced to the business it belongs to.
    return { ok: false, error: "artifact_scope_mismatch" };
  }
  return { ok: true, mode: "logical" };
}

/** The scope tag this module compares against, spelled once. */
function artifactScopeTagForBusiness(businessId: string): string {
  return logicalSnapshotScopeTag(businessId);
}

/**
 * The scope tag a logical snapshot for this business must carry. Deliberately
 * derived from the business id alone so a snapshot cannot be relabelled: the
 * artifact name and the business it may be restored to are the same fact.
 */
export function logicalSnapshotScopeTag(businessId: string): string {
  return businessId.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 16) || "default";
}

function isLogicalSnapshotScopeMatches(businessId: string, scopeTag: string): boolean {
  const expected = logicalSnapshotScopeTag(businessId);
  return scopeTag.toLowerCase() === expected;
}
