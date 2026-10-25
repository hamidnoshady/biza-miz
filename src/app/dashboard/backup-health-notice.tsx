"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";

interface HealthResponse {
  health?: {
    alert?: { level: "ok" | "warning" | "error"; reason: string };
  };
}

function warningFor(reason: string | null | undefined): string {
  if (reason === "disabled") {
    return "پشتیبان‌گیری خودکار خاموش است؛ در صورت خرابی دستگاه، داده‌های جدید محافظت نمی‌شوند.";
  }
  if (reason === "local_failed" || reason === "cloud_failed") {
    return "آخرین تلاش برای پشتیبان‌گیری ناموفق بود؛ مشکل را بررسی کنید تا نسخهٔ تازه ساخته شود.";
  }
  return "نسخهٔ پشتیبان تازه‌ای وجود ندارد؛ برای جلوگیری از از دست رفتن داده‌ها، وضعیت پشتیبان‌گیری را بررسی کنید.";
}

/** Persistent until the same health calculation used by Backup Manager is healthy. */
export function BackupHealthNotice() {
  const [health, setHealth] = useState<HealthResponse["health"] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    let controller: AbortController | null = null;
    async function load() {
      controller?.abort();
      controller = new AbortController();
      try {
        const response = await fetch("/api/backup/health", {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) return;
        const data = (await response.json()) as HealthResponse;
        if (active) setHealth(data.health ?? null);
      } catch {
        // Existing health remains visible during a transient refresh failure.
      } finally {
        if (active) setLoading(false);
      }
    }
    void load();
    const interval = window.setInterval(() => void load(), 5 * 60 * 1000);
    window.addEventListener("focus", load);
    return () => {
      active = false;
      controller?.abort();
      window.clearInterval(interval);
      window.removeEventListener("focus", load);
    };
  }, []);

  if (loading && !health) {
    return <Skeleton aria-label="بررسی سلامت پشتیبان‌گیری" className="h-9 rounded-none" />;
  }
  if (!health?.alert || health.alert.level === "ok") return null;

  return (
    <div role="alert" className="flex items-center justify-center gap-2 bg-amber-500/10 px-4 py-2 text-center text-sm font-medium text-amber-800 dark:text-amber-200">
      <AlertTriangle aria-hidden="true" className="size-4 shrink-0" />
      <span>{warningFor(health.alert.reason)}</span>
      <Link href="/settings/backup" className="shrink-0 underline underline-offset-4">
        بررسی پشتیبان‌گیری
      </Link>
    </div>
  );
}
