import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { memberAccessFor } from "@/lib/member-access";
import { GrowthSection } from "../growth-section";
import { canViewGrowthSection, growthFallbackHref } from "../growth-routes";

/** Growth → Seller Commission. Owner/manager only (compensation data). */
export default async function GrowthCommissionPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  const access = await memberAccessFor(session);
  const permissions = access?.permissions ?? new Set();
  if (!canViewGrowthSection(permissions, "commission")) redirect(growthFallbackHref(permissions));

  return (
    <div className="space-y-4">
      {/* Issue #869: the settlement lifecycle (build, approve, pay, reverse) lives on its own page. */}
      <div className="flex justify-end">
        <Link href="/growth/commission/runs" className="text-sm font-medium text-primary underline-offset-4 hover:underline">
          دوره‌های تسویه و پرداخت پورسانت
        </Link>
      </div>
      <GrowthSection section="commission" permissions={[...permissions]} />
    </div>
  );
}
