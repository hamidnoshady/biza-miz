import { describe, expect, it } from "vitest";
import { PERMISSIONS } from "@/lib/permissions";
import { WORKSPACE_MODULE_HOME, workspaceSectionHref } from "@/lib/app-routes";
import {
  isWorkspaceSectionPathname,
  visibleWorkspaceSections,
  WORKSPACE_SECTION_GROUPS,
  WORKSPACE_SECTION_META,
  workspaceCreateActions,
} from "./workspace-routes";
import { WORKSPACE_SECTIONS } from "@/lib/workspace-shared";

describe("My Workspace navigation", () => {
  it("groups each real section once in the focused contextual menu", () => {
    const grouped = WORKSPACE_SECTION_GROUPS.flatMap((group) => group.keys);
    expect(grouped).toEqual([...WORKSPACE_SECTIONS]);
    expect(new Set(grouped).size).toBe(grouped.length);
    expect(WORKSPACE_SECTION_GROUPS.map((group) => group.label)).toEqual([
      "کار روزانه",
      "بیشتر",
    ]);
  });

  it("keeps a section current on its nested detail route", () => {
    expect(isWorkspaceSectionPathname(WORKSPACE_MODULE_HOME, "overview")).toBe(true);
    expect(isWorkspaceSectionPathname(workspaceSectionHref("overview"), "overview")).toBe(true);
    expect(isWorkspaceSectionPathname("/workspace/projects/p-42/contracts", "projects")).toBe(true);
    expect(isWorkspaceSectionPathname("/workspace/projects/p-42", "tasks")).toBe(false);
  });

  it("only offers sections that the member can actually open", () => {
    const readOnly = visibleWorkspaceSections([PERMISSIONS.workspaceView]);
    expect(readOnly.map((section) => section.key)).not.toContain("templates");

    const manager = visibleWorkspaceSections([
      PERMISSIONS.workspaceView,
      PERMISSIONS.workspaceManage,
    ]);
    expect(manager.map((section) => section.key)).toEqual(Object.keys(WORKSPACE_SECTION_META));
  });
});

describe("workspaceCreateActions", () => {
  it("offers only what the platform permissions allow", () => {
    expect(workspaceCreateActions(["workspace.view"])).toEqual([]);
    const keys = workspaceCreateActions(["workspace.view", "workspace.manage"]).map((a) => a.key);
    expect(keys).toEqual(["project", "task", "event", "document", "member"]);
    expect(
      workspaceCreateActions(["workspace.manage", "workspace.contracts_manage"]).map((a) => a.key),
    ).toContain("contract");
  });

  it("preselects the project inside one, and drops «new project» there", () => {
    const actions = workspaceCreateActions(["workspace.manage"], "p-1");
    expect(actions.map((a) => a.key)).not.toContain("project");
    expect(actions.find((a) => a.key === "task")?.href).toBe(
      `${workspaceSectionHref("tasks")}?create=1&project=p-1`,
    );
  });
});
