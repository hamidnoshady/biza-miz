"use client";

/**
 * The store's mirrored customer book: who the customers are on the store
 * side, joined to the local CRM record. Reads /api/integrations/wp-manager/
 * customers; the sync itself is the catalogue button (plugin: queued
 * customer_export job; REST: direct pull).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ContactIcon, RefreshCwIcon, ExternalLinkIcon, EyeIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  deleted: number;
  updatedAt: string;
}

interface StoreCustomer {
  remoteId: string;
  localId: string | null;
  externalProfileId: string | null;
  identityStatus: string;
  accountType: "registered" | "guest" | "subscriber";
  remoteStatus: "active" | "deleted";
  name: string;
  remoteName: string;
  remotePhone: string | null;
  remoteEmail: string | null;
  canonicalName: string | null;
  canonicalPhone: string | null;
  canonicalEmail: string | null;
  phone: string | null;
  email: string | null;
  ordersCount: number | null;
  lastOnlineOrderAt: string | null;
  lastSyncedAt: string | null;
}

const IDENTITY_LABELS: Record<string, string> = {
  legacy: "پیوند قدیمی",
  auto_matched: "پیوند خودکار",
  confirmed: "پیوند تأییدشده",
  unmapped: "بدون پیوند",
  needs_review: "نیازمند بررسی",
  conflict: "تعارض اطلاعات",
  ignored: "نادیده‌گرفته‌شده",
  remote_deleted: "حذف‌شده در فروشگاه",
};

const ACCOUNT_TYPE_LABELS: Record<StoreCustomer["accountType"], string> = {
  registered: "حساب ثبت‌شده",
  guest: "خریدار مهمان",
  subscriber: "اشتراک بدون سفارش",
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
  const { connections, selectedId, setSelectedId, connectionsError, reloadConnections } = useWpStore();
  const [customers, setCustomers] = useState<StoreCustomer[] | null>(null);
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);
  const [total, setTotal] = useState(0);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [searchComposing, setSearchComposing] = useState(false);
  const [accountType, setAccountType] = useState<"all" | StoreCustomer["accountType"]>("all");
  const [identityFilter, setIdentityFilter] = useState<"all" | "linked" | "unlinked" | "needs_review" | "conflict" | "ignored">("all");
  const [remoteFilter, setRemoteFilter] = useState<"active" | "deleted" | "all">("active");
  const [sort, setSort] = useState<"name" | "last_synced" | "orders">("name");
  const [detailCustomer, setDetailCustomer] = useState<StoreCustomer | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [totalPages, setTotalPages] = useState(1);
  const [canViewCustomerFile, setCanViewCustomerFile] = useState(false);
  const [canViewIdentityStatus, setCanViewIdentityStatus] = useState(false);
  const [canResolveIdentities, setCanResolveIdentities] = useState(false);
  const [canSyncCustomers, setCanSyncCustomers] = useState(false);
  const [canViewOrderCounts, setCanViewOrderCounts] = useState(false);
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
    nextQuery = debouncedQuery,
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
      accountType,
      identity: identityFilter,
      remote: remoteFilter,
      sort,
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
        canViewIdentityStatus?: boolean;
        canResolveIdentities?: boolean;
        canSyncCustomers?: boolean;
        canViewOrderCounts?: boolean;
      };
    }>(`/api/integrations/wp-manager/customers?${params.toString()}`);
    // A newer selection (or unmount) supersedes this response.
    if (!mountedRef.current || seq !== loadSeqRef.current || selectedRef.current !== connectionId) return;
    if (res.ok) {
      setLoadError(false);
      setHasLoadedOnce(true);
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
      setCanViewIdentityStatus(res.data.permissions?.canViewIdentityStatus === true);
      setCanResolveIdentities(res.data.permissions?.canResolveIdentities === true);
      setCanSyncCustomers(res.data.permissions?.canSyncCustomers === true);
      const mayViewOrderCounts = res.data.permissions?.canViewOrderCounts === true;
      setCanViewOrderCounts(mayViewOrderCounts);
      if (!mayViewOrderCounts && sort === "orders") setSort("name");
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
          setNotice({
            kind: "ok",
            text: `همگام‌سازی افزونه با موفقیت کامل شد؛ ${toPersianDigits(nextSyncStatus.deleted)} حساب حذف‌شده از فروشگاه علامت‌گذاری شد.`,
          });
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
      setCanViewIdentityStatus(false);
      setCanResolveIdentities(false);
      setCanSyncCustomers(false);
      setCanViewOrderCounts(false);
      setSyncStatus(null);
    }
  }, [page, pageSize, debouncedQuery, accountType, identityFilter, remoteFilter, sort, pluginSyncQueued]);

  useEffect(() => {
    if (searchComposing) return;
    const timer = window.setTimeout(() => setDebouncedQuery(query), 300);
    return () => window.clearTimeout(timer);
  }, [query, searchComposing]);

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
    setCustomers(null);
    setHasLoadedOnce(false);
    setTotal(0);
    setLoadError(false);
    setCanViewCustomerFile(false);
    setCanViewIdentityStatus(false);
    setCanResolveIdentities(false);
    setCanSyncCustomers(false);
    setCanViewOrderCounts(false);
    setDetailCustomer(null);
    setQuery("");
    setDebouncedQuery("");
    setSearchComposing(false);
    setPage(1);
  }, [selectedId]);

  useEffect(() => {
    if (selectedId && !searchComposing) void load(selectedId, page, pageSize, debouncedQuery);
  }, [selectedId, page, pageSize, debouncedQuery, searchComposing, load]);

  // Plugin exports are asynchronous and may take several minutes. Refresh the
  // durable run summary while rows/markers are still arriving, without clearing
  // the visible customer list. Poll for at most five minutes per button press.
  useEffect(() => {
    if (!selectedId || !pluginSyncQueued || searchComposing || query !== debouncedQuery) return;
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
        try {
          await load(selectedId, page, pageSize, debouncedQuery, true);
        } catch {
          // api() normally resolves network failures as !ok; keep polling even
          // if an unexpected rejection escapes load().
        }
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
  }, [selectedId, pluginSyncQueued, page, pageSize, query, debouncedQuery, searchComposing, load]);

  async function syncCustomers() {
    const connectionId = selectedId;
    if (!connectionId || busy || !canSyncCustomers) return;
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
          deleted?: number;
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
                `${toPersianDigits(Number(res.data.conflicted ?? 0))} تعارض، ` +
                `${toPersianDigits(Number(res.data.deleted ?? 0))} حساب حذف‌شده در فروشگاه.`,
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
          void load(connectionId, page, pageSize, debouncedQuery);
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
      void load(connectionId, page, pageSize, debouncedQuery);
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
  const hasActiveFilters = Boolean(
    needle || accountType !== "all" || identityFilter !== "all" || remoteFilter !== "active",
  );
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
    } else if (syncStatus.transport === "rest_api" && syncStatus.totalPages !== null &&
      syncStatus.currentPage > syncStatus.totalPages) {
      syncProgressText = "صفحه‌های فروشگاه خوانده شد؛ در حال بررسی مستقیم حساب‌هایی هستیم که ممکن است با جابه‌جایی صفحه‌ها جا افتاده باشند.";
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
    if (connectionsError) {
      return (
        <EmptyState
          title="فهرست فروشگاه‌های متصل در دسترس نیست"
          action={(
            <Button type="button" variant="outline" size="sm" onClick={() => void reloadConnections()}>
              تلاش دوباره
            </Button>
          )}
        >
          {connectionsError}
        </EmptyState>
      );
    }
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
      {connectionsError ? (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/30 dark:text-red-200">
          <span>{connectionsError}</span>
          <Button type="button" variant="outline" size="sm" onClick={() => void reloadConnections()}>
            بارگیری دوباره
          </Button>
        </div>
      ) : null}
      <div className={`${cardClass} flex flex-wrap items-center gap-3 p-4`}>
        <ConnectionPicker
          embedded
          connections={connections}
          value={selectedId}
          onChange={(id) => {
            selectedRef.current = id;
            loadSeqRef.current += 1;
            setCustomers(null);
            setHasLoadedOnce(false);
            setTotal(0);
            setLoadError(false);
            setCanViewCustomerFile(false);
            setCanViewIdentityStatus(false);
            setCanResolveIdentities(false);
            setCanSyncCustomers(false);
            setCanViewOrderCounts(false);
            setDetailCustomer(null);
            setSelectedId(id);
          }}
        />
        {canSyncCustomers ? (
          <Button
            variant="outline"
            size="sm"
            disabled={busy || pluginSyncQueued || !selectedId || customers === null}
            onClick={() => void syncCustomers()}
            className="ms-auto w-full sm:w-auto"
          >
            <RefreshCwIcon aria-hidden="true" className="size-4" />
            {busy
              ? "در حال همگام‌سازی مشتریان…"
              : pluginSyncQueued
                ? "در انتظار پاسخ افزونه…"
                : "همگام‌سازی مشتریان"}
          </Button>
        ) : (
          <p className="ms-auto w-full text-xs text-muted-foreground sm:w-auto">
            برای همگام‌سازی به مجوز «همگام‌سازی فروشگاه» نیاز دارید.
          </p>
        )}
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
          <h2 className="font-semibold text-foreground">مشتریان و هویت‌های خریداران فروشگاه</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {customers === null && !loadError
              ? "در حال بارگیری…"
              : loadError
                ? "فهرست مشتریان خوانده نشد."
                : `${toPersianDigits(total)} هویت مشتری در این فروشگاه بر اساس فیلترهای انتخاب‌شده. صفحه ${toPersianDigits(page)} از ${toPersianDigits(totalPages)}.`}
          </p>
        </div>

        {/* Once the first store response arrives, this toolbar remains mounted
            even for zero-result searches and while a debounced request loads.
            That preserves the focused input/caret, including during IME entry. */}
        {hasLoadedOnce || needle ? (
          <div className="border-b border-border/80 px-4 py-3 sm:px-5">
            <div className="flex flex-wrap items-center gap-2">
              <input
                className={`${inputClass} w-full sm:max-w-72`}
                placeholder="جست‌وجو در نام، تلفن یا ایمیل…"
                aria-label="جست‌وجو در مشتریان"
                aria-busy={query !== debouncedQuery || searchComposing || customers === null}
                dir="auto"
                value={query}
                onCompositionStart={() => setSearchComposing(true)}
                onCompositionEnd={(event) => {
                  setSearchComposing(false);
                  setQuery(event.currentTarget.value);
                }}
                onChange={(event) => {
                  // Cancel older results immediately; the actual list request
                  // waits 300ms after typing/composition stops.
                  loadSeqRef.current += 1;
                  setQuery(event.target.value);
                  setPage(1);
                }}
              />
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                نوع حساب
                <select
                  className={`${inputClass} w-auto py-1.5 text-xs`}
                  aria-label="نوع حساب فروشگاه"
                  value={accountType}
                  onChange={(event) => {
                    loadSeqRef.current += 1;
                    setAccountType(event.target.value as typeof accountType);
                    setPage(1);
                  }}
                >
                  <option value="all">همهٔ انواع</option>
                  <option value="registered">حساب ثبت‌شده</option>
                  <option value="guest">خریدار مهمان</option>
                  <option value="subscriber">اشتراک بدون سفارش</option>
                </select>
              </label>
              {canViewIdentityStatus ? (
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  پیوند CRM
                  <select
                    className={`${inputClass} w-auto py-1.5 text-xs`}
                    aria-label="وضعیت پیوند CRM"
                    value={identityFilter}
                    onChange={(event) => {
                      loadSeqRef.current += 1;
                      setIdentityFilter(event.target.value as typeof identityFilter);
                      setPage(1);
                    }}
                  >
                    <option value="all">همهٔ وضعیت‌ها</option>
                    <option value="linked">پیوندخورده</option>
                    <option value="unlinked">بدون پیوند</option>
                    <option value="needs_review">نیازمند بررسی</option>
                    <option value="conflict">تعارض اطلاعات</option>
                    <option value="ignored">نادیده‌گرفته‌شده</option>
                  </select>
                </label>
              ) : null}
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                حساب فروشگاه
                <select
                  className={`${inputClass} w-auto py-1.5 text-xs`}
                  aria-label="وضعیت حساب در فروشگاه"
                  value={remoteFilter}
                  onChange={(event) => {
                    loadSeqRef.current += 1;
                    setRemoteFilter(event.target.value as typeof remoteFilter);
                    setPage(1);
                  }}
                >
                  <option value="active">فعال</option>
                  <option value="deleted">حذف‌شده</option>
                  <option value="all">همه</option>
                </select>
              </label>
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                مرتب‌سازی
                <select
                  className={`${inputClass} w-auto py-1.5 text-xs`}
                  aria-label="مرتب‌سازی مشتریان"
                  value={sort}
                  onChange={(event) => {
                    loadSeqRef.current += 1;
                    setSort(event.target.value as typeof sort);
                    setPage(1);
                  }}
                >
                  <option value="name">نام</option>
                  <option value="last_synced">آخرین همگام‌سازی</option>
                  {canViewOrderCounts ? <option value="orders">تعداد سفارش</option> : null}
                </select>
              </label>
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                تعداد در صفحه
                <select
                  className={`${inputClass} w-auto py-1.5 text-xs`}
                  aria-label="تعداد ردیف در هر صفحه"
                  value={pageSize}
                  onChange={(event) => {
                    loadSeqRef.current += 1;
                    setPageSize(Number(event.target.value));
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
              {query !== debouncedQuery || searchComposing ? (
                <span role="status" className="text-xs text-muted-foreground">
                  در حال آماده‌سازی جست‌وجو…
                </span>
              ) : needle || accountType !== "all" || identityFilter !== "all" || remoteFilter !== "active" ? (
                <span className="text-xs text-muted-foreground">
                  {toPersianDigits(total)} نتیجه بر اساس فیلترهای انتخاب‌شده
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
              onClick={() => selectedId && void load(selectedId, page, pageSize, debouncedQuery)}
            >
              تلاش دوباره
            </Button>
          </div>
        ) : customers === null ? (
          <div className="p-4 sm:p-5">
            <LoadingSkeleton rows={4} label="در حال بارگیری مشتریان" />
          </div>
        ) : visible.length === 0 ? (
          hasActiveFilters ? (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground sm:px-5">
              <p>مشتری‌ای با این جست‌وجو و فیلترها پیدا نشد.</p>
              <Button
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={() => {
                  loadSeqRef.current += 1;
                  setQuery("");
                  setDebouncedQuery("");
                  setAccountType("all");
                  setIdentityFilter("all");
                  setRemoteFilter("active");
                  setPage(1);
                }}
              >
                پاک کردن جست‌وجو و فیلترها
              </Button>
            </div>
          ) : (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground sm:px-5">
              هنوز حسابی از فروشگاه همگام نشده است. «همگام‌سازی مشتریان» را بزنید — در حالت افزونه، درخواست در صف
              قرار می‌گیرد و پیشرفت آن در همین صفحه گزارش می‌شود.
            </div>
          )
        ) : (
          <ul className="divide-y divide-border/80">
            {visible.map((c) => (
              <li key={c.remoteId} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 sm:px-5">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                  <ContactIcon aria-hidden="true" className="size-4" />
                </span>
                <div className="min-w-0 flex-1 basis-40">
                  <p className="truncate font-medium text-foreground">{c.name || "بدون نام"}</p>
                  <p dir="auto" className="truncate text-right text-xs text-muted-foreground">
                    {[c.phone, c.email].filter(Boolean).join(" • ") || "بدون تماس"}
                  </p>
                  <p dir="ltr" className="truncate text-start text-[11px] text-muted-foreground">
                    ID فروشگاه: {c.remoteId}
                  </p>
                </div>
                <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
                  <StatusBadge tone={c.remoteStatus === "active" ? "positive" : "neutral"}>
                    {c.remoteStatus === "active" ? "فعال در فروشگاه" : "حذف‌شده در فروشگاه"}
                  </StatusBadge>
                  <StatusBadge tone={c.accountType === "guest" ? "active" : "neutral"}>
                    {ACCOUNT_TYPE_LABELS[c.accountType]}
                  </StatusBadge>
                  {canViewIdentityStatus ? (
                    <StatusBadge tone={identityTone(c.identityStatus)}>
                      {IDENTITY_LABELS[c.identityStatus] ?? "وضعیت نامشخص"}
                    </StatusBadge>
                  ) : null}
                  {canViewOrderCounts && c.ordersCount !== null ? (
                    <StatusBadge tone={c.ordersCount > 0 ? "active" : "neutral"}>
                      {toPersianDigits(c.ordersCount)} سفارش آنلاین
                    </StatusBadge>
                  ) : null}
                  {canViewOrderCounts && c.lastOnlineOrderAt ? (
                    <span className="text-[11px] text-muted-foreground">
                      آخرین سفارش آنلاین: {formatJalali(c.lastOnlineOrderAt, { withTime: true })}
                    </span>
                  ) : null}
                  {c.lastSyncedAt ? (
                    <span className="text-[11px] text-muted-foreground">
                      آخرین همگام‌سازی: {formatJalali(c.lastSyncedAt, { withTime: true })}
                    </span>
                  ) : null}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-label={`جزئیات ${c.name || "مشتری"}`}
                    onClick={() => setDetailCustomer(c)}
                  >
                    <EyeIcon aria-hidden="true" className="size-4" />
                    جزئیات
                  </Button>
                  {c.localId && canViewCustomerFile ? (
                    <Link
                      href={crmCustomerHref(c.localId)}
                      aria-label={`پروندهٔ ${c.name || "مشتری"}`}
                      className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs text-foreground/80 transition-colors hover:bg-stone-50 dark:hover:bg-stone-800"
                    >
                      پرونده
                      <ExternalLinkIcon aria-hidden="true" className="size-3" />
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
                        <ExternalLinkIcon aria-hidden="true" className="size-3" />
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
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1}
                onClick={() => {
                  loadSeqRef.current += 1;
                  setPage((value) => Math.max(1, value - 1));
                }}
              >
                قبلی
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= totalPages}
                onClick={() => {
                  loadSeqRef.current += 1;
                  setPage((value) => Math.min(totalPages, value + 1));
                }}
              >
                بعدی
              </Button>
            </div>
          </div>
        ) : null}
      </section>

      <Dialog open={detailCustomer !== null} onOpenChange={(open) => !open && setDetailCustomer(null)}>
        <DialogContent className="max-h-[calc(100dvh-1rem)] overflow-y-auto sm:max-w-xl">
          {detailCustomer ? (
            <>
              <DialogHeader>
                <DialogTitle>{detailCustomer.name || "جزئیات مشتری فروشگاه"}</DialogTitle>
                <DialogDescription>
                  نمایش فقط‌خواندنی؛ اطلاعات فروشگاه و پروندهٔ CRM جدا نگه داشته می‌شوند و این صفحه دادهٔ محلی را تغییر نمی‌دهد.
                </DialogDescription>
              </DialogHeader>
              <div className="grid gap-3 sm:grid-cols-2">
                <section className="rounded-xl border border-border/80 p-3">
                  <h3 className="mb-2 text-sm font-semibold text-foreground">دادهٔ فروشگاه</h3>
                  <dl>
                    <DetailField label="نام" value={detailCustomer.remoteName || "بدون نام"} />
                    <DetailField label="تلفن" value={detailCustomer.remotePhone} />
                    <DetailField label="ایمیل" value={detailCustomer.remoteEmail} />
                    <DetailField label="شناسهٔ فروشگاه" value={detailCustomer.remoteId} dir="ltr" />
                  </dl>
                </section>
                <section className="rounded-xl border border-border/80 p-3">
                  <h3 className="mb-2 text-sm font-semibold text-foreground">پروندهٔ CRM</h3>
                  {canViewCustomerFile ? (
                    detailCustomer.localId ? (
                      <dl>
                        <DetailField label="نام" value={detailCustomer.canonicalName} />
                        <DetailField label="تلفن" value={detailCustomer.canonicalPhone} />
                        <DetailField label="ایمیل" value={detailCustomer.canonicalEmail} />
                      </dl>
                    ) : (
                      <p className="text-xs leading-6 text-muted-foreground">این هویت هنوز به پروندهٔ CRM پیوند نخورده است.</p>
                    )
                  ) : (
                    <p className="text-xs leading-6 text-muted-foreground">برای مشاهدهٔ جزئیات پروندهٔ CRM، مجوز دسترسی به اشخاص لازم است.</p>
                  )}
                </section>
              </div>
              <dl className="grid gap-3 rounded-xl bg-muted/40 p-3 sm:grid-cols-2">
                <DetailField label="نوع حساب" value={ACCOUNT_TYPE_LABELS[detailCustomer.accountType]} />
                <DetailField
                  label="وضعیت حساب در فروشگاه"
                  value={detailCustomer.remoteStatus === "active" ? "فعال" : "حذف‌شده"}
                />
                <DetailField
                  label="وضعیت پیوند CRM"
                  value={canViewIdentityStatus
                    ? IDENTITY_LABELS[detailCustomer.identityStatus] ?? detailCustomer.identityStatus
                    : "برای نقش شما قابل‌نمایش نیست"}
                />
                <DetailField
                  label="سفارش‌های آنلاین در این فروشگاه"
                  value={detailCustomer.ordersCount === null ? "برای نقش شما قابل‌نمایش نیست" : toPersianDigits(detailCustomer.ordersCount)}
                />
                <DetailField
                  label="آخرین سفارش آنلاین"
                  value={!canViewOrderCounts
                    ? "برای نقش شما قابل‌نمایش نیست"
                    : detailCustomer.lastOnlineOrderAt
                      ? formatJalali(detailCustomer.lastOnlineOrderAt, { withTime: true })
                      : "دادهٔ قابل‌اتکایی ثبت نشده"}
                />
                <DetailField
                  label="آخرین همگام‌سازی / به‌روزرسانی"
                  value={detailCustomer.lastSyncedAt ? formatJalali(detailCustomer.lastSyncedAt, { withTime: true }) : null}
                />
              </dl>
              <DialogFooter>
                {detailCustomer.localId && canViewCustomerFile ? (
                  <Link
                    href={crmCustomerHref(detailCustomer.localId)}
                    className="inline-flex items-center gap-1 rounded-lg border border-border px-3 py-2 text-sm text-foreground/80 transition-colors hover:bg-stone-50 dark:hover:bg-stone-800"
                  >
                    رفتن به پروندهٔ CRM
                    <ExternalLinkIcon aria-hidden="true" className="size-3" />
                  </Link>
                ) : null}
                <Button type="button" variant="outline" onClick={() => setDetailCustomer(null)}>
                  بستن
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function DetailField({
  label,
  value,
  dir,
}: {
  label: string;
  value: string | null | undefined;
  dir?: "ltr" | "rtl";
}) {
  return (
    <div className="mb-2 last:mb-0">
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd dir={dir ?? "auto"} className="break-words text-sm text-foreground">
        {value || "ثبت نشده"}
      </dd>
    </div>
  );
}
