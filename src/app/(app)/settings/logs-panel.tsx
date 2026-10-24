"use client";

/**
 * Logs panel (Section 9/12 of the desktop audit): the "Logs" entry the
 * unified Settings Center needs. Surfaces this browser's recorded client
 * errors (error-report.ts's ring buffer) with a one-click export, the
 * redacted route-timing/error aggregate (route-instrumentation.ts — issue
 * #909's "timing and error instrumentation by route family and stage"), and
 * — on the desktop app — a shortcut to reveal the process-level log file
 * (electron/logger.js) in the OS file explorer, so "logs" means one place to
 * look whether the failure was in this page or in the desktop shell/Postgres
 * bootstrap that runs before any page exists.
 *
 * The ring buffer this exports is written from two places, both routed
 * through error-report.ts: a render error caught by error.tsx/
 * global-error.tsx, and — the audit's Section 12 follow-up — a server-side
 * (5xx) or transport failure from any of the app's shared fetch wrappers
 * (dashboard/ui.tsx's and setup/ui.tsx's `api()`, platform-client.ts's
 * `platformFetch()`), logged silently with no on-screen change. An ordinary
 * validation rejection (a 400 the user can act on, like a missing field) is
 * deliberately never logged here — only failures nobody could self-resolve.
 */
import { useEffect, useState } from "react";
import { DownloadIcon, FolderOpenIcon } from "lucide-react";
import { exportClientErrorLog } from "@/lib/error-report";
import { buildRouteTimingReport } from "@/lib/route-instrumentation";
import { EmptyState, SectionCard } from "@/app/dashboard/page-chrome";
import { Button } from "@/components/ui/button";
import { InfoBox } from "@/app/dashboard/ui";

function downloadTextFile(content: string, filename: string) {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function LogsPanel() {
  const [hasEntries, setHasEntries] = useState(false);
  const [hasTimingEntries, setHasTimingEntries] = useState(false);
  const [isDesktop, setIsDesktop] = useState(false);
  const [desktopNotice, setDesktopNotice] = useState("");

  useEffect(() => {
    setHasEntries(Boolean(exportClientErrorLog()));
    setHasTimingEntries(Boolean(buildRouteTimingReport()));
    setIsDesktop(Boolean(window.businessSuiteDesktop?.isDesktop));
  }, []);

  function downloadBrowserLog() {
    downloadTextFile(exportClientErrorLog(), `pos-browser-error-log-${Date.now()}.txt`);
  }

  function downloadTimingReport() {
    downloadTextFile(buildRouteTimingReport(), `pos-route-timing-log-${Date.now()}.txt`);
  }

  async function openDesktopLogs() {
    setDesktopNotice("");
    try {
      const path = await window.businessSuiteDesktop?.localGateway.openLogs();
      setDesktopNotice(path ? `پوشهٔ گزارش‌ها باز شد: ${path}` : "پوشهٔ گزارش‌ها باز شد.");
    } catch {
      setDesktopNotice("بازکردن پوشهٔ گزارش‌ها ممکن نشد.");
    }
  }

  return (
    <div className="space-y-5">
      <SectionCard
        title="گزارش خطاهای این مرورگر"
        description="خطاهایی که هنگام نمایش صفحات در همین مرورگر ثبت شده‌اند — شناسهٔ خطا و جزئیات فنی، بدون اطلاعات حساس."
      >
        <div className="p-4 sm:p-5">
          {hasEntries ? (
            <Button type="button" variant="outline" onClick={downloadBrowserLog}>
              <DownloadIcon aria-hidden="true" />
              دریافت فایل گزارش خطاها
            </Button>
          ) : (
            <EmptyState>هیچ خطایی در این مرورگر ثبت نشده است.</EmptyState>
          )}
        </div>
      </SectionCard>

      <SectionCard
        title="گزارش کارایی مسیرها"
        description="میانگین و بیشینهٔ زمان پاسخ و شمار شکست‌ها، به تفکیک خانوادهٔ مسیر (بدون شناسهٔ تراکنش، بدون پرس‌وجو، بدون متن خطا) — برای تشخیص کندی یک بخش خاص."
      >
        <div className="p-4 sm:p-5">
          {hasTimingEntries ? (
            <Button type="button" variant="outline" onClick={downloadTimingReport}>
              <DownloadIcon aria-hidden="true" />
              دریافت فایل گزارش کارایی
            </Button>
          ) : (
            <EmptyState>هنوز داده‌ای برای این مرورگر ثبت نشده است.</EmptyState>
          )}
        </div>
      </SectionCard>

      {isDesktop ? (
        <SectionCard
          title="گزارش‌های برنامهٔ دسکتاپ"
          description="گزارش کامل سرور محلی، دیتابیس و درگاه شبکه — برای اشتراک‌گذاری با پشتیبانی."
        >
          <div className="space-y-3 p-4 sm:p-5">
            {desktopNotice ? <InfoBox>{desktopNotice}</InfoBox> : null}
            <Button type="button" variant="outline" onClick={() => void openDesktopLogs()}>
              <FolderOpenIcon aria-hidden="true" />
              بازکردن پوشهٔ گزارش‌ها
            </Button>
          </div>
        </SectionCard>
      ) : null}
    </div>
  );
}
