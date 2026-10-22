import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getAccessibleConnection, listAccessibleConnections } from "@/lib/integrations/connection-access";
import { wpOverviewStats } from "@/lib/integrations/wp-manager-service";

/**
 * The WP Manager میز کار counts: connections, mirrored catalogue/orders/
 * customers/terms/content, and the operational queue. Only connections covered
 * by the caller’s live branch grant contribute, including the aggregate view.
 */
export const GET = withTenantScope(async (request: Request) => {
  const { session, error } = await requirePermission(PERMISSIONS.woocommerceView);
  if (error) return error;

  const connectionId = new URL(request.url).searchParams.get("connectionId");
  if (connectionId) {
    const connection = await getAccessibleConnection(session, connectionId);
    if (!connection || connection.provider !== "woocommerce") {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
  }
  const connectionIds = connectionId ? [connectionId] : (await listAccessibleConnections(session))
    .filter((connection) => connection.provider === "woocommerce")
    .map((connection) => connection.id);
  const stats = await wpOverviewStats(session.businessId, connectionIds);
  return NextResponse.json({ stats });
});
