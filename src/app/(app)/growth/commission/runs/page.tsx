import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { memberAccessFor } from "@/lib/member-access";
import { CommissionRunsSection } from "../../commission-runs-section";
import { canViewGrowthSection, growthFallbackHref } from "../../growth-routes";

/**
 * Growth → Seller Commission → Settlement runs (issue #869). Compensation data:
 * the page and every run in it need `commission.view`, and each action needs its
 * own permission on the server as well as in the screen.
 */
export default async function GrowthCommissionRunsPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  const access = await memberAccessFor(session);
  const permissions = access?.permissions ?? new Set();
  if (!canViewGrowthSection(permissions, "commission")) redirect(growthFallbackHref(permissions));

  return <CommissionRunsSection permissions={[...permissions]} />;
}
