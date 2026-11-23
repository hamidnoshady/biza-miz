"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { FileUpIcon, XIcon } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import type { SetupImportsData } from "@/lib/setup-imports";
import { toPersianDigits } from "@/lib/digits";
import { cardClass } from "./page-chrome";

const DISMISS_PREFIX = "setup-import-notice:";

/**
 * The dashboard's continuation link for unfinished onboarding imports
 * (issue #1535 / ESH-218).
 *
 * Finish never blocks on an optional import, so the four states that still need
 * the owner or the worker — staged, applying, partial and failed — have to be
 * findable after the wizard closes. This notice is that door; it never claims a
 * job succeeded and never re-runs one.
 *
 * Dismissal is keyed to the current unfinished set, so a genuinely new or
 * changed job restores the reminder without a permanent popup.
 */
export function SetupImportNotice() {
  const [data, setData] = useState<SetupImportsData | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/setup/imports")
      .then((response) => (response.ok ? response.json() : null))
      .then((loadedData: SetupImportsData | null) => {
        if (cancelled) return;
        if (loadedData) setData(loadedData);
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const unfinished = (data?.sessions ?? []).filter(
    (session) =>
      session.state === "staged" ||
      session.state === "applying" ||
      session.state === "partial" ||
      session.state === "failed",
  );
  const dismissKey =
    unfinished.length > 0
      ? `${DISMISS_PREFIX}${unfinished.map((session) => session.id).join(",")}`
      : null;

  useEffect(() => {
    if (!dismissKey) return;
    try {
      setHidden(window.localStorage.getItem(dismissKey) === "1");
    } catch {
      setHidden(false);
    }
  }, [dismissKey]);

  if (!loaded) {
    return (
      <div
        className={`${cardClass} mx-2 mt-2 p-4`}
        role="status"
        aria-live="polite"
        aria-busy="true"
        aria-label="در حال بررسی وضعیت ورود اطلاعات"
      >
        <Skeleton className="h-10 w-full rounded-xl" />
      </div>
    );
  }

  if (!data || unfinished.length === 0 || hidden) return null;

  function dismiss() {
    setHidden(true);
    if (!dismissKey) return;
    try {
      window.localStorage.setItem(dismissKey, "1");
    } catch {
      // A blocked storage area only loses the dismissal.
    }
  }

  const needsOwner = unfinished.filter(
    (session) => session.state !== "applying",
  ).length;

  return (
    <section
      dir="rtl"
      aria-label="ادامهٔ ورود اطلاعات اولیه"
      className={`${cardClass} mx-2 mt-2 p-4`}
    >
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200">
          <FileUpIcon className="size-4" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <p className="font-semibold text-foreground">
              {needsOwner > 0
                ? "ورود اطلاعات اولیه هنوز کامل نشده است."
                : "ورود اطلاعات اولیه در حال اجراست."}
            </p>
            <button
              type="button"
              onClick={dismiss}
              aria-label="بستن یادآوری ورود اطلاعات"
              className="rounded-lg p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              <XIcon className="size-4" aria-hidden="true" />
            </button>
          </div>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            {toPersianDigits(unfinished.length)} جلسه در انتظار تأیید، بازبینی یا
            تکمیل است. جلسه‌های نیمه‌کاره ذخیره شده‌اند و می‌توانید همین‌جا ادامه
            دهید؛ داده‌ای دوباره ثبت نمی‌شود.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
            <Link
              href="/settings/data-transfer"
              className="rounded-lg bg-primary px-3 py-1.5 font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
            >
              ادامهٔ ورود اطلاعات
            </Link>
            <span className="text-xs text-muted-foreground">
              ورود اطلاعات اختیاری است و به فعال‌سازی برنامه‌ها ربطی ندارد.
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
