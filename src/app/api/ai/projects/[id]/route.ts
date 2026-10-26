import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import {
  getProject,
  getProjectCostSummary,
  listProjectAssignableOwners,
  updateProject,
  archiveProject,
  unarchiveProject,
} from "@/lib/ai-projects";
import { requireProjectCapability } from "@/lib/workspace";
import { PERMISSIONS, handleWorkspaceError, workspaceOwner } from "@/app/api/workspace/guard";

/**
 * GET    — one project
 * PATCH  — update name/instructions/status/owner/budget
 * DELETE — archive (soft delete)
 *
 * Issue #907 F01 — the project role decides, not merely membership of the
 * business: `view` to read, `manage` to amend the record, `administer` to
 * transfer ownership or to archive. Before this, any same-business member with
 * a known project id could PATCH the budget, hand the project to themselves as
 * owner, or archive it, because the only check was `getSession()`.
 */

export const GET = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner: actor, error } = await workspaceOwner(PERMISSIONS.workspaceView, request);
    if (error) return error;
    const { id } = await context.params;

    try {
      await requireProjectCapability(actor, id, "view");
      const owner = { businessId: actor.businessId, actorUserId: actor.actorUserId, projectId: id };
      const [project, cost, owners] = await Promise.all([
        getProject(owner), getProjectCostSummary(owner), listProjectAssignableOwners(owner),
      ]);
      if (!project) return NextResponse.json({ error: "not_found" }, { status: 404 });
      // Issue #812 §4 — no `agents` list any more. A tenant has no agent builder,
      // so there is nothing to pin: a system agent reaches this project through a
      // Superadmin assignment, never through a project setting.
      return NextResponse.json({ project, cost, owners });
    } catch (err) {
      return handleWorkspaceError(err);
    }
  },
);

export const PATCH = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner: actor, error } = await workspaceOwner(PERMISSIONS.workspaceManage, request);
    if (error) return error;
    const { id } = await context.params;

    const body = await request.json().catch(() => null);
    if (!body) return NextResponse.json({ error: "invalid body" }, { status: 400 });

    try {
      // Handing the project to another owner is an owner act, exactly as it is
      // on the workspace route; everything else here is manager work.
      await requireProjectCapability(actor, id, body.ownerUserId !== undefined ? "administer" : "manage");
      const project = await updateProject(
        { businessId: actor.businessId, actorUserId: actor.actorUserId, projectId: id },
        {
          ...(typeof body.name === "string" ? { name: body.name } : {}),
          ...(typeof body.instructions === "string" ? { instructions: body.instructions } : {}),
          ...(body.status === "active" || body.status === "paused" || body.status === "completed" ? { status: body.status } : {}),
          ...(typeof body.ownerUserId === "string" || body.ownerUserId === null ? { ownerUserId: body.ownerUserId } : {}),
          ...(typeof body.budgetRial === "number" || body.budgetRial === null ? { budgetRial: body.budgetRial } : {}),
        },
      );
      if (!project) return NextResponse.json({ error: "not_found" }, { status: 404 });
      return NextResponse.json({ project });
    } catch (err) {
      if (err instanceof Error && [
        "invalid_project_status", "invalid_project_budget", "project_owner_not_found",
      ].includes(err.message)) {
        return NextResponse.json({ error: err.message }, { status: 400 });
      }
      if (err instanceof Error && err.message.includes("character limit")) {
        return NextResponse.json({ error: "instructions exceed the character limit" }, { status: 400 });
      }
      return handleWorkspaceError(err);
    }
  },
);

export const DELETE = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner: actor, error } = await workspaceOwner(PERMISSIONS.workspaceManage, request);
    if (error) return error;
    const { id } = await context.params;

    const url = new URL(request.url);
    const unarchive = url.searchParams.get("unarchive") === "true";

    try {
      // Archiving (and restoring) a project is the `administer` capability —
      // the workspace's own project routes use the same one.
      await requireProjectCapability(actor, id, "administer");
      const owner = { businessId: actor.businessId, actorUserId: actor.actorUserId, projectId: id };
      const ok = unarchive ? await unarchiveProject(owner) : await archiveProject(owner);
      if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
      return NextResponse.json({ ok: true });
    } catch (err) {
      return handleWorkspaceError(err);
    }
  },
);
