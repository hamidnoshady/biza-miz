import { beforeEach, describe, expect, it, vi } from "vitest";
import { PERMISSIONS } from "../permissions";
import type { MemberAccess } from "../member-access";
import type { McpAuthentication } from "./auth";
import { parseMcpGrants } from "./grants";
import { parseMessage } from "./protocol";
import { dispatchMcpMessage } from "./server";

const mocks = vi.hoisted(() => ({
  memberAccessForUser: vi.fn(),
  resolveActiveLocationForUser: vi.fn(),
  runSystemReadTool: vi.fn<
    (
      name: string,
      args: Record<string, unknown>,
      businessId: string,
      floorScope?: unknown,
      actorUserId?: string,
      permissions?: ReadonlySet<string>,
      pinnedLocationId?: string,
      mcpScope?: { allowedBranchIds: string[] | null },
    ) => Promise<{ ok: true; data: { accepted: true } }>
  >(async () => ({ ok: true, data: { accepted: true } })),
}));
vi.mock("../member-access", () => ({ memberAccessForUser: mocks.memberAccessForUser }));
vi.mock("../setup-state", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../setup-state")>()),
  resolveActiveLocationForUser: mocks.resolveActiveLocationForUser,
}));
vi.mock("../ai-system-read", () => ({ runSystemReadTool: mocks.runSystemReadTool }));

const AUTH: McpAuthentication = {
  connectionId: "connection-1",
  connectionName: "Dashboard connector",
  businessId: "business-1",
  locationId: "location-1",
  scopes: ["pos.read"],
  writeMode: "approve",
  authorizedByUserId: "manager-1",
  // Legacy grants: every app, every branch — the branch-consent half has its
  // own tests; these pin the live-authorizer half.
  grants: parseMcpGrants({}),
  // What authenticateMcp resolved; the dispatcher intersects it with the
  // live membership, so it can only narrow.
  permissions: new Set([PERMISSIONS.reportsView, PERMISSIONS.reportsBusinessWide, PERMISSIONS.aiUse]),
};

function toolCall(name: string, args: Record<string, unknown> = {}) {
  return parseMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  });
}

function resourceRead(uri: string) {
  return parseMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "resources/read",
    params: { uri },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.runSystemReadTool.mockResolvedValue({ ok: true, data: { accepted: true } });
  mocks.memberAccessForUser.mockResolvedValue({
    role: "manager",
    isActive: true,
    permissions: new Set([PERMISSIONS.reportsView]),
  } satisfies MemberAccess);
  mocks.resolveActiveLocationForUser.mockResolvedValue({ id: "location-1" });
});

describe("MCP read authorization", () => {
  it("uses the authorizer's live report permissions and preserves the connection's pinned branch", async () => {
    const response = await dispatchMcpMessage(AUTH, toolCall("run_report", { key: "daily_sales_summary" }));
    expect(response).toMatchObject({ jsonrpc: "2.0", id: 1, result: expect.any(Object) });
    expect(mocks.memberAccessForUser).toHaveBeenCalledWith("business-1", "manager-1", "location-1");

    const [, , businessId, floorScope, actorUserId, permissions, pinnedLocationId] =
      mocks.runSystemReadTool.mock.calls[0];
    expect(businessId).toBe("business-1");
    expect(floorScope).toBeUndefined();
    expect(actorUserId).toBe("manager-1");
    expect(permissions).toEqual(new Set([PERMISSIONS.reportsView]));
    expect(pinnedLocationId).toBe("location-1");
  });

  it("does not let a branch-only MCP connection inherit system-wide reporting authority", async () => {
    await dispatchMcpMessage(AUTH, toolCall("get_branch_comparison"));
    const permissions = mocks.runSystemReadTool.mock.calls[0][5];
    expect(permissions).toBeDefined();
    expect(permissions?.has(PERMISSIONS.reportsBusinessWide)).toBe(false);
  });

  it("keeps business-wide AI reads available to an active owner, not to the connection scope alone", async () => {
    mocks.memberAccessForUser.mockResolvedValue({
      role: "owner",
      isActive: true,
      permissions: new Set([PERMISSIONS.reportsView, PERMISSIONS.reportsBusinessWide]),
    } satisfies MemberAccess);
    await dispatchMcpMessage(AUTH, toolCall("get_branch_comparison"));
    const permissions = mocks.runSystemReadTool.mock.calls[0][5];
    expect(permissions).toBeDefined();
    expect(permissions?.has(PERMISSIONS.reportsBusinessWide)).toBe(true);
  });

  it("reads nothing once the authorizer's membership is gone", async () => {
    mocks.memberAccessForUser.mockResolvedValue(null);
    await dispatchMcpMessage(AUTH, toolCall("run_report", { key: "daily_sales_summary" }));
    const [, , , , actorUserId, permissions, pinnedLocationId] = mocks.runSystemReadTool.mock.calls[0];
    expect(actorUserId).toBe("manager-1");
    expect(pinnedLocationId).toBe("location-1");
    expect(permissions).toEqual(new Set());
    expect(mocks.resolveActiveLocationForUser).not.toHaveBeenCalled();
  });

  it("never lets the live membership widen what authentication resolved", async () => {
    mocks.memberAccessForUser.mockResolvedValue({
      role: "owner",
      isActive: true,
      permissions: new Set([PERMISSIONS.reportsView, PERMISSIONS.reportsBusinessWide]),
    } satisfies MemberAccess);
    await dispatchMcpMessage(
      { ...AUTH, permissions: new Set([PERMISSIONS.reportsView]) },
      toolCall("run_report", { key: "daily_sales_summary" }),
    );
    expect(mocks.runSystemReadTool.mock.calls[0][5]).toEqual(new Set([PERMISSIONS.reportsView]));
  });

  it("passes the connection's branch consent to the executor alongside the pinned branch", async () => {
    await dispatchMcpMessage(
      { ...AUTH, grants: parseMcpGrants({ apps: { pos: { read: true } }, branches: ["location-1"] }) },
      toolCall("run_report", { key: "daily_sales_summary" }),
    );
    const call = mocks.runSystemReadTool.mock.calls[0];
    expect(call[6]).toBe("location-1");
    expect(call[7]).toEqual({ allowedBranchIds: ["location-1"] });
  });

  it("fails closed when the active authorizer can no longer access the connection's pinned branch", async () => {
    mocks.resolveActiveLocationForUser.mockResolvedValue({ id: "location-2" });
    await dispatchMcpMessage(AUTH, toolCall("run_report", { key: "daily_sales_summary" }));
    expect(mocks.runSystemReadTool.mock.calls[0][5]).toEqual(new Set());
    expect(mocks.resolveActiveLocationForUser).toHaveBeenCalledWith(
      "business-1",
      "manager-1",
      "location-1",
    );
  });

  it("removes read authority when the authorizing member is inactive", async () => {
    mocks.memberAccessForUser.mockResolvedValue({
      role: "manager",
      isActive: false,
      permissions: new Set([PERMISSIONS.reportsView]),
    } satisfies MemberAccess);
    await dispatchMcpMessage(AUTH, toolCall("run_report", { key: "daily_sales_summary" }));
    const permissions = mocks.runSystemReadTool.mock.calls[0][5];
    expect(permissions).toEqual(new Set());
  });

  it("revalidates the pinned branch before returning the branch-aware overview resource", async () => {
    const response = await dispatchMcpMessage(AUTH, resourceRead("pos://app/overview"));
    expect(response).toMatchObject({ jsonrpc: "2.0", id: 1, result: { contents: expect.any(Array) } });
    expect(mocks.resolveActiveLocationForUser).toHaveBeenCalledWith(
      "business-1",
      "manager-1",
      "location-1",
    );
    expect(mocks.runSystemReadTool).toHaveBeenCalledWith(
      "describe_app",
      {},
      "business-1",
      undefined,
      undefined,
      new Set([PERMISSIONS.reportsView]),
      "location-1",
    );
  });

  it("fails closed on a resource read when the active authorizer lost the pinned branch", async () => {
    mocks.resolveActiveLocationForUser.mockResolvedValue({ id: "location-2" });
    const response = await dispatchMcpMessage(AUTH, resourceRead("pos://app/overview"));
    expect(response).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32602, message: expect.stringContaining("شعبه") },
    });
    expect(mocks.runSystemReadTool).not.toHaveBeenCalled();
  });

  it("emits a real serverInfo.version on initialize and serves prompts/list and resources/templates/list", async () => {
    const init = await dispatchMcpMessage(
      AUTH,
      parseMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    );
    const initResult = (init as { result: { serverInfo: { version: string }; instructions: string } }).result;
    expect(initResult.serverInfo.version).not.toBe("unknown");
    expect(initResult.serverInfo.version).toMatch(/^\d+\.\d+\.\d+/);

    const prompts = await dispatchMcpMessage(
      AUTH,
      parseMessage({ jsonrpc: "2.0", id: 2, method: "prompts/list", params: {} }),
    );
    const promptList = (prompts as { result: { prompts: Array<{ name: string }> } }).result.prompts;
    expect(promptList.length).toBeGreaterThan(0);
    expect(promptList.map((p) => p.name)).toContain("daily_briefing");

    const promptGet = await dispatchMcpMessage(
      AUTH,
      parseMessage({
        jsonrpc: "2.0",
        id: 3,
        method: "prompts/get",
        params: { name: "daily_briefing", arguments: { date: "2026-10-16" } },
      }),
    );
    expect(promptGet).toMatchObject({
      jsonrpc: "2.0",
      id: 3,
      result: { messages: expect.any(Array) },
    });

    const templates = await dispatchMcpMessage(
      AUTH,
      parseMessage({ jsonrpc: "2.0", id: 4, method: "resources/templates/list", params: {} }),
    );
    const templateList = (
      templates as { result: { resourceTemplates: Array<{ uriTemplate: string }> } }
    ).result.resourceTemplates;
    expect(templateList.map((t) => t.uriTemplate)).toContain("pos://reports/{key}");
  });

  it("requires pos.read scope before listing or reading report template resources", async () => {
    const writeOnlyAuth: McpAuthentication = {
      ...AUTH,
      scopes: ["pos.write"],
    };

    const templates = await dispatchMcpMessage(
      writeOnlyAuth,
      parseMessage({ jsonrpc: "2.0", id: 1, method: "resources/templates/list", params: {} }),
    );
    const templateList = (
      templates as { result: { resourceTemplates: Array<{ uriTemplate: string }> } }
    ).result.resourceTemplates;
    expect(templateList).toEqual([]);

    const readRes = await dispatchMcpMessage(
      writeOnlyAuth,
      resourceRead("pos://reports/daily_sales_summary"),
    );
    expect(readRes).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32602 },
    });
    expect(mocks.runSystemReadTool).not.toHaveBeenCalled();
  });
});
