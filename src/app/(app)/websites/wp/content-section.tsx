"use client";

/**
 * WordPress content management: a paged/searchable mirror of posts and pages,
 * plus create/edit actions. Plugin mode queues writes for the next plugin run;
 * REST mode writes wp/v2 and mirrors the response immediately.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  FileTextIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  api,
  ErrorBox,
  errorMessageOrRaw,
  Field,
  InfoBox,
  inputClass,
} from "@/app/dashboard/ui";
import {
  cardClass,
  EmptyState,
  LoadingSkeleton,
  SectionCardSkeleton,
  StatusBadge,
  TabBar,
  TabPanel,
} from "@/app/dashboard/page-chrome";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { cn } from "@/lib/utils";
import { ConnectionPicker, type ConnectionLite } from "./connection-lite";
import { wpEditorIsDirty, wpEditorPatch, type WpEditorValues } from "./content-editor-state";
import { pluginSupportsJobType } from "@/lib/integrations/plugin-capabilities";
import { PluginWaitNote } from "./plugin-wait-note";
import { useWpStore } from "./wp-store-context";
import { WpStoreRefreshError } from "./wp-store-states";

interface ContentRow {
  remoteId: string;
  wpType: string;
  title: string;
  slug: string;
  status: string;
  permalink: string;
  authorName: string;
  mediaUrl: string | null;
  mimeType: string | null;
  /** Raw post HTML when the mirror carries it; null when it does not. */
  content: string | null;
  remoteUpdatedAt: string | null;
  syncedAt: string;
  writeStatus?: "pending" | "processing" | "failed" | "dead" | "needs_review" | null;
}

interface ContentDetail extends ContentRow {
  editorTitle: string;
  content: string | null;
  excerpt: string;
}

type ContentTab = "post" | "page";

const PAGE_SIZE = 20;
const STATUS_LABELS: Record<string, string> = {
  publish: "منتشرشده",
  draft: "پیش‌نویس",
  pending: "در انتظار بررسی",
  private: "خصوصی",
  future: "زمان‌بندی‌شده",
  trash: "زباله‌دان",
};
const WRITE_STATUS_LABELS: Record<NonNullable<ContentRow["writeStatus"]>, string> = {
  pending: "تغییر در صف",
  processing: "در حال اعمال",
  failed: "اعمال ناموفق",
  dead: "نیازمند رسیدگی",
  needs_review: "نیازمند بازبینی",
};

function statusTone(status: string): "active" | "positive" | "neutral" | "danger" {
  if (status === "publish") return "positive";
  if (status === "pending" || status === "future") return "active";
  if (status === "trash") return "danger";
  return "neutral";
}

export function WpContentSection({ canManage }: { canManage: boolean }) {
  const { connections, loadState, loadError, reloadConnections, selectedId, setSelectedId } = useWpStore();
  const [tab, setTab] = useState<ContentTab>("post");
  const [rows, setRows] = useState<ContentRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [listError, setListError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [notice, setNotice] = useState("");
  const [actionError, setActionError] = useState("");
  const [editing, setEditing] = useState<ContentRow | "new" | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setAppliedSearch(search.trim());
      setPage(1);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    if (!selectedId) return;
    const controller = new AbortController();
    setRows(null);
    setListError("");
    const query = new URLSearchParams({
      connectionId: selectedId,
      type: tab,
      page: String(page),
      pageSize: String(PAGE_SIZE),
    });
    if (appliedSearch) query.set("search", appliedSearch);

    void api<{
      rows: ContentRow[];
      total: number;
      syncedAt: string | null;
      error?: string;
    }>(`/api/integrations/wp-manager/content?${query.toString()}`, { signal: controller.signal }).then(
      (response) => {
        if (response.aborted) return;
        if (!response.ok) {
          setRows([]);
          setTotal(0);
          setListError(errorMessageOrRaw(response.data?.error) || "خواندن محتوای وردپرس ممکن نشد.");
          return;
        }
        const nextRows = Array.isArray(response.data.rows) ? response.data.rows : [];
        const reportedTotal = Number(response.data.total);
        const nextTotal = Number.isFinite(reportedTotal) && reportedTotal >= 0 ? reportedTotal : nextRows.length;
        const lastPage = Math.max(1, Math.ceil(nextTotal / PAGE_SIZE));
        if (page > lastPage) {
          setPage(lastPage);
          return;
        }
        setRows(nextRows);
        setTotal(nextTotal);
        setLastSyncedAt(response.data.syncedAt ?? null);
      },
    );
    return () => controller.abort();
  }, [selectedId, tab, page, appliedSearch, refreshKey]);

  const selectedConnection = useMemo(
    () => connections?.find((connection) => connection.id === selectedId) ?? null,
    [connections, selectedId],
  );
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const isPaused = selectedConnection?.status === "paused";
  const contentExportSupported = selectedConnection?.linkMode !== "plugin"
    || pluginSupportsJobType(selectedConnection?.pluginCapabilities, "content_export");
  const postWriteSupported = selectedConnection?.linkMode !== "plugin"
    || pluginSupportsJobType(selectedConnection?.pluginCapabilities, "post_upsert");

  const refresh = useCallback(() => setRefreshKey((value) => value + 1), []);

  function selectConnection(id: string) {
    setSelectedId(id);
    setLastSyncedAt(null);
    setPage(1);
    setNotice("");
    setActionError("");
  }

  function selectTab(next: ContentTab) {
    setTab(next);
    setPage(1);
    setEditing(null);
    setNotice("");
    setActionError("");
  }

  function changePage(next: number) {
    setPage(Math.min(totalPages, Math.max(1, next)));
    requestAnimationFrame(() => {
      window.document.getElementById("wp-content-list")?.scrollIntoView({ block: "start" });
    });
  }

  async function syncContent() {
    if (!selectedId) return;
    setSyncing(true);
    setNotice("");
    setActionError("");
    const response = await api<{
      error?: string;
      queued?: boolean;
      total?: number;
      removed?: number;
    }>("/api/integrations/wp-manager/content", {
      method: "POST",
      body: JSON.stringify({ connectionId: selectedId }),
    });
    setSyncing(false);
    if (!response.ok) {
      setActionError(errorMessageOrRaw(response.data?.error) || "همگام‌سازی محتوا انجام نشد.");
      return;
    }
    if (response.data.queued) {
      setNotice("درخواست همگام‌سازی در صف قرار گرفت. پس از اجرای افزونه، برای دیدن داده‌های رسیده «تازه‌سازی» را بزنید.");
      return;
    }
    const removed = Number(response.data.removed ?? 0);
    setNotice(
      `همگام‌سازی انجام شد؛ ${toPersianDigits(Number(response.data.total ?? 0))} مورد خوانده شد${
        removed > 0 ? ` و ${toPersianDigits(removed)} مورد حذف‌شده از فهرست پاک شد` : ""
      }.`,
    );
    refresh();
  }

  if (connections === null) {
    return <SectionCardSkeleton rows={6} label="در حال بارگذاری فروشگاه‌ها و محتوای وردپرس" />;
  }

  if (connections.length === 0) {
    return (
      <section className={`${cardClass} p-4 sm:p-5`} aria-labelledby="wp-content-empty-title">
        <h2 id="wp-content-empty-title" className="font-semibold text-foreground">محتوای وردپرس</h2>
        <div className="mt-4">
          <EmptyState>برای دیدن و ویرایش نوشته‌ها و برگه‌ها، ابتدا یک فروشگاه وردپرس/ووکامرس متصل کنید.</EmptyState>
        </div>
        <Button asChild className="mt-4 w-full sm:w-auto">
          <Link href="/settings/connections?tab=woocommerce">رفتن به اتصال‌های فنی</Link>
        </Button>
      </section>
    );
  }

  return (
    <div className="space-y-4">
      <section className={`${cardClass} p-4 sm:p-5`} aria-labelledby="wp-content-heading">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
          <div className="min-w-0">
            <h2 id="wp-content-heading" className="font-semibold text-foreground">محتوای وردپرس</h2>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              نوشته‌ها و برگه‌های سایت را جستجو، ایجاد و بدون از دست‌رفتن متن فعلی ویرایش کنید.
            </p>
          </div>
          <p className="shrink-0 text-xs leading-5 text-muted-foreground">
            {lastSyncedAt ? `آخرین همگام‌سازی: ${formatJalali(lastSyncedAt, { withTime: true })}` : "هنوز همگام نشده"}
          </p>
        </div>

        <div className="mt-4 flex flex-col gap-3 lg:flex-row lg:items-end">
          <ConnectionPicker
            embedded
            connections={connections}
            value={selectedId}
            disabled={syncing}
            onChange={selectConnection}
          />
          {canManage ? (
            <div className="grid w-full grid-cols-1 gap-2 min-[390px]:grid-cols-2 lg:w-auto">
              <Button
                variant="outline"
disabled={syncing || isPaused || !contentExportSupported}
                onClick={syncContent}
                aria-busy={syncing}
                className="w-full"
              >
                {!syncing ? <RefreshCwIcon aria-hidden="true" className="size-4" /> : null}
                {syncing ? "در حال همگام‌سازی…" : "همگام‌سازی"}
              </Button>
              <Button disabled={syncing || isPaused || !postWriteSupported} onClick={() => setEditing("new")} className="w-full">
                <PlusIcon aria-hidden="true" className="size-4" />
                {tab === "post" ? "نوشتهٔ تازه" : "برگهٔ تازه"}
              </Button>
            </div>
          ) : (
            <p className="max-w-sm text-xs leading-5 text-muted-foreground" role="status">
              دسترسی فقط‌خواندنی است؛ برای همگام‌سازی یا ویرایش، از مدیر کسب‌وکار دسترسی مدیریت بخواهید.
            </p>
          )}
        </div>
        {canManage && isPaused ? (
          <div className="mt-3"><InfoBox>این اتصال متوقف است؛ همگام‌سازی و تغییر محتوا تا ازسرگیری اتصال غیرفعال‌اند.</InfoBox></div>
        ) : null}
        {canManage && !contentExportSupported ? (
          <div className="mt-3"><InfoBox>نسخهٔ نصب‌شدهٔ افزونه از همگام‌سازی محتوا پشتیبانی نمی‌کند؛ برای فعال‌شدن آن افزونه را به‌روزرسانی کنید.</InfoBox></div>
        ) : null}
        {canManage && !postWriteSupported ? (
          <div className="mt-3"><InfoBox>نسخهٔ نصب‌شدهٔ افزونه از ایجاد و ویرایش نوشته‌ها پشتیبانی نمی‌کند؛ برای فعال‌شدن آن افزونه را به‌روزرسانی کنید.</InfoBox></div>
        ) : null}
      </section>

      <PluginWaitNote connections={connections} selectedId={selectedId} />
      {loadState === "error" && loadError ? (
        <WpStoreRefreshError failure={loadError} onRetry={() => void reloadConnections()} />
      ) : null}
      <ErrorBox>{actionError}</ErrorBox>
      <InfoBox>{notice}</InfoBox>

      <TabBar
        idPrefix="wp-content"
        label="نوع محتوا"
        tabs={[
          { key: "post", label: "نوشته‌ها" },
          { key: "page", label: "برگه‌ها" },
        ]}
        active={tab}
        onChange={selectTab}
      />

      <TabPanel idPrefix="wp-content" active={tab}>
        <section id="wp-content-list" className={`${cardClass} scroll-mt-4 overflow-hidden`} aria-labelledby="wp-content-list-title">
          <header className="border-b border-border/80 px-4 py-4 sm:px-5">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
              <div className="min-w-0">
                <h3 id="wp-content-list-title" className="font-semibold text-foreground">
                  {tab === "post" ? "نوشته‌های وردپرس" : "برگه‌های وردپرس"}
                </h3>
                <p id="wp-content-result-count" aria-live="polite" className="mt-1 text-xs text-muted-foreground">
                  {rows === null
                    ? "در حال خواندن فهرست…"
                    : appliedSearch
                      ? `${toPersianDigits(total)} نتیجه برای «${appliedSearch}»`
                      : `${toPersianDigits(total)} مورد`}
                </p>
              </div>
              <div className="flex w-full gap-2 sm:w-auto">
                <div className="relative min-w-0 flex-1 sm:w-72 sm:flex-none">
                  <SearchIcon
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-y-0 start-3 my-auto size-4 text-muted-foreground"
                  />
                  <input
                    type="search"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="جستجو در عنوان یا نامک"
                    aria-label="جستجو در محتوای وردپرس"
                    aria-describedby="wp-content-result-count"
                    className={cn(inputClass, "ps-9 pe-9")}
                  />
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  aria-label="تازه‌سازی فهرست"
                  title="تازه‌سازی فهرست"
                  disabled={rows === null}
                  onClick={refresh}
                >
                  <RefreshCwIcon aria-hidden="true" className="size-4" />
                </Button>
              </div>
            </div>
          </header>

          {rows === null ? (
            <LoadingSkeleton rows={5} label="در حال بارگذاری محتوای وردپرس" className="p-4 sm:p-5" />
          ) : listError ? (
            <div className="p-4 sm:p-5">
              <ErrorBox>{listError}</ErrorBox>
              <Button variant="outline" onClick={refresh}>
                <RefreshCwIcon aria-hidden="true" className="size-4" />
                تلاش دوباره
              </Button>
            </div>
          ) : rows.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-muted-foreground sm:px-5">
              {appliedSearch ? (
                <>
                  <p>برای این جستجو موردی پیدا نشد.</p>
                  <Button variant="outline" size="sm" className="mt-3" onClick={() => setSearch("")}>
                    پاک‌کردن جستجو
                  </Button>
                </>
              ) : (
                <p>هنوز محتوایی همگام نشده است. از دکمهٔ «همگام‌سازی» بالا استفاده کنید.</p>
              )}
            </div>
          ) : (
            <ul className="divide-y divide-border/80">
              {rows.map((row) => (
                <li key={row.remoteId} className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:px-5">
                  <div className="flex min-w-0 flex-1 items-start gap-3">
                    <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                      <FileTextIcon aria-hidden="true" className="size-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="break-words font-medium text-foreground">{row.title || `#${toPersianDigits(row.remoteId)}`}</p>
                      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                        <StatusBadge tone={statusTone(row.status)}>{STATUS_LABELS[row.status] ?? row.status}</StatusBadge>
                        {row.writeStatus ? (
                          <StatusBadge tone={row.writeStatus === "pending" || row.writeStatus === "processing" ? "active" : "danger"}>
                            {WRITE_STATUS_LABELS[row.writeStatus]}
                          </StatusBadge>
                        ) : null}
                        {row.authorName ? <span>{row.authorName}</span> : null}
                        {row.slug ? <span dir="auto" className="max-w-full truncate">/{row.slug}</span> : null}
                        <span>
                          {row.remoteUpdatedAt
                            ? formatJalali(row.remoteUpdatedAt, { withTime: true })
                            : "زمان ویرایش نامشخص"}
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className={cn("grid w-full gap-2 sm:w-auto", row.permalink && canManage ? "grid-cols-2" : "grid-cols-1")}>
                    {row.permalink ? (
                      <Button asChild variant="outline" size="sm" className="w-full">
                        <a href={row.permalink} target="_blank" rel="noopener noreferrer">
                          مشاهده
                          <ExternalLinkIcon aria-hidden="true" className="size-3" />
                        </a>
                      </Button>
                    ) : null}
                    {canManage ? (
                      <Button
                        variant="outline"
                        size="sm"
                        className="w-full"
                        disabled={isPaused || !postWriteSupported}
                        onClick={() => setEditing(row)}
                      >
                        <PencilIcon aria-hidden="true" className="size-3.5" />
                        ویرایش
                      </Button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}

          {!listError && rows !== null && totalPages > 1 ? (
            <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border/80 bg-muted/40 px-4 py-3 sm:px-5">
              <p className="text-xs text-muted-foreground">
                صفحهٔ {toPersianDigits(page)} از {toPersianDigits(totalPages)}
              </p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page <= 1 || rows === null}
                  onClick={() => changePage(page - 1)}
                >
                  <ChevronRightIcon aria-hidden="true" className="size-4" />
                  قبلی
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= totalPages || rows === null}
                  onClick={() => changePage(page + 1)}
                >
                  بعدی
                  <ChevronLeftIcon aria-hidden="true" className="size-4" />
                </Button>
              </div>
            </footer>
          ) : null}
        </section>
      </TabPanel>

      {editing ? (
        <PostEditor
          key={`${selectedId}-${tab}-${editing === "new" ? "new" : editing.remoteId}`}
          connectionId={selectedId}
          connectionMode={selectedConnection?.linkMode ?? "plugin"}
          lastContentSyncAt={selectedConnection?.lastContentSyncAt ?? null}
          type={tab}
          row={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={({ queued, alreadyApplied }) => {
            setEditing(null);
            setActionError("");
            if (alreadyApplied) {
              setNotice("این درخواست ایجاد قبلاً ثبت شده است؛ برای دریافت ردیف، فهرست را تازه‌سازی کنید.");
              refresh();
            } else if (queued) {
              setNotice("ذخیره در صف افزونه قرار گرفت. پس از اجرای بعدی افزونه، تغییر در فهرست نمایش داده می‌شود.");
              refresh();
            } else {
              setNotice("تغییر با موفقیت در وردپرس ذخیره شد.");
              refresh();
            }
          }}
        />
      ) : null}
    </div>
  );
}

function PostEditor({
  connectionId,
  connectionMode,
  lastContentSyncAt,
  type,
  row,
  onClose,
  onSaved,
}: {
  connectionId: string;
  connectionMode: ConnectionLite["linkMode"];
  lastContentSyncAt: string | null;
  type: ContentTab;
  row: ContentRow | null;
  onClose: () => void;
  onSaved: (outcome: { queued: boolean; alreadyApplied?: boolean }) => void;
}) {
  const [initial, setInitial] = useState<WpEditorValues | null>(
    row ? null : { editorTitle: "", content: "", excerpt: "", slug: "", status: "draft" },
  );
  const [values, setValues] = useState<WpEditorValues>(
    row
      ? { editorTitle: row.title, content: "", excerpt: "", slug: row.slug, status: row.status }
      : { editorTitle: "", content: "", excerpt: "", slug: "", status: "draft" },
  );
  const [contentEditable, setContentEditable] = useState(!row);
  const [loadError, setLoadError] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [expectedRemoteUpdatedAt, setExpectedRemoteUpdatedAt] = useState<string | null>(null);
  const [versionConflict, setVersionConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [createRequestId] = useState(() => (typeof crypto !== "undefined" ? crypto.randomUUID() : ""));

  useEffect(() => {
    if (!row) return;
    const controller = new AbortController();
    setInitial(null);
    setContentEditable(false);
    setLoadError("");
    const query = new URLSearchParams({ connectionId, type, id: row.remoteId });
    void api<{ row: ContentDetail; error?: string }>(
      `/api/integrations/wp-manager/content/posts?${query.toString()}`,
      { signal: controller.signal },
    ).then((response) => {
      if (response.aborted) return;
      if (!response.ok) {
        setLoadError(errorMessageOrRaw(response.data?.error) || "خواندن متن فعلی ممکن نشد.");
        return;
      }
      const detail = response.data.row;
      if (!detail || typeof detail !== "object") {
        setLoadError("پاسخ متن فعلی کامل نبود. دوباره تلاش کنید.");
        return;
      }
      const next = {
        editorTitle: detail.editorTitle ?? detail.title ?? "",
        content: detail.content ?? "",
        excerpt: detail.excerpt ?? "",
        slug: detail.slug ?? "",
        status: detail.status ?? "draft",
      };
      setContentEditable(detail.content !== null);
      setExpectedRemoteUpdatedAt(detail.remoteUpdatedAt ?? null);
      setVersionConflict(false);
      setInitial(next);
      setValues(next);
    });
    return () => controller.abort();
  }, [connectionId, type, row, loadAttempt]);

  const dirty = wpEditorIsDirty(initial, values);

  function setValue<K extends keyof WpEditorValues>(key: K, value: WpEditorValues[K]) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  function requestClose() {
    if (busy) return;
    if (dirty && !window.confirm("تغییرات ذخیره‌نشده رها شود؟")) return;
    onClose();
  }

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!initial || !dirty || !values.editorTitle.trim() || (row && !expectedRemoteUpdatedAt)) return;
    setBusy(true);
    setError("");

    const patch = wpEditorPatch(initial, values);

    const response = await api<{ error?: string; queued?: boolean; alreadyApplied?: boolean }>(
      "/api/integrations/wp-manager/content/posts",
      {
        method: "POST",
        body: JSON.stringify({
          connectionId,
          post_type: type,
          ...(row
            ? { id: row.remoteId, ...(expectedRemoteUpdatedAt ? { expectedRemoteUpdatedAt } : {}) }
            : { requestId: createRequestId }),
          ...patch,
        }),
      },
    );
    setBusy(false);
    if (!response.ok) {
      if (response.status === 409 && response.data?.error === "content_version_changed") {
        setVersionConflict(true);
        setError("این محتوا پس از بازشدن ویرایشگر در وردپرس تغییر کرده است. نسخهٔ تازه را بارگیری کنید و تغییرات خود را با آن تطبیق دهید.");
      } else {
        setError(errorMessageOrRaw(response.data?.error) || "ذخیرهٔ محتوا انجام نشد.");
      }
      return;
    }
    onSaved({ queued: Boolean(response.data.queued), alreadyApplied: Boolean(response.data.alreadyApplied) });
  }

  const typeLabel = type === "post" ? "نوشته" : "برگه";
  const unusualStatus = !["draft", "publish", "pending", "private"].includes(values.status);

  return (
    <Dialog open onOpenChange={(open) => (!open ? requestClose() : undefined)}>
      <DialogContent className="flex max-h-[calc(100dvh-1rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl lg:max-w-3xl">
        <form onSubmit={save} className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <DialogHeader className="shrink-0 border-b border-border/80 px-4 py-4 pe-12 sm:px-5 sm:pe-12">
            <DialogTitle className="font-sans text-lg font-semibold">
              {row ? `ویرایش ${typeLabel}` : `${typeLabel}ٔ تازه`}
            </DialogTitle>
            <DialogDescription>
              {row
                ? `متن ذخیره‌شدهٔ «${row.title || `#${toPersianDigits(row.remoteId)}`}» بارگذاری می‌شود تا هیچ بخشی ناخواسته پاک نشود.`
                : `یک ${typeLabel}ٔ تازه ابتدا به‌صورت پیش‌نویس ساخته می‌شود، مگر اینکه وضعیت دیگری انتخاب کنید.`}
            </DialogDescription>
          </DialogHeader>

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-5">
            {initial === null && !loadError ? (
              <LoadingSkeleton
                rows={5}
                label="در حال خواندن متن فعلی از نسخهٔ همگام‌شده"
                className="min-h-64"
              />
            ) : loadError ? (
              <div className="min-h-64">
                <ErrorBox>{loadError}</ErrorBox>
                <p className="mb-4 text-xs leading-5 text-muted-foreground">
                  تا متن فعلی کامل خوانده نشود، ویرایش فعال نمی‌شود؛ این کار از پاک‌شدن ناخواستهٔ نوشته جلوگیری می‌کند.
                </p>
                <Button type="button" variant="outline" onClick={() => setLoadAttempt((value) => value + 1)}>
                  <RefreshCwIcon aria-hidden="true" className="size-4" />
                  تلاش دوباره
                </Button>
              </div>
            ) : (
              <>
                <Field label="عنوان">
                  <input
                    autoFocus={!row}
                    className={inputClass}
                    value={values.editorTitle}
                    maxLength={500}
                    required
                    disabled={busy}
                    onChange={(event) => setValue("editorTitle", event.target.value)}
                  />
                </Field>
                <div className="grid gap-x-4 sm:grid-cols-2">
                  <Field label="نامک" hint="بخش پایانی آدرس؛ خالی بگذارید تا وردپرس آن را بسازد.">
                    <input
                      dir="ltr"
                      className={cn(inputClass, "text-left")}
                      value={values.slug}
                      maxLength={200}
                      disabled={busy}
                      onChange={(event) => setValue("slug", event.target.value)}
                      placeholder="about-us"
                    />
                  </Field>
                  <Field label="وضعیت">
                    <select
                      className={inputClass}
                      value={values.status}
                      disabled={busy}
                      onChange={(event) => setValue("status", event.target.value)}
                    >
                      {unusualStatus ? (
                        <option value={values.status} disabled>{STATUS_LABELS[values.status] ?? values.status}</option>
                      ) : null}
                      <option value="draft">پیش‌نویس</option>
                      <option value="publish">منتشرشده</option>
                      <option value="pending">در انتظار بررسی</option>
                      <option value="private">خصوصی</option>
                    </select>
                  </Field>
                </div>
                <Field label="خلاصه" hint="اختیاری؛ ممکن است قالب سایت آن را در فهرست نوشته‌ها نمایش دهد.">
                  <textarea
                    className={cn(inputClass, "h-auto min-h-24 py-2 leading-6")}
                    value={values.excerpt}
                    maxLength={20_000}
                    disabled={busy}
                    onChange={(event) => setValue("excerpt", event.target.value)}
                  />
                </Field>
                <Field
                  label="محتوا (HTML / بلوک‌های وردپرس)"
                  hint={
                    contentEditable
                      ? "کد HTML، شورت‌کدها و نشانه‌های بلوک وردپرس همان‌طور که ذخیره شده‌اند نگه داشته می‌شوند."
                      : "متن خام این مورد از وردپرس دریافت نشده است؛ برای جلوگیری از بازنویسی ناخواسته، فقط عنوان، نامک، خلاصه و وضعیت قابل تغییرند."
                  }
                >
                  <textarea
                    dir="auto"
                    className={cn(inputClass, "h-auto min-h-[16rem] resize-y py-3 leading-7 sm:min-h-[22rem]")}
                    value={values.content}
                    maxLength={1_500_000}
                    disabled={busy || !contentEditable}
                    spellCheck
                    onChange={(event) => setValue("content", event.target.value)}
                    placeholder={contentEditable ? "متن نوشته یا برگه…" : "متن خام در دسترس نیست"}
                  />
                </Field>
                <ErrorBox>{error}</ErrorBox>
                {row && !expectedRemoteUpdatedAt ? (
                  <div className="mb-3"><InfoBox>نسخهٔ این مورد مشخص نیست. برای جلوگیری از بازنویسی تغییرات هم‌زمان، ابتدا همگام‌سازی را اجرا کنید.</InfoBox></div>
                ) : null}
                {versionConflict ? (
                  <Button
                    type="button"
                    variant="outline"
                    className="mb-3"
                    onClick={() => {
                      if (dirty && !window.confirm("بارگیری نسخهٔ تازه، تغییرات ذخیره‌نشدهٔ شما را جایگزین می‌کند. ادامه می‌دهید؟")) return;
                      setInitial(null);
                      setError("");
                      setVersionConflict(false);
                      setLoadAttempt((value) => value + 1);
                    }}
                  >
                    <RefreshCwIcon aria-hidden="true" className="size-4" />
                    بارگیری نسخهٔ تازه
                  </Button>
                ) : null}
                {connectionMode === "plugin" ? (
                  <div className="space-y-2">
                    <InfoBox>
                      نسخهٔ محلی از آخرین همگام‌سازی افزونه{lastContentSyncAt ? ` در ${formatJalali(lastContentSyncAt, { withTime: true })}` : ""} است؛ ممکن است تغییرات جدید سایت هنوز در آینهٔ محلی نباشد. پیش از ویرایش موردی که احتمال تغییر هم‌زمان دارد، همگام‌سازی کنید.
                    </InfoBox>
                    <p className="text-xs leading-5 text-muted-foreground">
                      این اتصال با افزونه کار می‌کند؛ ذخیره در صف قرار می‌گیرد و پس از اجرای افزونه به سایت می‌رسد.
                    </p>
                  </div>
                ) : (
                  <p className="text-xs leading-5 text-muted-foreground">
                    این اتصال مستقیم است؛ پیش از ذخیره نسخهٔ فعلی در سایت بررسی می‌شود و پس از ذخیره، پاسخ وردپرس همان لحظه در فهرست منعکس می‌شود.
                  </p>
                )}
              </>
            )}
          </div>

          <DialogFooter className="mx-0 mb-0 shrink-0 rounded-none px-4 py-3 sm:px-5">
            <Button type="button" variant="outline" disabled={busy} onClick={requestClose}>
              انصراف
            </Button>
            <Button
              type="submit"
              disabled={busy || initial === null || !dirty || !values.editorTitle.trim() || Boolean(row && !expectedRemoteUpdatedAt)}
              aria-busy={busy}
            >
              {busy ? "در حال ذخیره…" : "ذخیره در وردپرس"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
