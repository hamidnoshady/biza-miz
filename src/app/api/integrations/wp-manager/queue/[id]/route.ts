import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getConnection } from "@/lib/integrations/connections-service";
import { wpQueueRowDetail } from "@/lib/integrations/wp-manager-service";

/**
 * One queue row's diagnostics, fetched lazily when an operator opens the
 * inspector (issue #942, F13). The list endpoint returns metadata only;
 * this is the one place a payload crosses the wire — behind the stricter
 * sync permission (not mere view), tenant-scoped, and redacted/bounded by
 * `wpQueueRowDetail` (credentials removed, contact data masked).
 */
export const GET = withTenantScope(async (request: Request, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.woocommerceSync);
  if (error) return error;

  const { id } = await context.params;
  const url = new URL(request.url);
  const connectionId = url.searchParams.get("connectionId");
  if (!connectionId) return NextResponse.json({ error: "missing_connection" }, { status: 400 });

  const connection = await getConnection(session.businessId, connectionId);
  if (!connection || connection.provider !== "woocommerce") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const directionParam = url.searchParams.get("direction");
  const direction = directionParam === "out" || directionParam === "in" ? directionParam : undefined;
  const row = await wpQueueRowDetail(session.businessId, connectionId, id, direction);
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ row });
});
