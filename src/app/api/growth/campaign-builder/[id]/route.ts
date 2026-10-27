import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { archiveCampaign, getCampaign, saveCampaignDraft } from "@/lib/campaign-builder-service";
import { campaignBuilderErrorResponse, readJsonObject } from "@/lib/campaign-builder-http";

type Context = { params: Promise<{ id: string }> };

export const GET = withTenantScope(async (_request: NextRequest, context: Context) => {
  const { session, error } = await requirePermission(PERMISSIONS.campaignsView);
  if (error) return error;
  const { id } = await context.params;
  const campaign = await getCampaign(session.businessId, id);
  if (!campaign) return NextResponse.json({ error: "campaign_not_found" }, { status: 404 });
  return NextResponse.json({ campaign });
});

/** Saves a draft; keys the body does not name keep their stored value. */
export const PATCH = withTenantScope(async (request: NextRequest, context: Context) => {
  const { session, error } = await requirePermission(PERMISSIONS.campaignsManage);
  if (error) return error;
  const { id } = await context.params;

  const body = await readJsonObject(request);
  if (!body) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  try {
    const campaign = await saveCampaignDraft(session.businessId, session.sub, id, {
      name: body.name,
      definition: body.definition,
    });
    return NextResponse.json({ campaign });
  } catch (e) {
    return campaignBuilderErrorResponse(e);
  }
});

/** Archives the campaign (nothing is deleted; its versions and audit trail stay). */
export const DELETE = withTenantScope(async (_request: NextRequest, context: Context) => {
  const { session, error } = await requirePermission(PERMISSIONS.campaignsManage);
  if (error) return error;
  const { id } = await context.params;
  try {
    return NextResponse.json({ campaign: await archiveCampaign(session.businessId, session.sub, id) });
  } catch (e) {
    return campaignBuilderErrorResponse(e);
  }
});
