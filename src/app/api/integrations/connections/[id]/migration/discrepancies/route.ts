import { getAccessibleConnection } from "@/lib/integrations/connection-access";
import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { isHoloo } from "@/lib/integrations/provider-registry";
import { buildMigrationDiscrepancyReport, type MigrationDiscrepancyManifest } from "@/lib/integrations/holoo/migration-discrepancy-service";

/** Build the Holoo-vs-app discrepancy report for a migration manifest. */
export const POST = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.integrationsManage);
  if (error) return error;
  const { id } = await context.params;
  const connection = await getAccessibleConnection(session, id);
  if (!connection || !isHoloo(connection)) return NextResponse.json({ error: "not_found" }, { status: 404 });

  let body: { manifest?: MigrationDiscrepancyManifest };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!body.manifest) return NextResponse.json({ error: "missing_manifest" }, { status: 400 });
  const report = await buildMigrationDiscrepancyReport(session.businessId, id, body.manifest);
  return NextResponse.json({ report });
});
