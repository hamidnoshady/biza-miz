import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { isAgencyBriefStatus } from "@/lib/agency-brief";
import { createAgencyBrief, listAgencyBriefs } from "@/lib/agency-brief-service";
import { briefActor, briefErrorResponse, readBriefBody } from "../brief-guard";

/**
 * The client briefs (issue #1128 §A): what each client actually asked for,
 * written down before anybody prices it or builds it.
 *
 * Readable by anyone who may read the pipeline, because a brief is the sales
 * record of a requirement and the board's «بریف کارفرما» stage is meaningless
 * without it. Writable on `crm.manage`: drafting one is an act on behalf of the
 * agency, not floor work.
 *
 * A brief posts no money and prices nothing. `budgetRial` is what the client says
 * they intend to spend — an input to a proposal, never a receivable. §D's
 * registers own the money, and a brief that also owned money would be a second
 * answer to "how much".
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.crmView);
  if (error) return error;

  const search = request.nextUrl.searchParams;
  const status = search.get("status");
  const openOnly = search.get("openOnly");
  const limit = search.get("limit");

  const briefs = await listAgencyBriefs(session.businessId, {
    partyId: search.get("partyId"),
    dealId: search.get("dealId"),
    projectId: search.get("projectId"),
    // An unknown status is treated as no filter rather than as an empty result:
    // a stale tab holding a status this build does not know should still see its
    // briefs.
    status: status && isAgencyBriefStatus(status) ? status : null,
    openOnly: openOnly === "1" || openOnly === "true",
    q: search.get("q"),
    limit: limit === null ? undefined : Number(limit) || undefined,
  });

  return NextResponse.json({ briefs });
});

/**
 * Writes a new brief, always as a draft.
 *
 * There is no way to create one already sent or confirmed: a brief becomes sent
 * by an act on `…/[id]/status`, so the stamp and the state always arrive
 * together. Creating a row with `status: "confirmed"` in the body would be
 * ignored rather than honoured, because the confirmation is an event with a time
 * and a name attached and not a field.
 *
 * The number is chosen inside the same transaction as the insert, so two members
 * drafting at once get BR-003 and BR-004 rather than both getting BR-003.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.crmManage);
  if (error) return error;

  const body = await readBriefBody(request);
  if (!body) return NextResponse.json({ error: "missing_fields" }, { status: 400 });

  try {
    const brief = await createAgencyBrief(session.businessId, briefActor(session), body);
    return NextResponse.json({ brief }, { status: 201 });
  } catch (err) {
    const response = briefErrorResponse(err);
    if (response) return response;
    throw err;
  }
});
