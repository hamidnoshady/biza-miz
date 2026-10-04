import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { applySiteLogAction, siteLogProjectId } from "@/lib/aec-site-service";
import { requireProjectCapability } from "@/lib/workspace";
import { PERMISSIONS, aecOwner, handleAecError, readBody } from "../../../guard";

const ACTIONS = ["submit", "reopen"] as const;
type Action = (typeof ACTIONS)[number];

/**
 * §13's one move that matters: the author signs the day, or takes it back.
 *
 * Both actions need `workspace.manage`, and neither is a decision about
 * somebody else's money or quality — signing a log says "this is what happened",
 * which is exactly what the project role that may write the log already covers.
 * A submitted day is frozen (header and lines) by migration 0199 until it is
 * reopened, so the two actions are the only two states it can be in.
 */
export const POST = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await aecOwner(PERMISSIONS.workspaceManage);
    if (error) return error;
    const { id } = await context.params;
    const body = await readBody(request);
    const action = String(body.action ?? "") as Action;
    if (!ACTIONS.includes(action)) {
      return NextResponse.json({ error: "invalid_action" }, { status: 400 });
    }
    try {
      const projectId = await siteLogProjectId(owner.businessId, id);
      await requireProjectCapability(owner, projectId, "manage");
      return NextResponse.json({ log: await applySiteLogAction(owner, id, action) });
    } catch (err) {
      return handleAecError(err);
    }
  },
);
