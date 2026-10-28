import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { createAgencyMilestone } from "@/lib/agency-commercial-service";
import { PERMISSIONS, agencyOwner, handleAgencyError, readBody } from "../../../guard";

/**
 * Adds one stage to a project's billing schedule (issue #1128 §D).
 *
 * The whole schedule is laid out by `…/commercial`'s POST; this is the single
 * row added afterwards — a stage the client agreed to later, a retainer period
 * being billed, or one period of hourly work whose time is now known. It starts
 * as a draft and is numbered `MS-001` per project by the service, under an
 * advisory lock, so two people adding a stage at the same moment cannot both be
 * handed the same number.
 *
 * A milestone is a percentage of the engagement's revised value *or* a fixed
 * Rial amount, never both and never neither; the service refuses either mistake
 * with `invalid_milestone_amount`. Sending it for approval is `…/[id]/status`,
 * and billing it is `invoice` there — on `workspace.approve` plus the invoice
 * screen's own permissions, never here.
 */
export const POST = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await agencyOwner(PERMISSIONS.workspaceManage, request);
    if (error) return error;
    const { id } = await context.params;
    try {
      const milestone = await createAgencyMilestone(owner, id, await readBody(request));
      return NextResponse.json({ milestone }, { status: 201 });
    } catch (err) {
      return handleAgencyError(err);
    }
  },
);
