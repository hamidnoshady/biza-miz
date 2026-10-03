import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import {
  closeSubmittalRevision,
  decideSubmittalRevision,
  startSubmittalReview,
  submitSubmittalRevision,
  submittalRevisionProjectId,
} from "@/lib/aec-rfi-service";
import { isSubmittalDecision, type SubmittalDecision } from "@/lib/aec-rfi";
import { requireProjectCapability } from "@/lib/workspace";
import { PERMISSIONS, aecOwner, handleAecError, readBody } from "../../../guard";

const ACTIONS = ["submit", "start_review", "decide", "close"] as const;
type Action = (typeof ACTIONS)[number];

/**
 * §11's life cycle, one endpoint — the same shape as the BOQ revision's status
 * route, and it acts on a *revision* (hence the path): a review is always about
 * one submission of one document, and `aec_submittal_revisions` is the row that
 * carries the reviewer, the due date and the determination.
 *
 * Two permissions, deliberately not one (§24's rule that a decision must not
 * inherit ordinary edit rights):
 *
 *   * `submit` is a write to the project — upload the file, send it to a
 *     reviewer — so it needs `workspace.manage`;
 *   * `start_review`, `decide` and `close` are determinations about somebody
 *     else's submission, so they need `workspace.approve`: the key that decides
 *     a contract, an estimate revision and an approval request, and one no role
 *     below manager holds by preset.
 *
 * `decide` carries the reviewer's own four outcomes (`approved`,
 * `approved_with_comments`, `revise_and_resubmit`, `rejected`). The approvals
 * queue can only express two of them, so it maps onto those two and this route
 * is where the finer pair lives — both land in the same service function, so
 * there is one implementation of "approved" and one of "returned".
 *
 * Every action also passes the project-role check, so a manager of another
 * project in the same business cannot review this one's submittals.
 */
export const POST = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { id } = await context.params;
    const body = await readBody(request);
    const action = String(body.action ?? "") as Action;
    if (!ACTIONS.includes(action)) {
      return NextResponse.json({ error: "invalid_action" }, { status: 400 });
    }

    const needed =
      action === "submit" ? PERMISSIONS.workspaceManage : PERMISSIONS.workspaceApprove;
    const { owner, error } = await aecOwner(needed);
    if (error) return error;

    try {
      const { projectId } = await submittalRevisionProjectId(owner.businessId, id);
      await requireProjectCapability(owner, projectId, action === "submit" ? "manage" : "view", true);
      if (action === "submit") {
        return NextResponse.json({ submittal: await submitSubmittalRevision(owner, id, body) });
      }
      if (action === "start_review") {
        return NextResponse.json({ submittal: await startSubmittalReview(owner, id) });
      }
      if (action === "close") {
        return NextResponse.json({ submittal: await closeSubmittalRevision(owner, id) });
      }
      const decision = String(body.decision ?? "");
      if (!isSubmittalDecision(decision)) {
        return NextResponse.json({ error: "invalid_submittal_decision" }, { status: 400 });
      }
      const submittal = await decideSubmittalRevision(
        owner,
        id,
        decision as SubmittalDecision,
        String(body.note ?? ""),
      );
      return NextResponse.json({ submittal });
    } catch (err) {
      return handleAecError(err);
    }
  },
);
