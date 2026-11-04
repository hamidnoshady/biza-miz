import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { applyTenantBackupSettings, tenantBackupSettings } from "@/lib/tenant-backup-contract";
import { aliasedBackupDestination, getBackupConfig, setBackupConfig } from "@/lib/backup-service";
import { resolveTenantBackupPolicy } from "@/lib/tenant-backup-storage";
import { deploymentRole } from "@/lib/deployment-role";

/**
 * Issue #903 §3 (owner decision 2026-10-28) — onboarding writes the **on-device
 * defaults** for a single-business installation, and nothing else can.
 *
 * The always-available tenant route `PUT /api/backup/config` is gone: a business
 * user no longer manages backup creation, scheduling, retention or destinations.
 * What remains is the wizard step that runs once, on a site install, while the
 * device is being set up (§1 "Superadmin-defined policy and safe on-device
 * defaults"). It is deliberately *not* reachable on a central deployment, where
 * the fleet's managed policy is the only source of a schedule.
 *
 * Everything the wizard may persist is still the narrow, validated allow-list in
 * `tenant-backup-contract.ts`; infrastructure and cloud credentials stay
 * unrepresentable here.
 */
function refuseNonSite(): NextResponse | null {
  if (deploymentRole() === "site") return null;
  // A central install has no local backup destination to choose, and its
  // schedule comes from the managed service.
  return NextResponse.json({ error: "not_site_install" }, { status: 403 });
}

export const GET = withTenantScope(async () => {
  const denied = refuseNonSite();
  if (denied) return denied;
  const { session, error } = await requirePermission(PERMISSIONS.backupConfigure);
  if (error) return error;

  const [config, policy] = await Promise.all([
    getBackupConfig(session.businessId),
    resolveTenantBackupPolicy(session.businessId),
  ]);
  return NextResponse.json(
    {
      config: tenantBackupSettings(config, { includeSiteInfrastructure: true }),
      siteInstall: true,
      desktop: Boolean(process.env.DESKTOP_INSTANCE_ID),
      policy: {
        intervalHours: policy.intervalHours,
        retentionDays: policy.retentionDays,
        source: policy.source,
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
});

export const PUT = withTenantScope(async (request: NextRequest) => {
  const denied = refuseNonSite();
  if (denied) return denied;
  const { session, error } = await requirePermission(PERMISSIONS.backupConfigure);
  if (error) return error;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const current = await getBackupConfig(session.businessId);
  const validated = applyTenantBackupSettings(current, body, { allowSiteInfrastructure: true });
  if (!validated.ok) {
    return NextResponse.json({ error: validated.error }, { status: 400 });
  }
  if (aliasedBackupDestination(validated.config)) {
    return NextResponse.json({ error: "backup_directories_must_differ" }, { status: 400 });
  }

  await setBackupConfig(session.businessId, validated.config);
  return NextResponse.json({ ok: true });
});
