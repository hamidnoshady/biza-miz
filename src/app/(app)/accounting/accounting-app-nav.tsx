"use client";

/**
 * The Accounting workspace's main sidebar.
 *
 * Accounting is the business's *primary* workspace, so this is the complete
 * work menu: the business's own areas — فروش و فاکتور، خرید و انبار،
 * محصولات، عملیات صنف، گزارش‌ها، تنظیمات — plus one ordinary link,
 * «فضای کار حسابداری», whose landing page lists the ledger tools. Before this,
 * opening «حسابداری» dropped straight into that ledger and nothing else, and
 * everything a business does daily lived in a second main menu at
 * `/dashboard/*`: two competing navigations, with the one named after the app
 * being the narrower.
 *
 * Nothing here is a new page or a second copy of one. The business entries are
 * picked out of the nav the shell already built and already filtered for this
 * member's trade, role, features and permissions
 * (`accounting-workspace.ts`), so a page this member cannot open is simply not
 * in the list — one gate, not two that could disagree. The workspace link is
 * the same `accounting-nav.ts` section behind the same role check the page
 * uses, and the ledger tools stay reachable at their own URLs and from the
 * workspace page.
 *
 * Every row is drawn by the shared `sidebar-nav-group.tsx`, so the workspace
 * link wears exactly the same skin as «فروش و فاکتور» — a 20px glyph, the
 * shared label class, hover/focus/selected states, `aria-current` and a
 * tooltip at the icon rail. It is a link, not a disclosure: no chevron, no
 * `aria-expanded`, no nested panel, and no open/closed state to remember.
 *
 * RTL: every inset is logical (`ms`/`me`, `border-s`, `text-start`), and each
 * row is a real `SidebarMenuButton` over a real `<Link>` so a screen reader
 * hears the same structure the eye sees.
 */

import { SidebarContent } from "@/components/ui/sidebar";
import type { AppShellNavProps } from "@/app/dashboard/app-shell-nav";
import { BackToWorkspaceMenu } from "@/app/dashboard/app-section-nav";
import { NavGroup } from "@/app/dashboard/sidebar-nav-group";
import {
  accountingWorkspaceGroups,
  workspaceEntryIsActive,
  type WorkspaceNavEntry,
} from "./accounting-workspace";

export function AccountingAppNav({
  permissions,
  pathname,
  search = "",
  navItems = [],
  onNavigate,
}: AppShellNavProps) {
  const groups = accountingWorkspaceGroups({ permissions: new Set(permissions), navItems });

  return (
    <SidebarContent className="px-3 py-4">
      <nav aria-label="منوی حسابداری" className="space-y-3">
        <BackToWorkspaceMenu onNavigate={onNavigate} />

        {groups.map((group) => {
          if (group.entries.length === 0) return null;
          const isActive = (entry: WorkspaceNavEntry) => workspaceEntryIsActive(entry, pathname, search);
          return <NavGroup key={group.key} group={group} isActive={isActive} onNavigate={onNavigate} />;
        })}
      </nav>
    </SidebarContent>
  );
}
