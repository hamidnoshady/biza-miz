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
  if (!canOpenLedger(permissions)) redirect("/accounting");
  if (!canViewAccountingSection(permissions, section)) redirect(accountingFallbackHref());
  await requireFeatureForPage(session.businessId, "ledger");
  const holooCompanion = await withTenant(session.businessId, () => hasActiveHolooCompanion(session.businessId));
  const features = await effectiveFeatures(session.businessId);
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
