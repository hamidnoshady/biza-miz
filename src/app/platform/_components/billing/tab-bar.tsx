"use client";

/**
 * The Billing Control Center's tab strip — query-param tabs on one canonical
 * route (`/platform/billing?tab=…`). Management tabs are hidden from operators
 * whose role lacks the tab's capability (the APIs re-check every write
 * server-side; this is UI honesty only). Horizontal scroll keeps it usable on
 * phones.
 */
import type { PlatformCapability } from "@/lib/platform-admin";

export const BILLING_TABS = [
  { key: "overview", label: "نمای کلی" },
  { key: "plans", label: "پلن‌ها و بسته‌ها", cap: "plans.manage" },
  { key: "usage", label: "تعرفه مصرف و اعتبار", cap: "billing.manage" },
  { key: "meters", label: "کنتورها و قیمت", cap: "billing.manage" },
  { key: "subscriptions", label: "اشتراک‌ها" },
  { key: "invoices", label: "فاکتورها" },
  { key: "payments", label: "پرداخت‌ها" },
  { key: "spend", label: "سقف هزینه", cap: "billing.manage" },
  // Issue #1041 — the per-service tariff and the destruction window are part
  // of the commercial console: money in (setup + hourly) and data out.
  { key: "services", label: "سرویس‌ها و نرخ ساعتی", cap: "billing.manage" },
  { key: "retention", label: "نگهداری داده", cap: "retention.manage" },
  { key: "gateways", label: "درگاه‌های پرداخت", cap: "gateways.manage" },
  { key: "rules", label: "قواعد و تنظیمات", cap: "billing.manage" },
  { key: "audit", label: "تاریخچه تغییرات" },
] as const satisfies readonly { key: string; label: string; cap?: PlatformCapability }[];

export type BillingTab = (typeof BILLING_TABS)[number]["key"];

export function BillingTabBar({
  active,
  onChange,
  can,
}: {
  active: BillingTab;
  onChange: (tab: BillingTab) => void;
  /** The signed-in admin's capability predicate (`useCan()`). */
  can: (capability: PlatformCapability) => boolean;
}) {
  return (
    <nav aria-label="بخش‌های صورت‌حساب" className="flex gap-1 overflow-x-auto rounded-xl border border-border bg-card p-1">
      {BILLING_TABS.filter((t) => !("cap" in t && t.cap) || can(t.cap)).map((item) => {
        const isActive = active === item.key;
        return (
          <button
            key={item.key}
            type="button"
            onClick={() => onChange(item.key)}
            aria-current={isActive ? "page" : undefined}
            className={
              isActive
                ? "shrink-0 whitespace-nowrap rounded-lg bg-sky-500/15 px-3.5 py-2 text-sm font-medium text-sky-700 dark:text-sky-300"
                : "shrink-0 whitespace-nowrap rounded-lg px-3.5 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            }
          >
            {item.label}
          </button>
        );
      })}
    </nav>
  );
}
