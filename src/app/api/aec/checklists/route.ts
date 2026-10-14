import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { createChecklist, listChecklists } from "@/lib/aec-site-service";
import { PERMISSIONS, aecOwner, handleAecError, readBody } from "../guard";

/**
 * The firm's inspection and handover checklists (issue #799 §14).
 *
 * Business-scoped rather than project-scoped, because that is what a checklist
 * *is*: the firm's standard. A project-scoped one (`projectId`) is for the
 * client who insists on their own, and the register's service refuses a
 * project's checklist on another project.
 *
 * There is no project-role check here — the resource is the business's, not one
 * project's — so the gate is `workspace.view` to read and `workspace.manage` to
 * write, plus the `qa_qc` capability the service asserts.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { owner, error } = await aecOwner(PERMISSIONS.workspaceView);
  if (error) return error;
  const params = request.nextUrl.searchParams;
  try {
    const checklists = await listChecklists(owner.businessId, {
      projectId: params.get("projectId") ?? undefined,
      kind: params.get("kind") ?? undefined,
      includeInactive: params.get("includeInactive") === "1",
    });
    return NextResponse.json({ checklists });
  } catch (err) {
    return handleAecError(err);
  }
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const { owner, error } = await aecOwner(PERMISSIONS.workspaceManage);
  if (error) return error;
  try {
    const checklist = await createChecklist(owner, await readBody(request));
    return NextResponse.json({ checklist }, { status: 201 });
  } catch (err) {
    return handleAecError(err);
  }
});
