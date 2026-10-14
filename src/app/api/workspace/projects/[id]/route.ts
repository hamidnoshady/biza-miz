import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import {
  contractListPage,
  getWorkspaceProject,
  listActivity,
  listMembers,
  listPhases,
  projectReport,
  requireProjectCapability,
  updateWorkspaceProject,
} from "@/lib/workspace";
import { todayIsoDate } from "@/lib/jalali";
import { projectCapabilities, projectHealth, workspaceAccessFlags } from "@/lib/workspace-shared";
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
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await workspaceOwner(PERMISSIONS.workspaceView);
    if (error) return error;
    const { id } = await context.params;
    try {
      const role = await requireProjectCapability(owner, id, "view");
      const [project, phases, members, activity, [report], expiring] = await Promise.all([
        getWorkspaceProject(owner.businessId, id),
        listPhases(id),
        listMembers(id),
        listActivity(owner, { projectId: id, limit: 20 }),
        projectReport(owner, { projectId: id }),
        contractListPage(owner, { projectId: id, status: "all", expiringWithinDays: 30, limit: 1 }),
      ]);
      if (!project) return NextResponse.json({ error: "project_not_found" }, { status: 404 });
      // The cockpit's attention strip and health verdict, from the same
      // scoped report the Reports section reads (spend is null without
      // ledger.view, and then budget is simply not judged).
      const attention = {
        overdueTasks: report?.overdueTaskCount ?? 0,
        pendingApprovals: report?.openApprovals ?? 0,
        expiringContracts: expiring.page.total,
        spentRial: report?.spentRial ?? null,
        contractValueRial: report?.contractValueRial ?? 0,
      };
      const health = projectHealth({
        today: todayIsoDate(),
        startDate: project.startDate,
        endDate: project.endDate,
        completed: project.status === "completed",
        taskCount: project.taskCount,
        doneTaskCount: project.doneTaskCount,
        overdueTaskCount: attention.overdueTasks,
        budgetRial: project.budgetRial,
        spentRial: attention.spentRial,
        pendingApprovals: attention.pendingApprovals,
        expiringContracts: attention.expiringContracts,
      });
      const capabilities = projectCapabilities(role, owner.access ?? workspaceAccessFlags(new Set()));
      return NextResponse.json({ project, phases, members, activity, role, capabilities, attention, health });
    } catch (err) {
      return handleWorkspaceError(err);
    }
  },
);

export const PATCH = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await workspaceOwner(PERMISSIONS.workspaceManage);
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
