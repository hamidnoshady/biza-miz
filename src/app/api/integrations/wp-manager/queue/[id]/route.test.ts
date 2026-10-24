import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import * as auth from "@/lib/auth";
import * as connectionsService from "@/lib/integrations/connections-service";
import * as wpManagerService from "@/lib/integrations/wp-manager-service";
import { PERMISSIONS } from "@/lib/permissions";
import { GET } from "./route";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requirePermission: vi.fn(),
    withTenantScope: (handler: (...args: unknown[]) => Promise<NextResponse>) => handler,
  };
});

vi.mock("@/lib/integrations/connections-service", () => ({
  getConnection: vi.fn(),
}));

vi.mock("@/lib/integrations/wp-manager-service", () => ({
  wpQueueRowDetail: vi.fn(),
}));

const SESSION = {
  businessId: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
  sub: "b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12",
  role: "owner",
};
const CONNECTION_ID = "c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a13";
const ROW_ID = "d0eebc99-9c0b-4ef8-bb6d-6bb9bd380a14";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
  vi.mocked(connectionsService.getConnection).mockResolvedValue({
    id: CONNECTION_ID,
    business_id: SESSION.businessId,
    provider: "woocommerce",
    status: "active",
    link_mode: "plugin",
  } as never);
});

describe("GET /api/integrations/wp-manager/queue/[id]", () => {
  it("requires the sync permission, not mere view (payloads are diagnostics)", async () => {
    vi.mocked(wpManagerService.wpQueueRowDetail).mockResolvedValueOnce(null);
    const req = new Request(`http://localhost:3000/api/integrations/wp-manager/queue/${ROW_ID}?connectionId=${CONNECTION_ID}`);
    await GET(req, { params: Promise.resolve({ id: ROW_ID }) });
    expect(auth.requirePermission).toHaveBeenCalledWith(PERMISSIONS.woocommerceSync);
  });

  it("returns the single row's detail", async () => {
    vi.mocked(wpManagerService.wpQueueRowDetail).mockResolvedValueOnce({
      id: ROW_ID,
      direction: "out",
      kind: "stock",
      status: "failed",
      remoteId: "5001",
      error: "timeout",
      attempts: 2,
      payload: { stock_quantity: 4 },
      createdAt: "2026-10-12T10:00:00Z",
    } as never);
    const req = new Request(
      `http://localhost:3000/api/integrations/wp-manager/queue/${ROW_ID}?connectionId=${CONNECTION_ID}&direction=out`,
    );
    const res = await GET(req, { params: Promise.resolve({ id: ROW_ID }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.row.payload).toEqual({ stock_quantity: 4 });
    expect(wpManagerService.wpQueueRowDetail).toHaveBeenCalledWith(SESSION.businessId, CONNECTION_ID, ROW_ID, "out");
  });

  it("answers 404 when the row is not this tenant's", async () => {
    vi.mocked(wpManagerService.wpQueueRowDetail).mockResolvedValueOnce(null);
    const req = new Request(`http://localhost:3000/api/integrations/wp-manager/queue/${ROW_ID}?connectionId=${CONNECTION_ID}`);
    const res = await GET(req, { params: Promise.resolve({ id: ROW_ID }) });
    expect(res.status).toBe(404);
  });

  it("ignores a junk direction instead of 500ing", async () => {
    vi.mocked(wpManagerService.wpQueueRowDetail).mockResolvedValueOnce(null);
    const req = new Request(
      `http://localhost:3000/api/integrations/wp-manager/queue/${ROW_ID}?connectionId=${CONNECTION_ID}&direction=sideways`,
    );
    const res = await GET(req, { params: Promise.resolve({ id: ROW_ID }) });
    expect(res.status).toBe(404);
    expect(wpManagerService.wpQueueRowDetail).toHaveBeenCalledWith(SESSION.businessId, CONNECTION_ID, ROW_ID, undefined);
  });
});
