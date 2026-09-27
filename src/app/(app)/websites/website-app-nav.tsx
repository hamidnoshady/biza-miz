"use client";

/**
 * Website Management's contextual sidebar.
 *
 * Website Management is one app with two managers, so it supplies manager
 * route data and connection-state visibility while sharing the common
 * AppSectionNav shell with CRM, Growth and My Workspace. That prevents a
 * visually separate bespoke sidebar from drifting in active state, RTL layout,
 * keyboard behavior or the back-to-platform affordance.
 */

import { useEffect, useState } from "react";
import {
  ContactIcon,
  CreditCardIcon,
  FileTextIcon,
  FolderTreeIcon,
  GlobeIcon,
  ImageIcon,
  LayoutDashboardIcon,
  ReceiptTextIcon,
  SendIcon,
  SettingsIcon,
  ShoppingBagIcon,
  WandSparklesIcon,
  type LucideIcon,
} from "lucide-react";
import type { AppShellNavProps } from "@/app/dashboard/app-shell-nav";
import {
  AppSectionNav,
  AppSectionNavSkeleton,
  type AppSectionNavGroup,
  type AppSectionNavItem,
} from "@/app/dashboard/app-section-nav";
import { api } from "@/app/dashboard/ui";
import { CMS_NAV_ITEMS, WEBSITE_NAV_GROUPS, WP_NAV_ITEMS } from "./website-nav";
import {
  cmsSectionHref,
  EMPTY_WEBSITE_MANAGERS_STATE,
  isCmsSectionPathname,
  isWpSectionPathname,
  visibleCmsSections,
  visibleWpSections,
  WEBSITE_OVERVIEW_HREF,
  WEBSITE_SETTINGS_HREF,
  wpSectionHref,
  type CmsSectionKey,
  type WebsiteManagersState,
} from "./website-routes";
import type { WpSectionKey } from "./wp/wp-routes";

const CMS_ICONS: Record<CmsSectionKey, LucideIcon> = {
  overview: LayoutDashboardIcon,
  setup: WandSparklesIcon,
  pages: FileTextIcon,
  posts: FileTextIcon,
  media: ImageIcon,
  products: ShoppingBagIcon,
  orders: ReceiptTextIcon,
  design: WandSparklesIcon,
  domain: GlobeIcon,
  settings: SettingsIcon,
  billing: CreditCardIcon,
};

const WP_ICONS: Record<WpSectionKey, LucideIcon> = {
  overview: LayoutDashboardIcon,
  products: ShoppingBagIcon,
  orders: ReceiptTextIcon,
  customers: ContactIcon,
  taxonomies: FolderTreeIcon,
  content: FileTextIcon,
  media: ImageIcon,
  queue: SendIcon,
};

type WebsiteNavKey = "overview" | "settings" | `cms:${CmsSectionKey}` | `wp:${WpSectionKey}`;

function cmsKey(key: CmsSectionKey): WebsiteNavKey {
  return `cms:${key}`;
}

function wpKey(key: WpSectionKey): WebsiteNavKey {
  return `wp:${key}`;
}

/** Reads a manager key only after its stable `cms:` / `wp:` prefix has matched. */
function managerSectionFor(key: WebsiteNavKey): { manager: "cms"; key: CmsSectionKey } | { manager: "wp"; key: WpSectionKey } | null {
  if (key.startsWith("cms:")) return { manager: "cms", key: key.slice(4) as CmsSectionKey };
  if (key.startsWith("wp:")) return { manager: "wp", key: key.slice(3) as WpSectionKey };
  return null;
}

export function WebsiteAppNav({ shell, pathname, onNavigate }: AppShellNavProps) {
  // Start from the same safe state used when the manager-status request fails:
  // each manager still exposes only a useful front door / connection CTA, never
  // an unavailable orders or content screen.
  const [state, setState] = useState<WebsiteManagersState>(EMPTY_WEBSITE_MANAGERS_STATE);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    api<{ managers: WebsiteManagersState }>("/api/website/managers").then(({ ok, data }) => {
      if (!alive) return;
      setState(ok ? data.managers : EMPTY_WEBSITE_MANAGERS_STATE);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, []);

  if (loading) {
    return (
      <AppSectionNavSkeleton
        ariaLabel="بخش‌های مدیریت وب‌سایت"
        title={shell.label}
        description={shell.description}
      />
    );
  }

  const cmsItems = CMS_NAV_ITEMS
    .filter((item) => visibleCmsSections(state).includes(item.key))
    .map<AppSectionNavItem<WebsiteNavKey>>((item) => ({
      key: cmsKey(item.key),
      label: item.label,
      description: item.description,
      icon: CMS_ICONS[item.key],
    }));
  const wpItems = WP_NAV_ITEMS
    .filter((item) => visibleWpSections(state).includes(item.key))
    .map<AppSectionNavItem<WebsiteNavKey>>((item) => ({
      key: wpKey(item.key),
      label: item.label,
      description: item.description,
      icon: WP_ICONS[item.key],
    }));

  const items: AppSectionNavItem<WebsiteNavKey>[] = [
    {
      key: "overview",
      label: "نمای کلی وب‌سایت",
      description: "وضعیت مدیرهای سایت و راه‌های شروع کار",
      icon: LayoutDashboardIcon,
    },
    ...cmsItems,
    ...wpItems,
    {
      key: "settings",
      label: "تنظیمات وب‌سایت",
      description: "تنظیمات این برنامه، جدا از تنظیمات پلتفرم",
      icon: SettingsIcon,
    },
  ];
  const groups: AppSectionNavGroup<WebsiteNavKey>[] = [
    { label: "نمای کلی", keys: ["overview"] },
    { label: WEBSITE_NAV_GROUPS[0].label, keys: cmsItems.map((item) => item.key) },
    { label: WEBSITE_NAV_GROUPS[1].label, keys: wpItems.map((item) => item.key) },
    { label: "تنظیمات", keys: ["settings"] },
  ];

  return (
    <AppSectionNav<WebsiteNavKey>
      ariaLabel="بخش‌های مدیریت وب‌سایت"
      title={shell.label}
      description={shell.description}
      items={items}
      groups={groups}
      hrefFor={(key) => {
        if (key === "overview") return WEBSITE_OVERVIEW_HREF;
        if (key === "settings") return WEBSITE_SETTINGS_HREF;
        const section = managerSectionFor(key);
        if (!section) return WEBSITE_OVERVIEW_HREF;
        return section.manager === "cms" ? cmsSectionHref(section.key) : wpSectionHref(section.key);
      }}
      isActive={(key) => {
        if (key === "overview") return pathname === WEBSITE_OVERVIEW_HREF;
        if (key === "settings") return pathname === WEBSITE_SETTINGS_HREF;
        const section = managerSectionFor(key);
        if (!section) return false;
        return section.manager === "cms"
          ? isCmsSectionPathname(pathname, section.key)
          : isWpSectionPathname(pathname, section.key);
      }}
      onNavigate={onNavigate}
    />
  );
}
