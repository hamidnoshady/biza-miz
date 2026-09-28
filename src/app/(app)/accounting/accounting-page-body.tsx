import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { effectiveFeatures, requireFeatureForPage } from "@/lib/features";
import { withTenant } from "@/lib/db";
import { memberAccessFor } from "@/lib/member-access";
import { hasActiveHolooCompanion } from "@/lib/integrations/holoo/connection-service";
import { PageHeader, PageShell } from "@/app/dashboard/page-chrome";
import { KnowledgeHelpButton } from "@/app/dashboard/knowledge-help";
import { AskAssistant } from "@/components/ai/ask-assistant";
import { AccountingManager } from "./accounting-manager";
import { canOpenLedger, canViewAccountingSection } from "./accounting-nav";
import {
  accountingFallbackHref,
  type AccountingSectionKey,
} from "./accounting-routes";

/**
 * What every Accounting page renders, with the gates every one of them draws.
 *
 * The app is one route per section now (`/accounting/<section>`),
 * and the pages are thin — this body is the whole app chrome, so a section
 * page and the app's home cannot drift apart. The gates run in order and in
 * one place: signed in, admitted to the app, admitted to *this* section
 * (payroll is the shorter list), entitled to the ledger.
 */
/**
 * The page title and one-line description per section.
 *
 * Only the sections whose subject is *not* «حسابداری» in general need an entry;
 * everything else keeps the app's own heading. «تنظیمات حسابداری» has one for
 * the reason the whole settings split exists: an app settings page must be
 * visibly the app's, with its own title and description, and never read as the
 * platform settings page.
 */
const DEFAULT_ACCOUNTING_HEADING = {
  title: "فضای کار حسابداری",
  description: "تراز آزمایشی، دفتر روزنامه، اسناد دستی و عملیات مالی کسب‌وکار.",
};

const ACCOUNTING_HEADINGS: Partial<Record<AccountingSectionKey, { title: string; description: string }>> = {
  settings: {
    title: "تنظیمات حسابداری",
    description:
      "تنظیمات مخصوص برنامهٔ حسابداری — سرفصل حساب‌ها، دوره‌های مالی و قواعد سندزنی. تنظیمات کسب‌وکار و پلتفرم جای دیگری است.",
  },
  "financial-reports": {
    title: "گزارش‌های مالی",
    description: "گزارش‌های حسابداری و راه رسیدن به گزارش‌های کسب‌وکار.",
  },
  dashboard: {
    title: "حسابداری",
    description:
      "میز کار حسابداری — نمای مالی کسب‌وکار، اشخاص و دسترسی به همهٔ بخش‌های کاری از منوی کناری.",
  },
  directory: {
    title: "اشخاص",
    description:
      "یک فهرست برای همهٔ طرف‌حساب‌ها — مشتریان، تأمین‌کنندگان، فروشندگان و کارکنان. یک پرونده برای هر نفر، حتی وقتی چند نقش دارد.",
  },
};

export async function AccountingPageBody({ section }: { section: AccountingSectionKey }) {
  const session = await getSession();
  if (!session) redirect("/login");
  // Resolved before the gates, because the gates are now asked in terms of
  // effective permissions — the same set the Accounting routes enforce.
  const member = await memberAccessFor(session);
  const permissions: ReadonlySet<string> = member?.permissions ?? new Set<string>();
  if (!canOpenLedger(permissions)) redirect("/accounting");
  if (!canViewAccountingSection(permissions, section)) redirect(accountingFallbackHref());
  await requireFeatureForPage(session.businessId, "ledger");
  const holooCompanion = await withTenant(session.businessId, () => hasActiveHolooCompanion(session.businessId));
  const features = await effectiveFeatures(session.businessId);
  const heading = ACCOUNTING_HEADINGS[section] ?? DEFAULT_ACCOUNTING_HEADING;

  return (
    <PageShell>
      {holooCompanion ? (
        <div className="mb-4 rounded-2xl border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/15 px-4 py-3 text-sm leading-6 text-amber-950 dark:text-amber-200">
          دفتر رسمی در هلو نگهداری می‌شود؛ این دفتر برای گزارش، پایش و تطبیق آینه می‌شود.
        </div>
      ) : null}
      <PageHeader
        title={heading.title}
        description={heading.description}
        actions={
          <>
            <KnowledgeHelpButton section="ledger" />
            {features.ai_assistant ? (
              <AskAssistant
                app="growth"
                context="وضعیت حسابداری را بررسی کن: تراز آزمایشی، دفتر روزنامه و اسناد ثبت‌شده."
              />
            ) : null}
          </>
        }
      />
      <AccountingManager
        role={member?.role ?? session.role}
        section={section}
        permissions={member ? [...member.permissions] : undefined}
        currentUserId={session.sub}
      />
    </PageShell>
  );
}
