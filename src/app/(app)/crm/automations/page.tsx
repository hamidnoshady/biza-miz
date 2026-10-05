import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { memberAccessFor } from "@/lib/member-access";
import { CrmSection } from "../crm-section";
import { canViewCrmSection, crmFallbackHref } from "../crm-routes";

/**
 * CRM → «اتوماسیون‌ها». The rules that act on their own.
 *
 * Reached from CRM settings and from the command field rather than the rail
 * (`CRM_SUB_SECTIONS`), because writing a rule is configuration — but it is a
 * real section with its own route, its own gate and its own bookmarks like every
 * other, and the gate is `crm.configure`: an automation changes records with
 * nobody watching.
 */
export default async function CrmAutomationsPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  const access = await memberAccessFor(session);
  const permissions = access?.permissions ?? new Set();
  if (!canViewCrmSection(permissions, "automations")) redirect(crmFallbackHref(permissions));

  return (
    <CrmSection
      section="automations"
      role={access?.role ?? session.role}
      permissions={[...permissions]}
    />
  );
}
