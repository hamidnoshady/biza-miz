import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { canViewCrmSection } from "@/lib/crm-permissions";
import { getConnection } from "@/lib/integrations/connections-service";
import {
  wpCustomerSyncStatus,
  wpStoreCustomers,
  type WpStoreCustomerAccountType,
  type WpStoreCustomerIdentityFilter,
  type WpStoreCustomerRemoteFilter,
  type WpStoreCustomerSort,
} from "@/lib/integrations/wp-manager-service";

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
  const { session, membership, error } = await requirePermission(PERMISSIONS.woocommerceView);
  if (error) return error;

  const url = new URL(request.url);
  const connectionId = url.searchParams.get("connectionId");
  if (!connectionId) return NextResponse.json({ error: "missing_connection" }, { status: 400 });
  const page = Number.parseInt(url.searchParams.get("page") ?? "1", 10);
  const pageSize = Number.parseInt(url.searchParams.get("pageSize") ?? "25", 10);
  const search = (url.searchParams.get("search") ?? "").trim().slice(0, 200);
  const accountTypeValues: WpStoreCustomerAccountType[] = ["registered", "guest", "subscriber"];
  const identityValues: WpStoreCustomerIdentityFilter[] = ["linked", "unlinked", "needs_review", "conflict", "ignored"];
  const remoteValues: WpStoreCustomerRemoteFilter[] = ["active", "deleted", "all"];
  const sortValues: WpStoreCustomerSort[] = ["name", "last_synced", "orders"];
  const requestedAccountType = url.searchParams.get("accountType");
  const accountType: WpStoreCustomerAccountType | "all" =
    requestedAccountType && accountTypeValues.includes(requestedAccountType as WpStoreCustomerAccountType)
      ? requestedAccountType as WpStoreCustomerAccountType
      : "all";
  const requestedIdentity = url.searchParams.get("identity");
  const identityFilter: WpStoreCustomerIdentityFilter =
    requestedIdentity && identityValues.includes(requestedIdentity as WpStoreCustomerIdentityFilter)
      ? requestedIdentity as WpStoreCustomerIdentityFilter
      : "all";
  const requestedRemote = url.searchParams.get("remote");
  const remoteFilter: WpStoreCustomerRemoteFilter =
    requestedRemote && remoteValues.includes(requestedRemote as WpStoreCustomerRemoteFilter)
      ? requestedRemote as WpStoreCustomerRemoteFilter
      : "active";
  const requestedSort = url.searchParams.get("sort");
  const sort: WpStoreCustomerSort =
    requestedSort && sortValues.includes(requestedSort as WpStoreCustomerSort)
      ? requestedSort as WpStoreCustomerSort
      : "name";
  const connection = await getConnection(session.businessId, connectionId);
  if (!connection || connection.provider !== "woocommerce") return NextResponse.json({ error: "not_found" }, { status: 404 });

  const canViewCustomerFile = canViewCrmSection(membership.permissions, "persons");
  const canViewIdentityStatus = membership.permissions.has(PERMISSIONS.crmView);
  // Resolution POSTs require crm.manage; showing a review link to a read-only
  // reconciliation viewer would otherwise promise an action the API refuses.
  const canResolveIdentities = membership.permissions.has(PERMISSIONS.crmManage);
  const canSyncCustomers = membership.permissions.has(PERMISSIONS.woocommerceSync);
  const canViewOrderCounts = membership.permissions.has(PERMISSIONS.ordersView);
  const [result, syncStatus] = await Promise.all([
    wpStoreCustomers(session.businessId, connectionId, {
      page,
      pageSize,
      search,
      accountType,
      identityFilter: canViewIdentityStatus ? identityFilter : "all",
      remoteFilter,
      sort: !canViewOrderCounts && sort === "orders" ? "name" : sort,
      includePartyDetails: canViewCustomerFile,
      includeIdentityDetails: canViewIdentityStatus,
      includeOrderCounts: canViewOrderCounts,
    }),
    wpCustomerSyncStatus(session.businessId, connectionId),
  ]);
  return NextResponse.json({
    customers: result.customers,
    total: result.total,
    page: result.page,
    pageSize: result.pageSize,
    totalPages: result.totalPages,
    clamped: result.clamped,
    syncStatus,
    permissions: { canViewCustomerFile, canViewIdentityStatus, canResolveIdentities, canSyncCustomers, canViewOrderCounts },
  });
});
