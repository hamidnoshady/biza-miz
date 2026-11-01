/**
 * The Growth app's main-menu entries (Phase 36b, revised).
 *
 * One list, two readers: the app's own sidebar (rendered through
 * `growth-app-nav.tsx` in the dashboard's app slot) and, before it, the menu
 * the page drew for itself. Section *routes* and the role gate stay in
 * `growth-routes.ts` — this file adds only what a menu needs to be drawn (a
 * label, a line of help, a glyph), so the app's name for a section and the
 * section's own title can never drift apart, and the cashier's shorter list is
 * derived from `canViewGrowthSection` rather than repeated here.
 *
 * No `"use client"` and no JSX: the list is data, and the sidebar (a client
 * component) and the app shell both need it.
 */

import {
  CreditCardIcon,
  HandCoinsIcon,
  HeartIcon,
  MegaphoneIcon,
  MessageCircleIcon,
  SettingsIcon,
  ShoppingBagIcon,
  TrendingUpIcon,
  UsersIcon,
  type LucideIcon,
} from "lucide-react";
import { canViewGrowthSection, type GrowthSectionKey } from "./growth-routes";

export interface GrowthNavItem {
  key: GrowthSectionKey;
  label: string;
  /** One line under the label — the rail's help text, hidden in a collapsed sidebar. */
  description: string;
  icon: LucideIcon;
}

/** The app's sections, in menu order. The overview is the app's home. */
export const GROWTH_NAV_ITEMS: readonly GrowthNavItem[] = [
  {
    key: "overview",
    label: "میز کار رشد",
    description: "اعداد کلیدی و رویدادها",
    icon: TrendingUpIcon,
  },
  {
    key: "customers",
    label: "مخاطبان",
    description: "نمای چرخهٔ حیات و خرید از پرونده‌های مشترک CRM",
    icon: UsersIcon,
  },
  {
    key: "campaigns",
    label: "کمپین‌ها",
    description: "موتور تخفیف و اثربخشی",
    icon: MegaphoneIcon,
  },
  {
    key: "messaging",
    label: "پیام‌رسانی",
    description: "پیامک و ایمیل رضایت‌محور، اعتبار و صف ارسال",
    icon: MessageCircleIcon,
  },
  {
    key: "gift-cards",
    label: "کارت هدیه",
    description: "صدور و مصرف",
    icon: CreditCardIcon,
  },
  {
    key: "loyalty",
    label: "وفاداری و اعتبار",
    description: "امتیاز و اعتبار فروشگاهی",
    icon: HeartIcon,
  },
  {
    key: "commission",
    label: "پورسانت فروشندگان",
    description: "قواعد و رتبه‌بندی",
    icon: HandCoinsIcon,
  },
  {
    // Issue #894: the Torob channel, seated in Growth's own rail rather than in a
    // separate app — a merchant manages one channel here, not a second product.
    key: "torob",
    label: "کانال ترب",
    description: "انتشار محصولات وب‌سایت‌های تحت مدیریت در ترب",
    icon: ShoppingBagIcon,
  },
  {
    key: "settings",
    label: "تنظیمات رشد و بازاریابی",
    description: "تنظیمات همین برنامه — نه تنظیمات پلتفرم",
    icon: SettingsIcon,
  },
];

/**
 * The entries a role may open — `canViewGrowthSection` is the only gate, so a
 * section that becomes floor-safe changes the menu by changing that one function.
 */
export function growthNavItemsForPermissions(permissions: ReadonlySet<import("@/lib/permissions").Permission>): GrowthNavItem[] {
  return GROWTH_NAV_ITEMS.filter((item) => canViewGrowthSection(permissions, item.key));
}
