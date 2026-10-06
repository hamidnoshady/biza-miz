"use client";

/**
 * The CRM app's own main sidebar.
 *
 * Rendered in the dashboard's app slot for every route under `/crm` —
 * `src/lib/app-shells.ts` is the rule that hands the slot over.
 *
 * The *arrangement* is `AppSectionNav`, shared with Growth: two apps in the
 * same platform whose menus behaved differently would be two products, and
 * that used to be guaranteed only by two identical copies of the same markup
 * sitting in two files. What is CRM's own — its sections, its groups, its href
 * function, its active-state rule and the name a screen reader announces — is
 * all that is left here.
 */

import type { AppShellNavProps } from "@/app/dashboard/app-shell-nav";
import { AppSectionNav } from "@/app/dashboard/app-section-nav";
import { crmNavGroupsForPermissions, crmNavItemsForPermissions } from "./crm-nav";
import { crmSectionHref, isCrmSectionPathname, type CrmSectionKey } from "./crm-routes";

export function CrmAppNav({ shell, permissions, pathname, onNavigate }: AppShellNavProps) {
  const items = crmNavItemsForPermissions(new Set(permissions as import("@/lib/permissions").Permission[]));
  return (
    <AppSectionNav<CrmSectionKey>
      ariaLabel="بخش‌های ارتباط با مشتری"
      title={shell.label}
      description={shell.description}
      items={items}
      groups={crmNavGroupsForPermissions(items)}
      hrefFor={crmSectionHref}
      isActive={(key) => isCrmSectionPathname(pathname, key)}
      onNavigate={onNavigate}
    />
  );
}
