import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { isUuid } from "@/lib/uuid";
import {
  createAgencyCampaign,
  listAgencyCampaigns,
  type AgencyCampaignListFilters,
} from "@/lib/agency-campaign-service";
import { campaignActor, campaignErrorResponse, readCampaignBody } from "../campaign-guard";

/**
 * The client campaigns list, and creating one (issue #1128 §A + §C).
 *
 * `GET` reads on `crm.view` and answers the two questions §C's reporting starts
 * from: what is on air for this client right now (`currentOnly`), and what is still
 * open (`openOnly`). A campaign current on a date is a range comparison rather than
 * a stored flag, because a flag would be wrong from midnight until somebody re-ran
 * it — and a calendar that says «running» yesterday and tomorrow but not today is
 * worse than no calendar.
 *
 * `POST` writes on `crm.manage` and returns 201, the convention every create in
 * this door uses. The number is assigned by the service inside its own transaction,
 * so two campaigns created at once cannot be handed the same one.
 *
 * A status may not be set on create. A campaign is born `planned` and reaches
 * `running` through `/status`, which is where the window it implies is checked: a
 * create that could arrive already live would skip the only place that asks when it
 * started.
 */
export const GET = withTenantScope(
  async (request: NextRequest) => {
    const { session, error } = await requirePermission(PERMISSIONS.crmView);
    if (error) return error;

    const search = request.nextUrl.searchParams;
    const status = search.get("status");
    const partyId = search.get("partyId");
    const limitRaw = Number(search.get("limit") ?? "");
    const filters: AgencyCampaignListFilters = {
      q: search.get("q") ?? undefined,
      // An unknown status filters nothing rather than matching nothing, so a stale
      // bookmark shows the list instead of an empty screen that looks like data loss.
      status: status ?? null,
      partyId: partyId && isUuid(partyId) ? partyId : null,
      currentOnly: search.get("currentOnly") === "1" || search.get("currentOnly") === "true",
      openOnly: search.get("openOnly") === "1" || search.get("openOnly") === "true",
      limit: Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : undefined,
    };

    try {
      return NextResponse.json({ campaigns: await listAgencyCampaigns(session.businessId, filters) });
    } catch (err) {
      const response = campaignErrorResponse(err);
      if (response) return response;
      throw err;
    }
  },
);

export const POST = withTenantScope(
  async (request: NextRequest) => {
    const { session, error } = await requirePermission(PERMISSIONS.crmManage);
    if (error) return error;

    const body = await readCampaignBody(request);
    if (!body) return NextResponse.json({ error: "missing_fields" }, { status: 400 });

    try {
      const campaign = await createAgencyCampaign(
        session.businessId,
        campaignActor(session),
        body,
      );
      return NextResponse.json({ campaign }, { status: 201 });
    } catch (err) {
      const response = campaignErrorResponse(err);
      if (response) return response;
      throw err;
    }
  },
);
