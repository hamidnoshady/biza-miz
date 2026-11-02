import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { createCampaign, listCampaigns } from "@/lib/campaign-builder-service";
import { campaignBuilderErrorResponse, readJsonObject } from "@/lib/campaign-builder-http";

/**
 * Issue #901, first slice — the campaign builder's list and create.
 *
 * These are builder campaigns (a typed trigger → reward rule under a hard
 * budget), a different record from the `promotions` price rules under
 * `/api/promotions`. Creating one writes a draft and an audit row; it issues
 * no reward and posts nothing.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.campaignsView);
  if (error) return error;
  return NextResponse.json({ campaigns: await listCampaigns(session.businessId) });
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.campaignsManage);
  if (error) return error;

  const body = await readJsonObject(request);
  if (!body) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  try {
    const campaign = await createCampaign(session.businessId, session.sub, {
      name: body.name,
      definition: body.definition,
    });
    return NextResponse.json({ campaign }, { status: 201 });
  } catch (e) {
    return campaignBuilderErrorResponse(e);
  }
});
