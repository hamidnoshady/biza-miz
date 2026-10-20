"use client";

/**
 * The store's mirrored customer book: who the customers are on the store
 * side, joined to the local CRM record. Reads /api/integrations/wp-manager/
 * customers; the sync itself is the catalogue button (plugin: queued
 * customer_export job; REST: direct pull).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ContactIcon, RefreshCwIcon, ExternalLinkIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api, inputClass } from "@/app/dashboard/ui";

import {
  cardClass,
  EmptyState,
  LoadingSkeleton,
  SectionCardSkeleton,
  StatusBadge,
} from "@/app/dashboard/page-chrome";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { ConnectionPicker } from "./connection-lite";
import { crmCustomerHref } from "@/app/(app)/crm/crm-routes";
import { PluginWaitNote } from "./plugin-wait-note";
import { useWpStore } from "./wp-store-context";

interface StoreCustomerSyncStatus {
  runId: string;
  transport: "rest_api" | "plugin";
  status: "running" | "partial" | "completed" | "failed";
  expected: number | null;
  processed: number;
  pending: number | null;
  failed: number;
  currentPage: number;
  totalPages: number | null;
  hasError: boolean;
  updatedAt: string;
}

interface StoreCustomer {
  remoteId: string;
  localId: string | null;
  externalProfileId: string | null;
  identityStatus: string;
  name: string;
  phone: string | null;
  email: string | null;
  ordersCount: number | null;
  lastSeen: string | null;
}

const IDENTITY_LABELS: Record<string, string> = {
  legacy: "پیوند قدیمی",
  auto_matched: "پیوند خودکار",
  confirmed: "پیوند تأییدشده",
  unmapped: "بدون پیوند",
  needs_review: "نیازمند بررسی",
  conflict: "تعارض اطلاعات",
  ignored: "نادیده‌گرفته‌شده",
};

function identityTone(status: string): "active" | "positive" | "neutral" | "danger" {
  if (status === "confirmed" || status === "legacy") return "positive";
  if (status === "auto_matched") return "active";
  if (status === "unmapped" || status === "needs_review" || status === "conflict") return "danger";
  return "neutral";
}

/** A transient line under the toolbar: teal for confirmations, red for failures. */
interface Notice {
  kind: "ok" | "error";
  text: string;
}

export function WpCustomersSection() {
  const { connections, selectedId, setSelectedId } = useWpStore();
  const [customers, setCustomers] = useState<StoreCustomer[] | null>(null);
  const [total, setTotal] = useState(0);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [totalPages, setTotalPages] = useState(1);
  const [canViewCustomerFile, setCanViewCustomerFile] = useState(false);
  const [canResolveIdentities, setCanResolveIdentities] = useState(false);
  const [syncStatus, setSyncStatus] = useState<StoreCustomerSyncStatus | null>(null);
  const [pluginSyncQueued, setPluginSyncQueued] = useState(false);

  // Guards against the two async races this page can hit: late load()
  // responses landing after a newer request (or after unmount) and the
  // post-sync refresh firing after the owner switched to another store.
  const mountedRef = useRef(false);
  const loadSeqRef = useRef(0);
  const selectedRef = useRef("");
  const syncTimerRef = useRef<number | null>(null);
  const pluginRunAtQueueRef = useRef<string | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (syncTimerRef.current !== null) window.clearTimeout(syncTimerRef.current);
    };
  }, []);

  const load = useCallback(async (
    connectionId: string,
    nextPage = page,
    nextPageSize = pageSize,
    nextQuery = query,
    preserveRows = false,
  ) => {
    const seq = ++loadSeqRef.current;
    if (!preserveRows) {
      setCustomers(null);
      setLoadError(false);
    }
    const params = new URLSearchParams({
      connectionId,
      page: String(nextPage),
      pageSize: String(nextPageSize),
    });
    if (nextQuery.trim()) params.set("search", nextQuery.trim());
    const res = await api<{
      customers: StoreCustomer[];
      total?: number;
      page?: number;
      pageSize?: number;
      totalPages?: number;
      syncStatus?: StoreCustomerSyncStatus | null;
      permissions?: {
        canViewCustomerFile?: boolean;
        canResolveIdentities?: boolean;
        canViewOrderCounts?: boolean;
      };
    }>(`/api/integrations/wp-manager/customers?${params.toString()}`);
    // A newer selection (or unmount) supersedes this response.
    if (!mountedRef.current || seq !== loadSeqRef.current || selectedRef.current !== connectionId) return;
    if (res.ok) {
      setLoadError(false);
      setCustomers(res.data.customers);
      setTotal(typeof res.data.total === "number" ? res.data.total : res.data.customers.length);
      // The server resolves the page: it counts first and clamps a request
      // past the end onto the last page that has rows. Adopting its answer is
      // what stops the footer saying «صفحه ۱۳ از ۲» next to an empty list
      // after a search narrowed the result set under the current page.
      setPage(typeof res.data.page === "number" ? res.data.page : nextPage);
      setPageSize(typeof res.data.pageSize === "number" ? res.data.pageSize : nextPageSize);
      setTotalPages(typeof res.data.totalPages === "number" ? Math.max(1, res.data.totalPages) : 1);
      setCanViewCustomerFile(res.data.permissions?.canViewCustomerFile === true);
      setCanResolveIdentities(res.data.permissions?.canResolveIdentities === true);
      const nextSyncStatus = res.data.syncStatus ?? null;
      setSyncStatus(nextSyncStatus);
      if (!pluginSyncQueued && nextSyncStatus?.transport === "plugin" &&
        (nextSyncStatus.status === "running" || (nextSyncStatus.pending ?? 0) > 0)) {
        pluginRunAtQueueRef.current = null;
        setPluginSyncQueued(true);
      }
      const pluginRunFinished = nextSyncStatus &&
        nextSyncStatus.runId !== pluginRunAtQueueRef.current &&
        (nextSyncStatus.status === "completed" || nextSyncStatus.status === "failed" ||
          (nextSyncStatus.hasError && nextSyncStatus.pending === 0));
      if (pluginSyncQueued && nextSyncStatus && pluginRunFinished) {
        setPluginSyncQueued(false);
        if (nextSyncStatus.status === "completed") {
          setNotice({ kind: "ok", text: "همگام‌سازی افزونه با موفقیت کامل شد." });
        } else {
          setNotice({
            kind: "error",
            text: `همگام‌سازی افزونه کامل نشد؛ ${toPersianDigits(nextSyncStatus.failed)} مورد ناموفق بود. پس از رفع مشکل دوباره اجرا کنید.`,
          });
        }
      }
    } else {
      // Not an empty list — a failed read. Reported as such, with a retry,
      // rather than the «nothing synced yet» copy that would send the owner
      // re-syncing a store whose data simply failed to load.
      setCustomers([]);
      setLoadError(true);
      setCanViewCustomerFile(false);
      setCanResolveIdentities(false);
      setSyncStatus(null);
    }
  }, [page, pageSize, query, pluginSyncQueued]);

  useEffect(() => {
    selectedRef.current = selectedId;
    if (syncTimerRef.current !== null) {
      window.clearTimeout(syncTimerRef.current);
      syncTimerRef.current = null;
    }
    setNotice(null);
    setSyncStatus(null);
    setPluginSyncQueued(false);
    pluginRunAtQueueRef.current = null;
    setQuery("");
    setPage(1);
  }, [selectedId]);

  useEffect(() => {
    if (selectedId) void load(selectedId, page, pageSize, query);
  }, [selectedId, page, pageSize, query, load]);

  // Plugin exports are asynchronous and may take several minutes. Refresh the
  // durable run summary while rows/markers are still arriving, without clearing
  // the visible customer list. Poll for at most five minutes per button press.
  useEffect(() => {
    if (!selectedId || !pluginSyncQueued) return;
    let cancelled = false;
    let attempts = 0;
    let timer: number | null = null;

    const poll = () => {
      if (cancelled) return;
      if (attempts >= 60) {
        setPluginSyncQueued(false);
        setNotice({ kind: "ok", text: "افزونه هنوز پاسخ کامل نداده است؛ فهرست را بعداً تازه کنید یا دوباره همگام‌سازی را بزنید." });
        return;
      }
      timer = window.setTimeout(async () => {
        timer = null;
        if (syncTimerRef.current !== null) syncTimerRef.current = null;
        if (cancelled || !mountedRef.current || selectedRef.current !== selectedId) return;
        attempts += 1;
        await load(selectedId, page, pageSize, query, true);
        if (!cancelled) poll();
      }, 5000);
      syncTimerRef.current = timer;
    };

    poll();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
      if (syncTimerRef.current === timer) syncTimerRef.current = null;
    };
  }, [selectedId, pluginSyncQueued, page, pageSize, query, load]);

  async function syncCustomers() {
    const connectionId = selectedId;
    if (!connectionId || busy) return;
    setBusy(true);
    setNotice(null);
    let batches = 0;

    try {
      // Each API request is intentionally bounded to three REST pages. Continue
      // with the durable cursor while this store remains selected; if the tab
      // closes or a request fails, the next click resumes the same run.
      while (batches < 100) {
        const res = await api<{
          queued?: boolean;
          runId?: string;
          status?: "running" | "partial" | "completed" | "failed";
          currentPage?: number;
          totalPages?: number | null;
          created?: number;
          updated?: number;
          linked?: number;
          unresolved?: number;
          conflicted?: number;
          skipped?: number;
          failed?: number;
          total?: number;
          hasMore?: boolean;
          lastError?: string | null;
          error?: unknown;
        }>(`/api/integrations/connections/${connectionId}/sync/customers`, { method: "POST" });

        if (!mountedRef.current) return;
        if (selectedRef.current !== connectionId) {
          setBusy(false);
          return;
        }
        if (!res.ok) {
          setBusy(false);
          const raw = typeof res.data?.error === "string" ? res.data.error : "";
          setNotice({
            kind: "error",
            text: raw && raw !== "not_found"
              ? `همگام‌سازی مشتریان ناموفق بود: ${raw}`
              : "همگام‌سازی مشتریان با خطا مواجه شد؛ دوباره تلاش کنید.",
          });
          return;
        }
        if (res.data?.queued) {
          setBusy(false);
          pluginRunAtQueueRef.current = syncStatus?.runId ?? null;
          setPluginSyncQueued(true);
          setNotice({
            kind: "ok",
            text: "درخواست همگام‌سازی در صف قرار گرفت؛ پیشرفت و نتیجهٔ افزونه به‌صورت خودکار تازه می‌شود.",
          });
          return;
        }

        if (!res.data?.hasMore) {
          setBusy(false);
          if (res.data?.status === "completed") {
            setNotice({
              kind: "ok",
              text: `همگام‌سازی کامل شد: ${toPersianDigits(Number(res.data.total ?? 0))} مشتری، ` +
                `${toPersianDigits(Number(res.data.created ?? 0))} تازه، ` +
                `${toPersianDigits(Number(res.data.updated ?? 0))} به‌روزرسانی، ` +
                `${toPersianDigits(Number(res.data.linked ?? 0))} پیوند، ` +
                `${toPersianDigits(Number(res.data.unresolved ?? 0))} بی‌تصمیم، ` +
                `${toPersianDigits(Number(res.data.conflicted ?? 0))} تعارض.`,
            });
          } else {
            const failed = Number(res.data?.failed ?? 0);
            setNotice({
              kind: "error",
              text: failed > 0
                ? `همگام‌سازی بخشی انجام شد و ${toPersianDigits(failed)} مشتری ناموفق ماند؛ دوباره تلاش کنید تا از صفحهٔ ${toPersianDigits(Number(res.data?.currentPage ?? 1))} ادامه یابد.`
                : "همگام‌سازی کامل نشد؛ دوباره تلاش کنید تا از نقطهٔ ذخیره‌شده ادامه یابد.",
            });
          }
          void load(connectionId, page, pageSize, query);
          return;
        }

        batches += 1;
        setNotice({
          kind: "ok",
          text: `همگام‌سازی در حال ادامه است؛ ${toPersianDigits(Number(res.data.total ?? 0))} مشتری تا اینجا پردازش شده، صفحهٔ ${toPersianDigits(Number(res.data.currentPage ?? 1))} از ${toPersianDigits(Number(res.data.totalPages ?? 0))}.`,
        });
      }

      setBusy(false);
      setNotice({
        kind: "ok",
        text: "همگام‌سازی همچنان ادامه دارد؛ این اجرا متوقف شد تا درخواست‌ها محدود بمانند. با زدن دوباره از همان نقطه ادامه می‌یابد.",
      });
      void load(connectionId, page, pageSize, query);
    } catch {
      if (!mountedRef.current) return;
      setBusy(false);
      if (selectedRef.current === connectionId) {
        setNotice({ kind: "error", text: "ارتباط هنگام همگام‌سازی قطع شد؛ دوباره تلاش کنید تا ادامه یابد." });
      }
    }
  }

  // Search is resolved **server-side**, over the whole store population, and
  // the rows that come back are already the matches for this page. Re-filtering
  // them in the browser was a second, narrower filter on top of the first: it
  // hid rows the server had matched (a Persian-digit phone that the server
  // matched on `remote_id`, say) and made the count under the box describe the
  // page rather than the result. One filter, on the server.
  const needle = query.trim();
  const visible = customers ?? [];
  const syncProgressHasError = Boolean(
    syncStatus && (
      syncStatus.failed > 0 || syncStatus.status === "failed" ||
      (syncStatus.hasError && (syncStatus.pending ?? 0) === 0)
    ),
  );
  let syncProgressText: string | null = null;
  if (syncStatus && syncStatus.status !== "completed") {
    if (syncStatus.failed > 0) {
      syncProgressText = `همگام‌سازی ناقص است؛ ${toPersianDigits(syncStatus.failed)} مشتری ناموفق بود. دوباره اجرا کنید تا تلاش ناموفق تکرار شود.`;
    } else if (syncStatus.hasError && (syncStatus.pending ?? 0) > 0) {
      syncProgressText = `افزونه هنوز ${toPersianDigits(syncStatus.pending ?? 0)} مشتری را نفرستاده است؛ تا رسیدن همهٔ موارد صبر می‌کنیم.`;
    } else if (syncStatus.hasError || syncStatus.status === "failed") {
      syncProgressText = "همگام‌سازی در نقطهٔ ذخیره‌شده متوقف شد؛ برای ادامه دوباره اجرا کنید.";
    } else if (syncStatus.transport === "rest_api" && syncStatus.totalPages !== null) {
      syncProgressText = `همگام‌سازی در حال پیشرفت است؛ صفحهٔ ${toPersianDigits(syncStatus.currentPage)} از ${toPersianDigits(syncStatus.totalPages)}.`;
    } else if (syncStatus.expected !== null) {
      syncProgressText = `دریافت افزونه: ${toPersianDigits(syncStatus.processed)} از ${toPersianDigits(syncStatus.expected)} مشتری؛ ${toPersianDigits(syncStatus.pending ?? 0)} مورد در انتظار.`;
    } else {
      syncProgressText = `${toPersianDigits(syncStatus.processed)} مشتری دریافت شد؛ در انتظار نشان پایان همگام‌سازی افزونه.`;
    }
  }

  if (connections === null) return <SectionCardSkeleton rows={6} />;
  if (connections.length === 0) {
    return (
      <EmptyState>
        فروشگاهی متصل نیست. ابتدا از بخش{" "}
        <Link
          href="/settings/connections?tab=woocommerce"
          className="font-medium text-teal-700 underline underline-offset-4 hover:text-teal-900 dark:text-teal-300 dark:hover:text-teal-100"
        >
          اتصال‌های فنی
        </Link>{" "}
        یک فروشگاه ووکامرس متصل کنید.
      </EmptyState>
    );
  }

  return (
    <div className="space-y-4">
      <div className={`${cardClass} flex flex-wrap items-center gap-3 p-4`}>
        <ConnectionPicker
          embedded
          connections={connections}
          value={selectedId}
          onChange={(id) => {
            selectedRef.current = id;
            setSelectedId(id);
          }}
        />
        <Button
          variant="outline"
          size="sm"
          disabled={busy || pluginSyncQueued || !selectedId || customers === null}
          onClick={() => void syncCustomers()}
          className="ms-auto w-full sm:w-auto"
        >
          <RefreshCwIcon className="size-4" />
          {busy
            ? "در حال همگام‌سازی مشتریان…"
            : pluginSyncQueued
              ? "در انتظار پاسخ افزونه…"
              : "همگام‌سازی مشتریان"}
        </Button>
      </div>
      <PluginWaitNote connections={connections} selectedId={selectedId} />
      {syncProgressText ? (
        <p
          role={syncProgressHasError ? "alert" : "status"}
          className={syncProgressHasError ? "text-xs text-red-700 dark:text-red-300" : "text-xs text-teal-700 dark:text-teal-300"}
        >
          {syncProgressText}
        </p>
      ) : null}
      {notice ? (
        <p
          role={notice.kind === "error" ? "alert" : "status"}
          className={
            notice.kind === "error"
              ? "text-xs text-red-700 dark:text-red-300"
              : "text-xs text-teal-700 dark:text-teal-300"
          }
        >
          {notice.text}
        </p>
      ) : null}

      <section className={`${cardClass} overflow-hidden`}>
        <div className="border-b border-border/80 px-4 py-4 sm:px-5">
          <h2 className="font-semibold text-foreground">مشتریان همگام‌شده</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {customers === null && !loadError
              ? "در حال بارگیری…"
              : loadError
                ? "فهرست مشتریان خوانده نشد."
                : `${toPersianDigits(total)} مشتری در این فروشگاه شناخته شده است؛ چه پیوندخورده و چه در انتظار بررسی. صفحه ${toPersianDigits(page)} از ${toPersianDigits(totalPages)}.`}
          </p>
        </div>

        {/* The toolbar stays while a search is active even when that search
            matched nothing — hiding it was a dead end, because the only way
            back to the full list was the one control that had just vanished. */}
        {customers !== null && (customers.length > 0 || needle) ? (
          <div className="border-b border-border/80 px-4 py-3 sm:px-5">
            <div className="flex flex-wrap items-center gap-2">
              <input
                className={`${inputClass} sm:max-w-72`}
                placeholder="جست‌وجو در نام، تلفن یا ایمیل…"
                aria-label="جست‌وجو در مشتریان"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setPage(1);
                }}
              />
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                تعداد در صفحه
                <select
                  className={`${inputClass} w-auto py-1.5 text-xs`}
                  aria-label="تعداد ردیف در هر صفحه"
                  value={pageSize}
                  onChange={(e) => {
                    // A bigger page means fewer pages: go back to the first one
                    // rather than keeping a page number the new size may not have.
                    setPageSize(Number(e.target.value));
                    setPage(1);
                  }}
                >
                  {[10, 25, 50, 100].map((size) => (
                    <option key={size} value={size}>
                      {toPersianDigits(size)}
                    </option>
                  ))}
                </select>
              </label>
              {needle ? (
                <span className="text-xs text-muted-foreground">
                  {toPersianDigits(total)} نتیجه برای این جست‌وجو
                </span>
              ) : null}
            </div>
          </div>
        ) : null}

        {loadError ? (
          <div className="px-4 py-8 text-center sm:px-5">
            <p className="text-sm text-red-700 dark:text-red-300">بارگیری فهرست مشتریان ناموفق بود.</p>
            <Button
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={() => selectedId && void load(selectedId, page, pageSize, query)}
            >
              تلاش دوباره
            </Button>
          </div>
        ) : customers === null ? (
          <div className="p-4 sm:p-5">
            <LoadingSkeleton rows={4} label="در حال بارگیری مشتریان" />
          </div>
        ) : visible.length === 0 ? (
          needle ? (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground sm:px-5">
              <p>با این جست‌وجو مشتری‌ای پیدا نشد.</p>
              <Button variant="outline" size="sm" className="mt-3" onClick={() => { setQuery(""); setPage(1); }}>
                پاک کردن جست‌وجو
              </Button>
            </div>
          ) : (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground sm:px-5">
              هنوز مشتری‌ای از فروشگاه همگام نشده است. «همگام‌سازی مشتریان» را بزنید — در حالت افزونه، درخواست در صف
              قرار می‌گیرد و در اجرای بعدی افزونه (معمولاً ظرف چند دقیقه) کل پروندهٔ مشتریان فروشگاه فرستاده می‌شود.
            </div>
          )
        ) : (
          <ul className="divide-y divide-border/80">
            {visible.map((c) => (
              <li key={c.remoteId} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 sm:px-5">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                  <ContactIcon className="size-4" />
                </span>
                <div className="min-w-0 flex-1 basis-40">
                  <p className="truncate font-medium text-foreground">{c.name || "بدون نام"}</p>
                  <p dir="auto" className="truncate text-right text-xs text-muted-foreground">
                    {[c.phone, c.email].filter(Boolean).join(" • ") || "بدون تماس"}
                  </p>
                </div>
                <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
                  <StatusBadge tone={identityTone(c.identityStatus)}>
                    {IDENTITY_LABELS[c.identityStatus] ?? "وضعیت نامشخص"}
                  </StatusBadge>
                  {c.ordersCount !== null ? (
                    <StatusBadge tone={c.ordersCount > 0 ? "active" : "neutral"}>
                      {toPersianDigits(c.ordersCount)} سفارش آنلاین
                    </StatusBadge>
                  ) : null}
                  {c.lastSeen ? (
                    <span className="text-[11px] text-muted-foreground">
                      {formatJalali(c.lastSeen, { withTime: true })}
                    </span>
                  ) : null}
                  {c.localId && canViewCustomerFile ? (
                    <Link
                      href={crmCustomerHref(c.localId)}
                      aria-label={`پروندهٔ ${c.name || "مشتری"}`}
                      className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs text-foreground/80 transition-colors hover:bg-stone-50 dark:hover:bg-stone-800"
                    >
                      پرونده
                      <ExternalLinkIcon className="size-3" />
                    </Link>
                  ) : null}
                  {c.externalProfileId && canResolveIdentities &&
                    ["unmapped", "needs_review", "conflict"].includes(c.identityStatus) ? (
                      <Link
                        href="/crm/reconciliation"
                        aria-label={`بررسی پیوند ${c.name || "مشتری"}`}
                        className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs text-foreground/80 transition-colors hover:bg-stone-50 dark:hover:bg-stone-800"
                      >
                        بررسی پیوند
                        <ExternalLinkIcon className="size-3" />
                      </Link>
                    ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
        {customers !== null && totalPages > 1 ? (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/80 px-4 py-3 text-xs text-muted-foreground sm:px-5">
            <span>
              صفحه {toPersianDigits(page)} از {toPersianDigits(totalPages)} — نمایش {toPersianDigits(visible.length)} از {toPersianDigits(total)} ردیف
            </span>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>
                قبلی
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= totalPages}
                onClick={() => setPage((value) => Math.min(totalPages, value + 1))}
              >
                بعدی
              </Button>
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}
