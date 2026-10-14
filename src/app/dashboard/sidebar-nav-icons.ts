/**
 * One glyph per navigation href.
 *
 * Split out of `dashboard-sidebar.tsx` for the same reason
 * `sidebar-nav-styles.ts` was: an app's own nav component has to draw the
 * business pages it adopts (the Accounting workspace lists فاکتورها، انبار،
 * محصولات beside its ledger sections), and importing the shell that imports
 * the app would close a cycle. Two icon maps over one set of pages is how the
 * same page ends up with two faces.
 *
 * Keyed by href, because that is the stable identity of a page — the label is
 * the trade's word for it and changes per industry.
 */
import {
  ArmchairIcon,
  BarChart3Icon,
  BookOpenIcon,
  CalculatorIcon,
  CalendarDaysIcon,
  ChefHatIcon,
  ClipboardListIcon,
  ContactIcon,
  GemIcon,
  GlobeIcon,
  ImageIcon,
  LayoutDashboardIcon,
  LifeBuoyIcon,
  PackageIcon,
  PlugIcon,
  SettingsIcon,
  ShoppingCartIcon,
  SparklesIcon,
  TrendingUpIcon,
  TruckIcon,
  UsersIcon,
  WalletIcon,
  WatchIcon,
  CarIcon,
  type LucideIcon,
} from "lucide-react";

export const NAV_ICONS: Record<string, LucideIcon> = {
  "/dashboard": LayoutDashboardIcon,
  "/accounting/orders": ClipboardListIcon,
  // Business work areas now sit under the primary Accounting workspace. The
  // retired dashboard URLs are redirect-only and intentionally have no icon
  // entries, so a new menu item cannot accidentally reintroduce one.
  "/accounting/pos": ShoppingCartIcon,
  "/crm/directory": UsersIcon,
  "/accounting/floor": ArmchairIcon,
  "/accounting/waiter": ArmchairIcon,
  "/accounting/kitchen": ChefHatIcon,
  "/accounting/reservations": CalendarDaysIcon,
  "/accounting/delivery": TruckIcon,
  "/accounting/inventory": PackageIcon,
  // The products workspace group's icon (nav entries derive theirs from href;
  // the group has none, so it names this key via `iconKey`).
  "/accounting/products": PackageIcon,
  "/accounting/jewelry": GemIcon,
  "/accounting/watch": WatchIcon,
  // Issue #839 — the automotive manager.
  "/accounting/automotive": CarIcon,
  // The Accounting app's own home (`/accounting`); the old
  // `/dashboard/ledger` address still forwards into it in middleware, so
  // nothing keys on the retired URL any more.
  "/accounting": CalculatorIcon,
  // Each app's *home* is its overview, and the nav entry carries that exact
  // href — so the glyph has to be keyed on it too, or the app's own door falls
  // back to the generic circle.
  "/accounting/overview": CalculatorIcon,
  "/settings/connections": PlugIcon,
  // Migration 0149 — the media library.
  "/media": ImageIcon,
  "/accounting/reports": BarChart3Icon,
  "/accounting/cosmetics": SparklesIcon,
  "/settings/billing": WalletIcon,
  "/settings": SettingsIcon,
  // Phase 36b — the Growth & Marketing app's home; the trend glyph the
  // workspace rail already uses for «رشد و بازاریابی».
  "/growth": TrendingUpIcon,
  "/growth/overview": TrendingUpIcon,
  // Phase 36 — the CRM app's home. `/crm/directory` keeps the plain
  // people glyph above; this is the app that now owns that record.
  "/crm": ContactIcon,
  "/crm/overview": ContactIcon,
  // «مدیریت وب‌سایت» — one app for both website systems (the Eshobe CMS site
  // builder and the WordPress/WooCommerce manager, each its own section).
  "/websites": GlobeIcon,
  "/websites/overview": GlobeIcon,
  // Migration 0130 — the support desk.
  "/support": LifeBuoyIcon,
  // Migration 0131 — the in-product knowledge base («مرکز آموزش»).
  "/knowledge": BookOpenIcon,
};
