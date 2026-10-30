import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { tenantBackupSettings } from "@/lib/tenant-backup-contract";
import { getBackupConfig } from "@/lib/backup-service";
import { resolveTenantBackupPolicy } from "@/lib/tenant-backup-storage";
import { isLocalOnly } from "@/lib/deployment-mode";
import { deploymentRole } from "@/lib/deployment-role";

/**
 * Issue #903 §3 (owner decision 2026-10-28) — **read-only**.
 *
 * This route used to accept a schedule/infrastructure mutation from a business
 * user. The epic supersedes that: Superadmin owns schedules, retention,
 * destinations, encryption and pricing, and the tenant surface is limited to
 * selecting a recovery point, downloading a backup and restoring. So the PUT is
 * removed rather than hidden, and what remains reports the policy actually in
 * force (the fleet's, or the device defaults where no fleet row is reachable).
 * A stale client that still sends a PUT now gets 405 from the framework — which
 * is the honest answer, not a silent no-op.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.backupConfigure);
  if (error) return error;

  const siteInstall = deploymentRole() === "site";
  const [config, policy] = await Promise.all([
    getBackupConfig(session.businessId),
    resolveTenantBackupPolicy(session.businessId),
  ]);
  return NextResponse.json(
    {
      config: tenantBackupSettings(config, { includeSiteInfrastructure: siteInstall }),
      siteInstall,
      desktop: siteInstall && Boolean(process.env.DESKTOP_INSTANCE_ID),
      // A local-only install has no cloud story at all.
      localOnly: await isLocalOnly(session.businessId),
      // Whether this caller may change any of the above: never, on the tenant
      // surface. The setup wizard has its own one-time endpoint.
      editable: false,
      policy: {
        intervalHours: policy.intervalHours,
        retentionDays: policy.retentionDays,
        source: policy.source,
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
});
