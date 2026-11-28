import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { campaignRewardReport, cashbackLiabilitySummary } from "@/lib/campaign-reward-service";

/**
 * Issue #901 — the campaign money table.
 *
 * Every figure is derived from the reward position and event tables, so the
 * screen cannot disagree with the ledger. `outstandingRial` is the liability
 * the books carry on account 2445 (earned − redeemed + restored − reversed −
 * expired, where `restored` is a refunded till tender given back to the
 * wallet); it is deliberately not called "budget remaining", which is a
 * different question (what the campaign may still promise).
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.campaignsView);
  if (error) return error;
  const [campaigns, liability] = await Promise.all([
    campaignRewardReport(session.businessId),
    cashbackLiabilitySummary(session.businessId),
  ]);
  return NextResponse.json({ campaigns, liability });
});
