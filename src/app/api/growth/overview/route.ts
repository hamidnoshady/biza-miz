import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { redactGrowthOverview } from "@/lib/growth-access";
import { PERMISSIONS } from "@/lib/permissions";
import { growthOverviewForSession } from "@/lib/growth-overview";

/**
 * The Growth & Marketing app's dashboard, in one call (Phase 36b). Read-only:
 * the app's writes stay where they already are — the loyalty/promotions/
 * commission services and their posting rules — so this endpoint can never
 * disagree with the ledger it reports the balances of.
 *
 * `growth.view` opens it; its compensation parts (the commission card, the
 * commission activity rows, the ۲۳۰۰/۵۲۱۰ bridge balances) additionally need
 * `commission.view` and are removed here, server-side, for anyone without it.
 */
export const GET = withTenantScope(async () => {
  const { session, membership, error } = await requirePermission(PERMISSIONS.growthView);
  if (error) return error;

  const overview = redactGrowthOverview(await growthOverviewForSession(session), membership.permissions);
  return NextResponse.json({ overview });
});
