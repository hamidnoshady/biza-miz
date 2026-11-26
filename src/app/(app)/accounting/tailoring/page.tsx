import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { memberAccessFor } from "@/lib/member-access";
import { requireIndustryForPage } from "@/lib/industry-guard";
import { PERMISSIONS } from "@/lib/permissions";
import { PageHeader, PageShell } from "@/app/dashboard/page-chrome";
import { TailoringManager } from "@/app/dashboard/tailoring/tailoring-manager";

/**
 * GH #1567 Phase 6A — «خیاطی و دوخت» for a fashion business.
 *
 * The page decides what the member may see from the server-side permission
 * set and passes plain booleans down, so the client never mounts (and never
 * requests) the measurements panel for a member without
 * `tailoring.measurements`. The API enforces the same keys independently.
 */
export default async function TailoringPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  const member = await memberAccessFor(session);
  if (!member?.isActive) redirect("/dashboard");
  await requireIndustryForPage(session.businessId, "fashion_apparel");
  const has = (permission: (typeof PERMISSIONS)[keyof typeof PERMISSIONS]) => member.permissions.has(permission);
  const canManage = has(PERMISSIONS.tailoringManage);
  const canMeasure = has(PERMISSIONS.tailoringMeasurements);
  if (!canManage && !canMeasure) redirect("/dashboard");

  return (
    <PageShell>
      <PageHeader
        title="خیاطی و دوخت"
        description="تعمیر، اصلاح و دوخت سفارشی: پذیرش، برآورد، تأیید مشتری، پرو، کنترل کیفیت و تحویل. اندازه‌های بدن رمزنگاری‌شده و با گزارش دسترسی نگهداری می‌شوند."
      />
      <TailoringManager
        permissions={{
          canManage,
          canMeasure,
          canExport: canMeasure && has(PERMISSIONS.crmExport),
          canErase: canMeasure && has(PERMISSIONS.crmDelete),
          canRetention: canMeasure && has(PERMISSIONS.settingsManage),
          canViewOrders: has(PERMISSIONS.ordersView),
        }}
      />
    </PageShell>
  );
}
