import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { createSubmittal, listProjectSubmittals } from "@/lib/aec-rfi-service";
import { requireProjectCapability } from "@/lib/workspace";
import { PERMISSIONS, aecOwner, handleAecError, readBody } from "../../../guard";

/**
 * A project's submittal log (issue #799 §11).
 *
 * GET  — every submittal with its current revision's status, whether it is
 *        waiting on a reviewer, and whether that review is late. Optional
 *        `status`, `type`, `search` and `waitingOnly` filters.
 * POST — register one. It arrives as revision 1 in draft: the number is booked,
 *        the file is attached, and «ارسال» is what puts it in front of a
 *        reviewer (§11's Draft → Submitted).
 *
 * Registering is `workspace.manage`; *deciding* the review is `workspace.approve`
 * and rides the approvals queue — see the status route.
 */
export const GET = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await aecOwner(PERMISSIONS.workspaceView);
    if (error) return error;
    const { id } = await context.params;
    const params = request.nextUrl.searchParams;
    try {
      await requireProjectCapability(owner, id, "view", true);
      const submittals = await listProjectSubmittals(owner.businessId, id, {
        status: params.get("status") ?? undefined,
        type: params.get("type") ?? undefined,
        search: params.get("search") ?? undefined,
        waitingOnly: params.get("waitingOnly") === "1",
      });
      return NextResponse.json({ submittals });
    } catch (err) {
      return handleAecError(err);
    }
  },
);

export const POST = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await aecOwner(PERMISSIONS.workspaceManage);
    if (error) return error;
    const { id } = await context.params;
    try {
      await requireProjectCapability(owner, id, "manage", true);
      const submittal = await createSubmittal(owner, id, await readBody(request));
      return NextResponse.json({ submittal }, { status: 201 });
    } catch (err) {
      return handleAecError(err);
    }
  },
);
