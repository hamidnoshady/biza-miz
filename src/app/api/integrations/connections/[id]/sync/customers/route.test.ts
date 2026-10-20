import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { PERMISSIONS } from "@/lib/permissions";
import * as auth from "@/lib/auth";
import * as connectionsService from "@/lib/integrations/connections-service";
import * as pluginService from "@/lib/integrations/plugin-service";
import * as syncService from "@/lib/integrations/sync-service";
import { POST } from "./route";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requirePermission: vi.fn(),
    withTenantScope: (handler: (...args: unknown[]) => Promise<NextResponse>) => handler,
  };
});

vi.mock("@/lib/integrations/connections-service", () => ({ getConnection: vi.fn() }));
vi.mock("@/lib/integrations/plugin-service", () => ({ enqueuePluginExport: vi.fn() }));
vi.mock("@/lib/integrations/sync-service", () => ({ syncCustomers: vi.fn() }));

const SESSION = {
  businessId: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
  sub: "b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12",
};
const CONNECTION_ID = "c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a13";
const CONNECTION = {
  id: CONNECTION_ID,
  business_id: SESSION.businessId,
  provider: "woocommerce",
  sync_customers: true,
  status: "active",
  link_mode: "plugin",
};

function request() {
  return new Request(`http://localhost/api/integrations/connections/${CONNECTION_ID}/sync/customers`, {
    method: "POST",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
  vi.mocked(connectionsService.getConnection).mockResolvedValue(CONNECTION as never);
  vi.mocked(pluginService.enqueuePluginExport).mockResolvedValue(undefined);
});

describe("POST /api/integrations/connections/[id]/sync/customers", () => {
  it("requires WooCommerce sync permission rather than integration administration", async () => {
    const response = await POST(request(), { params: Promise.resolve({ id: CONNECTION_ID }) });
    expect(response.status).toBe(200);
    expect(auth.requirePermission).toHaveBeenCalledWith(PERMISSIONS.woocommerceSync);
    expect(auth.requirePermission).not.toHaveBeenCalledWith(PERMISSIONS.integrationsManage);
  });

  it("passes the requesting member to the durable REST sync run", async () => {
    vi.mocked(connectionsService.getConnection).mockResolvedValueOnce({
      ...CONNECTION,
      link_mode: "rest_api",
    } as never);
    vi.mocked(syncService.syncCustomers).mockResolvedValueOnce({
      runId: "d0eebc99-9c0b-4ef8-bb6d-6bb9bd380a14",
      status: "completed",
      hasMore: false,
    } as never);

    const response = await POST(request(), { params: Promise.resolve({ id: CONNECTION_ID }) });
    expect(response.status).toBe(200);
    expect(syncService.syncCustomers).toHaveBeenCalledWith(SESSION.businessId, CONNECTION_ID, {
      requestedBy: SESSION.sub,
    });
  });

  it("enforces the permission on direct API calls", async () => {
    const denied = NextResponse.json({ error: "forbidden" }, { status: 403 });
    vi.mocked(auth.requirePermission).mockResolvedValueOnce({ session: null, error: denied } as never);

    const response = await POST(request(), { params: Promise.resolve({ id: CONNECTION_ID }) });
    expect(response.status).toBe(403);
    expect(connectionsService.getConnection).not.toHaveBeenCalled();
  });
});
