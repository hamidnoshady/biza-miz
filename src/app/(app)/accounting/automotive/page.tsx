import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { memberAccessFor } from "@/lib/member-access";
import { requireIndustryForPage } from "@/lib/industry-guard";
import { PageHeader, PageShell } from "@/app/dashboard/page-chrome";
import { KnowledgeHelpButton } from "@/app/dashboard/knowledge-help";
import { AutomotiveManager } from "@/app/dashboard/automotive/automotive-manager";
import { PERMISSIONS } from "@/lib/permissions";

/**
 * §17's manager pages, in the Accounting app's own workspace — the same
 * placement the watch and jewelry trades use (`/accounting/watch`,
 * `/accounting/jewelry`): a dealership's stock is accounting-adjacent, and the
 * section list lives on the shared chrome rather than in a fourth app.
 *
 * Two gates, both load-bearing: the member must hold `vehicles.view`, and the
 * business must *be* an automotive business (`requireIndustryForPage`) — so a
 * restaurant that bookmarks this URL lands back on its dashboard rather than on
 * an empty car lot.
 */
export default async function AutomotivePage() {
  const session = await getSession();
  if (!session) redirect("/login");
  const member = await memberAccessFor(session);
  if (!member?.isActive || !member.permissions.has(PERMISSIONS.vehiclesView)) redirect("/dashboard");
  await requireIndustryForPage(session.businessId, "automotive");

  const canSeeCost = member.permissions.has(PERMISSIONS.vehiclesCostView);

  return (
    <PageShell>
      <PageHeader
        title="خودرو و نمایشگاه اتومبیل"
        description="موجودی خودرو، خرید و بهای تمام‌شده، هزینه‌های هر خودرو و شاخص‌های نمایشگاه."
        actions={<KnowledgeHelpButton section="automotive" />}
      />
      <AutomotiveManager canSeeCost={canSeeCost} />
    </PageShell>
  );
}
