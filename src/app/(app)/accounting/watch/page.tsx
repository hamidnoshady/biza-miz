import Link from "next/link";
import { settingsTabHref } from "@/lib/settings-routes";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { memberAccessFor } from "@/lib/member-access";
import { requireIndustryForPage } from "@/lib/industry-guard";
import { PageHeader, PageShell } from "@/app/dashboard/page-chrome";
import { KnowledgeHelpButton } from "@/app/dashboard/knowledge-help";
import { WatchManager } from "@/app/dashboard/watch/watch-manager";

export default async function WatchPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  const member = await memberAccessFor(session);
  if (!member?.isActive || !member.permissions.has("inventory.view")) redirect("/dashboard");
  await requireIndustryForPage(session.businessId, "watch");

  return (
    <PageShell>
      <PageHeader
        title="ساعت"
        description="مدل‌ها و دستگاه‌های سریال‌دار، فروش با گارانتی، و تیکت‌های تعمیر."
        actions={<>
          {member.permissions.has("inventory.adjust") && member.permissions.has("data.import") && <Link className="text-primary underline" href={`${settingsTabHref("data-transfer")}#catalogue-import`}>ورود کاتالوگ اکسل</Link>}
          <KnowledgeHelpButton section="watch" />
        </>}
      />
      <WatchManager />
    </PageShell>
  );
}
