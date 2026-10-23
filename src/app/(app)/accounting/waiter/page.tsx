import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { memberAccessFor } from "@/lib/member-access";
import { PERMISSIONS } from "@/lib/permissions";
import { requireModuleForPage } from "@/lib/industry-guard";
import { requireFeatureForPage } from "@/lib/features";
import { PageHeader, PageShell } from "@/app/dashboard/page-chrome";
import { KnowledgeHelpButton } from "@/app/dashboard/knowledge-help";
import { WaiterBoard } from "@/app/dashboard/waiter/waiter-board";

export default async function WaiterPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  await requireModuleForPage(session.businessId, "waiter");
  const access = await memberAccessFor(session);
  const permissions = access?.permissions ?? new Set<string>();
  // «میزهای من» is the floor-staff view of their own tables. Anyone with
  // effective floor or order access (`tables.manage`, `orders.create`, or
  // `orders.view`) can open it, matching `GET /api/waiter/board`.
  if (
    !permissions.has(PERMISSIONS.ordersCreate) &&
    !permissions.has(PERMISSIONS.tablesManage) &&
    !permissions.has(PERMISSIONS.ordersView)
  ) {
    redirect("/dashboard");
  }
  await requireFeatureForPage(session.businessId, "reservations");

  return (
    <PageShell>
      <PageHeader
        title="میزهای من"
        description="میزهای تخصیص‌داده‌شده به شما"
        actions={<KnowledgeHelpButton section="waiter" />}
      />
      <WaiterBoard />
    </PageShell>
  );
}
