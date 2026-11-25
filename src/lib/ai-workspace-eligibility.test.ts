import { describe, expect, it } from "vitest";
import { appContextLines, toolDefinitions } from "@/lib/ai";
import { WORKSPACE_SCOPED_READ_TOOL_NAMES } from "@/lib/ai-action-service";

function toolNames(available: boolean | undefined): string[] {
  return toolDefinitions("dashboard", { workspaceAiAvailable: available }).map(
    (tool) => tool.function.name,
  );
}

function proposeTypes(available: boolean | undefined): string[] {
  const tool = toolDefinitions("dashboard", { workspaceAiAvailable: available }).find(
    (candidate) => candidate.function.name === "propose_action",
  );
  const properties = tool?.function.parameters as
    | { properties?: { type?: { enum?: string[] } } }
    | undefined;
  return properties?.properties?.type?.enum ?? [];
}

/**
 * Issue #1110 — capability-aware AI composition.
 *
 * An ineligible business's assistant must not receive Workspace/AEC tools or
 * the Workspace feature inventory, and must be told to answer a direct question
 * with a short "not available" instead of a navigation suggestion.
 */
describe("assistant prompt and tools for an unavailable Workspace", () => {
  it("offers the Workspace/AEC reads when available", () => {
    const names = toolNames(true);
    for (const name of WORKSPACE_SCOPED_READ_TOOL_NAMES) {
      expect(names, name).toContain(name);
    }
    expect(proposeTypes(true)).toContain("project.create");
    expect(appContextLines({ mode: "dashboard", workspaceAiAvailable: true }).join("\n")).toContain(
      "get_workspace_project_status",
    );
  });

  it("removes every Workspace/AEC read and action when unavailable", () => {
    const names = toolNames(false);
    for (const name of WORKSPACE_SCOPED_READ_TOOL_NAMES) {
      expect(names, name).not.toContain(name);
    }
    const types = proposeTypes(false);
    expect(types).not.toContain("project.create");
    expect(types).not.toContain("project.task.add");
    expect(types).not.toContain("project.memory.add");
  });

  it("does not advertise the feature and gives the refusal instruction", () => {
    const prompt = appContextLines({
      mode: "dashboard",
      workspaceAiAvailable: false,
    }).join("\n");
    expect(prompt).not.toContain("«میز کار من» جایی است");
    expect(prompt).not.toContain("get_workspace_project_status");
    expect(prompt).not.toContain("list_workspace_tasks");
    expect(prompt).not.toContain("get_aec_project_financial_health");
    expect(prompt).toContain("در دسترس نیست");
  });

  it("keeps unrelated assistant functionality and the ordinary word project", () => {
    const prompt = appContextLines({
      mode: "dashboard",
      workspaceAiAvailable: false,
    }).join("\n");
    expect(prompt).toContain("run_report");
    expect(prompt).toContain("propose_action");
    expect(prompt).toContain("پروژه");
  });
});
