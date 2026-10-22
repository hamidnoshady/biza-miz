import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { effectivePermissions, PERMISSIONS } from "@/lib/permissions";
import type { Role } from "@/lib/auth-edge";

const state = vi.hoisted(() => ({ role: "owner" as Role }));
vi.mock("@/lib/auth", () => ({
  withTenantScope: (handler: unknown) => handler,
  requirePermission: vi.fn(async (permission) => {
    // Even a forged/delegated override cannot grant an owner-only capability.
    const permissions = effectivePermissions(state.role, { granted: [PERMISSIONS.apiManage, PERMISSIONS.mcpManage, PERMISSIONS.integrationsManage] });
    if (!permissions.has(permission)) return { error: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
    return { error: null, session: { businessId: "biz", sub: "actor" }, membership: { permissions } };
  }),
}));
vi.mock("@/lib/features", () => ({ isFeatureEnabled: vi.fn(async () => true) }));
vi.mock("@/lib/setup-state", () => ({ resolveActiveLocation: vi.fn(async () => ({ id: "branch" })) }));
vi.mock("@/lib/branch-service", () => ({ listBranches: vi.fn(async () => []) }));
vi.mock("@/lib/desktop-link-service", () => ({ originFromHeaders: () => "https://biza.example" }));
vi.mock("@/lib/api-keys-service", () => ({
  listApiKeys: vi.fn(async () => []), createApiKeyForBusiness: vi.fn(async () => ({ ok: true, key: {}, secret: "once" })), revokeApiKey: vi.fn(async () => true),
}));
vi.mock("@/lib/mcp/connections-service", () => ({
  listMcpConnections: vi.fn(async () => []), listMcpPendingActions: vi.fn(async () => []),
  createStaticMcpConnection: vi.fn(async () => ({ ok: true, connection: {}, token: "once" })),
  listMcpGrantHistory: vi.fn(async () => []),
  updateMcpConnectionAccess: vi.fn(async () => ({ ok: true })), revokeMcpConnection: vi.fn(async () => true),
  rotateMcpConnectionToken: vi.fn(async () => ({ ok: true, token: "once" })),
}));
vi.mock("@/lib/mcp/write-service", () => ({ decideMcpPendingAction: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/integrations/connections-service", () => ({ rotateLinkToken: vi.fn(async () => ({ ok: true, linkToken: "once" })) }));

const keys = await import("./api-keys/route");
const key = await import("./api-keys/[id]/route");
const mcp = await import("./mcp/route");
const connector = await import("./mcp/[id]/route");
const pending = await import("./mcp/pending/[id]/route");
const rotate = await import("../integrations/connections/[id]/link-token/route");
const context = { params: Promise.resolve({ id: "id" }) };
function request(method = "POST", body = {}) {
  return new NextRequest("https://biza.example/api/connections", { method, ...(method === "GET" ? {} : { body: JSON.stringify(body) }) });
}
beforeEach(async () => { state.role = "owner"; vi.clearAllMocks();
  const { isFeatureEnabled } = await import("@/lib/features");
  vi.mocked(isFeatureEnabled).mockResolvedValue(true);
});

describe("server-side machine credential management", () => {
  it.each(["manager", "admin", "accountant", "cashier"] as const)("denies all sensitive reads/writes for %s even with delegated grants", async (role) => {
    state.role = role;
    const responses = await Promise.all([
      keys.GET(), keys.POST(request()), key.DELETE(request("DELETE"), context),
      mcp.GET(request("GET")), mcp.POST(request()), connector.PATCH(request("PATCH"), context),
      connector.GET(request("GET"), context), connector.POST(request(), context),
      connector.DELETE(request("DELETE"), context), pending.POST(request("POST", { decision: "approve" }), context),
      pending.POST(request("POST", { decision: "reject" }), context), rotate.POST(request(), context),
    ]);
    expect(responses.map((response) => response.status)).toEqual(Array(12).fill(403));
    const services = await import("@/lib/api-keys-service");
    expect(services.listApiKeys).not.toHaveBeenCalled();
    expect(services.createApiKeyForBusiness).not.toHaveBeenCalled();
  });

  it("refuses new machine credentials when the tenant entitlement is disabled", async () => {
    const { isFeatureEnabled } = await import("@/lib/features");
    vi.mocked(isFeatureEnabled).mockResolvedValue(false);
    expect((await keys.POST(request())).status).toBe(403);
    expect((await mcp.POST(request())).status).toBe(403);
    const { createApiKeyForBusiness } = await import("@/lib/api-keys-service");
    expect(createApiKeyForBusiness).not.toHaveBeenCalled();
  });

  it("allows owners and never caches one-time credential responses", async () => {
    expect((await keys.GET()).status).toBe(200);
    expect((await mcp.GET(request("GET"))).status).toBe(200);
    for (const response of [await keys.POST(request()), await mcp.POST(request()), await rotate.POST(request(), context)]) {
      expect(response.status).toBeLessThan(300);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
    const { rotateLinkToken } = await import("@/lib/integrations/connections-service");
    expect(rotateLinkToken).toHaveBeenCalledWith("biz", "id", "actor");
  });
});
