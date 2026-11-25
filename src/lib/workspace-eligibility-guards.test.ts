import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Issue #1110 — every entry point must consume the ONE decision.
 *
 * These are source contracts rather than runtime tests: the pages and guards are
 * server components that need a database and a browser to execute, while the
 * risk they encode is a future edit quietly reintroducing an unguarded path.
 */
function read(path: string): string {
  return readFileSync(path, "utf8");
}

describe("My Workspace eligibility at every entry point", () => {
  it("hides the rail row without rendering a disabled/padlocked item", () => {
    const sidebar = read("src/app/dashboard/dashboard-sidebar.tsx");
    const railStart = sidebar.indexOf("function WorkspaceRail");
    const railEnd = sidebar.indexOf("\nfunction SidebarBrand", railStart);
    const rail = sidebar.slice(railStart, railEnd);
    expect(rail).toContain("workspaceAvailable");
    expect(rail).toMatch(/workspaceAvailable \?\s*\(\s*<SidebarMenuItem>/);
    expect(rail).toContain("میز کار من");
    // The contextual nav is only selected when the area exists.
    expect(sidebar).toContain(
      "const workspaceRoute = workspaceAvailable && isWorkspacePathname(pathname);",
    );
  });

  it("computes one decision in the shell and empties sections when hidden", () => {
    const shell = read("src/app/dashboard/workspace-shell.tsx");
    expect(shell).toContain("resolveWorkspaceAccessDecision");
    expect(shell).toContain("const workspaceAvailable = workspaceAccess.available;");
    expect(shell).toContain("const workspaceSections = workspaceAvailable");
    expect(shell).toContain("workspaceAvailable={workspaceAvailable}");
    expect(shell).toContain("workspaceAvailable,");
  });

  it("guards every Workspace page with the shared page gate", () => {
    for (const path of [
      "src/app/(app)/workspace/workspace-page-body.tsx",
      "src/app/(app)/workspace/projects/[id]/page.tsx",
      "src/app/(app)/workspace/projects/[id]/field/page.tsx",
      "src/app/(app)/workspace/contracts/[id]/page.tsx",
      "src/app/(app)/workspace/contracts/[id]/print/page.tsx",
    ]) {
      const source = read(path);
      expect(source, path).toContain("requireWorkspacePageAccess");
      expect(source, path).toContain("member.permissions");
    }
  });

  it("checks the decision on reads as well as writes in the API guard", () => {
    const guard = read("src/app/api/workspace/guard.ts");
    const accessCheck = guard.indexOf("workspaceAccessFor(session.businessId");
    const mutationCheck = guard.indexOf("request.method.toUpperCase()");
    expect(accessCheck).toBeGreaterThan(-1);
    expect(mutationCheck).toBeGreaterThan(-1);
    expect(accessCheck).toBeLessThan(mutationCheck);
    expect(guard).toContain("WORKSPACE_UNAVAILABLE_ERROR");
  });

  it("guards AEC routes through the same decision", () => {
    const guard = read("src/app/api/aec/guard.ts");
    expect(guard).toContain("workspaceAccessFor(session.businessId, membership.permissions)");
    expect(guard).toContain("WORKSPACE_UNAVAILABLE_ERROR");
  });

  it("revalidates Workspace/AEC reads at execution time", () => {
    const tools = read("src/lib/ai-tools.ts");
    const workspaceBranch = tools.indexOf("if (isWorkspaceToolName(name))");
    const workspaceExec = tools.indexOf("runWorkspaceReadTool(name", workspaceBranch);
    const aecBranch = tools.indexOf("if (isAecAiToolName(name))");
    const aecExec = tools.indexOf("runAecReadTool(", aecBranch);
    const checks = tools.match(/workspaceAccessFor\(businessId, permissions/g) ?? [];
    expect(checks.length).toBeGreaterThanOrEqual(2);
    expect(tools.slice(workspaceBranch, workspaceExec)).toContain("workspaceAccessFor");
    expect(tools.slice(aecBranch, aecExec)).toContain("workspaceAccessFor");
  });

  it("filters the AI catalogue and the MCP catalogue, while re-checking writes", () => {
    const ai = read("src/lib/ai.ts");
    expect(ai).toContain("isWorkspaceAiActionEndpoint");
    expect(ai).toContain("isWorkspaceScopedReadTool");
    expect(read("src/lib/ai-service.ts")).toContain(
      "workspaceAiAvailable: promptContext.workspaceAiAvailable",
    );
    const mcp = read("src/lib/mcp/tools.ts");
    expect(mcp).toContain("workspaceAvailable?: boolean");
    expect(mcp).toContain("isWorkspaceScopedReadTool");
    expect(mcp).toContain("isWorkspaceAiActionEndpoint");
    expect(read("src/lib/mcp/server.ts")).toContain("workspaceAccessFor(auth.businessId, auth.permissions)");
    expect(read("src/lib/mcp/write-service.ts")).toContain("aiActionServiceGate");
  });

  it("filters knowledge guides and the learning centre for the same business", () => {
    for (const path of [
      "src/app/api/knowledge/route.ts",
      "src/app/api/knowledge/catalogue/route.ts",
      "src/app/api/knowledge/search/route.ts",
      "src/app/api/knowledge/articles/[slug]/route.ts",
      "src/app/api/knowledge/recommendations/route.ts",
      "src/app/api/knowledge/tours/route.ts",
      "src/app/api/knowledge/tours/[tourId]/route.ts",
      "src/lib/ai-tools.ts",
    ]) {
      const source = read(path);
      expect(source, path).toContain("workspaceAccessFor");
    }
    for (const path of [
      "src/app/api/knowledge/route.ts",
      "src/app/api/knowledge/catalogue/route.ts",
      "src/app/api/knowledge/search/route.ts",
      "src/app/api/knowledge/articles/[slug]/route.ts",
      "src/lib/ai-tools.ts",
    ]) {
      expect(read(path), path).toMatch(
        /WORKSPACE_KNOWLEDGE_SECTION_KEYS|isWorkspaceKnowledgeSection/,
      );
    }
  });

  it("gates Workspace imports and exports through the same decision", () => {
    const guard = read("src/app/api/data/guard.ts");
    expect(guard).toContain('entity.module === "workspace"');
    expect(guard).toContain("workspace_not_available");
    expect(read("src/app/api/data/entities/route.ts")).toContain(
      'entity.module !== "workspace"',
    );
    expect(read("src/lib/data-transfer/import-service.ts")).toContain(
      "workspace_not_available",
    );
  });

  it("keeps the API-side decision free of the page redirect layer", () => {
    expect(read("src/lib/workspace-access.ts")).not.toContain("next/navigation");
    expect(read("src/lib/workspace-page-access.ts")).toContain("next/navigation");
    expect(read("src/lib/workspace-page-access.ts")).toContain("requireWorkspacePageAccess");
  });

  it("stops and resumes the Workspace billing clock on an industry change", () => {
    const activation = read("src/lib/service-activation/activation-service.ts");
    expect(activation).toContain("applyWorkspaceEligibilityToRuntime");
    expect(activation).toContain('interval.service_kind === "workspace"');
    expect(activation).toContain("workspaceServiceIndustryAllowed(input.businessId)");
    const platform = read("src/lib/platform-service.ts");
    expect(platform).toContain("applyWorkspaceEligibilityToRuntime");
    expect(platform).toContain("isWorkspaceEligibleIndustry(industry)");
  });

  it("refuses activation and re-enable for an ineligible business type", () => {
    const activation = read("src/lib/service-activation/activation-service.ts");
    expect(activation).toContain("workspaceServiceIndustryAllowed");
    expect(activation).toContain('reason: "business_type_unsupported"');
    expect(activation).toContain("...(workspaceServiceAllowed ? WORKSPACE_SERVICE_DEFINITIONS : [])");
  });
});
