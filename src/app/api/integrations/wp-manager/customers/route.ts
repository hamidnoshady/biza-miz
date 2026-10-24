import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getAccessibleConnection } from "@/lib/integrations/connection-access";
import { wpCustomersStatusFilter, wpStoreCustomers } from "@/lib/integrations/wp-manager-service";

/**
 * The customers mirrored from one store, joined to their local CRM record.
 *
 * The page/pageSize the response echoes are the *resolved* ones — the service
 * counts first and clamps an out-of-range page onto the last page that has
 * rows — so a client that asked for page 13 of a 2-page result is told which
 * page it actually got (`page`) and that it was moved (`clamped`), instead of
 * being handed an empty list next to a total of zero.
 */
export const GET = withTenantScope(async (request: Request) => {
  const { session, error } = await requirePermission(PERMISSIONS.woocommerceView);
  if (error) return error;

  const url = new URL(request.url);
  const connectionId = url.searchParams.get("connectionId");
  if (!connectionId) return NextResponse.json({ error: "missing_connection" }, { status: 400 });
  const page = Number.parseInt(url.searchParams.get("page") ?? "1", 10);
  const pageSize = Number.parseInt(url.searchParams.get("pageSize") ?? "25", 10);
  const search = (url.searchParams.get("search") ?? "").trim().slice(0, 200);
  const connection = await getAccessibleConnection(session, connectionId);
  if (!connection || connection.provider !== "woocommerce") return NextResponse.json({ error: "not_found" }, { status: 404 });

  // An unknown status is not an error worth a 400 — it narrows to "no
  // filter", the same forgiving read the page/pageSize params get.
  const status = wpCustomersStatusFilter(url.searchParams.get("status") ?? undefined);

  const result = await wpStoreCustomers(session.businessId, connectionId, { page, pageSize, search, status });
  return NextResponse.json({
    customers: result.customers,
    total: result.total,
    page: result.page,
    pageSize: result.pageSize,
    totalPages: result.totalPages,
    clamped: result.clamped,
  });
});
