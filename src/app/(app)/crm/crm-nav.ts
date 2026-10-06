/**
 * The CRM app's main-menu entries — the Relationship OS information
 * architecture.
 *
 * One list, three readers: the app's own sidebar (`crm-app-nav.tsx`, rendered
 * in the dashboard's app slot), the app's groups below, and the overview's
 * quick actions. Section *routes* and the permission table stay in
 * `crm-routes.ts` / `crm-permissions.ts` — this file adds only what a menu
 * needs to be drawn, so the app's name for a section and the section's own
 * heading cannot drift apart, and a cashier's shorter list is derived from
 * `canViewCrmSection` rather than being repeated here.
 *
 * ## Why the groups
 *
 * The previous menu was eleven flat entries, which is a data model rendered as
 * navigation: «سرنخها» sat beside «قیف فروش» as though they were different
 * kinds of thing, and «اشخاص تکراری» sat beside «بخشبندی» for the same reason.
 * A staff member opening the app had to know the schema to find the screen they
 * wanted.
 *
 * The groups are the product's own concepts — the questions a person actually
 * arrives with — and they keep the destinations that answer the same question
 * together:
 *
 * - **امروز** — what needs attention.
 * - **مشتریان** — who is this person.
 * - **فرصتها** — what are we selling, and what might we sell.
 * - **ارتباط و پیگیری** — what did we promise, and what is outstanding.
 * - **شناخت مشتری** — what do we know about them in aggregate, and what may we
 *   say to them.
 * - **کیفیت داده** — where the record is wrong or unattached.
 * - **حاکمیت و تنظیمات** — who decided what, and how this app is configured.
 *
 * No `"use client"` and no JSX: the list is data, and both a client component
 * and a server component need it.
 */

import {
  DatabaseZapIcon,
  HeadsetIcon,
  HistoryIcon,
  LayoutDashboardIcon,
  ListChecksIcon,
  SettingsIcon,
  ShieldCheckIcon,
  SproutIcon,
  TargetIcon,
  UserSearchIcon,
  UsersIcon,
  type LucideIcon,
} from "lucide-react";
import type { AppSectionNavGroup } from "@/app/dashboard/app-section-nav";
import { canViewCrmSection, type CrmSectionKey } from "@/lib/crm-permissions";

export interface CrmNavItem {
  key: CrmSectionKey;
  label: string;
  /** One line under the label — hidden in a collapsed sidebar. */
  description: string;
  icon: LucideIcon;
}

/** The app's sections, in menu order. The overview is the app's home. */
export const CRM_NAV_ITEMS: readonly CrmNavItem[] = [
  {
    key: "overview",
    label: "امروز",
    description: "چه کسی به توجه نیاز دارد و قدم بعدی چیست",
    icon: LayoutDashboardIcon,
  },
  {
    key: "directory",
    label: "مشتریان",
    description: "جست‌وجو، افزودن، و پروندهٔ هر شخص",
    icon: UsersIcon,
  },
  {
    key: "deals",
    label: "فرصت‌ها",
    description: "معامله‌ها در قیف فروش: چقدر، برای کی، قدم بعدی چیست",
    icon: TargetIcon,
  },
  {
    key: "leads",
    label: "سرنخ‌ها",
    description: "پرس‌وجوهایی که هنوز مشتری نشده‌اند",
    icon: SproutIcon,
  },
  {
    key: "activities",
    label: "کارها و پیگیری‌ها",
    description: "تماس، جلسه و یادآوری — امروز و عقب‌افتاده",
    icon: ListChecksIcon,
  },
  {
    key: "cases",
    label: "تیکت‌های خدمات",
    description: "شکایت‌ها و درخواست‌ها با مهلت پاسخ‌گویی",
    icon: HeadsetIcon,
  },
  {
    key: "segments",
    label: "بخش‌بندی و شناخت",
    description: "گروه‌های پویا، ارزش مشتری و ریسک ریزش",
    icon: UserSearchIcon,
  },
  {
    key: "consent",
    label: "رضایت ارتباط",
    description: "سابقهٔ اجازهٔ پیامک و ایمیل",
    icon: ShieldCheckIcon,
  },
  {
    key: "quality",
    label: "کیفیت داده",
    description: "مسائل داده، پرونده‌های تکراری و خریداران ناشناس",
    icon: DatabaseZapIcon,
  },
  {
    key: "audit",
    label: "سابقهٔ تصمیم‌ها",
    description: "چه کسی چه تصمیمی گرفت و چه زمانی",
    icon: HistoryIcon,
  },
  {
    key: "settings",
    label: "تنظیمات ارتباط با مشتری",
    description: "قیف، فیلدهای کسب‌وکار، تطبیق و رضایت — نه تنظیمات پلتفرم",
    icon: SettingsIcon,
  },
];

/**
 * The menu's information architecture.
 *
 * `AppSectionNav` ignores a key it was not given, so a group never resurrects a
 * section a member's permissions filtered out — the same arrangement Website
 * Management uses to keep its two managers distinct in one menu.
 */
export const CRM_NAV_GROUPS: ReadonlyArray<AppSectionNavGroup<CrmSectionKey>> = [
  { label: "امروز", keys: ["overview"] },
  { label: "مشتریان", keys: ["directory"] },
  { label: "فرصت‌ها", keys: ["deals", "leads"] },
  { label: "ارتباط و پیگیری", keys: ["activities", "cases"] },
  { label: "شناخت مشتری", keys: ["segments", "consent"] },
  { label: "کیفیت داده", keys: ["quality"] },
  { label: "حاکمیت و تنظیمات", keys: ["audit", "settings"] },
];

/**
 * Sections that live *inside* a workspace rather than in the rail.
 *
 * Each is still a real section: its own route, its own permission gate, its own
 * bookmarks. What changed is where it is reached from — «کیفیت داده» opens on
 * the three questions together, and the old addresses keep working for anybody
 * who saved one. A sub-section absent from the rail is therefore **not** a
 * statement about permission, which is exactly why it has to be a declared list
 * rather than a silent omission.
 */
export const CRM_SUB_SECTIONS: readonly CrmSectionKey[] = [
  "duplicates",
  "reconciliation",
  // «اتوماسیون‌ها» is configuration, so it belongs to the settings screen rather
  // than the rail: the rail answers the six questions a person arrives with, and
  // "which rules run on their own" is not one of them until somebody wants to
  // write one. The command field finds it by name, and the settings screen links
  // to it, so nothing is buried — only ordered.
  "automations",
];

/**
 * The entries a member may open — `canViewCrmSection` is the only gate, so a
 * section that becomes floor-safe changes the menu by changing that one
 * function rather than this list.
 */
export function crmNavItemsForPermissions(
  permissions: ReadonlySet<import("@/lib/permissions").Permission>,
): CrmNavItem[] {
  return CRM_NAV_ITEMS.filter((item) => canViewCrmSection(permissions, item.key));
}

/**
 * The same grouping, with the sections this member may not open dropped.
 *
 * Derived from `CRM_NAV_ITEMS` rather than from `CRM_NAV_GROUPS` directly so a
 * section added to one list and forgotten in the other cannot end up visible in
 * the menu but missing from the grouped render — the failure mode
 * `AppSectionNav` would otherwise hide by simply not drawing it.
 */
export function crmNavGroupsForPermissions(
  items: readonly CrmNavItem[],
): ReadonlyArray<AppSectionNavGroup<CrmSectionKey>> {
  const visible = new Set(items.map((item) => item.key));
  const grouped = CRM_NAV_GROUPS.map((group) => ({
    label: group.label,
    keys: group.keys.filter((key) => visible.has(key)),
  })).filter((group) => group.keys.length > 0);
  const groupedKeys = new Set(grouped.flatMap((group) => [...group.keys]));
  const ungrouped = items.filter((item) => !groupedKeys.has(item.key));
  return ungrouped.length > 0 ? [...grouped, { label: "بیشتر", keys: ungrouped.map((item) => item.key) }] : grouped;
}
