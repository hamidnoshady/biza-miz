import { createHash } from "node:crypto";

/** Opaque lookup reference, not an authorization grant. Always re-resolve in owned inventory. */
export function tenantBackupArtifactRef(businessId: string, kind: "local" | "cloud", key: string): string {
  return createHash("sha256").update(JSON.stringify(["tenant-backup-v1", businessId, kind, key])).digest("hex");
}

/** Fail closed rather than reflect provider, process or database error messages. */
export function tenantRestoreError(error: string): string {
  const safe = new Set([
    "restore_busy", "restore_not_available", "artifact_not_found", "passphrase_required",
    "upload_not_found", "artifact_is_logical_snapshot", "physical_tenant_restore_forbidden_on_central",
  ]);
  return safe.has(error) ? error : "backup_operation_failed";
}
