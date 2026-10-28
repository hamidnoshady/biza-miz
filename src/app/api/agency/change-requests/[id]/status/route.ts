import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import {
  AGENCY_CHANGE_REQUEST_ACTIONS,
  agencyCommercialActionNeedsApproval,
  isAgencyChangeRequestAction,
} from "@/lib/agency-commercial";
import { applyChangeRequestAction } from "@/lib/agency-commercial-service";
import { PERMISSIONS, agencyOwner, handleAgencyError, readBody } from "../../../guard";

/**
 * §D's change-request chain, one endpoint — `price` → `submit` → `approve` or
 * `reject` → `implement`, with `withdraw` available to the author until somebody
 * decides and `reprice` after a refusal.
 *
 * Two permissions, read from the catalogue in `agency-commercial.ts` rather than
 * restated here (§24): `price`, `submit`, `implement`, `reprice` and `withdraw`
 * are the author's own acts on `workspace.manage`; `approve` and `reject` are the
 * determinations on `workspace.approve`.
 *
 * `approve` is the only act that moves money. The agreed figure joins the
 * engagement's *revised* value, which is what the next percentage milestone is
 * taken against — and the signed value on the contract is never rewritten, so
 * what the client signed and what the engagement is now worth stay two separate,
 * readable facts. A caller may agree a different figure than the one asked for
 * by passing `approvedAmountRial`; that difference is the commercial story of a
 * change request, so both are kept.
 */
export const POST = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { id } = await context.params;
    const body = await readBody(request);
    const action = String(body.action ?? "");
    if (!isAgencyChangeRequestAction(action)) {
      return NextResponse.json({ error: "invalid_action" }, { status: 400 });
    }

    const needsApproval = agencyCommercialActionNeedsApproval(
      AGENCY_CHANGE_REQUEST_ACTIONS,
      action,
    );
    const { owner, error } = await agencyOwner(
      needsApproval ? PERMISSIONS.workspaceApprove : PERMISSIONS.workspaceManage,
      request,
    );
    if (error) return error;

    try {
      const changeRequest = await applyChangeRequestAction(owner, id, action, {
        note: body.note,
        approvedAmountRial: body.approvedAmountRial,
      });
      return NextResponse.json({ changeRequest });
    } catch (err) {
      return handleAgencyError(err);
    }
  },
);
