import { describe, expect, it, vi } from "vitest";
import type { OpenAiTool } from "./ai";
import {
  PLATFORM_TOOL_CAPABILITIES,
  platformToolsForRole,
  runPlatformAssistantTool,
} from "./ai-platform-assistant";
import { PLATFORM_READ_TOOL_NAMES } from "./ai-platform-tools";

const tool = (name: string): OpenAiTool => ({
  type: "function",
  function: { name, description: name, parameters: { type: "object", properties: {} } },
});

describe("platform assistant tool surface", () => {
  it("names a capability for exactly the platform read tools", () => {
    expect(Object.keys(PLATFORM_TOOL_CAPABILITIES).sort()).toEqual([...PLATFORM_READ_TOOL_NAMES].sort());
  });

  it("offers only declared platform tools the role may call", () => {
    const declared = [tool("get_client_update_status"), tool("get_backup_health"), tool("propose_action"), tool("find_items")];
    const names = platformToolsForRole("owner", declared).map((t) => t.function.name);
    // Tenant tools never enter the platform realm, whatever the caller declares.
    expect(names.sort()).toEqual(["get_backup_health", "get_client_update_status"]);
  });

  it("refuses a tool the model names that is not a platform tool", async () => {
    const run = vi.fn();
    const outcome = await runPlatformAssistantTool("owner", "get_ar_aging", "{}", run);
    expect(outcome.allowed).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("runs an allowed tool with parsed arguments and tolerates garbage arguments", async () => {
    const run = vi.fn(async () => ({ ok: true, data: { n: 1 } }));
    const good = await runPlatformAssistantTool("owner", "get_backup_health", '{"lookbackHours": 6}', run);
    expect(good).toEqual({ name: "get_backup_health", allowed: true, content: '{"n":1}' });
    expect(run).toHaveBeenLastCalledWith("get_backup_health", { lookbackHours: 6 });
    await runPlatformAssistantTool("owner", "get_backup_health", "not json", run);
    expect(run).toHaveBeenLastCalledWith("get_backup_health", {});
    await runPlatformAssistantTool("owner", "get_backup_health", "[1,2]", run);
    expect(run).toHaveBeenLastCalledWith("get_backup_health", {});
  });

  it("reports a failing tool as a failure, never as a result", async () => {
    const outcome = await runPlatformAssistantTool("owner", "get_backup_health", "{}", async () => { throw new Error("db"); });
    expect(outcome).toEqual({ name: "get_backup_health", allowed: true, content: '{"error":"tool_failed"}' });
  });

  it("bounds an oversized tool result", async () => {
    const huge = await runPlatformAssistantTool("owner", "get_backup_health", "{}", async () => ({ ok: true, data: "x".repeat(40_000) }));
    expect(huge.content.length).toBeLessThan(13_000);
    expect(JSON.parse(huge.content).truncated).toBe(true);
  });
});
