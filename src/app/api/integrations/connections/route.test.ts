import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { PERMISSIONS } from "@/lib/permissions";
import * as auth from "@/lib/auth";
import * as setupState from "@/lib/setup-state";
import * as connectionAccess from "@/lib/integrations/connection-access";
import * as connections from "@/lib/integrations/connections-service";
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
vi.mock("@/lib/integrations/connection-access", () => ({ listAccessibleConnections: vi.fn() }));
vi.mock("@/lib/integrations/connections-service", () => ({ createConnection: vi.fn() }));
vi.mock("@/lib/integrations/holoo/connection-service", () => ({ createHolooConnection: vi.fn() }));

const session = { businessId: "biz-1", sub: "user-1", role: "owner" };
const accessibleConnections = [
  { id: "woo-1", provider: "woocommerce", name: "Store", locationId: "branch-1" },
  { id: "holoo-1", provider: "holoo", name: "Holoo", locationId: "branch-1" },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session, error: null } as never);
  vi.mocked(auth.requireAnyPermission).mockResolvedValue({ session, error: null } as never);
  vi.mocked(setupState.resolveActiveLocation).mockResolvedValue({ id: "branch-1" } as never);
  vi.mocked(connections.createConnection).mockResolvedValue({ ok: true } as never);
  vi.mocked(connectionAccess.listAccessibleConnections).mockResolvedValue(accessibleConnections as never);
  vi.mocked(holooConnections.createHolooConnection).mockResolvedValue({
    ok: true,
    connectionId: "conn-1",
  } as never);
});

describe("GET /api/integrations/connections", () => {
  it("keeps the unfiltered technical list behind integrations.view", async () => {
    const response = await GET(new Request("http://localhost/api/integrations/connections") as never);

    expect(response.status).toBe(200);
    expect(auth.requirePermission).toHaveBeenCalledWith(PERMISSIONS.integrationsView);
    expect(auth.requireAnyPermission).not.toHaveBeenCalled();
    expect(connectionAccess.listAccessibleConnections).toHaveBeenCalledWith(session);
    expect((await response.json()).connections).toHaveLength(2);
  });

  it("allows the Woo picker through either view grant and returns only accessible Woo stores", async () => {
    const response = await GET(
      new Request("http://localhost/api/integrations/connections?provider=woocommerce") as never,
    );

    expect(response.status).toBe(200);
    expect(auth.requireAnyPermission).toHaveBeenCalledWith(
      PERMISSIONS.integrationsView,
      PERMISSIONS.woocommerceView,
    );
    expect(auth.requirePermission).not.toHaveBeenCalled();
    expect(connectionAccess.listAccessibleConnections).toHaveBeenCalledWith(session);
    expect((await response.json()).connections).toEqual([accessibleConnections[0]]);
  });

  it("keeps the Holoo-filtered technical list behind integrations.view", async () => {
    const response = await GET(
      new Request("http://localhost/api/integrations/connections?provider=holoo") as never,
    );

    expect(response.status).toBe(200);
    expect(auth.requirePermission).toHaveBeenCalledWith(PERMISSIONS.integrationsView);
    expect(auth.requireAnyPermission).not.toHaveBeenCalled();
    expect((await response.json()).connections).toEqual([accessibleConnections[1]]);
  });

  it("rejects unknown providers before resolving permissions or querying connections", async () => {
    const response = await GET(new Request("http://localhost/api/integrations/connections?provider=other") as never);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_provider" });
    expect(auth.requirePermission).not.toHaveBeenCalled();
    expect(auth.requireAnyPermission).not.toHaveBeenCalled();
    expect(connectionAccess.listAccessibleConnections).not.toHaveBeenCalled();
  });

  it("passes a denial from either-of permission resolution straight through", async () => {
    const denied = NextResponse.json({ error: "forbidden" }, { status: 403 });
    vi.mocked(auth.requireAnyPermission).mockResolvedValue({ session: null, error: denied } as never);

    const response = await GET(
      new Request("http://localhost/api/integrations/connections?provider=woocommerce") as never,
    );

    expect(response.status).toBe(403);
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
