import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { memberAccessFor } from "@/lib/member-access";
import { requireIndustryForPage } from "@/lib/industry-guard";
import { PERMISSIONS } from "@/lib/permissions";
import { PageHeader, PageShell } from "@/app/dashboard/page-chrome";
import { SizePackManager } from "@/app/dashboard/size-packs/size-pack-manager";

/**
 * GH #1567 Phase 6C — «بسته‌های سایزی» for a fashion business: wholesale size
 * packs built from a style's size × colour matrix. The API enforces the same
 * permission keys independently.
 */
export default async function SizePacksPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  const member = await memberAccessFor(session);
  if (!member?.isActive) redirect("/dashboard");
  await requireIndustryForPage(session.businessId, "fashion_apparel");
  if (!member.permissions.has(PERMISSIONS.inventoryView)) redirect("/dashboard");

  return (
    <PageShell>
      <PageHeader
        title="بسته‌های سایزی"
        description="فروش عمدهٔ ترکیبی از سایز و رنگ‌ها با یک بارکد؛ بسته موجودی جدا ندارد و فروش آن همان تنوع‌ها را از انبار کم می‌کند."
      />
      <SizePackManager canEdit={member.permissions.has(PERMISSIONS.inventoryAdjust)} />
    </PageShell>
  );
}
