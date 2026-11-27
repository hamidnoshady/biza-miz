import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import {
  CAMPAIGN_LIFECYCLE_ACTIONS,
  transitionCampaign,
  type CampaignLifecycleAction,
} from "@/lib/campaign-builder-service";
import { campaignBuilderErrorResponse, readJsonObject } from "@/lib/campaign-builder-http";

/**
 * Issue #901 — the campaign lifecycle endpoint.
 *
 * One route, six acts, two permissions:
 *
 *   submit, pause, resume, complete   `campaigns.manage`  — composing and
 *                                     stopping; a safety action is never
 *                                     harder than the one it stops.
 *   approve, activate                 `campaigns.approve` — from here the
 *                                     campaign promises money, so it takes the
 *                                     second pair of eyes.
 *
 * The permission is chosen from the action **before** the service runs, so the
 * refusal happens regardless of the campaign's state.
 */
type Context = { params: Promise<{ id: string }> };

export const POST = withTenantScope(async (request: NextRequest, context: Context) => {
  const body = await readJsonObject(request);
  const action = body?.action;
  if (typeof action !== "string" || !(CAMPAIGN_LIFECYCLE_ACTIONS as readonly string[]).includes(action)) {
    return NextResponse.json({ error: "action_invalid" }, { status: 400 });
  }

  const promisesMoney = action === "approve" || action === "activate";
  const { session, error } = await requirePermission(
    promisesMoney ? PERMISSIONS.campaignsApprove : PERMISSIONS.campaignsManage,
  );
  if (error) return error;

  const { id } = await context.params;
  try {
    const campaign = await transitionCampaign(session.businessId, session.sub, id, action as CampaignLifecycleAction, {
      startsAt: body?.startsAt,
      endsAt: body?.endsAt,
    });
    return NextResponse.json({ campaign });
  } catch (e) {
    return campaignBuilderErrorResponse(e);
  }
});
