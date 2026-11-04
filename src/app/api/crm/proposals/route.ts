import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { isAgencyProposalStatus } from "@/lib/agency-proposal";
import { createAgencyProposal, listAgencyProposals } from "@/lib/agency-proposal-service";
import { proposalActor, proposalErrorResponse, readProposalBody } from "../proposal-guard";

/**
 * The agency's proposals (issue #1128 §A + §D): the priced offer, which is the
 * same document §D calls an "estimate" and §B puts between «بریف کارفرما» and
 * «قرارداد» on the pipeline. One name, one position, one lifecycle — two tables
 * would be the same offer in two places, free to disagree about the price.
 *
 * Readable by anyone who may read the pipeline. Writable on `crm.manage`: pricing
 * work for a client is an act on behalf of the agency, not floor work.
 *
 * A proposal posts no money. An accepted one is an agreement that money will
 * become due, and §D's registers own the moment it does — which is why this route
 * returns a `margin` and a `totalRial` and never a receivable.
 *
 * `lapsedOnly` reads a fact about a date rather than a status: it finds the offers
 * that quietly stopped being offers last week, which a `status=expired` filter
 * would miss entirely because nothing had got round to marking them.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.crmView);
  if (error) return error;

  const search = request.nextUrl.searchParams;
  const status = search.get("status");
  const openOnly = search.get("openOnly");
  const lapsedOnly = search.get("lapsedOnly");
  const limit = search.get("limit");

  const proposals = await listAgencyProposals(session.businessId, {
    partyId: search.get("partyId") ?? undefined,
    briefId: search.get("briefId") ?? undefined,
    dealId: search.get("dealId") ?? undefined,
    projectId: search.get("projectId") ?? undefined,
    contractId: search.get("contractId") ?? undefined,
    // An unknown status is treated as no filter rather than as an empty result:
    // a stale tab holding a status this build does not know should still see its
    // offers.
    status: status && isAgencyProposalStatus(status) ? status : undefined,
    openOnly: openOnly === "1" || openOnly === "true",
    lapsedOnly: lapsedOnly === "1" || lapsedOnly === "true",
    q: search.get("q") ?? undefined,
    limit: limit === null ? undefined : Number(limit) || undefined,
  });

  return NextResponse.json({ proposals });
});

/**
 * Writes a new proposal, always as a draft, header and lines in one transaction.
 *
 * There is no way to create one already sent or accepted: an offer becomes sent by
 * an act on `…/[id]/status`, so the stamp and the state always arrive together. A
 * `status` in the body would be ignored rather than honoured, because sending is
 * an event with a time attached and accepting is one with a time *and a name*.
 *
 * The number is chosen inside the same transaction as the insert, so two members
 * pricing at once get PR-003 and PR-004 rather than both getting PR-003.
 *
 * A draft may be empty and is not required to price anything — an offer is built
 * line by line — but it cannot be *sent* empty, and `…/[id]/status` is where that
 * is refused.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.crmManage);
  if (error) return error;

  const body = await readProposalBody(request);
  if (!body) return NextResponse.json({ error: "missing_fields" }, { status: 400 });

  try {
    const proposal = await createAgencyProposal(session.businessId, proposalActor(session), body);
    return NextResponse.json({ proposal }, { status: 201 });
  } catch (err) {
    const response = proposalErrorResponse(err);
    if (response) return response;
    throw err;
  }
});
