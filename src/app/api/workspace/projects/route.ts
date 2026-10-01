import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import {
  createWorkspaceProject,
  listWorkspaceProjects,
  type ProjectListFilter,
} from "@/lib/workspace";
import type { WorkspacePriority, WorkspaceProjectStatus } from "@/lib/workspace-shared";
import { PERMISSIONS, handleWorkspaceError, readBody, workspaceOwner } from "../guard";

/**
 * GET  — the workspace project list, with the filters the Projects section
 *        offers (status, priority, customer, tag, mine-only, search).
 * POST — create a project: the workspace record, its template phases and its
 *        creator-as-owner membership.
 *
 * The list is only the projects the caller is a member of (or every project
 * for a `workspace.admin` / ledger reader). The reads run on `workspace.view`,
 * the write on `workspace.manage`. Both
 * operate on `ai_projects`, the same table the pre-Phase-G `/api/ai/projects`
 * routes use — those keep working untouched, which is what "evolution, not
 * rewrite" means at the API boundary.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { owner, error } = await workspaceOwner(PERMISSIONS.workspaceView);
  if (error) return error;
  const params = new URL(request.url).searchParams;

  const filter: ProjectListFilter = {
    status: (params.get("status") as WorkspaceProjectStatus | "all") ?? undefined,
    priority: (params.get("priority") as WorkspacePriority) ?? undefined,
    partyId: params.get("partyId") ?? undefined,
    tag: params.get("tag") ?? undefined,
    search: params.get("q") ?? undefined,
    includeArchived: params.get("archived") === "true",
    // "Only mine" is resolved from the session, never from a query parameter:
    // a client-supplied user id here would be a read of somebody else's list.
    memberUserId: params.get("mine") === "true" ? owner.actorUserId : undefined,
  };
  try {
    return NextResponse.json({ projects: await listWorkspaceProjects(owner, filter) });
  } catch (err) {
    return handleWorkspaceError(err);
  }
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const { owner, error } = await workspaceOwner(PERMISSIONS.workspaceManage);
  if (error) return error;
  const body = await readBody(request);
  try {
    const project = await createWorkspaceProject(owner, body);
    return NextResponse.json({ project }, { status: 201 });
  } catch (err) {
    return handleWorkspaceError(err);
  }
});
