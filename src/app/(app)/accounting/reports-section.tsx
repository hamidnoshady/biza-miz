"use client";

/**
 * Accounting → «گزارش‌های مالی».
 *
 * The financial statements themselves are built by the business-reporting
 * workspace (`/accounting/reports`). This financial index remains a ledger
 * section at `/accounting/financial-reports`, so the two report surfaces have
 * different names and there is no competing `/dashboard/reports` address.
 *
 * This section is an index, not a second report engine. Its links make the
 * destination clear while keeping both financial and operational reporting in
 * the same primary Accounting application.
 */

import {
  BarChart3Icon,
  ClipboardListIcon,
  PercentIcon,
  ScrollTextIcon,
  type LucideIcon,
} from "lucide-react";
import { DestinationCard, SectionCard } from "@/app/dashboard/page-chrome";
import { accountingSectionHref } from "./accounting-routes";

interface ReportLink {
  label: string;
  description: string;
  href: string;
  icon: LucideIcon;
  /** True when the link leaves the Accounting app — said out loud on the card. */
  external?: boolean;
}

const IN_APP_REPORTS: ReportLink[] = [
  {
    label: "گزارش فروش شیفت",
    description: "فروش‌ها و سفارش‌های شیفت جاری؛ با بستن شیفت و شروع شیفت بعدی، گزارش از صفر شروع می‌شود.",
    href: "/accounting/reports?tab=shift-orders",
    icon: BarChart3Icon,
  },
  {
    label: "دفتر روزنامه",
    description: "همهٔ اسناد ثبت‌شده، با امکان جست‌وجو و فیلتر.",
    href: accountingSectionHref("entries"),
    icon: ClipboardListIcon,
  },
  {
    label: "گزارش مالیات بر ارزش افزوده",
    description: "مالیات فروش و خرید دوره، آمادهٔ اظهارنامه.",
    href: accountingSectionHref("vat"),
    icon: PercentIcon,
  },
  {
    label: "دریافت و پرداخت",
    description: "گردش وجه نقد و بانک در بازهٔ انتخابی.",
    href: accountingSectionHref("receipts"),
    icon: ScrollTextIcon,
  },
];

const BUSINESS_REPORTS: ReportLink[] = [
  {
    label: "گزارش‌های کسب‌وکار",
    description:
      "صورت سود و زیان، ترازنامه و گزارش‌ساز در فضای گزارش‌های کسب‌وکارِ همین برنامه قرار دارد.",
    href: "/accounting/reports",
    icon: BarChart3Icon,
  },
];

function ReportCard({ link }: { link: ReportLink }) {
  return (
    <DestinationCard
      href={link.href}
      title={link.label}
      description={link.description}
      icon={link.icon}
      external={link.external}
    />
  );
}

export function AccountingReportsSection() {
  return (
    <div className="space-y-4">
      <SectionCard
        title="گزارش‌های حسابداری"
        description="گزارش‌هایی که خودِ برنامهٔ حسابداری می‌سازد."
      >
        <div className="grid gap-3 sm:grid-cols-2">
          {IN_APP_REPORTS.map((link) => (
            <ReportCard key={link.href} link={link} />
          ))}
        </div>
      </SectionCard>

      <SectionCard
        title="گزارش‌های کسب‌وکار"
        description="گزارش‌های عملیاتی و گزارش‌سازِ همین فضای کاری."
      >
        <div className="grid gap-3 sm:grid-cols-2">
          {BUSINESS_REPORTS.map((link) => (
            <ReportCard key={link.href} link={link} />
          ))}
        </div>
      </SectionCard>
    </div>
  );
}
