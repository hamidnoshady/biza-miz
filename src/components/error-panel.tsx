"use client";

/**
 * The one error surface, shared by every realm's `error.tsx`.
 *
 * Section 12 of the desktop audit: every error gets a friendly message (the
 * Persian copy below), a short **error ID** the user can quote to support
 * (`generateErrorId` — distinct from Next's own `digest`, which is a
 * server-log correlation id that is not always present for a purely
 * client-side error), an on-demand **technical log** (message/stack, secrets
 * redacted — see `error-report.ts`'s `redactSecrets`, the same rule the
 * desktop's own log writer uses), and an **export logs** button that downloads
 * every recently recorded client error, not just this one, as a single file.
 *
 * It lives here rather than in `src/app/error.tsx` because the product now has
 * three boundaries — the root fallback, the tenant realm (`(app)`) and the
 * Superadmin console (`platform`) — and three copies of this markup would be
 * the same "hand-rolled chrome" the design system exists to prevent. Each
 * boundary passes only its own words and its own way back; the behaviour and
 * the markup are written once, so a fix (a new report field, a focus fix)
 * reaches all three.
 *
 * `minHeightClass` exists for the realm boundaries: the root fallback owns the
 * whole viewport, while the tenant boundary renders *inside* `WorkspaceShell`
 * and must not force a second full-height scroll area under a live sidebar.
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { CircleAlertIcon, DownloadIcon } from "lucide-react";
import { cardClass } from "@/app/dashboard/page-chrome";
import { buildTechnicalReport, exportClientErrorLog, generateErrorId, recordClientError } from "@/lib/error-report";

export interface ErrorPanelProps {
  error: Error & { digest?: string };
  reset: () => void;
  /** The realm's own headline — «خطایی پیش آمد», «خطایی در کنسول …». */
  title: string;
  /** One or two sentences in the realm's words, ending in what to do next. */
  description: string;
  /** Where the realm's home is. */
  homeHref: string;
  /** What that link says, so the destination is never guessed. */
  homeLabel: string;
  /** Downloaded log filename prefix, per realm. */
  logPrefix: string;
  /** `min-h-screen` for the root fallback; a shorter box inside a live shell. */
  minHeightClass?: string;
  /**
   * `main` for the root fallback (it replaces the page, so it needs the
   * landmark); `div` inside a shell, because `WorkspaceShell` already renders
   * the page's `<main>` and a nested `<main>` is invalid.
   */
  as?: "main" | "div";
}

export function ErrorPanel({
  error,
  reset,
  title,
  description,
  homeHref,
  homeLabel,
  logPrefix,
  minHeightClass = "min-h-screen",
  as: Root = "div",
}: ErrorPanelProps) {
  const [showDetails, setShowDetails] = useState(false);
  const errorId = useMemo(() => generateErrorId(error.message || "unknown", Date.now()), [error]);
  const report = useMemo(
    () =>
      buildTechnicalReport({
        errorId,
        message: error.message,
        stack: error.stack,
        digest: error.digest,
        url: typeof window !== "undefined" ? window.location.href : undefined,
        userAgent: typeof navigator !== "undefined" ? navigator.userAgent : undefined,
        appVersion: process.env.NEXT_PUBLIC_APP_VERSION,
      }),
    [error, errorId],
  );

  useEffect(() => {
    console.error(error);
    recordClientError({ errorId, occurredAt: new Date().toISOString(), report });
    // Only once per mounted error instance — recordClientError already de-dupes
    // nothing itself, so re-running this on every render would spam the log.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [error]);

  function downloadLogs() {
    const full = exportClientErrorLog() || report;
    const blob = new Blob([full], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${logPrefix}-${errorId}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <Root className={`flex ${minHeightClass} items-center justify-center p-4`}>
      <div className={`w-full max-w-sm ${cardClass} p-8 text-center`}>
        <CircleAlertIcon aria-hidden="true" className="mx-auto mb-4 size-10 text-destructive" />
        {/* The live region is the message only: the buttons below it stay
            outside it, so a screen reader announces the failure once and does
            not re-read the actions as part of it. */}
        <div role="alert">
          <h1 className="mb-1 text-xl font-bold">{title}</h1>
          <p className="mb-6 text-sm text-muted-foreground">{description}</p>
        </div>
        <p className="mb-2 text-xs text-muted-foreground">
          شناسهٔ خطا (برای پشتیبانی): <span dir="ltr" className="font-mono">{errorId}</span>
        </p>
        {error.digest && (
          <p className="mb-4 text-xs text-muted-foreground">
            کد پیگیری سرور: <span dir="ltr">{error.digest}</span>
          </p>
        )}
        <button
          type="button"
          onClick={() => setShowDetails((v) => !v)}
          aria-expanded={showDetails}
          className="mb-4 text-xs font-medium text-primary underline-offset-2 hover:underline"
        >
          {showDetails ? "پنهان‌کردن جزئیات فنی" : "نمایش جزئیات فنی"}
        </button>
        {showDetails ? (
          <pre
            dir="ltr"
            className="mb-4 max-h-40 overflow-auto rounded-lg border border-border bg-muted/40 p-3 text-start text-[11px] leading-5 text-muted-foreground"
          >
            {report}
          </pre>
        ) : null}
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={reset}
            className="w-full rounded-lg bg-primary py-2.5 font-semibold text-primary-foreground transition hover:bg-primary/85 outline-none focus-visible:ring focus-visible:ring-ring/50"
          >
            تلاش دوباره
          </button>
          <button
            type="button"
            onClick={downloadLogs}
            className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-input py-2.5 text-sm font-semibold transition hover:bg-primary/10 outline-none focus-visible:ring focus-visible:ring-ring/50"
          >
            <DownloadIcon aria-hidden="true" className="size-4" />
            دریافت فایل گزارش‌ها
          </button>
          <Link
            href={homeHref}
            className="w-full rounded-lg border border-input py-2.5 text-center text-sm font-semibold transition hover:bg-primary/10 outline-none focus-visible:ring focus-visible:ring-ring/50"
          >
            {homeLabel}
          </Link>
        </div>
      </div>
    </Root>
  );
}
