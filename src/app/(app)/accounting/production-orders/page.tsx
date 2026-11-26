import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { memberAccessFor } from "@/lib/member-access";
import { requireIndustryForPage } from "@/lib/industry-guard";
import { PERMISSIONS } from "@/lib/permissions";
import { PageHeader, PageShell } from "@/app/dashboard/page-chrome";
import { FashionProductionManager } from "@/app/dashboard/production/fashion-production-manager";

/**
 * GH #1567 Phase 6B — «تولید پوشاک» for a fashion business: production
 * orders, bills of materials and the WIP report. The API enforces the same
 * permission keys independently.
 */
export default async function ProductionOrdersPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  const member = await memberAccessFor(session);
  if (!member?.isActive) redirect("/dashboard");
  await requireIndustryForPage(session.businessId, "fashion_apparel");
  if (!member.permissions.has(PERMISSIONS.inventoryView)) redirect("/dashboard");

  return (
    <PageShell>
      <PageHeader
        title="تولید پوشاک"
        description="سفارش تولید از برش تا بسته‌بندی: رزرو و حوالهٔ مواد، پیشرفت مراحل، ضایعات و دوباره‌کاری، دستمزد و پیمانکار، ورود محصول به انبار به بهای تمام‌شده."
      />
      <FashionProductionManager
        permissions={{
          canAdjust: member.permissions.has(PERMISSIONS.inventoryAdjust),
          canWriteOff: member.permissions.has(PERMISSIONS.ledgerApprove),
        }}
      />
    </PageShell>
  );
}
