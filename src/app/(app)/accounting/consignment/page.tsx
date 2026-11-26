import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { memberAccessFor } from "@/lib/member-access";
import { requireIndustryForPage } from "@/lib/industry-guard";
import { PERMISSIONS } from "@/lib/permissions";
import { PageHeader, PageShell } from "@/app/dashboard/page-chrome";
import { ConsignmentManager } from "@/app/dashboard/consignment/consignment-manager";

/**
 * GH #1567 Phase 6D — «کالای امانی» for a fashion business: goods sold for
 * their owner under a contract (owner price or commission). The API enforces
 * the same permission keys independently.
 */
export default async function ConsignmentPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  const member = await memberAccessFor(session);
  if (!member?.isActive) redirect("/dashboard");
  await requireIndustryForPage(session.businessId, "fashion_apparel");
  if (!member.permissions.has(PERMISSIONS.inventoryView)) redirect("/dashboard");
  const canEdit = member.permissions.has(PERMISSIONS.inventoryAdjust);

  return (
    <PageShell>
      <PageHeader
        title="کالای امانی"
        description="کالای دیگران را با قرارداد بفروشید: فقط کارمزد فروشگاه درآمد است و سهم امانت‌گذار تا تسویه بدهی می‌ماند."
      />
      <ConsignmentManager canEdit={canEdit} canSettle={canEdit && member.permissions.has(PERMISSIONS.ledgerPost)} />
    </PageShell>
  );
}
