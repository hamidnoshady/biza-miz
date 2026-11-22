import { NextRequest, NextResponse } from "next/server";

import { requirePermission, withTenantScope } from "@/lib/auth";
import { listExternalMcpCalls } from "@/lib/mcp/outbound/service";
import { PERMISSIONS } from "@/lib/permissions";

/**
 * Recent external tool calls for one server (issue #1473).
 *
 * The rows carry no arguments and no result — the audit table is not a copy of
 * what a CMS returned — so this endpoint is safe to show beside the server in the
 * panel. `integrations.view` is enough: it is a history of outcomes, not a
 * credential or a document.
 */
export const GET = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.integrationsView);
  if (error) return error;

  const { id } = await context.params;
  const limit = Number.parseInt(new URL(request.url).searchParams.get("limit") ?? "", 10);

  return NextResponse.json({
    calls: await listExternalMcpCalls(session.businessId, {
      limit: Number.isFinite(limit) ? limit : undefined,
      serverId: id,
    }),
  });
});
