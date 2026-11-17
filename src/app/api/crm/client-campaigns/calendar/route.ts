import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { memberAccessFor } from "@/lib/member-access";
import { PERMISSIONS } from "@/lib/permissions";
import {
  CampaignCalendarError,
  readCampaignCalendarWindow,
} from "@/lib/agency-campaign-calendar";
import { listCampaignCalendar } from "@/lib/agency-campaign-calendar-service";
import { workspaceOwner } from "@/app/api/workspace/guard";
import type { ReportOwner } from "@/lib/agency-campaign-report-service";

export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.crmView);
  if (error) return error;
  try {
    const window = readCampaignCalendarWindow(request.nextUrl.searchParams);
    let owner: ReportOwner = {
      businessId: session.businessId,
      actorUserId: session.sub,
      workspaceAllowed: false,
    };
    const member = await memberAccessFor(session);
    if (member?.permissions.has(PERMISSIONS.workspaceView)) {
      const result = await workspaceOwner(PERMISSIONS.workspaceView, request);
      if (result.error) return result.error;
      owner = { ...result.owner, workspaceAllowed: true };
    }
    return NextResponse.json(await listCampaignCalendar(owner, window));
  } catch (err) {
    if (err instanceof CampaignCalendarError)
      return NextResponse.json({ error: err.message }, { status: 400 });
    throw err;
  }
});
