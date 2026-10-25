import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { effectiveFeatures } from "@/lib/features";
import { withTenant } from "@/lib/db";
import { memberAccessFor } from "@/lib/member-access";
import { hasActiveHolooCompanion } from "@/lib/integrations/holoo/connection-service";
import { PageHeader, PageShell } from "@/app/dashboard/page-chrome";
import { KnowledgeHelpButton } from "@/app/dashboard/knowledge-help";
import { AskAssistant } from "@/components/ai/ask-assistant";
import { AccountingManager } from "./accounting-manager";
import { AccountingStaffOverview } from "./accounting-staff-overview";
import { canOpenLedger, canViewAccountingSection } from "./accounting-nav";
import { accountingAssistantContext, accountingSectionHeading } from "./accounting-headings";
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
export async function AccountingPageBody({ section }: { section: AccountingSectionKey }) {
  const session = await getSession();
  if (!session) redirect("/login");
  // Resolved before the gates, because the gates are now asked in terms of
  // effective permissions — the same set the Accounting routes enforce.
  const member = await memberAccessFor(session);
  const permissions: ReadonlySet<string> = member?.permissions ?? new Set<string>();
  // The app's home is open to every member admitted to the app (issue #1124);
  // without the ledger door it is the operational overview, not the books.
  // Every other section still bounces to the app root, which lands on it.
  if (!canOpenLedger(permissions)) {
    if (section === "dashboard" && member) {
      return <AccountingStaffOverview businessId={session.businessId} member={member} />;
    }
    redirect("/accounting");
  }
  if (!canViewAccountingSection(permissions, section)) redirect(accountingFallbackHref());
  // `effectiveFeatures` and the Holoo-companion check are independent reads
  // for the same business — one is the feature_flags/business_features
  // join, the other a different table entirely — that used to run as two
  // sequential `await`s (issue #909's "serialize independent reads" defect).
  // `requireFeatureForPage` used to run *before* both of them and itself
  // called `effectiveFeatures` internally (via `isFeatureEnabled`), so the
  // same query ran twice for the same business on every load. Loading both
  // concurrently and deriving the ledger-feature gate from the one
  // `effectiveFeatures` result below keeps the exact same checks — fail
  // closed the same way `isFeatureEnabled` does (`features.ledger ?? true`)
  // — while halving this page's sequential DB round trips.
  const [features, holooCompanion] = await Promise.all([
    effectiveFeatures(session.businessId),
    withTenant(session.businessId, () => hasActiveHolooCompanion(session.businessId)),
  ]);
  if (!(features.ledger ?? true)) {
    // The ledger is switched off for this business, but the app still has its
    // work areas; its home stays the operational overview rather than a bounce.
    if (section === "dashboard" && member) {
      return <AccountingStaffOverview businessId={session.businessId} member={member} />;
    }
    redirect("/dashboard");
  }
  const heading = accountingSectionHeading(section);

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
              <AskAssistant app="accounting" context={accountingAssistantContext(section)} />
            ) : null}
          </>
        }
      />
      <AccountingManager
        role={member?.role ?? session.role}
        section={section}
        /*
         * The gates above guarantee `member`: `canOpenLedger` reads the same
         * effective-permission set and redirects on an empty one, so a page
         * that renders at all has resolved its member. The array below is
         * therefore never the `undefined` this used to be allowed to pass —
         * which is what let the manual-journal buttons be drawn for a session
         * whose permissions had not been read.
         */
        permissions={member ? [...member.permissions] : []}
        currentUserId={session.sub}
      />
    </PageShell>
  );
}
