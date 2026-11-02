import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { isUuid } from "@/lib/uuid";
import { isAgencyProposalAction } from "@/lib/agency-proposal";
import { applyAgencyProposalAction } from "@/lib/agency-proposal-service";
import { proposalActor, proposalErrorResponse, readProposalBody } from "../../../proposal-guard";

/**
 * §A's proposal chain, one endpoint: `send` → `accept` | `decline` | `expire`,
 * with `withdraw` available from a draft or a sent offer and `reopen` after one.
 *
 * Separate from the PATCH next door because a transition is not a field edit: it
 * stamps `sent_at` or `decided_at`, and a decision is attributed to a name.
 * Routing it through "save the whole proposal" would lose both the first time a
 * UI sent the offer back unchanged.
 *
 * `accepted`, `declined` and `expired` are terminal. That follows from the freeze
 * rather than being a separate choice: the price closed when the offer was sent,
 * so there is nothing left to revise in place. The client who declines at
 * ۶۵۰٬۰۰۰٬۰۰۰ and is then offered ۵۵۰٬۰۰۰٬۰۰۰ gets a *new* proposal in the same
 * series, and the declined one stays on the record as the offer that was actually
 * refused. Reopening it would destroy the only evidence of what the client said no
 * to. `withdrawn` does reopen, because an offer taken back before anyone decided
 * was never a fact about the client.
 *
 * `accept` is refused once the offer has lapsed, and this is one of two rules the
 * database cannot enforce: `valid_until < now()` is not an immutable expression, so
 * no CHECK can express it. Without the refusal a client could accept a
 * six-month-old quote at the old price — the exact mistake a validity date exists
 * to prevent. `decline` and `expire` are *not* refused, because both are accurate
 * statements about the past.
 *
 * `decidedByName` is optional and falls back to the stakeholder the offer already
 * records, because that person is who the agency named as the client's
 * decision-maker. If neither exists the decision is refused: an unattributed
 * acceptance is an assertion, not a record.
 */
export const POST = withTenantScope(
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.crmManage);
    if (error) return error;

    const { id } = await params;
    if (!isUuid(id)) return NextResponse.json({ error: "proposal_not_found" }, { status: 404 });

    const body = await readProposalBody(request);
    if (!body) return NextResponse.json({ error: "missing_fields" }, { status: 400 });

    const action = body.action;
    if (!isAgencyProposalAction(action)) {
      return NextResponse.json({ error: "invalid_action" }, { status: 400 });
    }

    try {
      const proposal = await applyAgencyProposalAction(
        session.businessId,
        id,
        proposalActor(session),
        action,
        { decidedByName: body.decidedByName },
      );
      return NextResponse.json({ proposal });
    } catch (err) {
      const response = proposalErrorResponse(err);
      if (response) return response;
      throw err;
    }
  },
);
