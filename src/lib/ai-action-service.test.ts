import { describe, expect, it } from "vitest";
import { AEC_AI_TOOL_NAMES } from "@/lib/aec";
import { WORKSPACE_TOOL_NAMES } from "@/lib/workspace-shared";
import {
  WORKSPACE_SCOPED_READ_TOOL_NAMES,
  aiActionServiceForEndpoint,
  isWorkspaceAiActionEndpoint,
  isWorkspaceScopedReadTool,
} from "@/lib/ai-action-service";

/**
 * Issue #1110 — the assistant/MCP Workspace tool and action inventory.
 *
 * Filtering the catalogue is only correct if this list stays complete. These
 * assertions fail when a new workspace/AEC read tool is added without being
 * classified, so an ineligible business cannot receive it by omission.
 */
describe("workspace-scoped AI tools", () => {
  it("covers every assistant workspace read", () => {
    for (const name of WORKSPACE_TOOL_NAMES) {
      expect(isWorkspaceScopedReadTool(name), name).toBe(true);
    }
  });

  it("covers every AEC read that answers from project registers", () => {
    for (const name of AEC_AI_TOOL_NAMES) {
      expect(isWorkspaceScopedReadTool(name), name).toBe(true);
    }
  });

  it("does not misclassify shared/ordinary reads", () => {
    for (const name of [
      "list_branches",
      "list_team_members",
      "list_media_assets",
      "run_report",
      "find_customers",
      "list_crm_deals",
    ]) {
      expect(isWorkspaceScopedReadTool(name), name).toBe(false);
    }
  });

  it("classifies the workspace and AEC endpoints, not the shared ones", () => {
    expect(aiActionServiceForEndpoint("/api/workspace/projects")).toEqual({
      kind: "workspace",
      key: "projects",
    });
    expect(aiActionServiceForEndpoint("/api/workspace/documents/42")).toEqual({
      kind: "workspace",
      key: "documents",
    });
    expect(aiActionServiceForEndpoint("/api/aec/projects/1")).toEqual({
      kind: "workspace",
      key: "projects",
    });
    expect(isWorkspaceAiActionEndpoint("/api/workspace/tasks")).toBe(true);
    expect(isWorkspaceAiActionEndpoint("/api/crm/deals")).toBe(false);
    expect(isWorkspaceAiActionEndpoint("/api/accounting/sales")).toBe(false);
  });

  it("keeps one name per tool (no accidental duplicates)", () => {
    expect(new Set(WORKSPACE_SCOPED_READ_TOOL_NAMES).size).toBe(
      WORKSPACE_SCOPED_READ_TOOL_NAMES.length,
    );
  });
});
