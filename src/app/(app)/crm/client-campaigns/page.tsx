import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { memberAccessFor } from "@/lib/member-access";
import { CrmSection } from "../crm-section";
import { canViewCrmSection, crmFallbackHref } from "../crm-routes";

/**
 * CRM → کمپین‌های کارفرما (issue #1128 §A + §C).
 *
 * The campaign as it ran for one client, downstream of the brief, the proposal, the
 * contract and the project. §A asks for concurrent campaigns per client and §C asks
 * for spend and return with *defensible* attribution — this is the record both read.
 *
 * Reporting half of §C — the calendar, the agency's-own versus client-managed split,
 * the CPL/CPA/ROAS views across campaigns — is deliberately not here: it needs this
 * record to exist first, and a report over a table that cannot name a client is a
 * report about nothing.
 *
 * The gate is the section table's, never restated here — the same rule every CRM page
 * follows, and the reason a screen cannot drift from the API behind it.
 */
export default async function CrmCampaignsPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  const access = await memberAccessFor(session);
  const permissions = access?.permissions ?? new Set();
  if (!canViewCrmSection(permissions, "client-campaigns")) redirect(crmFallbackHref(permissions));

  return (
    <CrmSection
      section="client-campaigns"
      role={access?.role ?? session.role}
      permissions={[...permissions]}
    />
  );
}
