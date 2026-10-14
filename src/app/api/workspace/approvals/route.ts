import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { listApprovals, approvalListPage, requestApproval, type ApprovalListFilter } from "@/lib/workspace";
import {
  APPROVAL_STATUSES,
  APPROVAL_SUBJECTS,
  type WorkspaceApprovalStatus,
  type WorkspaceApprovalSubject,
} from "@/lib/workspace-shared";
import { PERMISSIONS, handleWorkspaceError, readBody, pageParams, workspaceOwner } from "../guard";

/**
 * GET  — the approval inbox, scoped to approvals the caller may see.
 *        `?mine=true` is «منتظر تصمیم من» (assigned to me or unassigned, never
 *        my own request); `?requested=true` is «درخواست‌های من».
 * POST — REQUEST an approval. Requesting is ordinary workspace work
 *        (`workspace.manage`) plus `contribute` on the subject; DECIDING is
 *        `workspace.approve` and lives on `[id]`. The requester can never
 *        decide their own request.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { owner, error } = await workspaceOwner(PERMISSIONS.workspaceView);
  if (error) return error;
  const params = new URL(request.url).searchParams;
  const status = params.get("status");
  const subjectType = params.get("subjectType");
  const filter: ApprovalListFilter = {
    ...pageParams(params),
    status: status && (status === "all" || (APPROVAL_STATUSES as readonly string[]).includes(status))
      ? (status as WorkspaceApprovalStatus | "all")
      : undefined,
    projectId: params.get("projectId") ?? undefined,
    subjectType: subjectType && (APPROVAL_SUBJECTS as readonly string[]).includes(subjectType)
      ? (subjectType as WorkspaceApprovalSubject)
      : undefined,
    subjectId: params.get("subjectId") ?? undefined,
    awaitingActor: params.get("mine") === "true",
    requestedByActor: params.get("requested") === "true",
  };
  try {
    const [approvals, { page, summary }] = await Promise.all([
      listApprovals(owner, filter),
      approvalListPage(owner, filter),
    ]);
    return NextResponse.json({ approvals, page, summary });
  } catch (err) {
    return handleWorkspaceError(err);
  }
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const { owner, error } = await workspaceOwner(PERMISSIONS.workspaceManage);
  if (error) return error;
  const body = await readBody(request);
  try {
    return NextResponse.json({ approval: await requestApproval(owner, body) }, { status: 201 });
  } catch (err) {
    return handleWorkspaceError(err);
  }
});
