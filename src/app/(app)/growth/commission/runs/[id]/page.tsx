import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { memberAccessFor } from "@/lib/member-access";
import { CommissionRunDetailView } from "../../../commission-run-detail";
import { canViewGrowthSection, growthFallbackHref } from "../../../growth-routes";

interface Props {
  params: Promise<{ id: string }>;
}

/** One settlement run: its members, its source sales, its payouts and its trail (issue #869). Gated on `commission.view`. */
export default async function GrowthCommissionRunPage({ params }: Props) {
  const session = await getSession();
  if (!session) redirect("/login");
  const access = await memberAccessFor(session);
  const permissions = access?.permissions ?? new Set();
  if (!canViewGrowthSection(permissions, "commission")) redirect(growthFallbackHref(permissions));

  const { id } = await params;
  return <CommissionRunDetailView runId={id} permissions={[...permissions]} />;
}
