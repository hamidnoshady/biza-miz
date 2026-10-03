import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { applyRfiAction, rfiProjectId } from "@/lib/aec-rfi-service";
import { requireProjectCapability } from "@/lib/workspace";
import { PERMISSIONS, aecOwner, handleAecError, readBody } from "../../../guard";

const ACTIONS = ["open", "answer", "close", "cancel"] as const;
type Action = (typeof ACTIONS)[number];

/**
 * §10's four moves, one endpoint — the same shape as the BOQ revision's status
 * route, and for the same reason: the transitions belong together, so the chain
 * is one readable list rather than four routes that can drift apart.
 *
 * One permission, not two. Unlike issuing a transmittal or approving an
 * estimate, none of these is a financial or commercial decision about somebody
 * else's numbers: opening an RFI asks a question, answering it is the answer,
 * and closing it records that the answer was accepted. All four are the project
 * work `workspace.manage` already covers, and all four still pass the project
 * role check — a document controller of one project cannot answer another
 * project's RFIs.
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
      const projectId = await rfiProjectId(owner.businessId, id);
      await requireProjectCapability(owner, projectId, "manage", true);
      const rfi = await applyRfiAction(owner, id, action, body);
      return NextResponse.json({ rfi });
    } catch (err) {
      return handleAecError(err);
    }
  },
);
