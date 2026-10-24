"use client";

/**
 * The two states the shared store provider renders *instead of* its children:
 * the first read in flight, and the first read failed.
 *
 * Issue #944 / OVR-02: a failed list read used to be shown as «هنوز فروشگاهی
 * متصل نیست». That empty state is reserved for a successful, empty list; a
 * 401, 403, feature lock, 5xx or an offline browser each get their own words
 * and a «تلاش دوباره» — except the signed-out case, whose only remedy is
 * logging in again.
 */
import Link from "next/link";
import { PlugZapIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cardClass, SectionCardSkeleton } from "@/app/dashboard/page-chrome";
import { errorMessageOrRaw } from "@/app/dashboard/ui";
import { toPersianDigits } from "@/lib/digits";

export interface WpStoreFailure {
  status: number;
  code: string;
}

/** The sentence for a failed connection-list read, by what failed. Exported for the tests. */
export function describeStoreLoadFailure(failure: WpStoreFailure): { title: string; detail: string; signedOut: boolean } {
  if (failure.status === 401 || failure.code === "unauthorized") {
    return {
      title: "نشست شما به پایان رسیده است",
      detail: "برای دیدن فروشگاه‌های متصل دوباره وارد شوید.",
      signedOut: true,
    };
  }
  if (failure.code === "feature_disabled") {
    return {
      title: "مدیریت وردپرس برای این کسب‌وکار فعال نیست",
      detail: errorMessageOrRaw("feature_disabled"),
      signedOut: false,
    };
  }
  if (failure.code === "business_suspended") {
    return {
      title: "دسترسی این کسب‌وکار موقتاً معلق شده است",
      detail: "فهرست فروشگاه‌ها تا رفع تعلیق خوانده نمی‌شود.",
      signedOut: false,
    };
  }
  if (failure.code === "invalid_connections_response") {
    return {
      title: "پاسخ فهرست فروشگاه‌ها معتبر نیست",
      detail: "سرور فهرست فروشگاه‌ها را با قالب نامعتبر برگرداند؛ آن‌ها را ناموجود تلقی نمی‌کنیم. دوباره تلاش کنید.",
      signedOut: false,
    };
  }
  if (failure.status === 403) {
    return {
      title: "دسترسی به فهرست فروشگاه‌ها ندارید",
      detail: "برای این بخش مجوز «مشاهده ووکامرس» لازم است. اگر به‌تازگی به شما داده شده، دوباره تلاش کنید؛ وگرنه از مدیر کسب‌وکار بخواهید.",
      signedOut: false,
    };
  }
  if (failure.status === 0) {
    return {
      title: "ارتباط با سرور برقرار نشد",
      detail: "اتصال اینترنت را بررسی کنید و دوباره تلاش کنید. فهرست فروشگاه‌ها خوانده نشد؛ این به معنی نبود فروشگاه نیست.",
      signedOut: false,
    };
  }
  return {
    title: "خواندن فهرست فروشگاه‌ها ناموفق بود",
    detail:
      (failure.code ? errorMessageOrRaw(failure.code) : "") ||
      `سرور پاسخ نامعتبری داد (کد ${toPersianDigits(String(failure.status))}). فروشگاه‌های متصل شما سر جای خود هستند؛ دوباره تلاش کنید.`,
    signedOut: false,
  };
}

export function WpStoreLoadingSkeleton() {
  return <SectionCardSkeleton rows={6} label="در حال خواندن فروشگاه‌های متصل" />;
}

export function WpStoreLoadError({
  failure,
  onRetry,
  retrying,
}: {
  failure: WpStoreFailure;
  onRetry: () => void;
  retrying: boolean;
}) {
  const { title, detail, signedOut } = describeStoreLoadFailure(failure);
  return (
    <div role="alert" aria-live="assertive" className={`${cardClass} flex flex-col items-center gap-3 px-4 py-10 text-center sm:px-5`}>
      <span className="flex size-11 items-center justify-center rounded-xl bg-red-50 text-red-600 dark:bg-red-500/15 dark:text-red-300">
        <PlugZapIcon aria-hidden="true" className="size-5" />
      </span>
      <p className="font-semibold text-foreground">{title}</p>
      <p className="max-w-md text-sm leading-6 text-muted-foreground">{detail}</p>
      {signedOut ? (
        <Button asChild size="sm">
          <Link href="/login">ورود دوباره</Link>
        </Button>
      ) : (
        <Button size="sm" variant="outline" onClick={onRetry} disabled={retrying}>
          {retrying ? "در حال تلاش…" : "تلاش دوباره"}
        </Button>
      )}
    </div>
  );
}

/**
 * The inline banner for a *refresh* that failed while an older list is still
 * on screen — the list is kept, the member is told it may be out of date.
 */
export function WpStoreRefreshError({ failure, onRetry }: { failure: WpStoreFailure; onRetry: () => void }) {
  const { title } = describeStoreLoadFailure(failure);
  return (
    <p
      role="status"
      className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-amber-50 px-4 py-2 text-xs text-amber-900 dark:bg-amber-500/10 dark:text-amber-200"
    >
      <span>به‌روزرسانی فهرست فروشگاه‌ها ناموفق بود ({title})؛ فهرست قبلی نمایش داده می‌شود.</span>
      <Button size="sm" variant="ghost" onClick={onRetry}>
        تلاش دوباره
      </Button>
    </p>
  );
}
