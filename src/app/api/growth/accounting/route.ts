import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { redactGrowthOverview } from "@/lib/growth-access";
import { PERMISSIONS } from "@/lib/permissions";
import { growthOverviewForSession } from "@/lib/growth-overview";

/**
 * Growth & Marketing data as seen from accounting (Phase 36b, revised).
 *
 * The growth app posts to the ledger through its own posting rules — issuing a
 * gift card credits ۲۴۲۰, store credit ۲۴۱۰, commission expenses ۵۲۱۰ and
 * accrues ۲۳۰۰ — all in the backend, with no connection UI in the growth app.
 * This endpoint lets accounting *see* that same data: the bridge balances and
 * the rolling KPIs, reconstructed from `journal_lines` exactly the way the trial
 * balance reconstructs them, so a number here can never disagree with the
 * books. Owner, manager and accountant may read it.
 *
 * It answers with a subset rather than the whole overview: accounting has no
 * business reading the repurchase list or the growth activity feed.
 */
export const GET = withTenantScope(async () => {
  const { session, membership, error } = await requirePermission(PERMISSIONS.growthView);
  if (error) return error;

  const overview = redactGrowthOverview(await growthOverviewForSession(session), membership.permissions);
  return NextResponse.json({
    window: overview.window,
    bridge: overview.bridge,
    campaigns: overview.campaigns,
    giftCards: overview.giftCards,
    loyalty: overview.loyalty,
    commission: overview.commission,
  });
});
