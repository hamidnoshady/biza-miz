"use client";

/**
 * Platform Settings → «حسابداری» tab.
 *
 * The chart of accounts now lives in its canonical screen —
 * `/accounting/chart-of-accounts` — which is the dedicated editor inside the
 * Accounting workspace. Keeping a second, live editor here meant two places
 * could restructure the same chart, get out of sync, and expose different
 * validation/guards (issue #824 §8).
 *
 * This tab is now a *shortcut*: it explains where accounting configuration
 * lives and links there. The tab itself is still listed in `settings-tabs.ts`
 * under `accountsEdit` so old bookmarks/deep links (`/settings?tab=accounts`)
 * land on this friendly redirect rather than 404 — but no chart editing
 * happens on the platform settings surface any more. Platform settings stay
 * focused on platform/business settings; accounting configuration belongs in
 * the Accounting app.
 */

import Link from "next/link";
import { BookOpenIcon, ArrowLeftIcon } from "lucide-react";
import { InfoBox } from "@/app/dashboard/ui";
import { SectionCard } from "@/app/dashboard/page-chrome";
import { accountingSectionHref } from "@/app/(app)/accounting/accounting-routes";

export function AccountsSettings() {
  return (
    <div className="space-y-5">
      <InfoBox>
        مدیریت سرفصل حساب‌ها به صفحهٔ اختصاصی خود در برنامهٔ حسابداری منتقل شده است تا تنها یک نقطه برای ویرایش ساختار حساب‌ها وجود داشته باشد.
      </InfoBox>
      <SectionCard
        title="سرفصل حساب‌ها"
        description="ساختار درختی گروه، کل، معین و تفصیلی — افزودن، ویرایش، جابه‌جایی، بایگانی، گردش حساب و تاریخچهٔ تغییرات."
      >
        <div className="space-y-4">
          <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
            سرفصل حساب‌ها بخشی از برنامهٔ حسابداری است و ویرایش آن در همان‌جا انجام می‌شود. حساب‌های سیستمی محافظت می‌شوند؛ حساب‌های دارای سند حذف نمی‌شوند و فقط بایگانی می‌شوند؛ همهٔ تغییرات به‌صورت یکپارچه اعتبارسنجی و در تاریخچه ثبت می‌شوند.
          </p>
          <div className="flex flex-wrap gap-3">
            <Link
              href={accountingSectionHref("chart-of-accounts")}
              className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90"
            >
              <BookOpenIcon className="size-4" aria-hidden="true" />
              باز کردن مدیریت سرفصل حساب‌ها
            </Link>
            <Link
              href={accountingSectionHref("settings")}
              className="inline-flex items-center gap-2 rounded-xl border border-border/80 px-4 py-2 text-sm font-medium text-foreground transition hover:bg-muted"
            >
              <ArrowLeftIcon className="size-4" aria-hidden="true" />
              تنظیمات حسابداری
            </Link>
          </div>
        </div>
      </SectionCard>
    </div>
  );
}
