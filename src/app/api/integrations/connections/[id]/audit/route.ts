import { canReadConnectionHistory } from "@/lib/integrations/connection-access";
import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { listIntegrationAudit } from "@/lib/integrations/audit";

export const GET = withTenantScope(async (_request: Request, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.integrationsView);
  if (error) return error;
  const { id } = await context.params;
  if (!(await canReadConnectionHistory(session, id))) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const entries = await listIntegrationAudit(session.businessId, id);
  return NextResponse.json({ entries });
});
