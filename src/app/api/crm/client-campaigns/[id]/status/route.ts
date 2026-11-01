import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { isUuid } from "@/lib/uuid";
import { isAgencyCampaignAction } from "@/lib/agency-campaign";
import { applyAgencyCampaignAction } from "@/lib/agency-campaign-service";
import { campaignActor, campaignErrorResponse, readCampaignBody } from "../../../campaign-guard";

/**
 * Move one campaign through its lifecycle (issue #1128 §A + §C).
 *
 * Its own route rather than a field on `PATCH`, for the reason the proposal and
 * brief status routes give: a lifecycle step is not an edit. It has a vocabulary of
 * its own (`start`, `pause`, `resume`, `complete`, `cancel`), it is the step that
 * closes a record to further change, and it is the one a report needs to be able to
 * ask about separately from "somebody renamed this".
 *
 * `crm.manage`, the same key that writes the record. `complete` is not on a
 * stronger permission and needs no second signer, because it is not an approval of
 * money moving — it is a member recording that a campaign has finished, and the
 * figures it closes are the ones they were entering all along. §D's `approve` is
 * the internal determination about money, and this is not that.
 *
 * The window a step implies is checked before the write, so «آغاز اجرا» on a
 * campaign with no start date answers `start_date_required` rather than arriving as
 * 0278's CHECK.
 */
export const POST = withTenantScope(
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.crmManage);
    if (error) return error;

    const { id } = await params;
    if (!isUuid(id)) return NextResponse.json({ error: "campaign_not_found" }, { status: 404 });

    const body = await readCampaignBody(request);
    if (!body) return NextResponse.json({ error: "missing_fields" }, { status: 400 });

    const action = typeof body.action === "string" ? body.action : "";
    if (!isAgencyCampaignAction(action)) {
      return NextResponse.json({ error: "invalid_action" }, { status: 400 });
    }

    try {
      const campaign = await applyAgencyCampaignAction(
        session.businessId,
        id,
        campaignActor(session),
        action,
      );
      return NextResponse.json({ campaign });
    } catch (err) {
      const response = campaignErrorResponse(err);
      if (response) return response;
      throw err;
    }
  },
);
