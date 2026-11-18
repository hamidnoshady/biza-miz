"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { WalletIcon, XIcon } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { useMoney } from "@/components/money/money-context";
import type { SetupAppCatalogData } from "@/lib/setup-apps";
import { cardClass } from "./page-chrome";

const DISMISS_PREFIX = "setup-wallet-notice:";

/**
 * The post-Finish handoff reminder (issue #1239 / ESH-90).
 *
 * It appears only when the owner selected at least one app that is not active
 * yet. It never charges anything: its two destinations are the wallet top-up
 * page and the existing services screen where the binding quote is confirmed.
 * Dismissal is per selection, so a new app restores the reminder without
 * bringing back a popup on every render.
 */
export function SetupWalletNotice() {
  const money = useMoney();
  const [data, setData] = useState<SetupAppCatalogData | null>(null);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/setup/apps")
      .then((response) => (response.ok ? response.json() : null))
      .then((loaded: SetupAppCatalogData | null) => {
        if (!cancelled && loaded) setData(loaded);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const selected = (data?.cards ?? []).filter((card) => card.selected);
  const pending = selected.filter((card) => !card.activation?.active);
  const dismissKey =
    selected.length > 0
      ? `${DISMISS_PREFIX}${selected.map((card) => card.key).join(",")}`
      : null;

  useEffect(() => {
    if (!dismissKey) return;
    try {
      setHidden(window.localStorage.getItem(dismissKey) === "1");
    } catch {
      setHidden(false);
    }
  }, [dismissKey]);

  if (!data) {
    return (
      <div
        className={`${cardClass} mx-2 mt-2 p-4`}
        role="status"
        aria-live="polite"
        aria-busy="true"
        aria-label="در حال بررسی وضعیت کیف پول و برنامه‌ها"
      >
        <Skeleton className="h-10 w-full rounded-xl" />
      </div>
    );
  }

  if (selected.length === 0 || pending.length === 0 || hidden) return null;

  function dismiss() {
    setHidden(true);
    if (!dismissKey) return;
    try {
      window.localStorage.setItem(dismissKey, "1");
    } catch {
      // A private/blocked storage area only loses the dismissal; the content
      // is still correct on the next render.
    }
  }

  const incomplete = pending.filter((card) => !card.setupComplete);
  const setupDue = pending.reduce((sum, card) => sum + (card.pricing?.setupRial ?? 0), 0);
  const daily = pending.reduce((sum, card) => sum + (card.pricing?.estimated24hRial ?? 0), 0);

  return (
    <section
      dir="rtl"
      aria-label="یادآوری کیف پول و فعال‌سازی برنامه‌ها"
      className={`${cardClass} mx-2 mt-2 p-4`}
    >
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200">
          <WalletIcon className="size-4" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <p className="font-semibold text-foreground">
              {incomplete.length > 0
                ? "برای فعال‌سازی، ابتدا راه‌اندازی برنامه‌های انتخاب‌شده را کامل کنید."
                : "راه‌اندازی اولیه تکمیل شد. برنامه‌های انتخاب‌شده هنوز فعال نیستند؛ برای فعال‌سازی، کیف پول خود را بررسی یا شارژ کنید."}
            </p>
            <button
              type="button"
              onClick={dismiss}
              aria-label="بستن یادآوری"
              className="rounded-lg p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <XIcon className="size-4" aria-hidden="true" />
            </button>
          </div>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            {pending.map((card) => card.label).join("، ")} — موجودی کیف پول:{" "}
            {money.format(data.walletBalanceRial)}
            {setupDue > 0 ? `، جمع راه‌اندازی: ${money.format(setupDue)}` : ""}
            {daily > 0 ? `، برآورد روزانه: ${money.format(daily)}` : ""}. هیچ مبلغی
            تا تأیید شما کسر نمی‌شود.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
            <Link
              href="/settings/billing"
              className="rounded-lg bg-primary px-3 py-1.5 font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
            >
              شارژ کیف پول
            </Link>
            <Link href="/settings/services" className="text-primary hover:underline">
              {incomplete.length > 0 ? "بررسی راه‌اندازی برنامه‌ها" : "بررسی و فعال‌سازی برنامه‌ها"}
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}
