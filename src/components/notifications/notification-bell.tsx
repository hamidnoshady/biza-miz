"use client";
import { Bell } from "lucide-react";
import Link from "next/link";
import { Popover } from "radix-ui";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { CLOUD_EMBED_ATTRIBUTE } from "@/lib/cloud-embed";
import { toPersianDigits } from "@/lib/digits";
import type { InboxEntry } from "@/lib/notifications-service";

/** Keep push privacy binding in each authenticated origin, even when its inbox is hidden. */
export function NotificationPushBinding({ identity }: { identity: string }) {
  useEffect(() => {
    let active = true;
    if ("serviceWorker" in navigator)
      void navigator.serviceWorker
        .getRegistration()
        .then((reg) => {
          if (active) reg?.active?.postMessage({ type: "notification-binding", identity });
        })
        .catch(() => {});
    return () => { active = false; };
  }, [identity]);
  return null;
}

export function NotificationBell({ identity, local }: { identity: string; local?: boolean }) {
  const [ownsInbox, setOwnsInbox] = useState(false);
  useEffect(() => {
    // The root marker survives service-worker navigations whose request lost
    // the embed user agent. An embedded guest never polls or opens a second inbox.
    setOwnsInbox(!document.documentElement.hasAttribute(CLOUD_EMBED_ATTRIBUTE));
  }, []);
  return ownsInbox ? <NotificationInbox key={identity} local={local} /> : null;
}

const loadError = "دریافت اعلان‌ها ناموفق بود؛ دوباره تلاش کنید.";
const offlineError = "اتصال اینترنت برقرار نیست. شمار اعلان‌ها ممکن است به‌روز نباشد.";

function NotificationInbox({ local }: { local?: boolean }) {
  const pathname = usePathname();
  const [entries, setEntries] = useState<InboxEntry[]>([]);
  const [unread, setUnread] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("all");
  const [error, setError] = useState("");
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const [retention, setRetention] = useState(90);
  const inFlight = useRef<AbortController | null>(null);
  const write = useRef<AbortController | null>(null);
  const refreshAgain = useRef(false);
  const refresh = useCallback(async (): Promise<void> => {
    if (document.hidden) return;
    if (inFlight.current) {
      refreshAgain.current = true;
      return;
    }
    const request = new AbortController();
    inFlight.current = request;
    try {
      const res = await fetch("/api/notifications/inbox?limit=200", {
        cache: "no-store",
        signal: request.signal,
      });
      if (request.signal.aborted) return;
      if (res.status === 401 || res.status === 403) {
        setEntries([]);
        setUnread(null);
        setStale(false);
        setError(res.status === 401 ? "برای دیدن اعلان‌ها دوباره وارد شوید." : "دسترسی به اعلان‌ها برقرار نیست.");
        return;
      }
      if (!res.ok) throw new Error();
      const body = (await res.json()) as {
        entries: InboxEntry[];
        unread: number;
        retentionDays: number;
      };
      if (request.signal.aborted) return;
      if (!Array.isArray(body.entries) || !Number.isSafeInteger(body.unread) || body.unread < 0) {
        throw new Error();
      }
      setEntries(body.entries);
      setUnread(body.unread);
      setRetention(body.retentionDays);
      setStale(false);
      setError("");
    } catch {
      if (request.signal.aborted) return;
      setStale(true);
      setError(navigator.onLine ? loadError : offlineError);
    } finally {
      if (inFlight.current === request) {
        inFlight.current = null;
        if (refreshAgain.current) {
          refreshAgain.current = false;
          void refresh();
        }
      }
    }
  }, []);
  useEffect(() => {
    const openFromLink = new URLSearchParams(window.location.search).get("inbox") === "1";
    setOpen(openFromLink);
  }, [pathname]);
  useEffect(() => {
    const onRefresh = () => void refresh();
    void refresh();
    const timer = setInterval(onRefresh, 30_000);
    window.addEventListener("focus", onRefresh);
    window.addEventListener("online", onRefresh);
    window.addEventListener("offline", onRefresh);
    document.addEventListener("visibilitychange", onRefresh);
    return () => {
      clearInterval(timer);
      inFlight.current?.abort();
      inFlight.current = null;
      write.current?.abort();
      refreshAgain.current = false;
      window.removeEventListener("focus", onRefresh);
      window.removeEventListener("online", onRefresh);
      window.removeEventListener("offline", onRefresh);
      document.removeEventListener("visibilitychange", onRefresh);
    };
  }, [refresh]);
  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);
  async function mark(id?: string) {
    if (write.current) return;
    const request = new AbortController();
    write.current = request;
    setBusy(true);
    try {
      const res = await fetch("/api/notifications/inbox", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(id ? { id } : {}),
        signal: request.signal,
      });
      if (request.signal.aborted) return;
      if (!res.ok) throw new Error();
      await refresh();
    } catch {
      if (!request.signal.aborted) setError("ثبت خواندن ناموفق بود؛ دوباره تلاش کنید.");
    } finally {
      if (write.current === request) {
        write.current = null;
        if (!request.signal.aborted) setBusy(false);
      }
    }
  }
  const scope = local ? "اعلان‌های این دستگاه" : "اعلان‌ها";
  const label = unread === null
    ? `${scope}، شمار خوانده‌نشده نامشخص است`
    : `${scope}، ${unread} خوانده‌نشده${stale ? "، ممکن است به‌روز نباشد" : ""}`;
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <Button variant="outline" size="icon-sm" aria-label={label} title={label} className="relative shrink-0">
          <Bell aria-hidden="true" className="size-4" />
          {unread !== null ? (
            <span aria-hidden="true" className="absolute -top-1 -end-1 rounded-full bg-background px-0.5 text-[10px] leading-none">
              {toPersianDigits(unread)}{stale ? "؟" : ""}
            </span>
          ) : null}
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          dir="rtl"
          aria-label="صندوق اعلان"
          side="bottom"
          align="center"
          sideOffset={8}
          collisionPadding={12}
          className="z-50 flex max-h-[min(70dvh,var(--radix-popover-content-available-height))] w-[min(92vw,26rem)] flex-col rounded-xl border bg-background p-3 text-foreground"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-semibold">{local ? "صندوق اعلان این دستگاه" : "صندوق اعلان"}</h2>
            <Popover.Close asChild><Button variant="ghost">بستن</Button></Popover.Close>
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
          {!entries.length && !error && unread !== null && (
            <p role="status" className="py-5 text-center text-sm">
              هنوز اعلانی ندارید.
            </p>
          )}
          <Link className="mt-2 text-sm underline" href="/settings/notifications">
            تنظیمات و کاهش تعداد اعلان‌ها
          </Link>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
