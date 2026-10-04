import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { fieldBoard } from "@/lib/aec-field";
import { requireProjectCapability } from "@/lib/workspace";
import { PERMISSIONS, aecOwner, handleAecError } from "../../../guard";

/**
 * §25's field board — «حالت کارگاه» in one request.
 *
 * The phone asks once and gets the queues it opens on: today's log, the open
 * snags, the inspections whose checklist is waiting, the RFIs without an
 * answer, the dated tasks, the deliveries the site is expecting, the latest
 * drawings and the submittals waiting for review. Each register is capped and
 * each is asked only when its capability is on, so the screen never shows a
 * queue that would 403 if tapped.
 *
 * `requireProjectCapability(…, "view")` is the same gate every other AEC read
 * uses: platform `workspace.view` intersected with the member's project role,
 * and a project outside the caller's scope is a 404 rather than an empty board.
 */
export const GET = withTenantScope(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await aecOwner(PERMISSIONS.workspaceView);
    if (error) return error;
    const { id } = await context.params;
    try {
      await requireProjectCapability(owner, id, "view");
      return NextResponse.json({ board: await fieldBoard(owner, id) });
    } catch (err) {
      return handleAecError(err);
    }
  },
);
