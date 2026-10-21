import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { PERMISSIONS } from "@/lib/permissions";
import * as auth from "@/lib/auth";
import * as setupState from "@/lib/setup-state";
import * as connections from "@/lib/integrations/connections-service";
import * as connectionAccess from "@/lib/integrations/connection-access";
import * as holooConnections from "@/lib/integrations/holoo/connection-service";
import { GET, POST } from "./route";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requirePermission: vi.fn(),
    requireAnyPermission: vi.fn(),
    withTenantScope: (handler: (...args: unknown[]) => Promise<NextResponse>) => handler,
  };
});

vi.mock("@/lib/setup-state", () => ({ resolveActiveLocation: vi.fn() }));
vi.mock("@/lib/integrations/connections-service", () => ({
  createConnection: vi.fn(),
}));
vi.mock("@/lib/integrations/connection-access", () => ({ listAccessibleConnections: vi.fn() }));
vi.mock("@/lib/integrations/holoo/connection-service", () => ({ createHolooConnection: vi.fn() }));

const session = { businessId: "biz-1", sub: "user-1", role: "owner" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session, error: null } as never);
  vi.mocked(auth.requireAnyPermission).mockResolvedValue({ session, error: null } as never);
  vi.mocked(setupState.resolveActiveLocation).mockResolvedValue({ id: "branch-1" } as never);
  vi.mocked(connections.createConnection).mockResolvedValue({ ok: true } as never);
  vi.mocked(holooConnections.createHolooConnection).mockResolvedValue({ ok: true, connectionId: "conn-1" } as never);
});

describe("GET /api/integrations/connections", () => {
  const mixed = [
    { id: "woo-1", provider: "woocommerce", name: "Store" },
    { id: "holoo-1", provider: "holoo", name: "Holoo" },
  ];

  it("keeps the unfiltered technical list on integrations.view", async () => {
    vi.mocked(connectionAccess.listAccessibleConnections).mockResolvedValue(mixed as never);
    const res = await GET(new Request("http://localhost/api/integrations/connections") as never);
    expect(res.status).toBe(200);
    expect(auth.requirePermission).toHaveBeenCalledWith(PERMISSIONS.integrationsView);
    expect(auth.requireAnyPermission).not.toHaveBeenCalled();
    expect((await res.json()).connections).toHaveLength(2);
  });

  it("opens the WooCommerce-filtered picker list to woocommerce.view as well (issue #943)", async () => {
    // The WP Manager's store picker reads ?provider=woocommerce and its pages
    // are gated on woocommerce.view; a member granted only the WooCommerce
    // capabilities used to be locked out of the manager's own data.
    vi.mocked(connectionAccess.listAccessibleConnections).mockResolvedValue(mixed as never);
    const res = await GET(
      new Request("http://localhost/api/integrations/connections?provider=woocommerce") as never,
    );
    expect(res.status).toBe(200);
    expect(auth.requireAnyPermission).toHaveBeenCalledWith(
      PERMISSIONS.integrationsView,
      PERMISSIONS.woocommerceView,
    );
    const body = await res.json();
    // The wider grant is scoped: only WooCommerce connections come back,
    // never the tenant's other integrations.
    expect(body.connections).toEqual([{ id: "woo-1", provider: "woocommerce", name: "Store" }]);
  });

  it("passes a denial straight through", async () => {
    const denied = NextResponse.json({ error: "forbidden" }, { status: 403 });
    vi.mocked(auth.requireAnyPermission).mockResolvedValue({ session: null, error: denied } as never);
    const res = await GET(
      new Request("http://localhost/api/integrations/connections?provider=woocommerce") as never,
    );
    expect(res.status).toBe(403);
    expect(connectionAccess.listAccessibleConnections).not.toHaveBeenCalled();
  });
});

describe("POST /api/integrations/connections", () => {
  it("rejects a caller-supplied branch that is not the active authorized location", async () => {
    const response = await POST(
      new Request("http://localhost/api/integrations/connections", {
        method: "POST",
        body: JSON.stringify({ provider: "holoo", locationId: "branch-2" }),
      }) as never,
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "location_mismatch" });
    expect(holooConnections.createHolooConnection).not.toHaveBeenCalled();
    expect(connections.createConnection).not.toHaveBeenCalled();
  });

  it("binds a Holoo connection to the resolved active location", async () => {
    const response = await POST(
      new Request("http://localhost/api/integrations/connections", {
        method: "POST",
        body: JSON.stringify({ provider: "holoo", name: "Holoo" }),
      }) as never,
    );

    expect(response.status).toBe(201);
    expect(holooConnections.createHolooConnection).toHaveBeenCalledWith(
      session.businessId,
      session.sub,
      "Holoo",
      expect.objectContaining({ locationId: "branch-1" }),
    );
  });
});
