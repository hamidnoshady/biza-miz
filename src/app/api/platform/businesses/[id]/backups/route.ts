import { NextRequest, NextResponse } from "next/server";
import { platformAudit, requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import { getBusiness } from "@/lib/platform-service";
import { listBackupRuns } from "@/lib/backup-service";
import { readDeploymentProfile } from "@/lib/deployment-mode";
import { businessBackupSummary } from "@/lib/business-backup-summary";

/** Never use platform whole-system backup inventory for a business workspace. */
export const GET = withPlatformScope(async (_request: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePlatformCapability("tenant_backup.read");
  if (error) return error;
  const { id } = await ctx.params;
  if (!(await getBusiness(id))) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const [deployment, runs] = await Promise.all([readDeploymentProfile(id), listBackupRuns(id)]);
  await platformAudit({
    adminId: session.padmin, businessId: id,
    action: "tenant_backup.metadata_viewed", entity: "business", entityId: id,
    payload: { metadataOnly: true },
  });
  return NextResponse.json({ summary: businessBackupSummary(deployment.profile, runs) },
    { headers: { "Cache-Control": "no-store" } });
});
