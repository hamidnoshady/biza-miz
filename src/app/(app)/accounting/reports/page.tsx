import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { memberAccessFor } from "@/lib/member-access";
import { PERMISSIONS } from "@/lib/permissions";
import { reportCapabilities } from "@/lib/report-permissions";
import { effectiveFeatures, requireFeatureForPage } from "@/lib/features";
import { PageHeader, PageShell } from "@/app/dashboard/page-chrome";
import { KnowledgeHelpButton } from "@/app/dashboard/knowledge-help";
import { ReportsManager } from "@/app/dashboard/reports/reports-manager";
import { AskAssistant } from "@/components/ai/ask-assistant";

/** The business reporting workspace, moved under the primary Accounting app. */
export default async function ReportsPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  const access = await memberAccessFor(session);
  const permissions = access?.permissions ?? new Set<string>();
  if (!permissions.has(PERMISSIONS.reportsView)) redirect("/dashboard");
  await requireFeatureForPage(session.businessId, "reporting");
  const features = await effectiveFeatures(session.businessId);

  return (
    <PageShell>
      <PageHeader
        title="گزارش‌ها"
        description="گزارش‌های آمادهٔ فروش، انبار، حسابداری و کارکنان، به‌همراه گزارش‌ساز برای ساخت گزارش سفارشی."
        actions={
          <>
            <KnowledgeHelpButton section="reports" />
            {features.ai_assistant ? (
              <AskAssistant
                app="accounting"
                context="گزارش‌های این صفحه را بررسی کن و تفاوت فروش هفتهٔ جاری را با هفتهٔ قبل بگو."
              />
            ) : null}
          </>
        }
      />
      <ReportsManager
        capabilities={reportCapabilities(permissions)}
        canExplain={permissions.has(PERMISSIONS.reportsExport) && features.ai_assistant}
      />
    </PageShell>
  );
}
