import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { createRfi, listProjectRfis } from "@/lib/aec-rfi-service";
import { requireProjectCapability } from "@/lib/workspace";
import { PERMISSIONS, aecOwner, handleAecError, readBody } from "../../../guard";

/**
 * A project's RFI register (issue #799 §10).
 *
 * GET  — every RFI on the project, overdue ones flagged by the service rather
 *        than left for the reader to work out, with optional `status`,
 *        `discipline`, `search` and `openOnly` filters.
 * POST — raise one. It starts as a draft: §10's chain is Draft → Open → … and
 *        `open` is the act of asking somebody, which is what files the question
 *        against a party and a due date.
 *
 * Both go through the workspace module's per-project authorization on top of the
 * platform permission, like every other AEC route: `workspace.view` narrows to
 * «میز کار من», `requireProjectCapability` narrows to this project, and the
 * owner/manager's `workspace.manage` is the escape hatch.
 */
export const GET = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await aecOwner(PERMISSIONS.workspaceView);
    if (error) return error;
    const { id } = await context.params;
    const params = request.nextUrl.searchParams;
    try {
      await requireProjectCapability(owner, id, "view", true);
      const rfis = await listProjectRfis(owner.businessId, id, {
        status: params.get("status") ?? undefined,
        discipline: params.get("discipline") ?? undefined,
        search: params.get("search") ?? undefined,
        openOnly: params.get("openOnly") === "1",
      });
      return NextResponse.json({ rfis });
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
      const rfi = await createRfi(owner, id, await readBody(request));
      return NextResponse.json({ rfi }, { status: 201 });
    } catch (err) {
      return handleAecError(err);
    }
  },
);
