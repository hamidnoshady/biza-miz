// src/app/dashboard/till-navigation.tsx
"use client";

/**
 * Phase 45 — the sidebar of a Hybrid desktop: the till screens this member
 * may open (already reduced by `tillNavItems`), plus one «نسخهٔ ابری» door.
 * No app rail and no app menus — those are the cloud's.
 */
import Link from "next/link";
import { CircleIcon, CloudIcon } from "lucide-react";
import { SidebarContent, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { bestNavMatch, flattenNav } from "@/lib/nav-tree";
import type { NavItem } from "./dashboard-sidebar";
import { NAV_ICONS } from "./sidebar-nav-icons";
import { APP_NAV_BUTTON_CLASS, NAV_LABEL_CLASS } from "./sidebar-nav-styles";

export function TillNavigation({
  navItems,
  pathname,
  cloudUrl,
}: {
  navItems: NavItem[];
  pathname: string;
  cloudUrl: string | null;
}) {
  const items = flattenNav(navItems);
  const active = bestNavMatch(items, (href) => pathname === href || pathname.startsWith(`${href}/`));
  const openCloud = () => {
    if (!cloudUrl) return;
    const bridge = window.businessSuiteDesktop;
    if (bridge?.openCloud) void bridge.openCloud(cloudUrl);
    else window.open(cloudUrl, "_blank", "noopener,noreferrer");
  };
  return (
    <SidebarContent className="px-3 py-4">
      <nav aria-label="صندوق" className="space-y-4">
        <SidebarMenu className="space-y-1.5">
          {items.map((item) => {
            const Icon = NAV_ICONS[item.href] ?? CircleIcon;
            const isActive = active?.href === item.href;
            return (
              <SidebarMenuItem key={item.href}>
                <SidebarMenuButton asChild isActive={isActive} tooltip={item.label} className={APP_NAV_BUTTON_CLASS}>
                  <Link href={item.href} aria-current={isActive ? "page" : undefined}>
                    <Icon aria-hidden="true" className="size-5 shrink-0" />
                    <span className={NAV_LABEL_CLASS}>{item.label}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
        {cloudUrl ? (
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton tooltip="نسخهٔ ابری" className={APP_NAV_BUTTON_CLASS} onClick={openCloud}>
                <CloudIcon aria-hidden="true" className="size-5 shrink-0" />
                <span className={NAV_LABEL_CLASS}>نسخهٔ ابری</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        ) : null}
      </nav>
    </SidebarContent>
  );
}
