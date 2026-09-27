"use client";

/**
 * «سایت‌ساز» — the website platform's own section of the console.
 *
 * Everything an operator does to eshobe-cms lives here, because that is what the
 * repository layout rule asks for: functionality that supervises clients *across*
 * businesses belongs in the super-admin console, not in a per-business dashboard.
 * The business-facing half («مدیریت وب‌سایت», `/websites`) is unchanged
 * and is a different job — one owner, one site.
 *
 * Five pages, in the order an operator actually works in them: the report, the
 * fleet's sites, syncing content, the log tail, and the connection itself last
 * (because it is configured once and then read, not worked in).
 */
import { SubNav } from "../ui";

export default function CmsSectionLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-6xl space-y-4">
      <SubNav
        items={[
          { exact: true, href: "/platform/cms", label: "میز فرمان" },
          { href: "/platform/cms/sites", label: "سایت‌ها" },
          { href: "/platform/cms/themes", label: "پوسته‌ها" },
          { href: "/platform/cms/infrastructure", label: "زیرساخت" },
          { href: "/platform/cms/billing-sync", label: "همگام‌سازی صورتحساب" },
          { href: "/platform/cms/sync", label: "همگام‌سازی محتوا" },
          { href: "/platform/cms/logs", label: "فعالیت" },
          { href: "/platform/cms/connection", label: "اتصال" },
        ]}
      />
      {children}
    </div>
  );
}
