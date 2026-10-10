/**
 * Issue #883 P0-4 — the MCP management routes' authorization decision.
 *
 * The mismatch this pins: the consent screen told owners *"only you can do
 * this"*, while the APIs accepted the delegatable `integrations.manage` key a
 * manager or admin holds by default — so the sentence on the screen and the
 * guard on the wire disagreed. The documented policy now is **owner-only**,
 * carried by the dedicated owner-only permission `mcp.manage` (the same shape
 * as `api.manage`): minting a static token, narrowing or revoking a
 * connection, consenting to an OAuth grant, and deciding a queued write all
 * ask for exactly that key and no other.
 *
 * The database and services are mocked; what is being pinned is which
 * permission each route asks the guard for.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as auth from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import * as connections from "@/lib/mcp/connections-service";
import * as writeService from "@/lib/mcp/write-service";
import * as oauthService from "@/lib/mcp/oauth-service";
import { POST as createConnection } from "./route";
import { PATCH as patchConnection, DELETE as deleteConnection } from "./[id]/route";
import { POST as consent } from "./consent/route";
import { POST as decide } from "./pending/[id]/route";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requirePermission: vi.fn(),
    withTenantScope: (handler: (...args: unknown[]) => unknown) => handler,
  };
});

vi.mock("@/lib/db", () => ({ query: vi.fn(), withTenant: vi.fn() }));
vi.mock("@/lib/features", () => ({ isFeatureEnabled: vi.fn(async () => true) }));
vi.mock("@/lib/setup-state", () => ({
  resolveActiveLocation: vi.fn(async () => ({ id: "loc-1", name: "اصلی" })),
}));
vi.mock("@/lib/mcp/connections-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/mcp/connections-service")>();
  return {
    ...actual,
    createStaticMcpConnection: vi.fn(),
    revokeMcpConnection: vi.fn(),
    updateMcpConnectionAccess: vi.fn(),
    listMcpConnections: vi.fn(),
  };
});
vi.mock("@/lib/mcp/write-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/mcp/write-service")>();
  return { ...actual, decideMcpPendingAction: vi.fn() };
});
vi.mock("@/lib/mcp/oauth-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/mcp/oauth-service")>();
  return {
    ...actual,
    validateAuthorizationRequest: vi.fn(),
    issueAuthorizationCode: vi.fn(),
  };
});

const session = { businessId: "biz-1", sub: "user-1", role: "manager" as const };

/**
 * Drives the guard off an explicit permission set — a member holding
 * `integrations.manage` (managers/admins by default) but NOT the owner-only
 * `mcp.manage` is exactly the case that used to slip through.
 */
function actorHas(permissions: readonly string[]) {
  vi.mocked(auth.requirePermission).mockImplementation((async (permission: string) => {
    if (permissions.includes(permission)) {
      return {
        session,
        membership: { permissions: new Set(permissions) },
        error: null,
      };
    }
    return {
      session: null,
      error: {
        status: 403,
        json: async () => ({ error: "forbidden", permission }),
      },
    };
  }) as never);
}

function post(body: unknown, url = "http://localhost/api/connections/mcp") {
  return new Request(url, { method: "POST", body: JSON.stringify(body) }) as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(connections.createStaticMcpConnection).mockResolvedValue({
    ok: true,
    connection: { id: "conn-1" },
    token: "posmcp_x",
  } as never);
  vi.mocked(connections.revokeMcpConnection).mockResolvedValue(true as never);
  vi.mocked(connections.updateMcpConnectionAccess).mockResolvedValue({
    ok: true,
    connection: { id: "conn-1" },
  } as never);
  vi.mocked(writeService.decideMcpPendingAction).mockResolvedValue({
    ok: true,
    decision: "reject",
  } as never);
  vi.mocked(oauthService.validateAuthorizationRequest).mockResolvedValue({
    ok: true,
    client: { clientId: "client-1", clientName: "Claude" },
    request: {
      clientId: "client-1",
      redirectUri: "https://claude.ai/api/mcp/auth_callback",
      codeChallenge: "c".repeat(43),
    },
  } as never);
  vi.mocked(oauthService.issueAuthorizationCode).mockResolvedValue({
    ok: true,
    redirectTo: "https://claude.ai/api/mcp/auth_callback?code=x",
  } as never);
});

describe("POST /api/connections/mcp (mint a static token)", () => {
  const body = { name: "Codex", scopes: ["pos.read"], writeMode: "approve" };

  it("asks the guard for the owner-only mcp.manage, not the delegatable key", async () => {
    actorHas([PERMISSIONS.mcpManage]);
    const response = await createConnection(post(body) as never);
    expect(response.status).toBe(201);
    expect(auth.requirePermission).toHaveBeenCalledWith(PERMISSIONS.mcpManage);
  });

  it("refuses a manager holding integrations.manage", async () => {
    actorHas([PERMISSIONS.integrationsManage]);
    const response = await createConnection(post(body) as never);
    expect(response.status).toBe(403);
    expect(connections.createStaticMcpConnection).not.toHaveBeenCalled();
  });
});

describe("PATCH/DELETE /api/connections/mcp/[id] (narrow, revoke)", () => {
  it("PATCH requires mcp.manage", async () => {
    actorHas([PERMISSIONS.integrationsManage]);
    const response = await patchConnection(
      post({ scopes: ["pos.read"], writeMode: "approve" }, "http://x/api/connections/mcp/c1"),
      { params: Promise.resolve({ id: "c1" }) } as never,
    );
    expect(response.status).toBe(403);
    expect(auth.requirePermission).toHaveBeenCalledWith(PERMISSIONS.mcpManage);
    expect(connections.updateMcpConnectionAccess).not.toHaveBeenCalled();
  });

  it("DELETE requires mcp.manage", async () => {
    actorHas([PERMISSIONS.integrationsManage]);
    const response = await deleteConnection(
      new Request("http://x/api/connections/mcp/c1", { method: "DELETE" }) as never,
      { params: Promise.resolve({ id: "c1" }) } as never,
    );
    expect(response.status).toBe(403);
    expect(connections.revokeMcpConnection).not.toHaveBeenCalled();
  });

  it("an owner can narrow and revoke", async () => {
    actorHas([PERMISSIONS.mcpManage]);
    const patched = await patchConnection(
      post({ scopes: ["pos.read"], writeMode: "approve" }, "http://x/api/connections/mcp/c1"),
      { params: Promise.resolve({ id: "c1" }) } as never,
    );
    expect(patched.status).toBe(200);
    const deleted = await deleteConnection(
      new Request("http://x/api/connections/mcp/c1", { method: "DELETE" }) as never,
      { params: Promise.resolve({ id: "c1" }) } as never,
    );
    expect(deleted.status).toBe(200);
  });
});

describe("POST /api/connections/mcp/consent (the OAuth \"allow\")", () => {
  const body = {
    clientId: "client-1",
    redirectUri: "https://claude.ai/api/mcp/auth_callback",
    codeChallenge: "c".repeat(43),
    requestedScopes: ["pos.read"],
    approvedScopes: ["pos.read"],
    writeMode: "approve",
  };

  it("requires mcp.manage — the sentence the consent page already made", async () => {
    actorHas([PERMISSIONS.integrationsManage]);
    const response = await consent(post(body, "http://x/api/connections/mcp/consent"));
    expect(response.status).toBe(403);
    expect(auth.requirePermission).toHaveBeenCalledWith(PERMISSIONS.mcpManage);
    expect(oauthService.issueAuthorizationCode).not.toHaveBeenCalled();
  });

  it("issues the code for an owner", async () => {
    actorHas([PERMISSIONS.mcpManage]);
    const response = await consent(post(body, "http://x/api/connections/mcp/consent"));
    expect(response.status).toBe(200);
    expect(oauthService.issueAuthorizationCode).toHaveBeenCalled();
  });
});

describe("POST /api/connections/mcp/pending/[id] (decide a queued write)", () => {
  it("requires mcp.manage — someone able to say no is the whole point of approve mode", async () => {
    actorHas([PERMISSIONS.integrationsManage]);
    const response = await decide(
      post({ decision: "reject" }, "http://x/api/connections/mcp/pending/a1"),
      { params: Promise.resolve({ id: "a1" }) } as never,
    );
    expect(response.status).toBe(403);
    expect(auth.requirePermission).toHaveBeenCalledWith(PERMISSIONS.mcpManage);
    expect(writeService.decideMcpPendingAction).not.toHaveBeenCalled();
  });

  it("maps approver_forbidden to 403 — the row went back for a privileged approver", async () => {
    actorHas([PERMISSIONS.mcpManage]);
    vi.mocked(writeService.decideMcpPendingAction).mockResolvedValue({
      ok: false,
      error: "approver_forbidden",
    } as never);
    const response = await decide(
      post({ decision: "approve" }, "http://x/api/connections/mcp/pending/a1"),
      { params: Promise.resolve({ id: "a1" }) } as never,
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "approver_forbidden" });
  });
});
