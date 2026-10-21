"use client";
import { Bell } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { toPersianDigits } from "@/lib/digits";
import type { InboxEntry } from "@/lib/notifications-service";

/** First-party inbox works without Push permission. Poll only while visible,
 * refresh on focus, never overlap requests or keep data across identity changes. */
export function NotificationBell({ identity }: { identity: string }) {
  const [entries, setEntries] = useState<InboxEntry[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("all");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [retention, setRetention] = useState(90);
  const inFlight = useRef(false);
  const refreshAgain = useRef(false);
  const panel = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const refresh = useCallback(async (): Promise<void> => {
    if (document.hidden) return;
    if (inFlight.current) {
      refreshAgain.current = true;
      return;
    }
    inFlight.current = true;
    try {
      const res = await fetch("/api/notifications/inbox?limit=200", { cache: "no-store" });
      if (!res.ok) throw new Error();
      const body = (await res.json()) as {
        entries: InboxEntry[];
        unread: number;
        retentionDays: number;
      };
      setEntries(body.entries);
      setUnread(body.unread);
      setRetention(body.retentionDays);
      setError("");
    } catch {
      setError("دریافت اعلان‌ها ناموفق بود؛ دوباره تلاش کنید.");
    } finally {
      inFlight.current = false;
      if (refreshAgain.current) {
        refreshAgain.current = false;
        void refresh();
      }
    }
  }, []);
  useEffect(() => {
    setEntries([]);
    setUnread(0);
    if ("serviceWorker" in navigator)
      void navigator.serviceWorker
        .getRegistration()
        .then((reg) => reg?.active?.postMessage({ type: "notification-binding", identity }))
        .catch(() => {});
    void refresh();
    const timer = setInterval(() => void refresh(), 30_000);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    setOpen(new URLSearchParams(window.location.search).get("inbox") === "1");
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [identity, refresh]);
  useEffect(() => {
    if (open) {
      void refresh();
      panel.current?.focus();
    }
  }, [open, refresh]);
  async function mark(id?: string) {
    setBusy(true);
    try {
      const res = await fetch("/api/notifications/inbox", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(id ? { id } : {}),
      });
      if (!res.ok) throw new Error();
      await refresh();
    } catch {
      setError("ثبت خواندن ناموفق بود؛ دوباره تلاش کنید.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="fixed bottom-20 left-3 z-40 sm:bottom-4" dir="rtl">
      <Button
        ref={button}
        variant="outline"
        aria-expanded={open}
        aria-controls="notification-inbox"
        aria-label={`اعلان‌ها، ${unread} خوانده‌نشده`}
        onClick={() => setOpen(!open)}
      >
        <Bell aria-hidden="true" className="size-4" /> {toPersianDigits(unread)}
      </Button>
      {open && (
        <div
          id="notification-inbox"
          ref={panel}
          tabIndex={-1}
          role="region"
          aria-label="صندوق اعلان"
          className="absolute bottom-12 left-0 flex max-h-[70dvh] w-[min(92vw,26rem)] flex-col rounded-xl border bg-background p-3 text-foreground "
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setOpen(false);
              button.current?.focus();
            }
          }}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-semibold">صندوق اعلان</h2>
            <Button
              variant="ghost"
              onClick={() => {
                setOpen(false);
                button.current?.focus();
              }}
            >
              بستن
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            تاریخچه تا {toPersianDigits(retention)} روز نگهداری می‌شود. ساعت سکوت فقط ارسال Push را
            به تأخیر می‌اندازد.
          </p>
          <div className="my-2 flex flex-wrap gap-2">
            <select
              aria-label="فیلتر اعلان‌ها"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="rounded border bg-background p-1"
            >
              <option value="all">همه</option>
              <option value="unread">خوانده‌نشده</option>
              <option value="critical">بحرانی</option>
            </select>
            <Button variant="outline" disabled={busy || !unread} onClick={() => void mark()}>
              خواندن همه
            </Button>
            <Button variant="ghost" onClick={() => void refresh()}>
              تازه‌سازی
            </Button>
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <ul className="min-h-0 overflow-y-auto divide-y">
            {entries
              .filter((e) =>
                filter === "unread"
                  ? !e.readAt
                  : filter === "critical"
                    ? e.severity === "critical"
                    : true,
              )
              .map((e) => (
                <li key={e.id} className="space-y-1 py-3">
                  <Link
                    href={e.url}
                    className="font-medium underline"
                    onClick={() => {
                      void mark(e.id);
                      setOpen(false);
                    }}
                  >
                    {!e.readAt ? "● " : ""}
                    {e.title}
                  </Link>
                  <p className="text-sm">{e.body}</p>
                  <time className="text-xs text-muted-foreground" dateTime={e.createdAt}>
                    {new Date(e.createdAt).toLocaleString("fa-IR")}
                  </time>
                  {!e.readAt && (
                    <Button variant="ghost" disabled={busy} onClick={() => void mark(e.id)}>
                      خواندم
                    </Button>
                  )}
                </li>
              ))}
          </ul>
          {!entries.length && !error && (
            <p role="status" className="py-5 text-center text-sm">
              هنوز اعلانی ندارید.
            </p>
          )}
          <Link className="mt-2 text-sm underline" href="/settings/notifications">
            تنظیمات و کاهش تعداد اعلان‌ها
          </Link>
        </div>
      )}
    </div>
  );
}
