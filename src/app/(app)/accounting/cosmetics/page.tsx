import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { memberAccessFor } from "@/lib/member-access";
import { requireIndustryForPage } from "@/lib/industry-guard";
import { PageHeader, PageShell } from "@/app/dashboard/page-chrome";
import { KnowledgeHelpButton } from "@/app/dashboard/knowledge-help";
import { CosmeticsManager } from "@/app/dashboard/cosmetics/cosmetics-manager";
import { reportsTabHref } from "@/app/dashboard/reports/reports-nav";
import { Button } from "@/components/ui/button";

export default async function CosmeticsPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  const member = await memberAccessFor(session);
  if (!member?.isActive || !member.permissions.has("inventory.view")) redirect("/dashboard");
  await requireIndustryForPage(session.businessId, "cosmetics");

  return (
    <PageShell>
      <PageHeader
        title="آرایشی و بهداشتی"
        description="بچ و انقضای کالا، برندها و ماتریس تنوع‌ها. گزارش‌های این صنف — تحلیل فروش تنوع‌ها، فروش به تفکیک برند و بچ‌های نزدیک انقضا — در «گزارش‌های آماده» خوانده می‌شوند."
        actions={
          <>
            {/*
              The trade's reports moved into the report library; this is the
              door to them, so the page that used to hold a «گزارش‌ها» tab does
              not simply lose it without saying where it went.
            */}
            <span data-tour-id="cosmetics.reports">
              <Button asChild variant="outline">
                <Link href={reportsTabHref("standard")}>گزارش‌های آماده</Link>
              </Button>
            </span>
            <KnowledgeHelpButton section="cosmetics" />
          </>
        }
      />
      <CosmeticsManager />
    </PageShell>
  );
}
