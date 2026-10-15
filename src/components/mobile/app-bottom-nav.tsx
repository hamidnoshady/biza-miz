"use client";

/**
 * Adaptive 5-slot mobile bottom navigation (`MobileAppBottomNav`:
 * `Home | Sales | + | CRM | More`) for the Android TWA and mobile app
 * experience (issue #884).
 *
 * Adapts the primary operational slots to the business's industry, enabled
 * modules, and the signed-in user's authorized route set (`allowedHrefs`), and
 * opens `QuickCreateSheet` from the central `+` action button.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import {
  HomeIcon,
  MenuIcon,
  PlusIcon,
  ShoppingCartIcon,
  UsersIcon,
} from "lucide-react";
import { QuickCreateSheet } from "./quick-create-sheet";

export interface AdaptiveNavSlot {
  key: "home" | "sales" | "crm";
  href: string;
  label: string;
}

export function resolveAdaptiveBottomNavSlots(input: {
  industry?: string | null;
  allowedHrefs: ReadonlySet<string>;
  customHrefs?: readonly string[] | null;
}): { home: AdaptiveNavSlot; sales: AdaptiveNavSlot | null; crm: AdaptiveNavSlot | null } {
  const { industry, allowedHrefs } = input;

  const home: AdaptiveNavSlot = {
    key: "home",
    href: "/dashboard",
    label: "خانه",
  };

  const salesCandidates: Array<{ href: string; label: string }> =
    industry === "healthcare" || industry === "beauty"
      ? [
          { href: "/appointments", label: "نوبت‌ها" },
          { href: "/pos", label: "صندوق" },
          { href: "/accounting/orders", label: "فروش" },
        ]
      : industry === "aec"
        ? [
            { href: "/projects", label: "پروژه‌ها" },
            { href: "/accounting/orders", label: "فروش" },
            { href: "/pos", label: "صندوق" },
          ]
        : industry === "wholesale" || industry === "manufacturing"
          ? [
              { href: "/accounting/orders", label: "فروش" },
              { href: "/pos", label: "صندوق" },
              { href: "/accounting/inventory", label: "انبار" },
            ]
          : [
              { href: "/pos", label: "فروش" },
              { href: "/accounting/orders", label: "فروش" },
              { href: "/accounting/receipts", label: "دریافت" },
            ];

  const resolvedSales = salesCandidates.find((c) => allowedHrefs.has(c.href)) ?? null;

  const crmCandidates: Array<{ href: string; label: string }> = [
    { href: "/crm", label: "مشتریان" },
    { href: "/crm/customers", label: "مشتریان" },
    { href: "/accounting/customers", label: "مشتریان" },
    { href: "/accounting/products", label: "کالاها" },
    { href: "/accounting/receipts", label: "دریافت" },
  ];

  const resolvedCrm =
    crmCandidates.find((c) => allowedHrefs.has(c.href) && c.href !== resolvedSales?.href) ?? null;

  return {
    home,
    sales: resolvedSales ? { key: "sales", ...resolvedSales } : null,
    crm: resolvedCrm ? { key: "crm", ...resolvedCrm } : null,
  };
}

export interface MobileAppBottomNavProps {
  industry?: string | null;
  allowedHrefs: ReadonlySet<string>;
  onOpenMore: () => void;
  moreOpen?: boolean;
}

export function MobileAppBottomNav({
  industry,
  allowedHrefs,
  onOpenMore,
  moreOpen = false,
}: MobileAppBottomNavProps) {
  const pathname = usePathname() ?? "/dashboard";
  const [quickCreateOpen, setQuickCreateOpen] = useState(false);

  const slots = resolveAdaptiveBottomNavSlots({ industry, allowedHrefs });

  function isSlotActive(href: string): boolean {
    if (href === "/dashboard") return pathname === "/dashboard";
    return pathname === href || pathname.startsWith(`${href}/`);
  }

  const itemClass = (active: boolean) =>
    `relative flex min-h-12 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-xl px-1 py-1 text-[11px] transition-colors ${
      active
        ? "font-semibold text-amber-800 dark:text-amber-300"
        : "font-medium text-muted-foreground hover:text-foreground"
    }`;

  return (
    <>
      <nav
        aria-label="ناوبری پایین صفحه"
        className="fixed inset-x-0 bottom-0 z-20 flex items-center justify-around gap-1 border-t border-border/80 bg-card/95 px-2 pt-1.5 pb-[max(0.375rem,env(safe-area-inset-bottom))] backdrop-blur-md lg:hidden"
      >
        <Link
          href={slots.home.href}
          aria-current={isSlotActive(slots.home.href) ? "page" : undefined}
          className={itemClass(isSlotActive(slots.home.href))}
        >
          <HomeIcon className="size-5 shrink-0" aria-hidden="true" />
          <span className="max-w-full truncate leading-tight">{slots.home.label}</span>
        </Link>

        {slots.sales ? (
          <Link
            href={slots.sales.href}
            aria-current={isSlotActive(slots.sales.href) ? "page" : undefined}
            className={itemClass(isSlotActive(slots.sales.href))}
          >
            <ShoppingCartIcon className="size-5 shrink-0" aria-hidden="true" />
            <span className="max-w-full truncate leading-tight">{slots.sales.label}</span>
          </Link>
        ) : null}

        <div className="flex shrink-0 items-center justify-center px-1">
          <button
            type="button"
            aria-label="ایجاد سریع"
            onClick={() => setQuickCreateOpen(true)}
            className="inline-flex size-11 items-center justify-center rounded-2xl bg-amber-600 dark:bg-amber-500 text-white dark:text-stone-950 transition hover:bg-amber-700 dark:hover:bg-amber-400"
          >
            <PlusIcon className="size-5" aria-hidden="true" />
          </button>
        </div>

        {slots.crm ? (
          <Link
            href={slots.crm.href}
            aria-current={isSlotActive(slots.crm.href) ? "page" : undefined}
            className={itemClass(isSlotActive(slots.crm.href))}
          >
            <UsersIcon className="size-5 shrink-0" aria-hidden="true" />
            <span className="max-w-full truncate leading-tight">{slots.crm.label}</span>
          </Link>
        ) : null}

        <button
          type="button"
          onClick={onOpenMore}
          aria-expanded={moreOpen}
          className={itemClass(moreOpen)}
        >
          <MenuIcon className="size-5 shrink-0" aria-hidden="true" />
          <span className="max-w-full truncate leading-tight">بیشتر</span>
        </button>
      </nav>

      <QuickCreateSheet
        open={quickCreateOpen}
        onOpenChange={setQuickCreateOpen}
        allowedHrefs={allowedHrefs}
      />
    </>
  );
}
