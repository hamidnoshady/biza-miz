import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { createRfq, listProjectRfqs } from "@/lib/aec-procurement-service";
import { requireProjectCapability } from "@/lib/workspace";
import { PERMISSIONS, aecOwner, handleAecError, readBody } from "../../../guard";

/**
 * A project's RFQ register (issue #799 §18) — the "ask three suppliers" step.
 *
 * GET  — every tender on the project, newest first, with its invited-supplier
 *        count, how many offers came back, the lowest offer and the award it
 *        produced, so the register itself shows which tenders are still open.
 * POST — raise one, optionally tied to the material request it answers. It is
 *        numbered `RFQ-001` per project, starts as a draft, and its invitation
 *        list is written with it.
 *
 * Reading is `workspace.view`, writing `workspace.manage`. Issuing the RFQ (the
 * moment its content freezes) is on `…/status` and is *also* `workspace.manage`:
 * asking for prices commits nothing, which is why §24's approval rule lands on
 * the award and not here.
 */
export const GET = withTenantScope(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await aecOwner(PERMISSIONS.workspaceView);
    if (error) return error;
    const { id } = await context.params;
    try {
      await requireProjectCapability(owner, id, "view");
      return NextResponse.json({ rfqs: await listProjectRfqs(owner.businessId, id) });
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
      const rfq = await createRfq(owner, id, await readBody(request));
      return NextResponse.json({ rfq }, { status: 201 });
    } catch (err) {
      return handleAecError(err);
    }
  },
);
