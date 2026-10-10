"use client";

/**
 * One group of entries in the dashboard's navigation column, written once for
 * every menu that draws one.
 *
 * Why it exists: the Accounting menu's groups were each hand-rolled, in two
 * places (`dashboard-sidebar.tsx` and `accounting-app-nav.tsx`) that had
 * already drifted apart by a `duration-200`. The shared component keeps the
 * rules the menus agree on (docs/design-system.md §Rail navigation, §Radius
 * scale, §Colour roles):
 *  - a group heading is the **metadata label** (`NAV_GROUP_LABEL_CLASS`), and
 *    a group with no label is one ordinary link standing alone in the column —
 *    the «فضای کار حسابداری» workspace door, which wears its words on the row
 *    the way «فروش و فاکتور» does, never on a heading above it and never on a
 *    disclosure;
 *  - every row is a real `SidebarMenuButton`/`Link` wearing the shared skins
 *    (`APP_NAV_BUTTON_CLASS`, `NAV_LABEL_CLASS`) with the row's own tooltip,
 *    hover/focus/selected states and `aria-current`;
 *  - RTL throughout: logical insets only (`ms`/`ps`/`border-s`/`text-start`);
 *  - at the 4rem icon rail the words hide and the rows stay reachable.
 */

import Link from "next/link";
import { CircleIcon } from "lucide-react";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { NAV_ICONS } from "./sidebar-nav-icons";
import { APP_NAV_BUTTON_CLASS, NAV_LABEL_CLASS } from "./sidebar-nav-styles";
import type {
  WorkspaceNavEntry,
  WorkspaceNavGroup,
} from "@/app/(app)/accounting/accounting-workspace";
import { ACCOUNTING_SECTION_ICONS } from "@/app/(app)/accounting/accounting-icons";

/** The metadata type a group heading is written in — stated once. */
export const NAV_GROUP_LABEL_CLASS =
  "px-3 pb-1 pt-2 text-[11px] font-semibold tracking-wide text-muted-foreground group-data-[state=collapsed]/sidebar:hidden";

/**
 * The hairline that replaces a heading at the 4rem rail, where words are
 * hidden and two groups would otherwise read as one column of glyphs.
 */
export const NAV_GROUP_RULE_CLASS =
  "mx-2 hidden border-t border-border/70 group-data-[state=collapsed]/sidebar:block";

/** Whether an entry is the page currently open — each menu's own rule. */
export type EntryActiveTest = (entry: WorkspaceNavEntry) => boolean;

function EntryIcon({ entry }: { entry: WorkspaceNavEntry }) {
  // An explicit `iconKey` wins — it is the one place a row names the *mapping*
  // (the «حسابداری» calculator, `LEDGER_WORKSPACE_ICON_KEY`) rather than its
  // section's glyph. An entry has never carried both a business icon and a
  // section before, so this changes nothing for the existing rows.
  const Icon = entry.iconKey
    ? (NAV_ICONS[entry.iconKey] ?? CircleIcon)
    : entry.section
      ? ACCOUNTING_SECTION_ICONS[entry.section]
      : (NAV_ICONS[entry.href.split("?")[0]] ?? CircleIcon);
  return <Icon aria-hidden="true" className="size-5 shrink-0" />;
}

export function NavEntries({
  entries,
  isActive,
  onNavigate,
}: {
  entries: readonly WorkspaceNavEntry[];
  isActive: EntryActiveTest;
  /** Closes the mobile drawer after a tap, the way the flat nav does. */
  onNavigate: () => void;
}) {
  return (
    <SidebarMenu className="space-y-1.5">
      {entries.map((entry) => {
        const active = isActive(entry);
        return (
          <SidebarMenuItem key={entry.href}>
            <SidebarMenuButton asChild isActive={active} tooltip={entry.label} className={APP_NAV_BUTTON_CLASS}>
              <Link href={entry.href} onClick={onNavigate} aria-current={active ? "page" : undefined}>
                <EntryIcon entry={entry} />
                <span className={NAV_LABEL_CLASS}>{entry.label}</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        );
      })}
    </SidebarMenu>
  );
}

/**
 * A block of the menu: an optional heading over its rows.
 *
 * Without a label the block is one ordinary link in the column — the same
 * visual treatment as a row inside any other group, and no group furniture
 * around it beyond the collapsed-rail hairline that keeps the icon column's
 * boundaries legible.
 */
export function NavGroup({
  group,
  isActive,
  onNavigate,
}: {
  group: WorkspaceNavGroup;
  isActive: EntryActiveTest;
  onNavigate: () => void;
}) {
  return (
    <div className="space-y-1.5">
      <div aria-hidden="true" className={NAV_GROUP_RULE_CLASS} />
      {group.label ? <p className={NAV_GROUP_LABEL_CLASS}>{group.label}</p> : null}
      <NavEntries entries={group.entries} isActive={isActive} onNavigate={onNavigate} />
    </div>
  );
}
