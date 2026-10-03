import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { addSubmittalRevision, submittalProjectId } from "@/lib/aec-rfi-service";
import { requireProjectCapability } from "@/lib/workspace";
import { PERMISSIONS, aecOwner, handleAecError, readBody } from "../../../guard";

/**
 * A new revision of a submittal (issue #799 §11) — «اصلاح و ارسال مجدد» done by
 * hand, and the reason a rejected or withdrawn submittal is never a dead end.
 *
 * The reviewer's «Revise & Resubmit» already creates the next draft revision, so
 * this route exists for the two cases the automatic one cannot know about: a
 * submission that was rejected outright and is being replaced, and a register
 * entry whose next submission is raised before the previous one is decided.
 *
 * Drafting is a project write — `workspace.manage` — and the project role is
 * checked as usual. The revision starts empty and editable; §11's cycle begins
 * when somebody submits it.
 */
export const POST = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await aecOwner(PERMISSIONS.workspaceManage);
    if (error) return error;
    const { id } = await context.params;
    try {
      const projectId = await submittalProjectId(owner.businessId, id);
      await requireProjectCapability(owner, projectId, "manage", true);
      const submittal = await addSubmittalRevision(owner, id, await readBody(request));
      return NextResponse.json({ submittal }, { status: 201 });
    } catch (err) {
      return handleAecError(err);
    }
  },
);
