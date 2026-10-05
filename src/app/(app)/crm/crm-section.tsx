"use client";

/**
 * Renders one CRM section by key.
 *
 * Each section is its own route, so this is the single place that maps a
 * section key to its screen — the same arrangement `growth-section.tsx` uses.
 * The overview's quick actions navigate rather than switching an in-page tab,
 * because the sections are real pages with real URLs a person can bookmark.
 *
 * ## Permissions are read from the table, never restated here
 *
 * The screens below take booleans (`canDelete`, `canConfigure`), and this
 * component is where they are computed — from `src/lib/crm-permissions.ts` and
 * nothing else. The bug this replaced was a single inline `includes("crm.manage")`
 * that drew a delete button whose endpoint required `crm.delete`: the button
 * appeared for people who could not use it, and the request failed with a
 * message about the server rather than about permission. Deriving every flag
 * from the same table the API guards with is what makes that class of drift
 * impossible instead of merely fixed.
 */

import { useRouter } from "next/navigation";
import type { Permission } from "@/lib/permissions";
import { canConfigureCrmSection, canDeleteCrmSection, canWriteCrmSection } from "@/lib/crm-permissions";
import { CrmOverviewSection } from "./overview-section";
import { DirectorySection } from "./directory-section";
import { LeadsSection } from "./leads-section";
import { SegmentsSection } from "./segments-section";
import { DealsSection } from "./deals-section";
import { ActivitiesSection } from "./activities-section";
import { CasesSection } from "./cases-section";
import { DuplicatesSection } from "./duplicates-section";
import { ReconciliationSection } from "./reconciliation-section";
import { ConsentSection } from "./consent-section";
import { CrmAuditSection } from "./audit-section";
import { CrmSettingsSection } from "./settings-section";
import { crmSectionHref, type CrmSectionKey } from "./crm-routes";

export function CrmSection({
  section,
  role,
  permissions,
}: {
  section: CrmSectionKey;
  role: string;
  /**
   * The member's effective permission keys, threaded from the server page so
   * each screen's controls follow the member's real rights (see
   * `member-access.ts`).
   */
  permissions?: readonly string[];
}) {
  const router = useRouter();
  const goToSection = (key: CrmSectionKey) => router.push(crmSectionHref(key));
  const held = new Set(permissions ?? []) as ReadonlySet<Permission>;

  if (section === "overview")
    return (
      <CrmOverviewSection
        onGoToSection={goToSection}
        canRecompute={canWriteCrmSection(held, "overview")}
      />
    );
  if (section === "directory") return <DirectorySection role={role} permissions={permissions} />;
  if (section === "leads") return <LeadsSection />;
  if (section === "segments") return <SegmentsSection />;
  if (section === "deals") return <DealsSection />;
  if (section === "activities") return <ActivitiesSection />;
  if (section === "cases")
    return <CasesSection canDelete={canDeleteCrmSection(held, "cases")} />;
  if (section === "duplicates") return <DuplicatesSection />;
  if (section === "reconciliation") return <ReconciliationSection />;
  if (section === "audit") return <CrmAuditSection />;
  if (section === "settings") return <CrmSettingsSection canConfigure={canConfigureCrmSection(held, "settings")} />;
  return <ConsentSection />;
}
