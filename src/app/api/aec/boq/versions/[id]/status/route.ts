import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import {
  approveEstimateVersion,
  returnEstimateVersion,
  startEstimateReview,
  submitEstimateVersion,
  versionContextProjectId,
} from "@/lib/aec-boq-service";
import { requireProjectCapability } from "@/lib/workspace";
import { PERMISSIONS, aecOwner, handleAecError, readBody } from "../../../../guard";

const ACTIONS = ["submit", "start_review", "approve", "return"] as const;
type Action = (typeof ACTIONS)[number];

/**
 * The revision's life cycle, one endpoint: §7's
 * draft → submitted → under review → approved → superseded, expressed as the
 * four moves a person makes.
 *
 * Two permissions, deliberately not one (issue §24 — a commercial action must
 * not inherit ordinary task-edit rights):
 *
 *   * `submit` is a write to the project, so it needs `workspace.manage`;
 *   * `start_review`, `approve` and `return` are decisions about somebody
 *     else's numbers, so they need `workspace.approve` — the same key that
 *     decides a contract, and one no role below manager holds by preset.
 *
 * Every action also passes the project-role check, so a manager of another
 * project in the same business cannot approve this one's estimate.
 */
export const POST = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await aecOwner(PERMISSIONS.workspaceView);
    if (error) return error;
    const { id } = await context.params;
    const body = await readBody(request);
    const action = String(body.action ?? "") as Action;
    if (!ACTIONS.includes(action)) {
      return NextResponse.json({ error: "invalid_action" }, { status: 400 });
    }

    const needed = action === "submit" ? PERMISSIONS.workspaceManage : PERMISSIONS.workspaceApprove;
    const gate = await requirePermission(needed);
    if (gate.error) return gate.error;

    try {
      const { projectId } = await versionContextProjectId(owner.businessId, id);
      await requireProjectCapability(owner, projectId, action === "submit" ? "manage" : "view");
      const note = String(body.note ?? "");
      if (action === "submit") {
        const version = await submitEstimateVersion(owner, id, body);
        return NextResponse.json({ version });
      }
      if (action === "start_review") {
        return NextResponse.json({ version: await startEstimateReview(owner, id) });
      }
      if (action === "approve") {
        return NextResponse.json(await approveEstimateVersion(owner, id, note));
      }
      return NextResponse.json({ version: await returnEstimateVersion(owner, id, note) });
    } catch (err) {
      return handleAecError(err);
    }
  },
);
