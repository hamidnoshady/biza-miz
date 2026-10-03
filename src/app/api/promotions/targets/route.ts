import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getBusinessIndustry } from "@/lib/industry-guard";
import { industryProfile } from "@/lib/industry-profile";
import { listPromotionTargets } from "@/lib/promotions-service";

/**
 * The rows a discount campaign can be scoped to — items plus categories (F&B)
 * or brands (retail) — for the campaign form's product-eligibility step
 * (issue #764). A read of the catalogue, under the campaign read key.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.campaignsView);
  if (error) return error;

  const industry = await getBusinessIndustry(session.businessId);
  const salesModel = industry ? industryProfile(industry).salesModel : "order_ticket";
  return NextResponse.json({ targets: await listPromotionTargets(session.businessId, salesModel) });
});
