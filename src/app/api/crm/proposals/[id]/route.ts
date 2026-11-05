import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { isUuid } from "@/lib/uuid";
import {
  deleteAgencyProposal,
  loadAgencyProposal,
  updateAgencyProposal,
} from "@/lib/agency-proposal-service";
import { proposalActor, proposalErrorResponse, readProposalBody } from "../../proposal-guard";

/**
 * One proposal (issue #1128 §A + §D): who it offers to, which brief it prices,
 * what the lines cost and what they are sold for, what the agency earns on it,
 * how long it stays open, and the acts it can take from where it is.
 *
 * `totals` and `margin` are derived on every read rather than stored, so they
 * cannot disagree with the lines — the header carries `discountRial` and
 * `taxRial` because those are inputs somebody chose, and nothing else.
 *
 * `margin`, and every line's `costRial` and `passThrough`, are internal. This
 * route is the agency's own door and answers on `crm.view`; the client-facing
 * payload is `loadAgencyProposalClientView`, a different shape in which those
 * properties do not exist, and #1127's proposal and service-quote print templates
 * are what will serve it. The two doors are separate so that the client one
 * cannot be widened by accident.
 *
 * `actions` is derived from the offer's own status by the same function the panel
 * renders its buttons from, so the member-facing side can never offer an act this
 * route would refuse. `lapsed` is a fact about `validUntil` and is independent of
 * `status`: an offer can be `sent` and lapsed at once, which is exactly the case
 * worth surfacing.
 *
 * PATCH edits what is still editable. From `sent` on, the whole offer is frozen —
 * here and again by migration 0276's trigger, lines included, because the lines
 * *are* the price — and the way forward is a new proposal in the series, which is
 * also the audit trail. The pointer to the contract is *not* frozen, because it
 * records what the offer became and that happens afterwards; freezing it would
 * make the outcome unrecordable.
 *
 * DELETE is a draft-only escape hatch for an offer written by mistake. One the
 * client has seen is withdrawn, not deleted: the withdrawal is the record that an
 * offer was made and taken back.
 */
export const GET = withTenantScope(
  async (_request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.crmView);
    if (error) return error;

    const { id } = await params;
    if (!isUuid(id)) return NextResponse.json({ error: "proposal_not_found" }, { status: 404 });

    try {
      return NextResponse.json({ proposal: await loadAgencyProposal(session.businessId, id) });
    } catch (err) {
      const response = proposalErrorResponse(err);
      if (response) return response;
      throw err;
    }
  },
);

export const PATCH = withTenantScope(
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.crmManage);
    if (error) return error;

    const { id } = await params;
    if (!isUuid(id)) return NextResponse.json({ error: "proposal_not_found" }, { status: 404 });

    const body = await readProposalBody(request);
    if (!body) return NextResponse.json({ error: "missing_fields" }, { status: 400 });

    try {
      const proposal = await updateAgencyProposal(
        session.businessId,
        id,
        proposalActor(session),
        body,
      );
      return NextResponse.json({ proposal });
    } catch (err) {
      const response = proposalErrorResponse(err);
      if (response) return response;
      throw err;
    }
  },
);

export const DELETE = withTenantScope(
  async (_request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    // Owner-level, unlike the rest of this surface: a proposal is the record of
    // what a client was offered and at what figure, and making it never have
    // existed is not the same work as editing one.
    const { session, error } = await requirePermission(PERMISSIONS.crmDelete);
    if (error) return error;

    const { id } = await params;
    if (!isUuid(id)) return NextResponse.json({ error: "proposal_not_found" }, { status: 404 });

    try {
      const deleted = await deleteAgencyProposal(session.businessId, id);
      if (!deleted) return NextResponse.json({ error: "proposal_not_found" }, { status: 404 });
      return NextResponse.json({ result: "deleted" });
    } catch (err) {
      const response = proposalErrorResponse(err);
      if (response) return response;
      throw err;
    }
  },
);
