import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { memberAccessFor } from "@/lib/member-access";
import { requireIndustryForPage } from "@/lib/industry-guard";
import { PageHeader, PageShell } from "@/app/dashboard/page-chrome";
import { KnowledgeHelpButton } from "@/app/dashboard/knowledge-help";
import { ClientCostsSection } from "@/app/(app)/accounting/client-costs-section";
import { PERMISSIONS } from "@/lib/permissions";

/**
 * Issue #1128 §D — the reimbursable-cost register, in the Accounting app's own
 * workspace: the same placement the automotive, watch and jewelry trades use.
 *
 * Two gates, both load-bearing. The member must hold `ledger.view`, and the business
 * must *be* an advertising agency (`requireIndustryForPage`) — so a café that
 * bookmarks this URL lands back on its dashboard rather than on a register whose
 * every row would mean something else. The API answers the same question more
 * strictly (`assertAgency` refuses another trade rather than defaulting it), because
 * hiding a page is not authorization.
 *
 * ## Why this is a page of its own and not an accounting section
 *
 * `ACCOUNTING_SECTIONS` is a list of `{ key, label, permission }` with no industry
 * gate at all, so a key added there would appear in every trade's ledger workspace —
 * a café would be offered «هزینه‌های کارفرما» and its API would answer `not_agency`.
 * The trade-page shape exists precisely for this: a module (`agency`) removes the
 * entry entirely for every other business, and `requireIndustryForPage` backs it up.
 *
 * ## The three permissions are the routes', handed down
 *
 * Reading the register is `ledger.view` — the door. Recording a cost and choosing the
 * presentation policy are `finance.expenses_manage`; recharging also needs
 * `orders.create`, because a recharge *is* an invoice. They are passed down as three
 * booleans so a member who may read but not move money sees the figures and no
 * buttons, and the screen cannot invent a fourth authority of its own.
 */
export default async function ClientCostsPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  const member = await memberAccessFor(session);
  if (!member?.isActive || !member.permissions.has(PERMISSIONS.ledgerView)) redirect("/dashboard");
  await requireIndustryForPage(session.businessId, "advertising_agency");

  const canRecord = member.permissions.has(PERMISSIONS.financeExpensesManage);
  const canRecharge = canRecord && member.permissions.has(PERMISSIONS.ordersCreate);

  return (
    <PageShell>
      <PageHeader
        title="هزینه‌های کارفرما"
        description="پولی که آژانس از طرف کارفرما پرداخته: ثبت هزینه، بازدریافت آن با فاکتور، و سیاست خالص یا ناخالص."
        actions={<KnowledgeHelpButton section="client-costs" />}
      />
      <ClientCostsSection
        canChooseVendor={member.permissions.has(PERMISSIONS.partiesView)}
        canSettle={member.permissions.has(PERMISSIONS.financePayablesManage)}
        canRecord={canRecord}
        canRecharge={canRecharge}
        canSetPolicy={canRecord}
      />
    </PageShell>
  );
}
