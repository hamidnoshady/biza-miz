import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { createMaterialRequest, listProjectRequests } from "@/lib/aec-procurement-service";
import { requireProjectCapability } from "@/lib/workspace";
import { PERMISSIONS, aecOwner, handleAecError, readBody } from "../../../guard";

/**
 * A project's material-request register (issue #799 §18), the first step of the
 * flow: requirement → request → RFQ → quotations → award → delivery.
 *
 * GET  — every request on the project, newest first, each with its priority, the
 *        date it is needed by, how many lines and offers hang off it and how long
 *        it has been waiting on somebody (`daysWaiting`, measured from the
 *        submission — a draft is not late, it is unwritten).
 * POST — raise one. It starts as a draft, numbered `MR-001` per project by the
 *        service under an advisory lock, and its lines are written in the same
 *        transaction: a requirement with no lines is a title, not a requirement.
 *
 * Reading is `workspace.view`, writing `workspace.manage` — the *approval* that
 * files the request and the determination that grants it are on `…/status`, on
 * `workspace.approve`, because §24 keeps the money decisions away from ordinary
 * edit rights.
 */
export const GET = withTenantScope(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await aecOwner(PERMISSIONS.workspaceView);
    if (error) return error;
    const { id } = await context.params;
    try {
      await requireProjectCapability(owner, id, "view");
      return NextResponse.json({ requests: await listProjectRequests(owner.businessId, id) });
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
      const materialRequest = await createMaterialRequest(owner, id, await readBody(request));
      return NextResponse.json({ materialRequest }, { status: 201 });
    } catch (err) {
      return handleAecError(err);
    }
  },
);
