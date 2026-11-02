import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { memberAccessFor } from "@/lib/member-access";
import { CrmSection } from "../crm-section";
import { canViewCrmSection, crmFallbackHref } from "../crm-routes";

/**
 * CRM → پیشنهاد قیمت (issue #1128 §A + §D).
 *
 * The priced offer, between the brief and the contract on §B's own stage list. §A
 * calls it a proposal or quote and §D calls it an estimate; it is one document, so
 * it is one screen.
 *
 * Management, like the deals and briefs it sits beside: it states a price and
 * carries the agency's own margin, which is forecasting data rather than floor
 * data. The margin is internal — the payload a client would ever see is a
 * different shape that cannot name a cost.
 *
 * The gate is the section table's, never restated here — the same rule every CRM
 * page follows, and the reason a screen cannot drift from the API behind it.
 */
export default async function CrmProposalsPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  const access = await memberAccessFor(session);
  const permissions = access?.permissions ?? new Set();
  if (!canViewCrmSection(permissions, "proposals")) redirect(crmFallbackHref(permissions));

  return (
    <CrmSection
      section="proposals"
      role={access?.role ?? session.role}
      permissions={[...permissions]}
    />
  );
}
