"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import { stepsFor } from "./steps";
import { useSetupIndustry } from "./industry-context";
import { Skeleton } from "@/components/ui/skeleton";

interface StateResponse {
  progress?: { steps: Record<string, string>; completedAt: string | null };
  siteInstall?: boolean;
}

export function StepNav({ compact = false }: { compact?: boolean }) {
  const pathname = usePathname();
  const industry = useSetupIndustry();
  const [done, setDone] = useState<Record<string, string>>({});
  const [siteInstall, setSiteInstall] = useState(false);
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
  const steps = stepsFor(industry).filter(
    (s) => s.id !== "backup" || siteInstall,
  );

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
      className={
        compact
          ? "flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none]"
          : "space-y-1"
      }
    >
      {steps.map((s, i) => {
        const active = pathname === s.path;
        const isDone = Boolean(done[s.id]);
        return (
          <Link
            key={s.id}
            href={s.path}
            aria-current={active ? "step" : undefined}
            className={`flex min-h-10 items-center gap-2 whitespace-nowrap rounded-xl px-3 py-2 text-sm transition-colors ${
              active
                ? "bg-amber-100 font-semibold text-amber-950 dark:bg-amber-500/20 dark:text-amber-200"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            }`}
          >
            <span
              className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] ${
                isDone
                  ? "bg-emerald-700 dark:bg-emerald-500/80 text-white"
                  : active
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground"
              }`}
            >
              {isDone ? "✓" : toPersianDigits(i + 1)}
            </span>
            <span className="truncate">{s.short}</span>
            {s.optional ? (
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
