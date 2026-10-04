import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { addComment, listComments, resolveWorkspaceSubject } from "@/lib/workspace";
import { APPROVAL_SUBJECTS, type WorkspaceApprovalSubject } from "@/lib/workspace-shared";
import { PERMISSIONS, handleWorkspaceError, readBody, workspaceOwner } from "../guard";

/**
 * One comment thread shape for every commentable subject (project, task,
 * document, contract). Both verbs resolve the subject first
 * (`resolveWorkspaceSubject`): it must exist in this business and be
 * reachable by the caller — `view` to read the thread, `contribute` to add to
 * it — so an arbitrary id can neither be read nor gain an orphan thread.
 */
function subjectOf(value: string | null): WorkspaceApprovalSubject | null {
  return value && (APPROVAL_SUBJECTS as readonly string[]).includes(value)
    ? (value as WorkspaceApprovalSubject)
    : null;
}

export const GET = withTenantScope(async (request: NextRequest) => {
  const { owner, error } = await workspaceOwner(PERMISSIONS.workspaceView);
  if (error) return error;
  const params = new URL(request.url).searchParams;
  const subjectType = subjectOf(params.get("subjectType"));
  const subjectId = params.get("subjectId");
  if (!subjectType || !subjectId) {
    return NextResponse.json({ error: "subject_required" }, { status: 400 });
  }
  try {
    await resolveWorkspaceSubject(owner, subjectType, subjectId, "view");
    return NextResponse.json({ comments: await listComments(owner.businessId, subjectType, subjectId) });
  } catch (err) {
    return handleWorkspaceError(err);
  }
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const { owner, error } = await workspaceOwner(PERMISSIONS.workspaceManage);
  if (error) return error;
  const body = await readBody(request);
  const subjectType = subjectOf(typeof body.subjectType === "string" ? body.subjectType : null);
  const subjectId = typeof body.subjectId === "string" ? body.subjectId : null;
  if (!subjectType || !subjectId) {
    return NextResponse.json({ error: "subject_required" }, { status: 400 });
  }
  try {
    const comments = await addComment(owner, subjectType, subjectId, String(body.body ?? ""));
    return NextResponse.json({ comments }, { status: 201 });
  } catch (err) {
    return handleWorkspaceError(err);
  }
});
