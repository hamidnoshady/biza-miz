import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { memberAccessFor } from "@/lib/member-access";
import { CrmSection } from "../crm-section";
import { canViewCrmSection, crmFallbackHref } from "../crm-routes";

/**
 * CRM → «کیفیت داده». The data-quality workspace.
 *
 * Management (`crm.merge`): deciding that two rows are one person, and deciding
 * that a record is unusable, are the same judgement about the same data — and
 * the two views it hosts are already gated the same way. The page checks the
 * workspace's own key; `crm-section.tsx` computes each view's flag from the same
 * table, so a member who may clean the record but not merge it sees the issues
 * and not the duplicate pairs.
 */
export default async function CrmQualityPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  const access = await memberAccessFor(session);
  const permissions = access?.permissions ?? new Set();
  if (!canViewCrmSection(permissions, "quality")) redirect(crmFallbackHref(permissions));

  return (
    <CrmSection section="quality" role={access?.role ?? session.role} permissions={[...permissions]} />
  );
}
