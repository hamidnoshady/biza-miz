import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import {
  emptyWorkspacePartyPage,
  normalizePartySearchTerm,
  partyIdsFrom,
  partyPageRequest,
  searchWorkspaceParties,
} from "@/lib/workspace-lookups";
import { PERMISSIONS, handleWorkspaceError, workspaceOwner } from "../../guard";

/**
 * Issue #907 F10 — the party picker's own read, so a business with more parties
 * than one page can still find the one it means.
 *
 * `GET /api/workspace/lookups` answers the pickers a form opens with, and its
 * party list is bounded. This endpoint is the way past that bound: `q` filters
 * by name on the server, `page`/`pageSize` walk the results, and `ids` resolves
 * the row a form already holds — so opening an edit panel keeps its party
 * selected, and a party outside the current page still shows its name.
 *
 * Authorisation is the same decision as the shared list, not a new one
 * (`workspaceOwner` applies `workspace.view`, the industry/service-activation
 * and eligibility gate of #1110, and the current effective permissions):
 * a member who administers the workspace, or who may record contracts, gets
 * the picker; anyone else gets an empty result rather than a directory. The
 * answer is still only an id and a display name.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { owner, error } = await workspaceOwner(PERMISSIONS.workspaceView, request);
  if (error) return error;

  const params = request.nextUrl.searchParams;
  const { page, pageSize } = partyPageRequest({
    page: params.get("page"),
    pageSize: params.get("pageSize"),
  });

  const partyPickers =
    owner.access?.canManage === true || owner.access?.canManageContracts === true;
  if (!partyPickers) return NextResponse.json(emptyWorkspacePartyPage(pageSize));

  try {
    const result = await searchWorkspaceParties(owner.businessId, {
      q: normalizePartySearchTerm(params.get("q")),
      page,
      pageSize,
      ids: partyIdsFrom(params.get("ids")),
    });
    return NextResponse.json(result);
  } catch (err) {
    return handleWorkspaceError(err);
  }
});
