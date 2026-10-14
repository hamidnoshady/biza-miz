import { beforeEach, describe, expect, it, vi } from "vitest";
import { PERMISSIONS } from "../permissions";
import type { MemberAccess } from "../member-access";
import type { McpAuthentication } from "./auth";
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

  it("lets a deleted author retain the branch-pinned read grant but strips the owner-only aggregate", async () => {
    mocks.memberAccessForUser.mockResolvedValue(null);
    await dispatchMcpMessage(AUTH, toolCall("run_report", { key: "daily_sales_summary" }));
    const [, , , , actorUserId, permissions, pinnedLocationId] = mocks.runSystemReadTool.mock.calls[0];
    expect(actorUserId).toBeUndefined();
    expect(pinnedLocationId).toBe("location-1");
    expect(permissions?.has(PERMISSIONS.reportsBusinessWide)).toBe(false);
    expect(permissions?.has(PERMISSIONS.reportsView)).toBe(true);
    expect(mocks.resolveActiveLocationForUser).not.toHaveBeenCalled();
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
      undefined,
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
});
