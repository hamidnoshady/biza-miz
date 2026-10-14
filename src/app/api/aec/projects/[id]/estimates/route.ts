import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { boqVariance, createEstimate, listProjectEstimates } from "@/lib/aec-boq-service";
import { requireProjectCapability } from "@/lib/workspace";
import { PERMISSIONS, aecOwner, handleAecError, readBody } from "../../../guard";

/**
 * The estimates of one project (issue #799 §7).
 *
 * GET  — every estimate with its revisions, newest first, plus the project's
 *        BOQ variance (the approved revision against the ledger's actual cost).
 *        An empty list is the normal first answer: most projects never keep a
 *        BOQ at all.
 * POST — create an estimate, which arrives with its first draft revision so the
 *        editor has somewhere to put a line.
 *
 * Both go through the workspace module's per-project authorization on top of
 * the platform permission, exactly like the profile and participants routes
 * next door: `workspace.view` narrows to «میز کار من», `requireProjectCapability`
 * narrows to this project, and membership is what grants it — `workspace.admin`
 * is the single business-wide override, as everywhere in this module.
 */
export const GET = withTenantScope(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await aecOwner(PERMISSIONS.workspaceView);
    if (error) return error;
    const { id } = await context.params;
    try {
      await requireProjectCapability(owner, id, "view");
      // Both reads land in one response because the screen shows both together:
      // the revisions and the one number that says how the approved one is
      // doing against what Accounting has posted.
      const [estimates, variance] = await Promise.all([
        listProjectEstimates(owner.businessId, id),
        boqVariance(owner.businessId, id),
      ]);
      return NextResponse.json({ estimates, variance });
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
      await requireProjectCapability(owner, id, "manage");
      const estimate = await createEstimate(owner, id, await readBody(request));
      return NextResponse.json({ estimate }, { status: 201 });
    } catch (err) {
      return handleAecError(err);
    }
  },
);
