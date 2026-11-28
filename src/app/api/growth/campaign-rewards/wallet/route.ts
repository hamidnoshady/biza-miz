import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { CampaignRewardError, campaignRewardWallet } from "@/lib/campaign-reward-service";
import { isUuid } from "@/lib/uuid";

/**
 * Issue #901 — a customer's campaign reward wallet, as the till shows it.
 *
 * Reads only. The figures are derived from the position rows on every call, so
 * a hold that ended a second ago is reflected without a cached balance.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.campaignsView);
  if (error) return error;
  const customerId = request.nextUrl.searchParams.get("customerId");
  if (!isUuid(customerId)) return NextResponse.json({ error: "customer_not_found" }, { status: 404 });
  try {
    return NextResponse.json({ wallet: await campaignRewardWallet(session.businessId, customerId) });
  } catch (e) {
    if (e instanceof CampaignRewardError) return NextResponse.json({ error: e.code }, { status: e.status });
    throw e;
  }
});
