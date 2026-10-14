import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { memberAccessFor } from "@/lib/member-access";
import { CrmSection } from "../crm-section";
import { canViewCrmSection, crmFallbackHref } from "../crm-routes";

/**
 * CRM → سابقهٔ تصمیم‌ها. The decision log.
 *
 * Management: it names who decided what. Same gate as `/crm/settings` because
 * it answers the same kind of question — "how is this app being run" — and the
 * two are the only CRM screens a cashier never opens.
 */
export default async function CrmAuditPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  const access = await memberAccessFor(session);
  const permissions = access?.permissions ?? new Set();
  if (!canViewCrmSection(permissions, "audit")) redirect(crmFallbackHref(permissions));

  return <CrmSection section="audit" role={access?.role ?? session.role} permissions={[...permissions]} />;
}
