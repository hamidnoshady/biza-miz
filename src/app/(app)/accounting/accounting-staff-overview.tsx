import Link from "next/link";
import { effectiveFeatures } from "@/lib/features";
import { getBusinessIndustry } from "@/lib/industry-guard";
import { flattenNav } from "@/lib/nav-tree";
import { resolveAccessibleAppLanding } from "@/lib/apps";
import type { MemberAccess } from "@/lib/member-access";
import { accessibleNavItemsFor } from "@/app/dashboard/workspace-shell";
import { navIconFor } from "@/app/dashboard/sidebar-nav-icons";
import { DestinationCard, EmptyState, PageHeader, PageShell, SectionCard } from "@/app/dashboard/page-chrome";
import { KnowledgeHelpButton } from "@/app/dashboard/knowledge-help";
import { accountingOverviewShortcuts } from "./accounting-workspace";

/**
 * `/accounting/overview` for a member who does not hold the ledger door
 * (issue #1124).
 *
 * The app's home is one address for everyone admitted to the app, so a
 * cashier or waiter who opens «حسابداری» lands here instead of being bounced
 * into the till. What differs is the content: the ledger dashboard
 * (`ledger-dashboard-section.tsx`) reads `/api/ledger/overview`, which needs
 * `ledger.view`, so this page never mounts it and fetches no figures at all —
 * it is a server-rendered page of shortcuts into the work areas the member's
 * *own* navigation already admits them to (`accessibleNavItemsFor` is the one
 * gate the sidebar uses). Granting `ledger.view` is the only way to see
 * balances, and the API guards stay the authority either way.
 *
 * A member the app has nothing for gets a plain access explanation rather
 * than a redirect to a till they may not own either.
 */
export async function AccountingStaffOverview({
  businessId,
  member,
}: {
  businessId: string;
  member: MemberAccess;
}) {
  const [industry, features] = await Promise.all([
    getBusinessIndustry(businessId),
    effectiveFeatures(businessId),
  ]);
  const navigation = accessibleNavItemsFor(
    industry ?? "food_service",
    { settingsTabs: [] },
    member.role,
    member.permissions,
    features,
  );
  const groups = accountingOverviewShortcuts({
    permissions: member.permissions,
    navItems: flattenNav(navigation).map(({ label, href, iconKey }) => ({ label, href, iconKey })),
  });
  const admitted = resolveAccessibleAppLanding("accounting", navigation) !== null;

  return (
    <PageShell>
      <PageHeader
        title="حسابداری"
        description="میز کار شما — میان‌برهای بخش‌هایی که نقش شما به آن‌ها دسترسی دارد. ارقام مالی دفتر فقط برای نقش‌های دارای دسترسی به دفتر نمایش داده می‌شود."
        actions={<KnowledgeHelpButton />}
      />
      {!admitted || groups.length === 0 ? (
        <EmptyState title="دسترسی به این برنامه ندارید">
          نقش فعلی شما به هیچ‌یک از بخش‌های حسابداری دسترسی ندارد؛ برای دریافت دسترسی با مدیر کسب‌وکار
          تماس بگیرید.
        </EmptyState>
      ) : (
        <div data-tour-id="overview.staff-shortcuts" className="space-y-4">
          {groups.map((group) => (
            <SectionCard key={group.key} title={group.label ?? ""}>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {group.entries.map((entry) => (
                  <DestinationCard
                    key={entry.href}
                    href={entry.href}
                    title={entry.label}
                    icon={navIconFor(entry.href, entry.iconKey)}
                  />
                ))}
              </div>
            </SectionCard>
          ))}
        </div>
      )}
      {!admitted ? (
        <p className="mt-4 text-sm text-muted-foreground">
          <Link href="/dashboard" className="underline underline-offset-4">
            بازگشت به دستیار هوشمند
          </Link>
        </p>
      ) : null}
    </PageShell>
  );
}
