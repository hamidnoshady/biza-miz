import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { isRfqAction } from "@/lib/aec-procurement";
import { applyRfqAction, rfqProjectId } from "@/lib/aec-procurement-service";
import { requireProjectCapability } from "@/lib/workspace";
import { PERMISSIONS, aecOwner, handleAecError, readBody } from "../../../guard";

/**
 * Issue, close or cancel an RFQ (§18).
 *
 * All three ride `workspace.manage`: issuing sends a document to suppliers and
 * commits nothing, closing a decided tender is bookkeeping, and cancelling one
 * before any award exists takes nothing away from anybody. §24's approval rule
 * for this flow is the *award* — see `…/commitments/[id]/status` — and putting
 * the approval key here would make the register ask for it at the wrong moment.
 *
 * The service refuses to issue an RFQ with no invited supplier: an issued tender
 * nobody was asked to price is a file, not a tender.
 */
export const POST = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await aecOwner(PERMISSIONS.workspaceManage);
    if (error) return error;
    const { id } = await context.params;
    try {
      const body = await readBody(request);
      const action = String(body.action ?? "");
      if (!isRfqAction(action)) {
        return NextResponse.json({ error: "invalid_action" }, { status: 400 });
      }
      const projectId = await rfqProjectId(owner.businessId, id);
      await requireProjectCapability(owner, projectId, "manage");
      const rfq = await applyRfqAction(owner, id, action);
      return NextResponse.json({ rfq });
    } catch (err) {
      return handleAecError(err);
    }
  },
);
