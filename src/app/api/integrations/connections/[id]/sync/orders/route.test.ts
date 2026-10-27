import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { PERMISSIONS } from "@/lib/permissions";
import * as auth from "@/lib/auth";
import * as connectionAccess from "@/lib/integrations/connection-access";
import * as wooOps from "@/lib/integrations/woo-ops-service";
import { PluginJobUnsupportedError } from "@/lib/integrations/plugin-job-guard";
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
vi.mock("@/lib/integrations/woo-ops-service", () => ({ enqueueExport: vi.fn() }));
vi.mock("@/lib/integrations/sync-service", () => ({ syncOrders: vi.fn() }));

const SESSION = {
  businessId: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
  sub: "b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12",
};
const CONNECTION_ID = "c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a13";
const CONNECTION = {
  id: CONNECTION_ID,
  business_id: SESSION.businessId,
  provider: "woocommerce",
  sync_orders: true,
  status: "active",
  link_mode: "plugin",
  plugin_capabilities: null as Record<string, unknown> | null,
};

function request() {
  return new Request(`http://localhost/api/integrations/connections/${CONNECTION_ID}/sync/orders`, { method: "POST" });
}
const call = () => POST(request(), { params: Promise.resolve({ id: CONNECTION_ID }) });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requireAnyPermission).mockResolvedValue({ session: SESSION, error: null } as never);
  vi.mocked(connectionAccess.getAccessibleConnection).mockResolvedValue(CONNECTION as never);
  vi.mocked(wooOps.enqueueExport).mockResolvedValue({ jobId: "job-orders" });
});

describe("POST /api/integrations/connections/[id]/sync/orders", () => {
  it("queues the export under the WP sync ability and names the job", async () => {
    const response = await call();
    expect(response.status).toBe(200);
    expect(auth.requireAnyPermission).toHaveBeenCalledWith(PERMISSIONS.woocommerceSync, PERMISSIONS.integrationsManage);
    await expect(response.json()).resolves.toEqual({ ok: true, queued: true, result: "queued", jobIds: ["job-orders"] });
  });

  it("answers 409 plugin_job_unsupported, without queueing, when the plugin did not advertise orders_export", async () => {
    vi.mocked(connectionAccess.getAccessibleConnection).mockResolvedValueOnce({
      ...CONNECTION,
      plugin_capabilities: { jobTypes: ["stock", "price"] },
    } as never);
    const response = await call();
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ ok: false, error: "plugin_job_unsupported" });
    expect(wooOps.enqueueExport).not.toHaveBeenCalled();
  });

  it("maps the service's own refusal to the same 409", async () => {
    vi.mocked(wooOps.enqueueExport).mockRejectedValueOnce(new PluginJobUnsupportedError("orders_export"));
    const response = await call();
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: "plugin_job_unsupported" });
  });

  it("enforces the permission and the sync flag on direct API calls", async () => {
    const denied = NextResponse.json({ error: "forbidden" }, { status: 403 });
    vi.mocked(auth.requireAnyPermission).mockResolvedValueOnce({ session: null, error: denied } as never);
    expect((await call()).status).toBe(403);
    expect(connectionAccess.getAccessibleConnection).not.toHaveBeenCalled();

    vi.mocked(connectionAccess.getAccessibleConnection).mockResolvedValueOnce({ ...CONNECTION, sync_orders: false } as never);
    const disabled = await call();
    expect(disabled.status).toBe(409);
    await expect(disabled.json()).resolves.toMatchObject({ error: "sync_orders_disabled" });
  });
});
