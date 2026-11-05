"use client";

/**
 * Issue #1076 — walk the WordPress plugin's own queue, a page at a time.
 *
 * The strip above it shows the aggregate plus the ten newest problem rows the
 * plugin volunteers in every handshake. That is enough to know something is
 * stuck, not enough to find the one row that matters in a two-hundred-row
 * backlog. This control records one page request; the plugin answers it on a
 * later handshake (the same 5-minute lane it already runs), so the copy says
 * «ثبت شد» and never pretends the rows are already on the way.
 */

import { useCallback, useEffect, useState } from "react";
import { ChevronLeftIcon, RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LoadingSkeleton } from "@/app/dashboard/page-chrome";
import { formatJalali } from "@/lib/jalali";
import { toPersianDigits } from "@/lib/digits";

interface PageRow {
  topic: string;
  remoteId: string;
  status: "pending" | "failed";
  attempts: number;
  lastError: string | null;
  createdAt: string | null;
}

interface PageRequest {
  after: number;
  limit: number;
  requestedAt: string;
}

interface PageAnswer {
  after: number;
  limit: number;
  rows: PageRow[];
  next: number | null;
  answeredAt: string;
}

interface State {
  supported?: boolean;
  reason?: string;
  request: PageRequest | null;
  answer: PageAnswer | null;
}

const PAGE_SIZE = 10;

function RowList({ rows }: { rows: PageRow[] }) {
  return (
    <ul className="mt-1.5 space-y-1">
      {rows.map((item, index) => (
        <li
          key={`${item.topic}-${item.remoteId}-${index}`}
          className="flex flex-wrap items-baseline gap-x-2 rounded-lg bg-muted/50 px-2.5 py-1.5"
        >
          <span className="font-medium text-foreground" dir="ltr">{item.topic}</span>
          {item.remoteId ? <span className="font-mono" dir="ltr">{item.remoteId}</span> : null}
          <span
            className={
              item.status === "failed"
                ? "font-semibold text-red-600 dark:text-red-400"
                : "text-amber-700 dark:text-amber-300"
            }
          >
            {item.status === "failed" ? "ناموفق" : "در انتظار ارسال"}
          </span>
          <span>تلاش: {toPersianDigits(item.attempts)}</span>
          {item.createdAt ? <span>از {formatJalali(item.createdAt, { withTime: true })}</span> : null}
          {item.lastError ? (
            <span className="w-full break-words text-red-600 dark:text-red-400">{item.lastError}</span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export function PluginLocalQueuePage({ connectionId, canSync }: { connectionId: string; canSync: boolean }) {
  const [state, setState] = useState<State | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch(
        `/api/integrations/wp-manager/queue/local?connectionId=${encodeURIComponent(connectionId)}`,
        { cache: "no-store" },
      );
      const body = (await response.json().catch(() => null)) as State | null;
      if (!response.ok || !body) {
        setError("خواندن وضعیت صف افزونه ناموفق بود.");
        return;
      }
      setState(body);
      setError(null);
    } catch {
      setError("خواندن وضعیت صف افزونه ناموفق بود.");
    }
  }, [connectionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const requestPage = useCallback(
    async (after: number) => {
      setBusy(true);
      setError(null);
      try {
        const response = await fetch(`/api/integrations/wp-manager/queue/local`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ connectionId, after, limit: PAGE_SIZE }),
        });
        const body = (await response.json().catch(() => null)) as { request?: PageRequest; error?: string } | null;
        if (!response.ok || !body?.request) {
          setError(
            body?.error === "connection_paused"
              ? "همگام‌سازی این اتصال متوقف است؛ برای درخواست صفحه، ابتدا آن را فعال کنید."
              : "ثبت درخواست صفحهٔ صف افزونه ناموفق بود.",
          );
          return;
        }
        setState((previous) => ({
          supported: true,
          request: body.request ?? null,
          answer: previous?.answer ?? null,
        }));
      } catch {
        setError("ثبت درخواست صفحهٔ صف افزونه ناموفق بود.");
      } finally {
        setBusy(false);
      }
    },
    [connectionId],
  );

  // The first read reserves the control's own shape, so the card never jumps
  // when the answer arrives.
  if (!state && !error) {
    return <LoadingSkeleton rows={1} compact label="در حال خواندن وضعیت صف افزونه" className="mt-2" />;
  }

  // An older plugin (or a REST connection) has no paging protocol: the parent
  // only mounts this control for a plugin that advertised it, but a route
  // answer of `supported: false` still has to be shown honestly.
  if (state && state.supported === false) {
    return (
      <p className="mt-1.5" role="note">
        پیمایش صفحه‌به‌صفحهٔ صف افزونه به نسخهٔ جدید افزونه نیاز دارد؛ افزونهٔ وردپرس را به‌روز کنید.
      </p>
    );
  }

  const answer = state?.answer ?? null;
  const pending = state?.request ?? null;
  const nextAfter = answer?.next ?? null;

  return (
    <div className="mt-2 space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={!canSync || busy}
          onClick={() => void requestPage(nextAfter ?? 0)}
          title={nextAfter ? "صفحهٔ بعدی صف داخلی افزونه" : "شروع پیمایش صف داخلی افزونه"}
        >
          <ChevronLeftIcon className="size-4" />
          {busy ? "در حال ثبت درخواست…" : nextAfter ? "صفحهٔ بعدی صف افزونه" : "پیمایش صف افزونه"}
        </Button>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void load()}>
          <RefreshCwIcon className="size-4" />
          {busy ? "در حال به‌روزرسانی…" : "دریافت پاسخ افزونه"}
        </Button>
      </div>

      {!canSync ? (
        <p className="text-xs text-muted-foreground" role="note">
          برای درخواست صفحه از صف افزونه دسترسی «همگام‌سازی ووکامرس» لازم است.
        </p>
      ) : null}

      {pending ? (
        <p className="text-xs text-amber-700 dark:text-amber-300" role="status">
          درخواست صفحهٔ «پس از {toPersianDigits(pending.after)}» ثبت شد. افزونه آن را در اجرای بعدی خود
          (حداکثر چند دقیقه) پاسخ می‌دهد؛ سپس «دریافت پاسخ افزونه» را بزنید.
        </p>
      ) : null}

      {answer ? (
        <div className="rounded-lg border border-border p-2.5 text-xs">
          <p className="font-medium text-foreground">
            صفحهٔ پس از {toPersianDigits(answer.after)} — {toPersianDigits(answer.rows.length)} رویداد
            {" • "}
            پاسخ افزونه در {formatJalali(answer.answeredAt, { withTime: true })}
          </p>
          {answer.rows.length > 0 ? (
            <RowList rows={answer.rows} />
          ) : (
            <p className="mt-1 text-muted-foreground">در این بازه رویداد گیرکرده‌ای نبود.</p>
          )}
          {answer.next !== null ? (
            <p className="mt-1 text-muted-foreground">
              صفحهٔ بعدی از رویداد {toPersianDigits(answer.next)} ادامه می‌یابد.
            </p>
          ) : (
            <p className="mt-1 text-muted-foreground">این آخرین صفحهٔ صف افزونه است.</p>
          )}
        </div>
      ) : null}

      {error ? (
        <p className="text-xs text-red-600 dark:text-red-400" role="alert">{error}</p>
      ) : null}
    </div>
  );
}
