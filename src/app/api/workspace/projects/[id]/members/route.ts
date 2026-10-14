import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { listMembers, removeMember, requireProjectCapability, setMember } from "@/lib/workspace";
import { PERMISSIONS, handleWorkspaceError, readBody, workspaceOwner } from "../../../guard";

/**
 * GET    — the project's team.
 * PUT    — add a member or change their project role (idempotent by user).
 * DELETE — remove a member, unless they are the last owner.
 *
 * Membership is a project-level concept, so the write needs the `manage`
 * capability on THIS project, not merely the business-wide permission.
 */
export const GET = withTenantScope(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await workspaceOwner(PERMISSIONS.workspaceView);
    if (error) return error;
    const { id } = await context.params;
    try {
      await requireProjectCapability(owner, id, "view");
      return NextResponse.json({ members: await listMembers(id) });
    } catch (err) {
      return handleWorkspaceError(err);
    }
  },
);

export const PUT = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await workspaceOwner(PERMISSIONS.workspaceManage);
    if (error) return error;
    const { id } = await context.params;
    const body = await readBody(request);
    try {
      await requireProjectCapability(owner, id, "manage");
      const members = await setMember(owner, id, String(body.userId ?? ""), String(body.role ?? "viewer"));
      return NextResponse.json({ members });
    } catch (err) {
      return handleWorkspaceError(err);
    }
  },
);

export const DELETE = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await workspaceOwner(PERMISSIONS.workspaceManage);
    if (error) return error;
    const { id } = await context.params;
    const userId = new URL(request.url).searchParams.get("userId") ?? "";
    try {
      await requireProjectCapability(owner, id, "manage");
      return NextResponse.json({ members: await removeMember(owner, id, userId) });
    } catch (err) {
      return handleWorkspaceError(err);
    }
  },
);
