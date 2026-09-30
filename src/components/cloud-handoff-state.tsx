// src/components/cloud-handoff-state.tsx
"use client";

/**
 * Phase 45 — a Hybrid desktop does not render back-office screens. It hands
 * the same address to the «نسخهٔ ابری» window (a phone on the LAN gets a
 * new-tab link), and says so here. Offline it says the screen needs the
 * Internet: the till keeps working, this part waits for the connection.
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import { CloudIcon, CloudOffIcon } from "lucide-react";
import { cardClass, PageHeader, PageShell } from "@/app/dashboard/page-chrome";
import { Button } from "@/components/ui/button";
import { ACCOUNTING_WORKSPACE_HREFS } from "@/lib/app-routes";

export function cloudHandoffUrl(cloudUrl: string | null, pathAndQuery: string): string | null {
  if (!cloudUrl) return null;
  try {
    const url = new URL(pathAndQuery, cloudUrl);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function CloudHandoffState({ pathname, cloudUrl }: { pathname: string; cloudUrl: string | null }) {
  const [target, setTarget] = useState<string | null>(() => cloudHandoffUrl(cloudUrl, pathname));
  const [online, setOnline] = useState(true);
  const [opened, setOpened] = useState(false);
  const [desktop, setDesktop] = useState(false);

  useEffect(() => {
    // Runs on mount and again on every online/offline event, so the offline
    // screen really does open once the connection returns.
    const handOff = () => {
      const next = cloudHandoffUrl(cloudUrl, `${pathname}${window.location.search}`);
      const bridge = window.businessSuiteDesktop;
      setTarget(next);
      setOnline(navigator.onLine);
      setDesktop(Boolean(bridge?.openCloud));
      setOpened(false);
      if (next && navigator.onLine && bridge?.openCloud) void bridge.openCloud(next).then(setOpened);
    };
    handOff();
    window.addEventListener("online", handOff);
    window.addEventListener("offline", handOff);
    return () => {
      window.removeEventListener("online", handOff);
      window.removeEventListener("offline", handOff);
    };
  }, [pathname, cloudUrl]);

  const reopen = () => {
    if (target) void window.businessSuiteDesktop?.openCloud?.(target).then(setOpened);
  };

  const message = !target
    ? "نشانی نسخهٔ ابری تنظیم نشده است. اتصال را از «تنظیمات ← ابر و همگام‌سازی» بررسی کنید."
    : !online
      ? "صندوق، میزها، آشپزخانه و شیفت بدون اینترنت روی همین دستگاه کار می‌کنند. این بخش با برگشت اینترنت باز می‌شود."
      : opened
        ? "این بخش در پنجرهٔ «نسخهٔ ابری» باز شد."
        : "حسابداری، گزارش‌ها، انبار، مشتریان و تنظیمات در نسخهٔ ابری کار می‌کنند.";

  return (
    <PageShell className="py-6">
      <PageHeader title="نسخهٔ ابری" description="این بخش روی نسخهٔ ابری کسب‌وکار شما کار می‌کند." />
      <section className={`${cardClass} mx-auto mt-6 max-w-2xl p-6 sm:p-8`}>
        <div className="flex items-start gap-4">
          <span className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-200">
            {online ? <CloudIcon className="size-5" aria-hidden="true" /> : <CloudOffIcon className="size-5" aria-hidden="true" />}
          </span>
          <div className="min-w-0">
            {!online && target ? <h2 className="font-bold text-foreground">این بخش به اینترنت نیاز دارد</h2> : null}
            <p className="mt-2 text-sm leading-7 text-muted-foreground">{message}</p>
            <div className="mt-5 flex flex-wrap gap-2">
              {target && online ? (
                desktop ? (
                  <Button onClick={reopen}>
                    <CloudIcon className="size-4" aria-hidden="true" />
                    بازکردن دوباره در نسخهٔ ابری
                  </Button>
                ) : (
                  <Button asChild>
                    <a href={target} target="_blank" rel="noopener noreferrer">
                      <CloudIcon className="size-4" aria-hidden="true" />
                      بازکردن نسخهٔ ابری
                    </a>
                  </Button>
                )
              ) : null}
              <Button variant="outline" asChild>
                <Link href={ACCOUNTING_WORKSPACE_HREFS.pos}>بازگشت به صندوق</Link>
              </Button>
            </div>
          </div>
        </div>
      </section>
    </PageShell>
  );
}
