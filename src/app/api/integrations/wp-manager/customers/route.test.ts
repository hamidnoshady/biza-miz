import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { PERMISSIONS } from "@/lib/permissions";
import * as auth from "@/lib/auth";
import * as connectionsService from "@/lib/integrations/connections-service";
import * as managerService from "@/lib/integrations/wp-manager-service";
import { GET } from "./route";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requirePermission: vi.fn(),
    withTenantScope: (handler: (...args: unknown[]) => Promise<NextResponse>) => handler,
  };
});

vi.mock("@/lib/integrations/connections-service", () => ({ getConnection: vi.fn() }));
vi.mock("@/lib/integrations/wp-manager-service", () => ({
  wpStoreCustomers: vi.fn(),
  wpCustomerSyncStatus: vi.fn(),
}));

const BUSINESS_ID = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
const CONNECTION_ID = "c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a13";
const SESSION = { businessId: BUSINESS_ID, sub: "b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12" };
const CONNECTION = { id: CONNECTION_ID, business_id: BUSINESS_ID, provider: "woocommerce" };
const PAGE = {
  customers: [],
  total: 0,
  page: 1,
  pageSize: 25,
  totalPages: 1,
  clamped: false,
};

function request() {
  return new Request(`http://localhost/api/integrations/wp-manager/customers?connectionId=${CONNECTION_ID}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({
    session: SESSION,
    membership: { permissions: new Set([PERMISSIONS.woocommerceView]) },
    error: null,
  } as never);
  vi.mocked(connectionsService.getConnection).mockResolvedValue(CONNECTION as never);
  vi.mocked(managerService.wpStoreCustomers).mockResolvedValue(PAGE as never);
  vi.mocked(managerService.wpCustomerSyncStatus).mockResolvedValue(null);
});

describe("GET /api/integrations/wp-manager/customers", () => {
  it("omits CRM and order details unless the session has their distinct view permissions", async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(managerService.wpStoreCustomers).toHaveBeenCalledWith(BUSINESS_ID, CONNECTION_ID, expect.objectContaining({
      accountType: "all",
      identityFilter: "all",
      remoteFilter: "active",
      sort: "name",
      includePartyDetails: false,
      includeIdentityDetails: false,
      includeOrderCounts: false,
    }));
    expect(managerService.wpCustomerSyncStatus).toHaveBeenCalledWith(BUSINESS_ID, CONNECTION_ID);
    await expect(response.json()).resolves.toMatchObject({
      syncStatus: null,
      permissions: {
        canViewCustomerFile: false,
        canViewIdentityStatus: false,
        canResolveIdentities: false,
        canSyncCustomers: false,
        canViewOrderCounts: false,
      },
    });
  });

  it("forwards validated account, identity, remote-status and sort filters to the whole-store query", async () => {
    vi.mocked(auth.requirePermission).mockResolvedValueOnce({
      session: SESSION,
      membership: { permissions: new Set([PERMISSIONS.woocommerceView, PERMISSIONS.crmView]) },
      error: null,
    } as never);
    const filtered = new Request(
      `http://localhost/api/integrations/wp-manager/customers?connectionId=${CONNECTION_ID}&accountType=guest&identity=conflict&remote=deleted&sort=last_synced&search=guest`,
    );
    const response = await GET(filtered);
    expect(response.status).toBe(200);
    expect(managerService.wpStoreCustomers).toHaveBeenCalledWith(BUSINESS_ID, CONNECTION_ID, expect.objectContaining({
      accountType: "guest",
      identityFilter: "conflict",
      remoteFilter: "deleted",
      sort: "last_synced",
      includeIdentityDetails: true,
      search: "guest",
    }));
  });

  it("accepts the all remote-status filter", async () => {
    const allRemoteStatuses = new Request(
      `http://localhost/api/integrations/wp-manager/customers?connectionId=${CONNECTION_ID}&remote=all`,
    );
    const response = await GET(allRemoteStatuses);
    expect(response.status).toBe(200);
    expect(managerService.wpStoreCustomers).toHaveBeenCalledWith(BUSINESS_ID, CONNECTION_ID, expect.objectContaining({
      remoteFilter: "all",
    }));
  });

  it("does not let a Woo-only role infer CRM identity or order-history details through filters", async () => {
    const restricted = new Request(
      `http://localhost/api/integrations/wp-manager/customers?connectionId=${CONNECTION_ID}&identity=conflict&sort=orders`,
    );
    const response = await GET(restricted);
    expect(response.status).toBe(200);
    expect(managerService.wpStoreCustomers).toHaveBeenCalledWith(BUSINESS_ID, CONNECTION_ID, expect.objectContaining({
      identityFilter: "all",
      includeIdentityDetails: false,
      includeOrderCounts: false,
      sort: "name",
    }));
  });

  it("derives each data/action affordance from its own CRM and order permission", async () => {
    vi.mocked(auth.requirePermission).mockResolvedValueOnce({
      session: SESSION,
      membership: {
        permissions: new Set([
          PERMISSIONS.woocommerceView,
          PERMISSIONS.crmView,
          PERMISSIONS.partiesView,
          PERMISSIONS.crmMerge,
          PERMISSIONS.crmManage,
          PERMISSIONS.ordersView,
          PERMISSIONS.woocommerceSync,
        ]),
      },
      error: null,
    } as never);

    const response = await GET(request());
    expect(managerService.wpStoreCustomers).toHaveBeenCalledWith(BUSINESS_ID, CONNECTION_ID, expect.objectContaining({
      accountType: "all",
      identityFilter: "all",
      remoteFilter: "active",
      sort: "name",
      includePartyDetails: true,
      includeIdentityDetails: true,
      includeOrderCounts: true,
    }));
    await expect(response.json()).resolves.toMatchObject({
      permissions: {
        canViewCustomerFile: true,
        canViewIdentityStatus: true,
        canResolveIdentities: true,
        canSyncCustomers: true,
        canViewOrderCounts: true,
      },
    });
  });

  it("enforces Woo view permission on direct reads", async () => {
    const denied = NextResponse.json({ error: "forbidden" }, { status: 403 });
    vi.mocked(auth.requirePermission).mockResolvedValueOnce({ session: null, error: denied } as never);
    const response = await GET(request());
    expect(response.status).toBe(403);
    expect(connectionsService.getConnection).not.toHaveBeenCalled();
  });
});
