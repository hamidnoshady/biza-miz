import { describe, expect, it } from "vitest";

import { canUseAiTool, filterAiToolsByPermissions } from "./ai-capabilities";
import { PERMISSIONS } from "./permissions";
import type { OpenAiTool } from "./ai";

/**
 * The capability edge for external MCP tools (#1473).
 *
 * These names are built per tenant at runtime, so they cannot have a static
 * entry in `AI_TOOL_PERMISSION_MAP`. `ai.use` is the floor; whether a specific
 * server is enabled and whether the tool is in its allowlist is decided by the
 * dispatcher against the database. The test states both halves so a future change
 * cannot turn the floor into a ceiling (a tool no member can use) or remove it
 * (a tool every member can use).
 */
const tool = (name: string): OpenAiTool => ({
  function: { description: "", name, parameters: { properties: {}, type: "object" } },
  type: "function",
});

describe("canUseAiTool for external MCP tools", () => {
  it("allows a namespaced external tool to a member who may use the assistant", () => {
    expect(canUseAiTool("mcp_acme__findpages", new Set([PERMISSIONS.aiUse]))).toBe(true);
  });

  it("refuses it to a member without ai.use", () => {
    expect(canUseAiTool("mcp_acme__findpages", new Set([PERMISSIONS.integrationsView]))).toBe(false);
    expect(canUseAiTool("mcp_acme__findpages", new Set())).toBe(false);
  });

  it("still denies an unknown built-in tool", () => {
    // The external escape hatch must not become a general "any unknown name" pass.
    expect(canUseAiTool("some_unregistered_tool", new Set([PERMISSIONS.aiUse]))).toBe(false);
    expect(canUseAiTool("mcp_state", new Set([PERMISSIONS.aiUse]))).toBe(false);
  });
});

describe("filterAiToolsByPermissions with external tools", () => {
  it("keeps an external tool only for a member holding ai.use", () => {
    const tools = [tool("mcp_acme__findpages"), tool("get_ar_aging")];

    const withAiUse = filterAiToolsByPermissions(tools, new Set([PERMISSIONS.aiUse, PERMISSIONS.aiUse]));
    expect(withAiUse.map((entry) => entry.function.name)).toEqual(["mcp_acme__findpages"]);

    const withoutAiUse = filterAiToolsByPermissions(tools, new Set());
    expect(withoutAiUse).toEqual([]);
  });
});
