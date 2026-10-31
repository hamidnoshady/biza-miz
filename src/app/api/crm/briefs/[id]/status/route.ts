import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { isUuid } from "@/lib/uuid";
import { isAgencyBriefAction } from "@/lib/agency-brief";
import { applyAgencyBriefAction } from "@/lib/agency-brief-service";
import { briefActor, briefErrorResponse, readBriefBody } from "../../../brief-guard";

/**
 * §A's brief chain, one endpoint: `send` → `confirm` → `supersede`, with
 * `withdraw` available from a draft or a sent brief and `reopen` after one.
 *
 * Separate from the PATCH next door because a transition is not a field edit: it
 * stamps `sent_at` or `confirmed_at`, and confirming attributes the confirmation
 * to a name. Routing it through "save the whole brief" would lose both the first
 * time a UI sent the brief back unchanged.
 *
 * One permission for the whole chain, which is a deliberate difference from §D's
 * change requests. There, `approve` sits on `workspace.approve` because agreeing
 * somebody else's *figure* is a different power from drafting one, and money
 * moves. Here `confirm` records the **client's** decision rather than an internal
 * determination — the agency member is the scribe, the client's approver is the
 * decider — so it is the same act as drafting and is gated the same way. Nothing
 * is priced and nothing posts.
 *
 * `confirmedByName` is optional and falls back to the approver the brief already
 * records, because that person is who the agency named as the client's
 * decision-maker. If neither exists the confirmation is refused: an unattributed
 * confirmation is an assertion, not a record.
 */
export const POST = withTenantScope(
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.crmManage);
    if (error) return error;

    const { id } = await params;
    if (!isUuid(id)) return NextResponse.json({ error: "brief_not_found" }, { status: 404 });

    const body = await readBriefBody(request);
    if (!body) return NextResponse.json({ error: "missing_fields" }, { status: 400 });

    const action = body.action;
    if (!isAgencyBriefAction(action)) {
      return NextResponse.json({ error: "invalid_action" }, { status: 400 });
    }

    try {
      const brief = await applyAgencyBriefAction(
        session.businessId,
        id,
        briefActor(session),
        action,
        { confirmedByName: body.confirmedByName },
      );
      return NextResponse.json({ brief });
    } catch (err) {
      const response = briefErrorResponse(err);
      if (response) return response;
      throw err;
    }
  },
);
