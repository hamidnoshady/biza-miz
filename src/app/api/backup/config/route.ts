import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { applyTenantBackupSettings, tenantBackupSettings } from "@/lib/tenant-backup-contract";
import { aliasedBackupDestination, getBackupConfig, setBackupConfig } from "@/lib/backup-service";
import { isLocalOnly } from "@/lib/deployment-mode";
import { deploymentRole } from "@/lib/deployment-role";

/** Site Owners manage local paths; central tenants remain schedule-only. */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.backupConfigure);
  if (error) return error;

  const siteInstall = deploymentRole() === "site";
  return NextResponse.json({
    config: tenantBackupSettings(await getBackupConfig(session.businessId), {
      includeSiteInfrastructure: siteInstall,
    }),
    siteInstall,
    desktop: siteInstall && Boolean(process.env.DESKTOP_INSTANCE_ID),
    // A local-only install has no cloud story: the client hides the whole
    // S3 section, and the PUT below refuses to enable it.
    localOnly: await isLocalOnly(session.businessId),
  }, { headers: { "Cache-Control": "no-store" } });
});

export const PUT = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.backupConfigure);
  if (error) return error;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const current = await getBackupConfig(session.businessId);
  const validated = applyTenantBackupSettings(current, body, {
    allowSiteInfrastructure: deploymentRole() === "site",
  });
  if (!validated.ok) {
    return NextResponse.json({ error: validated.error }, { status: 400 });
  }
  if (deploymentRole() === "site" && aliasedBackupDestination(validated.config)) {
    return NextResponse.json({ error: "backup_directories_must_differ" }, { status: 400 });
  }

  await setBackupConfig(session.businessId, validated.config);
  return NextResponse.json({ ok: true });
});
