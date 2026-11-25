import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(async (_sql?: unknown, _params?: unknown) => ({ rows: [], rowCount: 0 })),
  audit: vi.fn(async (_entry: Record<string, unknown>) => {}),
}));

vi.mock("../db", () => ({
  query: mocks.query,
  withoutTenantScope: (_reason: string, work: () => unknown) => work(),
  withoutTenantScopeTransaction: (_reason: string, work: () => unknown) => work(),
}));

vi.mock("../platform-auth", () => ({ platformAudit: mocks.audit }));

import { callPlatformMcpTool, type PlatformMcpConnection } from "./platform-mcp";

const connection: PlatformMcpConnection = {
  id: "connection-1",
  adminId: "admin-1",
  adminName: "Admin",
  adminRole: "owner",
  name: "ChatGPT",
  origin: "token",
  capabilities: ["knowledge.manage"],
  businessIds: null,
  status: "active",
  lastUsedAt: null,
  expiresAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

afterEach(() => {
  vi.clearAllMocks();
});

/**
 * The shapes the MCP server log actually produced: the console's own parsers
 * used to be bypassed with `record.input as never`, so these partial records
 * reached Postgres and failed on NOT NULL / `invalid_sort_order` / `trim()`
 * instead of being answered as bad arguments.
 */
const partialRecords = [
  {
    tool: "save_kb_tag",
    record: { input: { slug: "technical-integrations" } },
    message: "missing_label",
  },
  {
    tool: "save_kb_tag",
    record: { id: "83b0fa69-7614-4b6f-bb79-61d5b1ce19f6", input: { slug: "technical-integrations" } },
    message: "missing_label",
  },
  {
    tool: "save_kb_category",
    record: { input: { slug: "platform-settings" } },
    message: "missing_title",
  },
  {
    tool: "save_kb_category",
    record: { id: "e35c2d36-9de3-494e-9bf5-210a82d6e427", input: { slug: "platform-settings" } },
    message: "missing_title",
  },
  {
    tool: "save_kb_article",
    record: { input: { slug: "pos-setup" } },
    message: "missing_title",
  },
  {
    tool: "save_kb_article",
    record: { id: "0b6a0f0e-f6ea-4a5c-9df0-1f2f0f1f0f0f", input: { slug: "pos-setup" } },
    message: "missing_title",
  },
] as const;

describe("platform MCP knowledge save tools", () => {
  it.each(partialRecords)(
    "$tool rejects a partial record.input as invalid_arguments without touching the database",
    async ({ tool, record, message }) => {
      const result = await callPlatformMcpTool(connection, tool, { record });

      expect(result.data).toEqual({ error: "invalid_arguments", message });
      expect(result.text).toContain("invalid arguments");
      expect(mocks.query).not.toHaveBeenCalled();
      expect(mocks.audit).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({ tool, outcome: "invalid_arguments", message }),
        }),
      );
    },
  );

  it("still refuses an assistant-shaped record.input with a bad sortOrder before any write", async () => {
    const result = await callPlatformMcpTool(connection, "save_kb_article", {
      record: { input: { slug: "pos-setup", title: "راه‌اندازی صندوق", sortOrder: 1_000_000_000 } },
    });

    expect(result.data).toEqual({ error: "invalid_arguments", message: "invalid_sort_order" });
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
