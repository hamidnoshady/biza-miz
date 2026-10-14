"use client";

/**
 * The shape an app's main sidebar takes when the app is a flat list of
 * sections — written once, worn by every app that is one.
 *
 * CRM and Growth each shipped their own copy of this component, and the copies
 * were identical down to the comment about the two-line help text: the same
 * markup, the same «بازگشت» control, the same `line-clamp-2` description, the
 * same tooltip composition. Structural sameness was the *intent* there — "two
 * apps in the same platform whose menus behaved differently would be two
 * products" — but it was enforced by nobody, so the only thing keeping the two
 * menus in step was that no one had edited one of them yet. A fix to the
 * collapsed-rail behaviour, the tooltip, or the RTL arrow would have landed in
 * one app and quietly skipped the other.
 *
 * So the *arrangement* lives here and each app supplies only what is actually
 * its own: its sections, labels and glyphs, href function, active-state rule,
 * and the name a screen reader announces the menu by. Apps can also pass their
 * own information-architecture groups; Website Management uses that to keep
 * its CMS and WordPress managers distinct without maintaining a second sidebar
 * implementation. Accounting retains its dedicated navigation because its
 * business-type filtering is structurally different.
 *
 * The `NAV_LABEL_CLASS`/`APP_NAV_BUTTON_CLASS` skins and the «بازگشت» control
 * come from `sidebar-nav-styles.ts`, the same place every other menu in the
 * product takes them from, so «you are here» looks the same everywhere.
 */

import Link from "next/link";
import { ArrowRightIcon, type LucideIcon } from "lucide-react";
import {
  SidebarContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import {
  APP_NAV_BUTTON_CLASS,
  BACK_TO_WORKSPACE_BUTTON_CLASS,
  NAV_LABEL_CLASS,
} from "./sidebar-nav-styles";

/** A section as a flat app menu needs it drawn. */
export interface AppSectionNavItem<K extends string = string> {
  key: K;
  label: string;
  /** One line under the label — hidden when the rail collapses to icons. */
  description: string;
  icon: LucideIcon;
}

/**
 * Optional information-architecture headings for a contextual app menu.
 *
 * The app owns its route keys; this primitive only arranges those keys. A
 * missing key is ignored (usually because a role or connection-state gate
 * removed it), so grouping can never resurrect a route the caller hid.
 */
export interface AppSectionNavGroup<K extends string = string> {
  label: string;
  keys: readonly K[];
}

/**
 * «بازگشت» leads out to the workspace home for every app, so owning the
 * sidebar never means trapping the member inside the app. One home, one label,
 * stated once rather than in each app's component.
 */
export const BACK_TO_WORKSPACE_HREF = "/dashboard";
export const BACK_TO_WORKSPACE_LABEL = "بازگشت به میز کار";

/** The «بازگشت» control: always first, always drawn as a control, not a section. */
export function BackToWorkspaceMenu({ onNavigate }: { onNavigate: () => void }) {
  return (
    <>
      <SidebarMenu className="space-y-1.5">
        <SidebarMenuItem>
          <SidebarMenuButton
            asChild
            tooltip={BACK_TO_WORKSPACE_LABEL}
            className={BACK_TO_WORKSPACE_BUTTON_CLASS}
          >
            <Link href={BACK_TO_WORKSPACE_HREF} onClick={onNavigate}>
              {/* An arrow drawn for LTR points the wrong way in Persian. */}
              <ArrowRightIcon aria-hidden="true" className="size-5 shrink-0 rtl:rotate-180" />
              <span className={NAV_LABEL_CLASS}>{BACK_TO_WORKSPACE_LABEL}</span>
            </Link>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
      <div aria-hidden="true" className="border-t border-border/80" />
    </>
  );
}

/**
 * Structural placeholder for a contextual sidebar whose visible sections depend
 * on an initial client-side request. It preserves the sidebar's footprint and
 * announces its busy state instead of briefly showing links for another
 * connection state.
 */
export function AppSectionNavSkeleton({
  ariaLabel,
  title,
  description,
}: {
  ariaLabel: string;
  title: string;
  description: string;
}) {
  return (
    <SidebarContent className="px-3 py-4">
      <nav aria-label={ariaLabel} aria-busy="true" className="space-y-3">
        <div className="px-2 group-data-[state=collapsed]/sidebar:hidden">
          <p className="text-sm font-bold text-foreground">{title}</p>
          <p className="mt-0.5 text-[11px] leading-5 text-muted-foreground">{description}</p>
        </div>
        <div aria-hidden="true" className="border-t border-border/80" />
        <SidebarMenu aria-hidden="true" className="space-y-2">
          {Array.from({ length: 5 }, (_, index) => (
            <SidebarMenuItem key={index}>
              <div className="flex min-h-11 items-center gap-3 rounded-lg px-2">
                <Skeleton className="size-5 shrink-0 rounded-md" />
                <div className="min-w-0 flex-1 space-y-1.5 group-data-[state=collapsed]/sidebar:hidden">
                  <Skeleton className="h-3.5 w-2/3" />
                  <Skeleton className="h-3 w-full" />
                </div>
              </div>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </nav>
    </SidebarContent>
  );
}

export function AppSectionNav<K extends string>({
  /** Names the menu for a screen reader — «بخش‌های …». */
  ariaLabel,
  /** The app's name and one line of description, from the shell registry. */
  title,
  description,
  items,
  groups,
  hrefFor,
  isActive,
  onNavigate,
}: {
  ariaLabel: string;
  title: string;
  description: string;
  items: readonly AppSectionNavItem<K>[];
  /** Headings for a long contextual menu; omitted for a flat app menu. */
  groups?: readonly AppSectionNavGroup<K>[];
  hrefFor: (key: K) => string;
  isActive: (key: K) => boolean;
  onNavigate: () => void;
}) {
  const itemsByKey = new Map(items.map((item) => [item.key, item]));
  const groupedItems: ReadonlyArray<{ label: string | null; items: readonly AppSectionNavItem<K>[] }> = groups
    ? groups
        .map((group) => ({
          label: group.label,
          items: group.keys
            .map((key) => itemsByKey.get(key))
            .filter((item): item is AppSectionNavItem<K> => Boolean(item)),
        }))
        .filter((group) => group.items.length > 0)
    : [{ label: null, items }];
  return (
    <SidebarContent className="px-3 py-4">
      <nav aria-label={ariaLabel} className="space-y-3">
        <div className="px-2 group-data-[state=collapsed]/sidebar:hidden">
          <p className="text-sm font-bold text-foreground">{title}</p>
          <p className="mt-0.5 text-[11px] leading-5 text-muted-foreground">{description}</p>
        </div>

        <BackToWorkspaceMenu onNavigate={onNavigate} />

        {groupedItems.map((group, groupIndex) => (
          <div key={group.label ?? `items-${groupIndex}`} className="space-y-1.5">
            {group.label ? (
              <p className="px-3 pb-1 pt-2 text-[11px] font-semibold tracking-wide text-muted-foreground group-data-[state=collapsed]/sidebar:hidden">
                {group.label}
              </p>
            ) : null}
            {groupIndex > 0 ? (
              <div
                aria-hidden="true"
                className="mx-2 hidden border-t border-border/70 group-data-[state=collapsed]/sidebar:block"
              />
            ) : null}
            <SidebarMenu className="space-y-1.5">
              {group.items.map((item) => {
                const active = isActive(item.key);
                const Icon = item.icon;
                return (
                  <SidebarMenuItem key={item.key}>
                    <SidebarMenuButton
                      asChild
                      isActive={active}
                      tooltip={`${item.label} — ${item.description}`}
                      className={APP_NAV_BUTTON_CLASS}
                    >
                      <Link
                        href={hrefFor(item.key)}
                        onClick={onNavigate}
                        aria-current={active ? "page" : undefined}
                      >
                        <Icon aria-hidden="true" className="size-5 shrink-0" />
                        <span className="min-w-0 flex-1 py-1.5 text-start group-data-[state=collapsed]/sidebar:sr-only">
                          <span className="block truncate">{item.label}</span>
                          {/*
                            The help line is a second line, so it needs room to
                            be one: two clamped lines keep long Persian labels
                            legible while the collapsed rail uses the tooltip.
                          */}
                          <span className="mt-0.5 block line-clamp-2 text-[11px] font-normal leading-4 text-muted-foreground">
                            {item.description}
                          </span>
                        </span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </div>
        ))}
      </nav>
    </SidebarContent>
  );
}
