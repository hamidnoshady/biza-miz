import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { isUuid } from "@/lib/uuid";
import {
  deleteAgencyCampaign,
  loadAgencyCampaign,
  updateAgencyCampaign,
} from "@/lib/agency-campaign-service";
import { campaignActor, campaignErrorResponse, readCampaignBody } from "../../campaign-guard";

/**
 * One client campaign (issue #1128 §A + §C).
 *
 * `GET` on `crm.view`, `PATCH` and `DELETE` on `crm.manage` and `crm.delete`.
 *
 * The patch carries only the fields it means to change, and that is load-bearing
 * rather than tidy: `undefined` leaves a field alone while an empty string clears
 * it, so a request that renames a campaign cannot also wipe its budget, its window
 * and its figures. 0278's freeze is what stops a closed campaign being edited at
 * all, and the service checks it first only so the member is told in words.
 */
export const GET = withTenantScope(
  async (_request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.crmView);
    if (error) return error;

    const { id } = await params;
    if (!isUuid(id)) return NextResponse.json({ error: "campaign_not_found" }, { status: 404 });

    try {
      const campaign = await loadAgencyCampaign(session.businessId, id);
      if (!campaign) return NextResponse.json({ error: "campaign_not_found" }, { status: 404 });
      return NextResponse.json({ campaign });
    } catch (err) {
      const response = campaignErrorResponse(err);
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
    if (!isUuid(id)) return NextResponse.json({ error: "campaign_not_found" }, { status: 404 });

    const body = await readCampaignBody(request);
    if (!body) return NextResponse.json({ error: "missing_fields" }, { status: 400 });

    try {
      const campaign = await updateAgencyCampaign(
        session.businessId,
        id,
        campaignActor(session),
        body,
      );
      return NextResponse.json({ campaign });
    } catch (err) {
      const response = campaignErrorResponse(err);
      if (response) return response;
      throw err;
    }
  },
);

export const DELETE = withTenantScope(
  async (_request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.crmDelete);
    if (error) return error;

    const { id } = await params;
    if (!isUuid(id)) return NextResponse.json({ error: "campaign_not_found" }, { status: 404 });

    try {
      await deleteAgencyCampaign(session.businessId, id);
      return NextResponse.json({ result: "deleted" });
    } catch (err) {
      const response = campaignErrorResponse(err);
      if (response) return response;
      throw err;
    }
  },
);
