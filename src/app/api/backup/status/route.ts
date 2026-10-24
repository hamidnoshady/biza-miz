import { tenantBackupError } from "@/lib/tenant-backup-contract";
import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getBackupHealth, listBackupRuns } from "@/lib/backup-service";

/** Backup health + recent run history for the dashboard. Owner/Manager. */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.backupManage);
  if (error) return error;

  const [health, runs] = await Promise.all([
    getBackupHealth(session.businessId),
    listBackupRuns(session.businessId),
  ]);
  return NextResponse.json({
    health: { ...health, localLastError: tenantBackupError(health.localLastError), cloudLastError: tenantBackupError(health.cloudLastError) },
    runs: runs.filter((run) => !health.localOnly || run.kind === "local").map((run) => ({
      id: run.id, kind: run.kind, trigger: run.trigger, status: run.status,
      scope: run.scope, sizeBytes: run.sizeBytes, startedAt: run.startedAt,
      error: tenantBackupError(run.error),
    })),
  }, { headers: { "Cache-Control": "no-store" } });
});
