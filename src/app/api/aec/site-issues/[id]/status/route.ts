import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { applySiteIssueAction, siteIssueProjectId } from "@/lib/aec-site-service";
import { isSiteIssueAction, siteIssueActionNeedsApproval } from "@/lib/aec-site";
import { requireProjectCapability } from "@/lib/workspace";
import { PERMISSIONS, aecOwner, handleAecError, readBody } from "../../../guard";

/**
 * §14's four moves, one endpoint — the same shape as the RFI and submittal
 * status routes, and for the same reason: the transitions belong together, so
 * the chain is one readable list rather than four routes that can drift.
 *
 * Two permissions, deliberately not one (§24's rule that a decision must not
 * inherit ordinary edit rights):
 *
 *   * `start`, `resolve` and `cancel` are site work — somebody did something
 *     about a finding — so they need `workspace.manage`;
 *   * `close` is the closeout verification §14 names, the act that accepts
 *     somebody else's fix, so it needs `workspace.approve` — and the service
 *     additionally refuses it when the verifier *is* the assignee, which is what
 *     makes the verification a check rather than a formality.
 */
export const POST = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { id } = await context.params;
    const body = await readBody(request);
    const action = String(body.action ?? "");
    if (!isSiteIssueAction(action)) {
      return NextResponse.json({ error: "invalid_action" }, { status: 400 });
    }

    const needed = siteIssueActionNeedsApproval(action)
      ? PERMISSIONS.workspaceApprove
      : PERMISSIONS.workspaceManage;
    const { owner, error } = await aecOwner(needed);
    if (error) return error;

    try {
      const projectId = await siteIssueProjectId(owner.businessId, id);
      await requireProjectCapability(
        owner,
        projectId,
        siteIssueActionNeedsApproval(action) ? "view" : "manage",
        true,
      );
      const issue = await applySiteIssueAction(owner, id, action, {
        resolutionNote: body.resolutionNote,
        result: body.result,
        closeoutNote: body.closeoutNote,
      });
      return NextResponse.json({ issue });
    } catch (err) {
      return handleAecError(err);
    }
  },
);
