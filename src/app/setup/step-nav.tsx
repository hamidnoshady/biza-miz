"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import type { AppKey } from "@/lib/apps";
import { toPersianDigits } from "@/lib/digits";
import { stepsFor } from "./steps";
import { useSetupIndustry } from "./industry-context";
import { Skeleton } from "@/components/ui/skeleton";

interface StateResponse {
  progress?: { steps: Record<string, string>; completedAt: string | null };
  siteInstall?: boolean;
  selectedApps?: AppKey[] | null;
}

export function StepNav({ compact = false }: { compact?: boolean }) {
  const pathname = usePathname();
  const industry = useSetupIndustry();
  const [done, setDone] = useState<Record<string, string>>({});
  const [siteInstall, setSiteInstall] = useState(false);
  const [selectedApps, setSelectedApps] = useState<AppKey[] | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    fetch("/api/setup/state")
      .then((r) => r.json())
      .then((s: StateResponse) => {
        if (cancelled) return;
        if (s.progress) setDone(s.progress.steps);
        setSiteInstall(Boolean(s.siteInstall));
        setSelectedApps(s.selectedApps ?? null);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [pathname]);

  // Every site install owns a physical database, including Hybrid. Central
  // cloud tenants do not get an operator-storage destination step.
  const steps = stepsFor(industry, selectedApps).filter(
    (s) => s.id !== "backup" || siteInstall,
  );
  const completedCount = steps.filter((step) => Boolean(done[step.id])).length;
  const percent = steps.length > 0 ? Math.round((completedCount / steps.length) * 100) : 0;

  if (!loaded) {
    return (
      <nav
        role="status"
        aria-live="polite"
        aria-busy="true"
        aria-label="در حال بارگذاری مراحل راه‌اندازی"
        className={compact ? "flex gap-2 overflow-hidden" : "space-y-2"}
      >
        {[0, 1, 2, 3, 4, 5].map((item) => (
          <Skeleton
            key={item}
            aria-hidden="true"
            className="h-9 w-full rounded-lg"
          />
        ))}
      </nav>
    );
  }

  return (
    <nav
      aria-label="مراحل راه‌اندازی کسب‌وکار"
      className={
        compact
          ? "flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none]"
          : "space-y-1"
      }
    >
      {!compact ? (
        <div className="mb-3 rounded-xl bg-muted/60 p-3">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>
              {toPersianDigits(completedCount)} از {toPersianDigits(steps.length)} مرحله
              تکمیل شده
            </span>
            <span className="tabular-nums">{toPersianDigits(percent)}٪</span>
          </div>
          <div
            className="mt-2 h-1 overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-label="پیشرفت کلی راه‌اندازی"
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuetext={`${toPersianDigits(percent)} درصد`}
          >
            <div
              className="h-full rounded-full bg-amber-500 transition-[width] duration-500 dark:bg-amber-400"
              style={{ width: `${percent}%` }}
            />
          </div>
        </div>
      ) : null}
      {steps.map((s, i) => {
        const active = pathname === s.path;
        const isDone = Boolean(done[s.id]);
        // `app_setup` is skippable only when no app was selected; with a
        // selection the Finish gate requires its answers, so do not label it
        // optional.
        const optionalHere =
          s.optional && !(s.id === "app_setup" && (selectedApps?.length ?? 0) > 0);
        return (
          <Link
            key={s.id}
            href={s.path}
            aria-current={active ? "step" : undefined}
            className={`flex min-h-10 items-center gap-2 whitespace-nowrap rounded-xl px-3 py-2 text-sm transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none ${
              active
                ? "bg-amber-100 font-semibold text-amber-950 dark:bg-amber-500/20 dark:text-amber-200"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            }`}
          >
            <span
              aria-label={isDone ? "تکمیل‌شده" : undefined}
              className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] ${
                isDone
                  ? "bg-emerald-700 text-white dark:bg-emerald-500/80"
                  : active
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground"
              }`}
            >
              {isDone ? "✓" : toPersianDigits(i + 1)}
            </span>
            <span className="truncate">{s.short}</span>
            {optionalHere ? (
              <span className="ms-auto text-[10px] text-muted-foreground">
                اختیاری
              </span>
            ) : null}
          </Link>
        );
      })}
      <Link
        href="/setup/finish"
        className={`mt-2 flex items-center gap-2 rounded-lg border-t border-border px-3 py-2 pt-3 text-sm ${
          pathname === "/setup/finish"
            ? "font-semibold text-primary"
            : "text-muted-foreground hover:bg-muted/50"
        }`}
      >
        پایان راه‌اندازی
      </Link>
    </nav>
  );
}
