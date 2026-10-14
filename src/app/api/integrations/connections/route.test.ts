import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import * as auth from "@/lib/auth";
import * as setupState from "@/lib/setup-state";
import * as connections from "@/lib/integrations/connections-service";
import * as holooConnections from "@/lib/integrations/holoo/connection-service";
import { POST } from "./route";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requirePermission: vi.fn(),
    withTenantScope: (handler: (...args: unknown[]) => Promise<NextResponse>) => handler,
  };
});

vi.mock("@/lib/setup-state", () => ({ resolveActiveLocation: vi.fn() }));
vi.mock("@/lib/integrations/connections-service", () => ({
  createConnection: vi.fn(),
  listConnections: vi.fn(),
}));
vi.mock("@/lib/integrations/holoo/connection-service", () => ({ createHolooConnection: vi.fn() }));

const session = { businessId: "biz-1", sub: "user-1", role: "owner" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session, error: null } as never);
  vi.mocked(setupState.resolveActiveLocation).mockResolvedValue({ id: "branch-1" } as never);
  vi.mocked(connections.createConnection).mockResolvedValue({ ok: true } as never);
  vi.mocked(holooConnections.createHolooConnection).mockResolvedValue({ ok: true, connectionId: "conn-1" } as never);
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
