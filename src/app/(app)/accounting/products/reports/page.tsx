import { PageHeader, PageShell } from "@/app/dashboard/page-chrome";
import { KnowledgeHelpButton } from "@/app/dashboard/knowledge-help";
import { ReportsSection } from "@/app/dashboard/accessories/reports-section";
import { AutomotiveReports } from "@/app/dashboard/products/automotive-reports";
import { JewelryReports } from "@/app/dashboard/products/jewelry-reports";
import { ReportsSection as WatchReportsSection } from "@/app/dashboard/watch/reports-section";
import { specialistSectionForPage, automotiveProductSectionForPage, requireProductWorkspace } from "@/app/dashboard/products/workspace-context";

/** «گزارش‌ها» — the trade's sales-by-variant report, kept in the group. */
export default async function ProductsReportsPage() {
  const specialist = await specialistSectionForPage("reports");
  if (specialist?.industry === "jewelry") return (
    <PageShell>
      <PageHeader title="گزارش‌های طلا و جواهر" description="تطبیق وزن و صورت‌حساب امانی؛ فقط‌خواندنی." actions={<KnowledgeHelpButton section="jewelry" />} />
      <JewelryReports />
    </PageShell>
  );
  if (specialist?.industry === "watch") return (
    <PageShell>
      <PageHeader title="گزارش‌های ساعت" description="گزارش گارانتی و تعمیرات دستگاه‌های سریال‌دار شعبه." actions={<KnowledgeHelpButton section="watch" />} />
      <WatchReportsSection />
    </PageShell>
  );
  const automotive = await automotiveProductSectionForPage("reports");
  if (automotive) return (
    <PageShell>
      <PageHeader title="گزارش موجودی خودرو" description="شاخص‌های موجودی و فروش نمایشگاه در شعبهٔ فعال." actions={<KnowledgeHelpButton section="automotive" />} />
      <AutomotiveReports canSeeCost={automotive.canSeeCost} />
    </PageShell>
  );
  const { apiBase } = await requireProductWorkspace();
  return (
    <PageShell>
      <PageHeader
        title="گزارش‌های کالا"
        description="فروش تنوع‌ها و خانواده‌های کالا — همان گزارش صنف، پشت درِ مشترک محصولات."
        actions={<KnowledgeHelpButton section="pos" />}
      />
      <ReportsSection apiBase={apiBase} />
    </PageShell>
  );
}
