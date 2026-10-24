import { readFileSync } from "node:fs";
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
vi.mock("@/lib/integrations/holoo/connection-service", () => ({ createHolooConnection: vi.fn() }));
// Since #1037 the GET lists through the live branch-scope layer, not the raw
// service list; this suite pins the permission matrix, hub-contract covers
// the scoping itself.
vi.mock("@/lib/integrations/connection-access", () => ({ listAccessibleConnections: vi.fn() }));

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

describe("GET /api/integrations/connections (#944 OVR-01)", () => {
  it("lets a WooCommerce viewer read the WooCommerce-only slice", async () => {
    vi.mocked(connectionAccess.listAccessibleConnections).mockResolvedValue([
      { id: "woo-1", provider: "woocommerce" },
      { id: "holoo-1", provider: "holoo" },
    ] as never);

    const response = await GET(new Request("http://localhost/api/integrations/connections?provider=woocommerce") as never);

    expect(auth.requireAnyPermission).toHaveBeenCalledWith(PERMISSIONS.integrationsView, PERMISSIONS.woocommerceView);
    expect(auth.requirePermission).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ connections: [{ id: "woo-1", provider: "woocommerce" }] });
  });

  it("keeps the unfiltered cross-provider list behind integrations.view alone", async () => {
    vi.mocked(connectionAccess.listAccessibleConnections).mockResolvedValue([] as never);

    await GET(new Request("http://localhost/api/integrations/connections") as never);

    expect(auth.requirePermission).toHaveBeenCalledWith(PERMISSIONS.integrationsView);
    expect(auth.requireAnyPermission).not.toHaveBeenCalled();
  });

  it("surfaces the guard's refusal without touching the list", async () => {
    vi.mocked(auth.requireAnyPermission).mockResolvedValue({
      session: null,
      error: NextResponse.json({ error: "forbidden" }, { status: 403 }),
    } as never);

    const response = await GET(new Request("http://localhost/api/integrations/connections?provider=woocommerce") as never);

    expect(response.status).toBe(403);
    expect(connectionAccess.listAccessibleConnections).not.toHaveBeenCalled();
  });
});

describe("the sync routes run on the narrow WooCommerce sync ability (#944 OVR-01)", () => {
  const read = (kind: string) =>
    readFileSync(`src/app/api/integrations/connections/[id]/sync/${kind}/route.ts`, "utf8");

  it("products/orders/customers accept the canonical WP sync ability", () => {
    for (const kind of ["products", "orders", "customers"]) {
      const source = read(kind);
      // #944's matrix names the action `woocommerce.sync` while retaining
      // the pre-existing `integrations.manage` access inside the tuple.
      expect(source, kind).toContain("requireAnyPermission(...WP_ABILITY_PERMISSIONS.sync)");
      expect(source, kind).not.toContain("requirePermission(PERMISSIONS.integrationsManage)");
    }
  });

  it("the connection-generic inventory push accepts either ability", () => {
    expect(read("inventory")).toContain(
      "requireAnyPermission(PERMISSIONS.woocommerceSync, PERMISSIONS.integrationsManage)",
    );
  });
});
