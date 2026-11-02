import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { PERMISSIONS } from "@/lib/permissions";
import * as auth from "@/lib/auth";
import * as connectionAccess from "@/lib/integrations/connection-access";
import * as pluginService from "@/lib/integrations/plugin-service";
import * as syncService from "@/lib/integrations/sync-service";
import { POST } from "./route";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requireAnyPermission: vi.fn(),
    withTenantScope: (handler: (...args: unknown[]) => Promise<NextResponse>) => handler,
  };
});

vi.mock("@/lib/integrations/connection-access", () => ({ getAccessibleConnection: vi.fn() }));
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
  vi.mocked(auth.requireAnyPermission).mockResolvedValue({ session: SESSION, error: null } as never);
  vi.mocked(connectionAccess.getAccessibleConnection).mockResolvedValue(CONNECTION as never);
  vi.mocked(pluginService.enqueuePluginExport).mockResolvedValue({ jobId: "job-customer" });
});

describe("POST /api/integrations/connections/[id]/sync/customers", () => {
  it("accepts the WP sync ability while retaining integrations.manage access", async () => {
    const response = await POST(request(), { params: Promise.resolve({ id: CONNECTION_ID }) });
    expect(response.status).toBe(200);
    expect(auth.requireAnyPermission).toHaveBeenCalledWith(PERMISSIONS.woocommerceSync, PERMISSIONS.integrationsManage);
    expect(connectionAccess.getAccessibleConnection).toHaveBeenCalledWith(SESSION, CONNECTION_ID);
    expect(await response.json()).toEqual({
      ok: true,
      queued: true,
      result: "queued",
      jobIds: ["job-customer"],
    });
  });

  it("passes the requesting member to the durable REST sync run", async () => {
    vi.mocked(connectionAccess.getAccessibleConnection).mockResolvedValueOnce({
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
    await expect(response.json()).resolves.toMatchObject({ result: "completed", runId: "d0eebc99-9c0b-4ef8-bb6d-6bb9bd380a14" });
    expect(syncService.syncCustomers).toHaveBeenCalledWith(SESSION.businessId, CONNECTION_ID, {
      requestedBy: SESSION.sub,
    });
  });

  it("answers 409 plugin_job_unsupported, without queueing, when the plugin did not advertise customer_export (#944 / OVR-08)", async () => {
    vi.mocked(connectionAccess.getAccessibleConnection).mockResolvedValueOnce({
      ...CONNECTION,
      plugin_capabilities: { jobTypes: ["stock", "price"] },
    } as never);
    const response = await POST(request(), { params: Promise.resolve({ id: CONNECTION_ID }) });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ ok: false, error: "plugin_job_unsupported" });
    expect(pluginService.enqueuePluginExport).not.toHaveBeenCalled();
  });

  it("enforces the permission on direct API calls", async () => {
    const denied = NextResponse.json({ error: "forbidden" }, { status: 403 });
    vi.mocked(auth.requireAnyPermission).mockResolvedValueOnce({ session: null, error: denied } as never);

    const response = await POST(request(), { params: Promise.resolve({ id: CONNECTION_ID }) });
    expect(response.status).toBe(403);
    expect(connectionAccess.getAccessibleConnection).not.toHaveBeenCalled();
  });
});
