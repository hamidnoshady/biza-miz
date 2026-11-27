import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { runSingleCampaignSweep } from "@/lib/campaign-reward-service";
import { campaignBuilderErrorResponse } from "@/lib/campaign-builder-http";

/**
 * Issue #901 — «اجرای پاداش»: one reward pass over this campaign, now.
 *
 * The background tick runs the same pass every couple of minutes; this endpoint
 * exists so an operator does not have to wait for it after activating a
 * campaign or fixing a connection. It is idempotent by construction — one
 * entitlement per campaign+order and a transaction-scoped campaign lock — so
 * pressing it twice grants nothing twice.
 */
export const POST = withTenantScope(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.campaignsManage);
  if (error) return error;
  const { id } = await context.params;
  try {
    const result = await runSingleCampaignSweep(session.businessId, id);
    return NextResponse.json({ result });
  } catch (e) {
    return campaignBuilderErrorResponse(e);
  }
});
