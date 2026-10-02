/**
 * Issue #799 §23 — the AEC read tools' catalogue contract and their refusals.
 *
 * What needs no database is asserted here: the names are the ones §23 chose,
 * every one has a Persian label, the permission map covers each of them, the
 * model-facing catalogue actually defines them, and a business of another
 * industry is refused with a sentence rather than answered with an empty list.
 * The data the tools read is covered in `integration/aec.integration.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { AEC_AI_TOOL_LABELS, AEC_AI_TOOL_NAMES, isAecAiToolName } from "./aec";
import { runAecReadTool } from "./aec-ai-tools";
import { AI_TOOL_PERMISSION_MAP } from "./ai-capabilities";
import { READ_TOOL_NAMES } from "./ai-tools";
import { toolDefinitions } from "./ai";

describe("the AEC read tools", () => {
  it("declares exactly the two the issue names", () => {
    expect([...AEC_AI_TOOL_NAMES]).toEqual([
      "get_aec_project_financial_health",
      "list_delayed_project_activities",
    ]);
    expect(isAecAiToolName("get_aec_project_financial_health")).toBe(true);
    expect(isAecAiToolName("get_workspace_project_status")).toBe(false);
  });

  it("labels each one in Persian and registers a permission for it", () => {
    for (const name of AEC_AI_TOOL_NAMES) {
      expect(AEC_AI_TOOL_LABELS[name]?.trim().length, name).toBeGreaterThan(0);
      // Fails closed: an unregistered tool is denied, so a tool with no entry
      // would be advertised to the model and then always refused.
      expect(AI_TOOL_PERMISSION_MAP[name], name).toBe("workspace.view");
    }
    expect(Object.keys(AEC_AI_TOOL_LABELS).sort()).toEqual([...AEC_AI_TOOL_NAMES].sort());
  });

  it("is executable and model-visible", () => {
    for (const name of AEC_AI_TOOL_NAMES) {
      expect(READ_TOOL_NAMES.has(name), name).toBe(true);
    }
    const defined = new Set(
      toolDefinitions("dashboard").map((tool) => tool.function.name),
    );
    for (const name of AEC_AI_TOOL_NAMES) {
      expect(defined.has(name), name).toBe(true);
    }
  });

  it("refuses another industry in words the model can relay", async () => {
    for (const industry of ["food_service", "service_saas", null]) {
      const result = await runAecReadTool(
        "get_aec_project_financial_health",
        {},
        "00000000-0000-0000-0000-000000000000",
        industry,
      );
      expect(result.ok, String(industry)).toBe(false);
      expect(result.error).toContain("عمران");
    }
  });

  it("refuses a name that is not one of its own", async () => {
    const result = await runAecReadTool(
      "get_workspace_project_status",
      {},
      "00000000-0000-0000-0000-000000000000",
      "architecture_construction",
    );
    expect(result.ok).toBe(false);
  });
});
