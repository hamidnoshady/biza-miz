import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import {
  getWorkspaceProjectWithHealth,
  listActivity,
  listMembers,
  listPhases,
  projectReport,
  requireProjectCapability,
  updateWorkspaceProject,
} from "@/lib/workspace";
import { projectCapabilities, workspaceAccessFlags } from "@/lib/workspace-shared";
import { PERMISSIONS, handleWorkspaceError, readBody, workspaceOwner } from "../../guard";

/**
 * GET   — one project with everything its page needs: phases, members,
 *         activity, the caller's effective role and the capability object the
 *         page renders its controls from.
 * PATCH — amend the project record (`manage`); transferring ownership is
 *         `administer` — an owner act.
 *
 * Holding `workspace.view` means "may use the workspace", not "may read every
 * project in it": the project role decides, and a non-member without the
 * explicit `workspace.admin` override (or the ledger reader's read-only one)
 * gets a 404.
 */
export const GET = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await workspaceOwner(PERMISSIONS.workspaceView, request);
    if (error) return error;
    const { id } = await context.params;
    try {
      const role = await requireProjectCapability(owner, id, "view");
      const [project, phases, members, activity, [report]] = await Promise.all([
        getWorkspaceProjectWithHealth(owner, id),
        listPhases(id),
        listMembers(id),
        listActivity(owner, { projectId: id, limit: 20 }),
        projectReport(owner, { projectId: id }),
      ]);
      if (!project) return NextResponse.json({ error: "project_not_found" }, { status: 404 });
      // The cockpit's attention strip, from the same scoped report the Reports
      // section reads (spend is null without ledger.view, and then budget is
      // simply not judged). The expiring-contract count is the project row's
      // own — the same one the portfolio card was judged on (issue #907 F07) —
      // and the verdict itself is the server's, not rebuilt here.
      const attention = {
        overdueTasks: report?.overdueTaskCount ?? 0,
        pendingApprovals: report?.openApprovals ?? 0,
        expiringContracts: project.expiringContractCount,
        spentRial: report?.spentRial ?? null,
        contractValueRial: report?.contractValueRial ?? 0,
      };
      const health = project.health;
      const capabilities = projectCapabilities(role, owner.access ?? workspaceAccessFlags(new Set()));
      return NextResponse.json({ project, phases, members, activity, role, capabilities, attention, health });
    } catch (err) {
      return handleWorkspaceError(err);
    }
  },
);

export const PATCH = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await workspaceOwner(PERMISSIONS.workspaceManage, request);
    if (error) return error;
    const { id } = await context.params;
    const body = await readBody(request);
    try {
      await requireProjectCapability(owner, id, body.ownerUserId !== undefined ? "administer" : "manage");
      const project = await updateWorkspaceProject(owner, id, body);
      if (!project) return NextResponse.json({ error: "project_not_found" }, { status: 404 });
      return NextResponse.json({ project });
    } catch (err) {
      return handleWorkspaceError(err);
    }
  },
);
