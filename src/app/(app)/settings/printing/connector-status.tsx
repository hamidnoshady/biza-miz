"use client";

/**
 * The connector gate — the one thing standing between the operator and
 * hardware printing. The Bizamiz Windows Print Connector (a small
 * dependency-free helper on the cashier's own computer) owns every printer
 * this machine can reach: Windows queues AND network printers. When it is
 * missing or outdated, the flow says so in one plain card with a one-click
 * install — no mention of agents, ports or protocols.
 *
 * After the .cmd is downloaded the card stops being passive: it shows the
 * exact next steps and a bounded watch polls the connector itself, so the
 * page detects a finished install without the operator hammering
 * «بررسی دوباره».
 */
import { DownloadIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SectionCard } from "@/app/dashboard/page-chrome";
import { printerErrorMessage, type PrinterErrorCode } from "@/lib/printing/errors";
import { useConnectorInstallWatch } from "./use-connector-install-watch";

export type ConnectorState = "checking" | "down" | "ready";

function statusLabel(error: PrinterErrorCode | null, installing: boolean): string {
  if (installing) return "در حال نصب…";
  if (error === "connector_outdated") return "نیازمند به‌روزرسانی";
  if (error === "connector_unreachable") return "مشکل اتصال";
  return "نصب نشده";
}

/**
 * «اتصال این کامپیوتر» — the install card shown when hardware printing
 * needs the connector and it is not there (or is an older version).
 */
export function ConnectorInstallCard({ error, onRecheck, rechecking }: {
  error: PrinterErrorCode | null;
  onRecheck: () => void;
  rechecking: boolean;
}) {
  const outdated = error === "connector_outdated";
  // A successful install flips the page via the parent's own recheck.
  const installWatch = useConnectorInstallWatch(() => onRecheck());
  const installing = installWatch.installing;
  const status = statusLabel(error, installing);

  return (
    <SectionCard title="سرویس چاپ بیزامیز" description="برای دسترسی امن مرورگر به چاپگرهای این کامپیوتر، سرویس چاپ بیزامیز را یک‌بار نصب کنید.">
      <div className="space-y-3">
        <p className="flex items-center gap-2 text-sm font-medium text-foreground">
          <span
            aria-hidden="true"
            className={
              installing
                ? "inline-block size-2 animate-pulse rounded-full bg-sky-500 dark:bg-sky-400"
                : "inline-block size-2 rounded-full bg-amber-500 dark:bg-amber-400"
            }
          />
          {status}
        </p>
        <p className="text-sm leading-6 text-muted-foreground">
          {printerErrorMessage(error ?? "connector_not_installed")}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild>
            <a href="/api/printing/connector/installer" download onClick={installWatch.begin}>
              <DownloadIcon aria-hidden="true" />
              {outdated ? "به‌روزرسانی سرویس چاپ" : "راه‌اندازی سرویس چاپ"}
            </a>
          </Button>
          <Button type="button" variant="outline" onClick={onRecheck} disabled={rechecking}>
            {rechecking ? "در حال بررسی…" : "بررسی دوباره"}
          </Button>
        </div>
        {installing ? (
          <ol className="list-decimal space-y-1 rounded-xl border border-sky-200 bg-sky-50/60 px-4 py-3 ps-8 text-xs leading-5 text-sky-950 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-200">
            <li>فایل دانلودشده (Install-Bizamiz-Print-Connector.cmd) را باز کنید.</li>
            <li>اگر Windows تأیید خواست، اجازهٔ اجرا را بدهید.</li>
            <li>منتظر پیام موفقیت نصب بمانید؛ نصب خودکار است و به Node.js یا دستور خاصی نیاز ندارد.</li>
            <li>به همین صفحه برگردید — اتصال به‌صورت خودکار تشخیص داده می‌شود.</li>
          </ol>
        ) : (
          <p className="text-xs leading-5 text-muted-foreground">
            فایل دانلودشده را باز کنید و تأیید Windows را بزنید؛ نصب خودکار است، به Node.js یا دستور خاصی نیاز ندارد و از ورودهای بعدی
            Windows هم خودکار اجرا می‌شود. اجرای دوبارهٔ همان فایل، رابط چاپ را به‌روز یا تعمیر می‌کند. پس از نصب، این صفحه اتصال را خودکار پیدا می‌کند.
          </p>
        )}
      </div>
    </SectionCard>
  );
}
