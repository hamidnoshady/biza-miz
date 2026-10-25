import Link from "next/link";
import { CloudIcon, LockKeyholeIcon } from "lucide-react";
import { cardClass, PageHeader, PageShell } from "@/app/dashboard/page-chrome";

/** One deployment lock for every cloud application (distinct from plan locks). */
export function CloudRequiredState({ featureName, cloudUrl = null }: { featureName: string; cloudUrl?: string | null }) {
  return (
    <PageShell className="py-6">
      <PageHeader
        title={featureName}
        description="این قابلیت به اتصال کسب‌وکار محلی شما به ابر بیزامیز نیاز دارد."
      />
      <section className={`${cardClass} mx-auto mt-6 max-w-2xl p-6 sm:p-8`}>
        <div className="flex items-start gap-4">
          <span className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-200">
            <LockKeyholeIcon className="size-5" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h2 className="font-bold text-foreground">نیازمند اتصال ابری</h2>
            <p className="mt-2 text-sm leading-7 text-muted-foreground">
              سیستم محلی، حسابداری، CRM، فروش و انبار همچنان فعال‌اند. اتصال به ابر، مدیریت وب‌سایت، رشد و بازاریابی، دستیار هوشمند، گزارش مرکزی و پشتیبان‌گیری ابری را فعال می‌کند.
            </p>
            <Link
              href={cloudUrl ?? "/settings/cloud-sync"}
              className="mt-5 inline-flex min-h-10 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground"
            >
              <CloudIcon className="size-4" aria-hidden="true" />
              {cloudUrl ? "بازکردن نسخهٔ ابری" : "اتصال به ابر"}
            </Link>
          </div>
        </div>
      </section>
    </PageShell>
  );
}
