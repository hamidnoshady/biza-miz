import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { isQuotationAction } from "@/lib/aec-procurement";
import { applyQuotationAction, quotationProjectId } from "@/lib/aec-procurement-service";
import { requireProjectCapability } from "@/lib/workspace";
import { PERMISSIONS, aecOwner, handleAecError, readBody } from "../../../guard";

/**
 * §18's quotation states, one endpoint: shortlist, decline, put back, or mark
 * one selected.
 *
 * `workspace.manage` throughout, and deliberately not `workspace.approve`: this
 * endpoint decides which offers are *compared*, not which one is *bought*.
 * Marking a quotation selected here only labels it — the money is committed by
 * the commitment raised from it, whose approval is on `workspace.approve`. That
 * is why the pure module answers `false` for every action in this catalogue
 * (`quotationActionNeedsApproval`) rather than this route deciding for itself.
 */
export const POST = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await aecOwner(PERMISSIONS.workspaceManage);
    if (error) return error;
    const { id } = await context.params;
    try {
      const body = await readBody(request);
      const action = String(body.action ?? "");
      if (!isQuotationAction(action)) {
        return NextResponse.json({ error: "invalid_action" }, { status: 400 });
      }
      const projectId = await quotationProjectId(owner.businessId, id);
      await requireProjectCapability(owner, projectId, "manage");
      const quotation = await applyQuotationAction(owner, id, action);
      return NextResponse.json({ quotation });
    } catch (err) {
      return handleAecError(err);
    }
  },
);
