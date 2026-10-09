import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { listMessageCampaignRoiReport } from "@/lib/message-campaigns-service";

/**
 * Campaign ROI is deliberately available only for a campaign with its own
 * promotion. We never infer attribution from an audience, a message body, or
 * an eventual customer purchase.
 *
 * ## Why this needs the consolidated capability (issue #819)
 *
 * `message_campaigns` has no branch: a campaign runs across the whole business,
 * its promotion applies wherever an order is rung up, and its spend is a single
 * business-level journal entry. The report therefore cannot be expressed for one
 * branch — filtering orders by branch would divide the campaign's revenue by a
 * fraction of its cost and report a *wrong* ROI, which is worse than reporting
 * none.
 *
 * So it is a consolidated report by construction, and it is gated like one:
 * `reports.business_wide`, the owner-level grant that the branch comparison and
 * the consolidated statements already require. A branch-only manager reading it
 * under plain `reports.view` — the previous state — was exactly the leak the
 * issue names.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.reportsBusinessWide);
  if (error) return error;
  const rows = await listMessageCampaignRoiReport(session.businessId);
  return NextResponse.json({ rows });
});
