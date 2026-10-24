import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { listConnections } from "@/lib/integrations/connections-service";

/**
 * `GET /api/integrations/wp-manager/connections` — the WooCommerce stores the
 * WordPress & WooCommerce manager can be pointed at.
 *
 * Issue #944 / OVR-01. The manager's shared store picker used to read the
 * technical hub's `GET /api/integrations/connections?provider=woocommerce`,
 * which asks for `integrations.view` — a key the manager's own pages do not
 * require. A member granted only `woocommerce.view` opened a legitimate page
 * and was told no store was connected. This route is the same secret-free
 * list, filtered to the one provider the manager handles, behind the same
 * key the pages stand behind. Tenant scope is the session's business, as
 * everywhere else.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.woocommerceView);
  if (error) return error;
  const connections = (await listConnections(session.businessId)).filter(
    (connection) => connection.provider === "woocommerce",
  );
  const response = NextResponse.json({ connections });
  response.headers.set("Cache-Control", "no-store");
  return response;
});
