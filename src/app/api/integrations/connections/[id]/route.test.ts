import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextResponse } from "next/server";
import * as auth from "@/lib/auth";
import * as service from "@/lib/integrations/connections-service";
import * as setup from "@/lib/setup-state";
import { DELETE, PATCH } from "./route";

vi.mock("@/lib/auth", () => ({
  requirePermission: vi.fn(),
  withTenantScope: (handler: (...args: unknown[]) => Promise<NextResponse>) => handler,
}));

vi.mock("@/lib/integrations/connections-service", () => ({
  getConnection: vi.fn(),
  updateConnection: vi.fn(),
  deleteConnection: vi.fn(),
}));

vi.mock("@/lib/setup-state", () => ({
  accessibleLocationsFor: vi.fn(),
  resolveActiveLocation: vi.fn(),
}));

// Exercise the real connection-access helper with a live, branch-scoped
// operational permission, not an always-allowed mock of the security boundary.
const session = { businessId: "biz-1", sub: "user-1", role: "manager" };
const connection = { id: "conn-1", business_id: session.businessId, provider: "woocommerce", location_id: "loc-1" };
const params = { params: Promise.resolve({ id: "conn-1" }) };

function request(method: "PATCH" | "DELETE", body: Record<string, unknown> = {}) {
  return new Request("http://localhost/api/integrations/connections/conn-1", {
    method,
    ...(method === "PATCH" ? { body: JSON.stringify(body) } : {}),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session, error: null } as never);
  vi.mocked(service.getConnection).mockResolvedValue(connection as never);
  vi.mocked(setup.accessibleLocationsFor).mockResolvedValue({
    locations: [{ id: "loc-1" }], businessLocationCount: 2,
  } as never);
  vi.mocked(setup.resolveActiveLocation).mockResolvedValue({ id: "loc-1" } as never);
  vi.mocked(service.updateConnection).mockResolvedValue({ ok: true, connection: { id: "conn-1" } } as never);
  vi.mocked(service.deleteConnection).mockResolvedValue(true);
});

describe("PATCH /api/integrations/connections/[id]", () => {
  it("forwards every sync setting supported by updateConnection after live branch authorization", async () => {
    const body = {
      syncOrders: false,
      syncProducts: true,
      syncCustomers: false,
      pushStock: true,
      pushPrices: false,
      syncCategories: true,
      autoPullOrders: false,
      orderLookbackDays: 30,
    };

    const res = await PATCH(request("PATCH", body) as never, params as never);

    expect(res.status).toBe(200);
    expect(service.getConnection).toHaveBeenCalledWith(session.businessId, "conn-1");
    expect(setup.accessibleLocationsFor).toHaveBeenCalledWith(session, { includeInactive: true });
    expect(service.updateConnection).toHaveBeenCalledWith(session.businessId, "conn-1", expect.objectContaining(body));
  });

  it("rejects WooCommerce sync fields for a different provider", async () => {
    vi.mocked(service.getConnection).mockResolvedValue({ ...connection, provider: "holoo" } as never);
    const res = await PATCH(request("PATCH", { syncOrders: true }) as never, params as never);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "provider_mismatch" });
    expect(service.updateConnection).not.toHaveBeenCalled();
  });

  it.each([null, "loc-2"])("rejects reassignment to %s instead of the active branch", async (locationId) => {
    const res = await PATCH(request("PATCH", { locationId }) as never, params as never);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "location_mismatch" });
    expect(service.updateConnection).not.toHaveBeenCalled();
  });

  it("allows reassignment only to the resolved active branch", async () => {
    const res = await PATCH(request("PATCH", { locationId: "loc-1" }) as never, params as never);
    expect(res.status).toBe(200);
    expect(setup.resolveActiveLocation).toHaveBeenCalledWith(session);
    expect(service.updateConnection).toHaveBeenCalledWith(session.businessId, "conn-1", expect.objectContaining({ locationId: "loc-1" }));
  });
});

describe.each(["PATCH", "DELETE"] as const)("%s live authorization", (method) => {
  const handler = method === "PATCH" ? PATCH : DELETE;

  it.each(["loc-2", null])("denies an inaccessible branch/business-wide assignment (%s) without mutation", async (location_id) => {
    vi.mocked(service.getConnection).mockResolvedValue({ ...connection, location_id } as never);
    const res = await handler(request(method, { name: "changed" }) as never, params as never);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expect(service.updateConnection).not.toHaveBeenCalled();
    expect(service.deleteConnection).not.toHaveBeenCalled();
  });

  it("denies a missing or tenant-filtered connection without mutation", async () => {
    vi.mocked(service.getConnection).mockResolvedValue(null);
    const res = await handler(request(method) as never, params as never);
    expect(res.status).toBe(404);
    expect(service.getConnection).toHaveBeenCalledWith(session.businessId, "conn-1");
    expect(service.updateConnection).not.toHaveBeenCalled();
    expect(service.deleteConnection).not.toHaveBeenCalled();
  });

  it("stops at a permission denial before reading connections or mutating", async () => {
    vi.mocked(auth.requirePermission).mockResolvedValue({
      session: null, error: NextResponse.json({ error: "forbidden" }, { status: 403 }),
    } as never);
    const res = await handler(request(method) as never, params as never);
    expect(res.status).toBe(403);
    expect(service.getConnection).not.toHaveBeenCalled();
    expect(setup.accessibleLocationsFor).not.toHaveBeenCalled();
    expect(service.updateConnection).not.toHaveBeenCalled();
    expect(service.deleteConnection).not.toHaveBeenCalled();
  });
});

it("disconnects an accessible connection with its tenant and audit actor", async () => {
  const res = await DELETE(request("DELETE") as never, params as never);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
  expect(service.deleteConnection).toHaveBeenCalledWith(session.businessId, "conn-1", session.sub);
});
