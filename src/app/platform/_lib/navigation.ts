/**
 * The console's information architecture — one grouped source of truth for the
 * sidebar, the mobile drawer and breadcrumb resolution.
 *
 * The flat 16-item sidebar made unrelated functions look equally important;
 * grouping them by operator intent (Customers, Revenue, Product, Operations,
 * Access & Security) restores hierarchy (task section 2). Persian labels face
 * the operator; the `href`/`id` identifiers stay English.
 *
 * Capability gating here is UI honesty only — every route re-checks server-side.
 */
import type { PlatformCapability } from "@/lib/platform-admin";

export interface NavItem {
  label: string;
  href: string;
  /** Capability required to see the item (any one of, if array). */
  cap?: PlatformCapability | PlatformCapability[];
  /** Exact-match the pathname (for a group's root landing page). */
  exact?: boolean;
  /** Extra path prefixes that also mark this item active (e.g. detail routes). */
  alsoActive?: string[];
}

export interface NavGroup {
  /** Group heading shown above its items; the overview link stands alone. */
  label: string | null;
  items: NavItem[];
}

/**
 * The grouped navigation. Section labels are Persian; a null label renders the
 * item ungrouped (the overview link at the very top).
 */
export const NAV_GROUPS: NavGroup[] = [
  {
    label: "فضای کاری",
    items: [
      { label: "مدیریت پلتفرم", href: "/platform", exact: true },
      { label: "کسب‌وکار پلتفرم", href: "/platform/company", alsoActive: ["/platform/company/"] },
    ],
  },
  {
    label: "مشتریان",
    items: [
      {
        label: "کسب‌وکارها",
        href: "/platform/businesses",
        alsoActive: ["/platform/businesses/"],
      },
      { label: "پشتیبانی", href: "/platform/support", cap: "support.manage" },
      { label: "نشست‌های فعال", href: "/platform/support/sessions", cap: "businesses.read" },
      { label: "صندوق نصب‌های محلی", href: "/platform/cloud-exceptions", cap: "support.manage" },
      { label: "گزارش‌های خطا", href: "/platform/bug-reports", cap: "audit.read" },
    ],
  },
  {
    label: "درآمد",
    items: [
      // The ONE commercial surface (migration 0176): plans, rates, credit
      // products, subscriptions, invoices, payments, gateways and the
      // commercial audit history — all under /platform/billing. The old
      // /platform/plans builder redirects into its plans tab.
      { label: "صورت‌حساب و درآمد", href: "/platform/billing" },
    ],
  },
  {
    label: "محصول",
    items: [
      { label: "برنامه‌ها", href: "/platform/apps" },
      { label: "هوش مصنوعی", href: "/platform/ai", cap: "ai.read", alsoActive: ["/platform/ai/"] },
      { label: "ویجت‌های پیشنهادی", href: "/platform/ai/widgets", cap: "ai.read" },
      { label: "پلتفرم وب‌سایت", href: "/platform/cms" },
      { label: "پیام‌رسانی", href: "/platform/messaging" },
      { label: "پایگاه دانش", href: "/platform/knowledge" },
    ],
  },
  {
    label: "عملیات",
    items: [
      { label: "سیستم", href: "/platform/system" },
      { label: "پشتیبان‌گیری", href: "/platform/backup", cap: "system.read" },
      { label: "رسانه و فایل‌ها", href: "/platform/media", cap: "system.read" },
      { label: "به‌روزرسانی‌ها", href: "/platform/updates" },
      { label: "رویدادها", href: "/platform/audit" },
    ],
  },
  {
    label: "دسترسی و امنیت",
    items: [
      { label: "حساب من", href: "/platform/account" },
      { label: "امنیت", href: "/platform/security", cap: "system.read" },
      { label: "مدیران", href: "/platform/admins", cap: "admins.manage" },
    ],
  },
];

/** Does the operator's capability set allow seeing this item? */
export function navItemVisible(item: NavItem, caps: PlatformCapability[]): boolean {
  if (!item.cap) return true;
  const list = Array.isArray(item.cap) ? item.cap : [item.cap];
  return list.some((c) => caps.includes(c));
}

/** Whether `pathname` should mark `item` active. */
export function navItemActive(item: NavItem, pathname: string): boolean {
  if (item.alsoActive?.some((p) => pathname === p.replace(/\/$/, "") || pathname.startsWith(p))) {
    return true;
  }
  if (item.exact) return pathname === item.href;
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}

/**
 * Resolve breadcrumbs for a pathname: the group heading (non-linking) plus the
 * matched top-level section. Sub-page crumbs are appended by the page itself.
 */
export function breadcrumbsForPath(
  pathname: string,
): { label: string; href?: string }[] {
  for (const group of NAV_GROUPS) {
    for (const item of group.items) {
      if (item.href === "/platform") continue;
      if (navItemActive(item, pathname)) {
        const crumbs: { label: string; href?: string }[] = [
          { label: "نمای کلی", href: "/platform" },
        ];
        if (group.label) crumbs.push({ label: group.label });
        crumbs.push({ label: item.label, href: item.href });
        return crumbs;
      }
    }
  }
  return [{ label: "نمای کلی", href: "/platform" }];
}
