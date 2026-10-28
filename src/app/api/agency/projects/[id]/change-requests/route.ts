import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { createAgencyChangeRequest } from "@/lib/agency-commercial-service";
import { PERMISSIONS, agencyOwner, handleAgencyError, readBody } from "../../../guard";

/**
 * A project's change requests (issue #1128 §D) — what altered an engagement
 * after the client agreed to it, and what the client then approved.
 *
 * POST raises one as a draft, numbered `CR-001` per project under the same
 * advisory lock the milestones use. Its amount is signed and never zero: a
 * descope is a negative figure rather than a second column, so the register
 * cannot hold two amounts that have to agree with each other, and the
 * engagement's revised value is one addition rather than a subtraction somebody
 * has to remember.
 *
 * Reading the whole list is `…/commercial`'s GET, which answers the change
 * requests beside the schedule and the P&L they both feed — one read for one
 * panel, rather than three that can disagree about the same project.
 *
 * Approving a change is not here: that is `…/change-requests/[id]/status`, on
 * `workspace.approve`, because agreeing more money with a client must not
 * inherit the right that writes a schedule (§24).
 */
export const POST = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await agencyOwner(PERMISSIONS.workspaceManage, request);
    if (error) return error;
    const { id } = await context.params;
    try {
      const changeRequest = await createAgencyChangeRequest(owner, id, await readBody(request));
      return NextResponse.json({ changeRequest }, { status: 201 });
    } catch (err) {
      return handleAgencyError(err);
    }
  },
);
