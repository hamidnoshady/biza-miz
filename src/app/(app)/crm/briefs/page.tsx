import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { memberAccessFor } from "@/lib/member-access";
import { CrmSection } from "../crm-section";
import { canViewCrmSection, crmFallbackHref } from "../crm-routes";

/**
 * CRM → بریف کارفرما (issue #1128 §A).
 *
 * What each client actually asked for, written down before anybody prices it or
 * builds it. Management, like the deals a brief hangs off: it carries what a
 * client intends to spend and who on their side decides.
 *
 * The gate is the section table's, never restated here — the same rule every CRM
 * page follows, and the reason a screen cannot drift from the API behind it.
 */
export default async function CrmBriefsPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  const access = await memberAccessFor(session);
  const permissions = access?.permissions ?? new Set();
  if (!canViewCrmSection(permissions, "briefs")) redirect(crmFallbackHref(permissions));

  return (
    <CrmSection section="briefs" role={access?.role ?? session.role} permissions={[...permissions]} />
  );
}
