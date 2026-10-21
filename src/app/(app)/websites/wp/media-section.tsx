"use client";

/**
 * WordPress media mirrored from one connected store. The section browses a
 * paged local mirror (rather than hot-reading WordPress on every visit) and
 * requests a full content export when the owner asks to sync.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ExternalLinkIcon,
  FileTextIcon,
  ImageIcon,
  ImageOffIcon,
  ImagePlusIcon,
  Music2Icon,
  RefreshCwIcon,
  SearchIcon,
  VideoIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  api,
  ErrorBox,
  errorMessageOrRaw,
  InfoBox,
  inputClass,
} from "@/app/dashboard/ui";
import {
  EmptyState,
  SectionCard,
  SectionCardSkeleton,
} from "@/app/dashboard/page-chrome";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import {
  WP_MEDIA_KINDS,
  WP_MEDIA_TITLE_MAX,
  wpMediaKindForMime,
  type WpMediaKind,
} from "@/lib/integrations/wp-media";
import { pluginSupportsJobType } from "@/lib/integrations/plugin-capabilities";
import { WpMediaBulkActions } from "./media-bulk-actions";
import { WpMediaDetailDialog } from "./media-detail-dialog";
import { WpMediaLibraryPanel } from "./media-library-panel";
import { ConnectionPicker } from "./connection-lite";
import { PluginWaitNote } from "./plugin-wait-note";
import { useWpStore } from "./wp-store-context";
import { FilterChip } from "@/app/dashboard/filters";

interface MediaRow {
  remoteId: string;
  title: string;
  slug: string;
  mediaUrl: string | null;
  mimeType: string | null;
  thumbnailUrl?: string | null;
  revision?: string | null;
  altText: string;
  remoteUpdatedAt: string | null;
}

interface MediaResponse {
  rows: MediaRow[];
  total: number;
  limit: number;
  offset: number;
  syncedAt: string | null;
  error?: string;
  nextCursor?: string | null;
}

const PAGE_SIZE = 24;

const KIND_LABELS: Record<WpMediaKind, string> = {
  all: "همه",
  image: "تصویرها",
  video: "ویدئوها",
  audio: "فایل‌های صوتی",
  document: "سندها و فایل‌ها",
};

const KIND_SINGULAR_LABELS: Record<Exclude<WpMediaKind, "all">, string> = {
  image: "تصویر",
  video: "ویدئو",
  audio: "فایل صوتی",
  document: "سند یا فایل",
};

function MediaGallerySkeleton() {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label="در حال بارگذاری رسانه‌های فروشگاه"
      className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-6"
    >
      {Array.from({ length: 8 }, (_, index) => (
        <div
          key={index}
          aria-hidden="true"
          className="overflow-hidden rounded-xl border border-border"
        >
          <Skeleton className="aspect-square w-full rounded-none" />
          <div className="space-y-2 p-3">
            <Skeleton className="h-3.5 w-4/5" />
            <Skeleton className="h-3 w-3/5" />
            <Skeleton className="h-11 w-full rounded-lg" />
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyMedia({
  filtered,
  onClear,
}: {
  filtered: boolean;
  onClear: () => void;
}) {
  return (
    <div className="flex flex-col items-center rounded-xl border border-dashed border-border px-4 py-10 text-center">
      <span className="grid size-12 place-items-center rounded-2xl bg-amber-100/70 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">
        <ImageIcon aria-hidden="true" className="size-6" />
      </span>
      <h3 className="mt-3 text-sm font-semibold text-foreground">
        {filtered
          ? "رسانه‌ای با این فیلتر پیدا نشد"
          : "هنوز رسانه‌ای همگام نشده است"}
      </h3>
      <p className="mt-1 max-w-lg text-xs leading-5 text-muted-foreground">
        {filtered
          ? "عبارت جستجو یا نوع فایل را تغییر دهید تا نتیجه‌های دیگر نمایش داده شوند."
          : "با «همگام‌سازی با وردپرس»، کتابخانهٔ فایل فروشگاه درخواست و پس از دریافت در این بخش نمایش داده می‌شود."}
      </p>
      {filtered ? (
        <Button className="mt-4" variant="outline" onClick={onClear}>
          پاک‌کردن فیلترها
        </Button>
      ) : null}
    </div>
  );
}

function MediaPreview({ row }: { row: MediaRow }) {
  const [failed, setFailed] = useState(false);
  const kind = wpMediaKindForMime(row.mimeType);
  const Icon =
    kind === "video"
      ? VideoIcon
      : kind === "audio"
        ? Music2Icon
        : kind === "document"
          ? FileTextIcon
          : ImageIcon;

  if (kind === "image" && row.mediaUrl && !failed) {
    return (
      // WordPress hosts are dynamic, so Next/Image cannot know their domains.

      <img
        src={row.thumbnailUrl || row.mediaUrl}
        alt=""
        className="size-full object-cover"
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
      />
    );
  }

  const FallbackIcon = failed ? ImageOffIcon : Icon;
  return (
    <div
      role="img"
      aria-label={
        failed ? "پیش‌نمایش تصویر در دسترس نیست" : KIND_SINGULAR_LABELS[kind]
      }
      className="flex size-full flex-col items-center justify-center gap-2 bg-muted/70 px-2 text-center text-muted-foreground"
    >
      <FallbackIcon aria-hidden="true" className="size-8" />
      {failed ? (
        <span className="text-[10px] leading-4">پیش‌نمایش در دسترس نیست</span>
      ) : null}
    </div>
  );
}

function MediaTile({ row, onOpen }: { row: MediaRow; onOpen: () => void }) {
  const kind = wpMediaKindForMime(row.mimeType);
  const rawTitle = row.title.trim();
  const generatedTitle = rawTitle === `attachment #${row.remoteId}`;
  const title =
    generatedTitle || !rawTitle
      ? `رسانهٔ ${toPersianDigits(row.remoteId)}`
      : toPersianDigits(rawTitle);

  return (
    <article className="min-w-0 overflow-hidden rounded-xl border border-border bg-card">
      <div className="aspect-square overflow-hidden bg-muted/70">
        <MediaPreview row={row} />
      </div>
      <div className="p-3">
        <h3
          className="truncate text-sm font-medium text-foreground"
          title={title}
        >
          {title}
        </h3>
        <p className="mt-1 truncate text-[11px] text-muted-foreground">
          {KIND_SINGULAR_LABELS[kind]}
          {row.mimeType ? ` • ${toPersianDigits(row.mimeType)}` : ""}
        </p>
        {row.remoteUpdatedAt ? (
          <p className="mt-1 text-[11px] tabular-nums text-muted-foreground">
            به‌روزرسانی: {formatJalali(row.remoteUpdatedAt, { withTime: true })}
          </p>
        ) : null}
        {row.altText ? (
          <p className="mt-1 line-clamp-2 text-[11px] leading-5 text-muted-foreground">
            متن جایگزین: {row.altText}
          </p>
        ) : null}
        <Button className="mt-2 w-full" variant="outline" onClick={onOpen}>جزئیات و مدیریت پیوست</Button>
        {row.mediaUrl ? (
          <Button asChild variant="outline" size="lg" className="mt-3 w-full">
            <a href={row.mediaUrl} target="_blank" rel="noopener noreferrer">
              باز کردن فایل
              <ExternalLinkIcon aria-hidden="true" className="size-3.5" />
            </a>
          </Button>
        ) : (
          <p className="mt-3 flex min-h-11 items-center justify-center rounded-lg bg-muted px-2 text-center text-[11px] text-muted-foreground">
            نشانی فایل در دسترس نیست
          </p>
        )}
      </div>
    </article>
  );
}

export function WpMediaSection({ canManage = false, canUseCanonical = false }: { canManage?: boolean; canUseCanonical?: boolean }) {
  const { connections, selectedId, setSelectedId } = useWpStore();
  const [selectedRows, setSelectedRows] = useState<Set<string>>(new Set());
  const [detailId, setDetailId] = useState<string | null>(null);
  const [rows, setRows] = useState<MediaRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [syncedAt, setSyncedAt] = useState<string | null>(null);
  const [searchInput, setSearchInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [kind, setKind] = useState<WpMediaKind>("all");
  const [loadingMore, setLoadingMore] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [syncError, setSyncError] = useState("");
  const [notice, setNotice] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [addUrl, setAddUrl] = useState("");
  const [addTitle, setAddTitle] = useState("");
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState("");
  const nextCursorRef = useRef<string | null>(null);
  const listAbortRef = useRef<AbortController | null>(null);
  const listRequestRef = useRef(0);
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;

  useEffect(() => {
    const handle = window.setTimeout(
      () => setSearchQuery(searchInput.trim()),
      300,
    );
    return () => window.clearTimeout(handle);
  }, [searchInput]);

  const load = useCallback(
    async (connectionId: string, offset = 0, append = false) => {
      if (!connectionId) return;
      listAbortRef.current?.abort();
      const controller = new AbortController();
      const request = ++listRequestRef.current;
      listAbortRef.current = controller;
      setLoadError("");
      setLoadingMore(append);
      if (!append) { setRows(null); nextCursorRef.current = null; }

      const params = new URLSearchParams({
        connectionId,
        type: "attachment",
        kind,
        limit: String(PAGE_SIZE),
        offset: String(offset),
        cursorMode: "1",
      });
      if (append && nextCursorRef.current) params.set("cursor", nextCursorRef.current);
      if (searchQuery) params.set("search", searchQuery);
      const response = await api<MediaResponse>(
        `/api/integrations/wp-manager/content?${params}`,
        {
          signal: controller.signal,
        },
      );
      if (response.aborted || request !== listRequestRef.current) return;
      setLoadingMore(false);
      if (!response.ok) {
        if (!append) setRows([]);
        setLoadError(
          errorMessageOrRaw(response.data?.error) ||
            "خواندن رسانه‌های فروشگاه ناموفق بود.",
        );
        return;
      }

      setRows((current) => {
        if (!append || !current) return response.data.rows;
        const byId = new Map(current.map((row) => [row.remoteId, row]));
        for (const row of response.data.rows) byId.set(row.remoteId, row);
        return [...byId.values()];
      });
      nextCursorRef.current = response.data.nextCursor ?? null;
      setTotal(response.data.nextCursor ? response.data.total : (append ? offset : 0) + response.data.rows.length);
      setSyncedAt(response.data.syncedAt);
    },
    [kind, searchQuery],
  );

  useEffect(() => {
    if (selectedId) void load(selectedId);
    return () => listAbortRef.current?.abort();
  }, [selectedId, load]);

  useEffect(() => {
    // A result message belongs to the store that produced it. Keeping it on
    // screen after the picker moves to another store is actively misleading.
    setNotice("");
    setSyncError("");
    // The add form too: a half-typed URL for store A must not queue on store B.
    setSelectedRows(new Set());
    setDetailId(null);
    setAddOpen(false);
    setAddUrl("");
    setAddTitle("");
    setAddError("");
  }, [selectedId]);

  async function syncContent() {
    if (!selectedId) return;
    const connectionId = selectedId;
    setSyncBusy(true);
    setSyncError("");
    setNotice("");
    const response = await api<{
      queued?: boolean;
      total?: number;
      error?: string;
    }>("/api/integrations/wp-manager/content", {
      method: "POST",
      body: JSON.stringify({ connectionId }),
    });
    setSyncBusy(false);
    if (connectionId !== selectedIdRef.current) return;
    if (!response.ok) {
      setSyncError(
        errorMessageOrRaw(response.data?.error) ||
          "همگام‌سازی رسانه‌ها ناموفق بود.",
      );
      return;
    }

    if (response.data.queued) {
      setNotice(
        "درخواست بازخوانی در صف قرار گرفت. افزونه پس از ارسال کامل کتابخانه، زمان آخرین همگام‌سازی را به‌روز می‌کند؛ برای دیدن فایل‌های رسیده «تازه‌سازی فهرست» را بزنید.",
      );
      return;
    }

    setNotice(
      `همگام‌سازی انجام شد و ${toPersianDigits(response.data.total ?? 0)} مورد از وردپرس دریافت شد.`,
    );
    await load(connectionId);
  }

  async function submitAddMedia() {
    if (!selectedId || addBusy) return;
    const connectionId = selectedId;
    setAddBusy(true);
    setAddError("");
    setNotice("");
    const response = await api<{ queued?: boolean; error?: string }>(
      "/api/integrations/wp-manager/media",
      {
        method: "POST",
        body: JSON.stringify({ connectionId, url: addUrl.trim(), title: addTitle.trim() || undefined }),
      },
    );
    setAddBusy(false);
    if (connectionId !== selectedIdRef.current) return;
    if (!response.ok) {
      setAddError(errorMessageOrRaw(response.data?.error) || "افزودن رسانه ناموفق بود.");
      return;
    }
    setAddOpen(false);
    setAddUrl("");
    setAddTitle("");
    setNotice(
      "درخواست افزودن تصویر در صف قرار گرفت؛ افزونهٔ وردپرس در اجرای بعدی آن را از نشانی داده‌شده دریافت و در کتابخانهٔ سایت ثبت می‌کند. پس از آن، فایل در همین فهرست ظاهر می‌شود.",
    );
  }

  function clearFilters() {
    setSearchInput("");
    setSearchQuery("");
    setKind("all");
  }

  if (connections === null)
    return (
      <SectionCardSkeleton rows={6} label="در حال خواندن فروشگاه‌های متصل" />
    );

  if (connections.length === 0) {
    return (
      <SectionCard
        title="کتابخانهٔ رسانه‌های وردپرس"
        description="تصاویر، ویدئوها، فایل‌های صوتی و سندهای سایت در این بخش دیده می‌شوند."
      >
        <EmptyState>هنوز فروشگاه وردپرسی متصل نشده است.</EmptyState>
        <Button asChild className="mt-4">
          <Link href="/settings/connections?tab=woocommerce">
            اتصال فروشگاه
          </Link>
        </Button>
      </SectionCard>
    );
  }

  const filtered = Boolean(searchQuery) || kind !== "all";
  const shown = rows?.length ?? 0;

  // Capability-driven: the add action exists only where the transport can
  // actually perform it — a plugin connection whose handshake advertised
  // `media_create`. A REST store (wp/v2 has no sideload-by-URL) and an older
  // plugin are simply not offered the button, rather than shown one that fails.
  const selectedConnection = connections.find((connection) => connection.id === selectedId) ?? null;
  const canAddMedia =
    canManage && selectedConnection?.status !== "paused" &&
    selectedConnection?.linkMode === "plugin" &&
    pluginSupportsJobType(selectedConnection.pluginCapabilities ?? null, "media_create");

  return (
    <div className="space-y-4 sm:space-y-5">
      {detailId && selectedId ? <WpMediaDetailDialog key={`${selectedId}:${detailId}`} remoteId={detailId} connectionId={selectedId} siteName={selectedConnection?.name ?? selectedId} canManage={canManage} onClose={() => setDetailId(null)} /> : null}
      {selectedId ? <WpMediaLibraryPanel allowCanonical={canUseCanonical} key={selectedId} connectionId={selectedId} siteName={selectedConnection?.name ?? selectedId} canPush={canAddMedia} /> : null}
      <SectionCard
        title="کتابخانهٔ رسانه‌های وردپرس"
        description={
          canAddMedia
            ? "فایل‌های همگام‌شدهٔ سایت را مرور کنید؛ افزودن تصویر JPEG، PNG، GIF یا WebP از نشانی اینترنتی پشتیبانی می‌شود."
            : "فایل‌های همگام‌شدهٔ سایت را جستجو و بر اساس نوع مرور کنید. این صفحه فایل‌ها را تغییر یا حذف نمی‌کند."
        }
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" asChild><Link href="/media">کتابخانهٔ اصلی و بارگذاری فایل</Link></Button>
            <Button variant="outline" asChild><Link href={`/websites/wp/queue?store=${encodeURIComponent(selectedId)}`}>وضعیت صف و تلاش دوباره</Link></Button>
            {canAddMedia ? (
              <Button
                variant="outline"
                aria-expanded={addOpen}
                disabled={!selectedId}
                onClick={() => {
                  setAddError("");
                  setAddOpen((open) => !open);
                }}
              >
                <ImagePlusIcon aria-hidden="true" className="size-4" />
                افزودن تصویر از نشانی
              </Button>
            ) : null}
            <Button
              variant="outline"
              disabled={!selectedId || rows === null || loadingMore}
              onClick={() => void load(selectedId)}
            >
              <RefreshCwIcon aria-hidden="true" className="size-4" />
              تازه‌سازی فهرست
            </Button>
            <Button
              disabled={!canManage || !selectedId || syncBusy || selectedConnection?.status === "paused"}
              onClick={() => void syncContent()}
            >
              <RefreshCwIcon aria-hidden="true" className="size-4" />
              {syncBusy ? "در حال درخواست…" : "همگام‌سازی با وردپرس"}
            </Button>
          </div>
        }
      >
        <ConnectionPicker
          embedded
          connections={connections}
          value={selectedId}
          onChange={setSelectedId}
        />
        <div className="mt-4 grid gap-4 border-t border-border/80 pt-4 lg:grid-cols-[minmax(16rem,1fr)_minmax(0,2fr)] lg:items-end">
          <div>
            <label
              htmlFor="wp-media-search"
              className="mb-1.5 block text-sm font-medium text-foreground"
            >
              جستجو در رسانه‌ها
            </label>
            <div className="relative">
              <SearchIcon
                aria-hidden="true"
                className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <input
                id="wp-media-search"
                type="search"
                className={`${inputClass} ps-9`}
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
                placeholder="عنوان، نامک یا نوع فایل…"
                aria-label="جستجوی عنوان، نامک یا نوع فایل"
              />
            </div>
          </div>
          <div>
            <p className="mb-1.5 text-sm font-medium text-foreground">
              نوع فایل
            </p>
            <div
              className="flex flex-wrap gap-2"
              role="group"
              aria-label="فیلتر نوع رسانه"
            >
              {WP_MEDIA_KINDS.map((value) => (
                <FilterChip
                  key={value}
                  selected={kind === value}
                  onClick={() => setKind(value)}
                >
                  {KIND_LABELS[value]}
                </FilterChip>
              ))}
            </div>
          </div>
        </div>
        {canAddMedia && addOpen ? (
          <form
            className="mt-4 space-y-3 rounded-xl border border-border bg-muted/40 p-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submitAddMedia();
            }}
          >
            <p className="text-xs leading-5 text-muted-foreground">
              نشانی عمومی یک تصویر را وارد کنید؛ خود سایت وردپرس فایل را از این نشانی دریافت و در
              کتابخانه‌اش ثبت می‌کند. عملیات در صف افزونه قرار می‌گیرد و معمولاً ظرف چند دقیقه انجام می‌شود.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label htmlFor="wp-media-add-url" className="mb-1.5 block text-sm font-medium text-foreground">
                  نشانی فایل تصویر
                </label>
                <input
                  id="wp-media-add-url"
                  type="url"
                  dir="ltr"
                  required
                  className={inputClass}
                  value={addUrl}
                  onChange={(event) => setAddUrl(event.target.value)}
                  placeholder="https://example.com/banner.jpg"
                  disabled={addBusy}
                />
              </div>
              <div>
                <label htmlFor="wp-media-add-title" className="mb-1.5 block text-sm font-medium text-foreground">
                  عنوان (اختیاری)
                </label>
                <input
                  id="wp-media-add-title"
                  type="text"
                  className={inputClass}
                  value={addTitle}
                  maxLength={WP_MEDIA_TITLE_MAX}
                  onChange={(event) => setAddTitle(event.target.value)}
                  placeholder="مثلاً بنر تخفیف پاییزی"
                  disabled={addBusy}
                />
              </div>
            </div>
            <ErrorBox>{addError}</ErrorBox>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={addBusy || !addUrl.trim()}>
                {addBusy ? "در حال ثبت…" : "افزودن به صف افزونه"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={addBusy}
                onClick={() => {
                  setAddOpen(false);
                  setAddError("");
                }}
              >
                انصراف
              </Button>
            </div>
          </form>
        ) : null}
      </SectionCard>

      <PluginWaitNote connections={connections} selectedId={selectedId} />
      <InfoBox>{notice}</InfoBox>
      <ErrorBox>{syncError}</ErrorBox>

      <SectionCard
        title="فایل‌های همگام‌شده"
        description={
          rows === null
            ? "در حال آماده‌سازی کتابخانه"
            : `${toPersianDigits(total)} نتیجه${syncedAt ? ` • آخرین همگام‌سازی ${formatJalali(syncedAt, { withTime: true })}` : " • هنوز همگام‌سازی کامل ثبت نشده است"}`
        }
      >
        {loadError && rows !== null && rows.length === 0 ? (
          <div>
            <ErrorBox>{loadError}</ErrorBox>
            <Button variant="outline" onClick={() => void load(selectedId)}>
              تلاش دوباره
            </Button>
          </div>
        ) : rows === null ? (
          <MediaGallerySkeleton />
        ) : rows.length === 0 ? (
          <EmptyMedia filtered={filtered} onClear={clearFilters} />
        ) : (
          <>
            <WpMediaBulkActions key={selectedId} connectionId={selectedId} items={rows.filter((row) => selectedRows.has(row.remoteId))} canManage={canManage && selectedConnection?.status !== "paused" && pluginSupportsJobType(selectedConnection?.pluginCapabilities, "media_update")} canTrash={selectedConnection?.pluginCapabilities?.mediaTrash === true} />
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-6">
              {rows.map((row) => (
                <div key={row.remoteId}>
                  <label className="mb-1 flex min-h-11 items-center gap-2 text-xs"><input type="checkbox" checked={selectedRows.has(row.remoteId)} disabled={!selectedRows.has(row.remoteId) && selectedRows.size >= 20} onChange={(e) => setSelectedRows((current) => { const next = new Set(current); if (e.target.checked) next.add(row.remoteId); else next.delete(row.remoteId); return next; })} />انتخاب {row.title}</label>
                  <MediaTile row={row} onOpen={() => setDetailId(row.remoteId)} />
                </div>
              ))}
            </div>
            {loadError ? (
              <div className="mt-5 border-t border-border/80 pt-4">
                <ErrorBox>{loadError}</ErrorBox>
                <Button
                  variant="outline"
                  onClick={() => void load(selectedId, shown, true)}
                >
                  تلاش دوباره برای ادامهٔ فهرست
                </Button>
              </div>
            ) : shown < total ? (
              <div className="mt-5 flex flex-col items-center gap-2 border-t border-border/80 pt-4">
                <p className="text-xs text-muted-foreground">
                  نمایش {toPersianDigits(shown)} از {toPersianDigits(total)}{" "}
                  فایل
                </p>
                <Button
                  variant="outline"
                  disabled={loadingMore}
                  onClick={() => void load(selectedId, shown, true)}
                >
                  {loadingMore ? "در حال دریافت…" : "نمایش فایل‌های بیشتر"}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </SectionCard>
    </div>
  );
}
