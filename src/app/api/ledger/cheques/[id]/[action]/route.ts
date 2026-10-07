import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { transitionCheque } from "@/lib/cheques-service";
import { CHEQUE_ACTIONS, type ChequeAction } from "@/lib/cheques";
import { chequeErrorResponse } from "../../errors";
import { MalformedBodyError, readJsonObjectBody } from "../../body";

interface ActionBody {
  occurredOn?: string;
  endorsedToSupplierId?: string;
  feeAmount?: number;
  memo?: string;
}

/**
 * One step of a cheque's life: deposit, endorse, clear, bounce, present,
 * cancel, and the two returned-cheque resolutions (settle, restore). Which of
 * those are legal from here is `cheques.ts`'s transition table, not this
 * route's — an illegal one comes back 409 rather than being filtered out of the
 * URL space.
 *
 * The branch is *not* read from the session: `transitionCheque` posts to the
 * cheque's own `location_id`, so one instrument's life cannot be split across
 * two branches' books by whoever happens to be switched into another one.
 */
export const POST = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string; action: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.financeChequesManage);
    if (error) return error;

    const { id, action } = await context.params;
    if (!CHEQUE_ACTIONS.includes(action as ChequeAction)) {
      return NextResponse.json({ error: "invalid_action" }, { status: 400 });
    }

    let body: ActionBody;
    try {
      body = (await readJsonObjectBody(request)) as ActionBody;
    } catch (err) {
      if (err instanceof MalformedBodyError) {
        return NextResponse.json({ error: "bad_request" }, { status: 400 });
      }
      throw err;
    }

    try {
      const cheque = await transitionCheque({
        businessId: session.businessId,
        chequeId: id,
        action: action as ChequeAction,
        occurredOn: body.occurredOn ?? null,
        endorsedToSupplierId: body.endorsedToSupplierId ?? null,
        feeAmount: body.feeAmount ?? null,
        memo: body.memo ?? null,
        createdBy: session.sub,
      });
      return NextResponse.json({ cheque });
    } catch (err) {
      return chequeErrorResponse(err);
    }
  },
);
