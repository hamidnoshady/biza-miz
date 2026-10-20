"use client";

/**
 * The WP Manager میز کار: connection picker, sync watermarks, KPI tiles for
 * the mirrored catalogue/orders/customers/content, and quick actions
 * (همگام‌سازی) per connection. All numbers come from local mirrors so the
 * page behaves identically in plugin and REST link modes.
 *
 * Issue #944 made the page tell the truth in five places:
 *  - a failed store-list read is an error with a retry, never «هنوز فروشگاهی
 *    متصل نیست» (that copy needs a successful, empty list — OVR-02);
 *  - the queue tiles use the Queue page's own classification, so the inbound
 *    backlog and `needs_review` rows count (OVR-03);
 *  - a sync reply is `completed | queued | partial | failed` from the response,
 *    and a partial one names the failed step and offers it on its own (OVR-04);
 *  - the KPI read has its own loading/error/last-updated state, refreshes on
 *    the response rather than a fixed timer, and polls a queued sync until the
 *    store's watermark moves (OVR-06);
 *  - configured status and transport health are two badges, and each sync
 *    button is live only when this store, plugin and member allow it (OVR-07,
 *    OVR-08).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  PlugIcon,
  ShoppingBagIcon,
  ReceiptTextIcon,
  ContactIcon,
  FolderTreeIcon,
  FileTextIcon,
  ImageIcon,
  RefreshCwIcon,
  AlertTriangleIcon,
  ClockIcon,
} from "lucide-react";
import { api } from "@/app/dashboard/ui";
import { cardClass, EmptyState, SectionCard, SectionCardSkeleton, StatusBadge } from "@/app/dashboard/page-chrome";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import type { WpOverviewStats } from "@/lib/integrations/wp-manager-service";
import type { WpAbility } from "@/lib/wp-access";
import { PluginWaitNote } from "./plugin-wait-note";
import { useWpStore, type WpManagerConnection } from "./wp-store-context";
import { WpStoreRefreshError } from "./wp-store-states";
import {
  classifySyncResponse,
  describeSyncOutcome,
  storeDisplayName,
  SYNC_LABELS,
  syncAvailability,
  transportHealthPresentation,
  type SyncKind,
  type SyncOutcomeText,
} from "./wp-sync-status";

/** How often a queued (plugin-mode) sync is re-checked, and for how long. The plugin's fast lane runs every five minutes. */
const QUEUED_POLL_INTERVAL_MS = 60_000;
const QUEUED_POLL_MAX_MS = 15 * 60_000;

function syncNow(connectionId: string, kind: SyncKind) {
  if (kind === "content") {
    return api<Record<string, unknown>>(`/api/integrations/wp-manager/content`, {
      method: "POST",
      body: JSON.stringify({ connectionId }),
    });
  }
  return api<Record<string, unknown>>(`/api/integrations/connections/${connectionId}/sync/${kind}`, { method: "POST" });
}

/** The watermark a given sync moves when it has really run. */
function watermarkFor(connection: WpManagerConnection | null, kind: SyncKind): string | null {
  if (!connection) return null;
  switch (kind) {
    case "products":
      return connection.lastCatalogueSyncAt ?? null;
    case "orders":
      return connection.lastOrderSyncAt ?? null;
    case "customers":
      return connection.lastCustomerSyncAt ?? null;
    case "content":
      return connection.lastContentSyncAt ?? null;
  }
}

/** A tile number the way the rest of the dashboard shows numbers: grouped. */
function tileNumber(value: number | string | null | undefined): string {
  if (value === null || value === undefined) return "…";
  if (typeof value === "number") return value.toLocaleString("fa-IR");
  return toPersianDigits(value);
}

function Kpi({
  icon: Icon,
  label,
  value,
  href,
  tone = "default",
  hint,
}: {
  icon: typeof PlugIcon;
  label: string;
  value: number | string | null | undefined;
  href?: string;
  tone?: "default" | "warn";
  hint?: string;
}) {
  const body = (
    <div className={`${cardClass} flex items-center gap-3 p-4 transition-colors hover:bg-muted/60 dark:hover:bg-stone-900/40 sm:p-5`}>
      <span
        className={`flex size-11 shrink-0 items-center justify-center rounded-xl ${
            tone === "warn" ? "bg-red-50 text-red-600 dark:bg-red-500/15 dark:text-red-300" : "bg-teal-50 text-teal-700 dark:bg-teal-500/15 dark:text-teal-300"
        }`}
      >
        <Icon className="size-5" />
      </span>
      <div className="min-w-0">
        <p className="text-2xl font-bold tabular-nums text-foreground">{tileNumber(value)}</p>
        <p className="truncate text-xs text-muted-foreground">{label}</p>
        {hint ? <p className="truncate text-[11px] text-muted-foreground/80">{hint}</p> : null}
      </div>
    </div>
  );
  return href ? (
    <Link href={href} className="block rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-400/40">
      {body}
    </Link>
  ) : (
    body
  );
}

function SyncRow({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium text-foreground/80">{value ? formatJalali(value, { withTime: true }) : "—"}</span>
    </div>
  );
}

type StatsState =
  | { phase: "loading"; stats: WpOverviewStats | null; updatedAt: string | null }
  | { phase: "loaded"; stats: WpOverviewStats; updatedAt: string }
  | { phase: "error"; stats: WpOverviewStats | null; updatedAt: string | null; status: number; code: string };

const NOTICE_CLASS: Record<SyncOutcomeText["tone"], string> = {
  positive: "bg-emerald-50 text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-200",
  neutral: "bg-teal-50 text-teal-900 dark:bg-teal-500/10 dark:text-teal-200",
  warn: "bg-amber-50 text-amber-900 dark:bg-amber-500/10 dark:text-amber-200",
  danger: "bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300",
};

export function WpOverviewSection() {
  const {
    connections,
    loadState,
    loadError,
    setSelectedId,
    selectedConnection: selected,
    reloadConnections,
    can,
  } = useWpStore();
  const [statsState, setStatsState] = useState<StatsState>({ phase: "loading", stats: null, updatedAt: null });
  const [busy, setBusy] = useState<SyncKind | null>(null);
  const [notice, setNotice] = useState<(SyncOutcomeText & { storeId: string; kind: SyncKind }) | null>(null);
  const [awaiting, setAwaiting] = useState<{ storeId: string; kind: SyncKind; since: string | null; startedAt: number } | null>(null);
  const selectedId = selected?.id ?? "";
  const statsRequest = useRef(0);
  // The store on screen *now* — a sync that started on store A must not
  // refresh (and so overwrite) store B's numbers when its reply lands.
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  // Bumped after every poll pass so the effect below re-arms even when a
  // transient reload failure leaves `selected` and `awaiting` unchanged.
  const [pollTick, setPollTick] = useState(0);

  // One stats fetch per selected connection — never a business-wide one
  // racing it. Each read takes a generation; a response from an older read
  // (a slow first store after a quick switch) is dropped.
  const loadStats = useCallback(
    async (storeId: string, { keep }: { keep: boolean }) => {
      const generation = ++statsRequest.current;
      setStatsState((prev) => ({ phase: "loading", stats: keep ? prev.stats : null, updatedAt: keep ? prev.updatedAt : null }));
      const res = await api<{ stats: WpOverviewStats; error?: string }>(`/api/integrations/wp-manager/overview?connectionId=${storeId}`);
      if (generation !== statsRequest.current) return;
      if (!res.ok) {
        setStatsState((prev) => ({
          phase: "error",
          stats: keep ? prev.stats : null,
          updatedAt: keep ? prev.updatedAt : null,
          status: res.status,
          code: String(res.data?.error ?? ""),
        }));
        return;
      }
      setStatsState({ phase: "loaded", stats: res.data.stats, updatedAt: new Date().toISOString() });
    },
    [],
  );

  // Store change: drop the previous store's numbers, notice and pending
  // poll — nothing of store A may be shown under store B's name.
  useEffect(() => {
    statsRequest.current += 1;
    setNotice(null);
    setAwaiting(null);
    if (!selectedId) {
      setStatsState({ phase: "loading", stats: null, updatedAt: null });
      return;
    }
    void loadStats(selectedId, { keep: false });
  }, [selectedId, loadStats]);

  // A queued sync is confirmed by the store's watermark moving, not by a
  // timer: re-read connections and counts every minute until it does, or
  // until the plugin's expected window has clearly passed.
  useEffect(() => {
    if (!awaiting || awaiting.storeId !== selectedId) return;
    const current = watermarkFor(selected, awaiting.kind);
    if (current && current !== awaiting.since) {
      setAwaiting(null);
      setNotice({
        storeId: awaiting.storeId,
        kind: awaiting.kind,
        tone: "positive",
        message: `همگام‌سازی ${SYNC_LABELS[awaiting.kind]} توسط افزونه اعمال شد (${formatJalali(current, { withTime: true })}).`,
      });
      void loadStats(selectedId, { keep: true });
      return;
    }
    if (Date.now() - awaiting.startedAt > QUEUED_POLL_MAX_MS) {
      setAwaiting(null);
      setNotice({
        storeId: awaiting.storeId,
        kind: awaiting.kind,
        tone: "warn",
        message: `درخواست همگام‌سازی ${SYNC_LABELS[awaiting.kind]} پس از ۱۵ دقیقه هنوز توسط افزونه اعمال نشده است؛ وضعیت افزونه و صف را بررسی کنید.`,
      });
      return;
    }
    const timer = setTimeout(async () => {
      await reloadConnections();
      if (selectedIdRef.current !== awaiting.storeId) return;
      void loadStats(awaiting.storeId, { keep: true });
      // Re-arm whether or not the reload changed anything: a failed refresh
      // leaves every dependency as it was, and the poll must still continue
      // to the next check or the 15-minute warning.
      setPollTick((tick) => tick + 1);
    }, QUEUED_POLL_INTERVAL_MS);
    return () => clearTimeout(timer);
  }, [awaiting, selected, selectedId, reloadConnections, loadStats, pollTick]);

  async function runSync(kind: SyncKind) {
    if (!selected || busy) return;
    const storeId = selected.id;
    const before = watermarkFor(selected, kind);
    setBusy(kind);
    setNotice(null);
    const res = await syncNow(storeId, kind);
    setBusy(null);
    const outcome = classifySyncResponse(res);
    setNotice({ storeId, kind, ...describeSyncOutcome(kind, outcome) });
    if (outcome.kind === "queued") {
      setAwaiting({ storeId, kind, since: before, startedAt: Date.now() });
    }
    // The response *is* the completion signal for a REST sync, and for a
    // queued one the queue tile should show the new job now — so re-read on
    // the reply, not on a 400/600 ms guess. Only for the store still on
    // screen: a reply for store A after a switch to B must not refresh A's
    // numbers under B's name.
    void reloadConnections();
    if (selectedIdRef.current === storeId) void loadStats(storeId, { keep: true });
  }

  // The provider renders the first read's skeleton or error screen in place
  // of its children; this is only the frame for the instant in between.
  if (connections === null) return <SectionCardSkeleton rows={6} />;

  const refreshFailure = loadState === "error" && loadError ? loadError : null;

  if (connections.length === 0) {
    return (
      <div className="space-y-4">
        {refreshFailure ? <WpStoreRefreshError failure={refreshFailure} onRetry={() => void reloadConnections()} /> : null}
        <EmptyState>
          <div className="flex flex-col items-center gap-3 py-8 text-center">
            <PlugIcon className="size-10 text-muted-foreground/60" />
            <p className="font-semibold text-foreground">هنوز فروشگاهی متصل نیست</p>
            <p className="max-w-md text-sm text-muted-foreground">
              برای مدیریت وردپرس و ووکامرس از اینجا، ابتدا فروشگاه خود را با کلیدهای REST یا افزونهٔ وردپرس متصل کنید.
            </p>
            <Link href="/settings/connections?tab=woocommerce">
              <Button>اتصال فروشگاه</Button>
            </Link>
          </div>
        </EmptyState>
      </div>
    );
  }

  const stats = statsState.stats;
  const queue = stats?.queue;
  const inFlight = queue ? queue.inFlight : null;
  const attention = queue ? queue.attention : null;
  const health = selected ? transportHealthPresentation(selected) : null;
  const visibleNotice = notice && notice.storeId === selectedId ? notice : null;

  return (
    <div className="space-y-4 sm:space-y-5">
      {refreshFailure ? <WpStoreRefreshError failure={refreshFailure} onRetry={() => void reloadConnections()} /> : null}

      {/* Connection picker */}
      <SectionCard
        title={
          <div>
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">مدیریت فروشگاه</p>
            <h2 className="mt-1 text-base sm:text-lg font-semibold text-foreground">اتصال و وضعیت همگام‌سازی</h2>
          </div>
        }
        description="فروشگاه متصل را انتخاب کنید و وضعیت همگام‌سازی کاتالوگ، سفارش‌ها و مشتریان را بررسی نمایید."
      >
        <div className="flex flex-wrap items-center gap-3">
          <select
            className="min-w-[14rem] flex-1 rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground focus-visible:border-teal-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-400/30"
            value={selectedId}
            onChange={(e) => setSelectedId(e.target.value)}
            aria-label="انتخاب فروشگاه"
          >
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {storeDisplayName(c)} — {c.linkMode === "plugin" ? "افزونهٔ وردپرس" : "REST API"}
              </option>
            ))}
          </select>
          {selected ? (
            <span className="flex flex-wrap items-center gap-2" aria-label="وضعیت اتصال">
              <StatusBadge tone={selected.status === "active" ? "positive" : selected.status === "error" ? "danger" : "neutral"}>
                پیکربندی: {selected.status === "active" ? "فعال" : selected.status === "error" ? "خطا" : "متوقف"}
              </StatusBadge>
              {health ? <StatusBadge tone={health.tone}>ارتباط: {health.label}</StatusBadge> : null}
            </span>
          ) : null}
          <span className="text-xs text-muted-foreground">
            {selected?.linkMode === "plugin"
              ? selected.pluginVersion
                ? `افزونه نسخهٔ ${toPersianDigits(selected.pluginVersion)}`
                : "حالت افزونه"
              : "حالت REST API"}
          </span>
          <div className="ms-auto flex flex-wrap gap-2" role="group" aria-label="همگام‌سازی اکنون">
            {(Object.keys(SYNC_LABELS) as SyncKind[]).map((kind) => {
              const availability = syncAvailability(selected, can, kind);
              const disabled = busy !== null || !availability.enabled;
              return (
                <Button
                  key={kind}
                  variant="outline"
                  size="sm"
                  disabled={disabled}
                  aria-disabled={disabled}
                  title={availability.reason}
                  aria-label={`همگام‌سازی ${SYNC_LABELS[kind]}${availability.reason ? ` — ${availability.reason}` : ""}`}
                  onClick={() => void runSync(kind)}
                >
                  <RefreshCwIcon className="size-4" />
                  {busy === kind ? "در حال همگام‌سازی…" : SYNC_LABELS[kind]}
                </Button>
              );
            })}
          </div>
        </div>
        {selected ? <SyncLimits selected={selected} can={can} /> : null}
        {visibleNotice ? (
          <p
            role={visibleNotice.tone === "danger" ? "alert" : "status"}
            aria-live="polite"
            className={`mt-3 flex flex-wrap items-start justify-between gap-2 rounded-lg px-3 py-2 text-xs ${NOTICE_CLASS[visibleNotice.tone]}`}
          >
            <span>{visibleNotice.message}</span>
            {visibleNotice.retryKind && syncAvailability(selected, can, visibleNotice.retryKind).enabled ? (
              <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void runSync(visibleNotice.retryKind!)}>
                همگام‌سازی {SYNC_LABELS[visibleNotice.retryKind]} به‌تنهایی
              </Button>
            ) : null}
          </p>
        ) : null}
        {awaiting && awaiting.storeId === selectedId ? (
          <p className="mt-2 flex items-center gap-2 text-xs text-muted-foreground" role="status">
            <ClockIcon className="size-3.5" aria-hidden="true" />
            در انتظار اعمال توسط افزونه؛ هر دقیقه بررسی می‌شود.
          </p>
        ) : null}
        {health?.explanation ? (
          <p className="mt-3 flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">
            <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" />
            <span>
              {health.explanation}{" "}
              <Link className="underline underline-offset-2" href="/settings/connections?tab=woocommerce">
                تنظیمات اتصال
              </Link>
              {" · "}
              <Link className="underline underline-offset-2" href={`/websites/wp/queue?store=${selectedId}`}>
                صف همگام‌سازی
              </Link>
            </span>
          </p>
        ) : null}
        {selected?.lastError ? (
          <p className="mt-3 flex items-start gap-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-500/10 dark:text-red-300">
            <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" />
            آخرین خطا: {selected.lastError}
          </p>
        ) : null}
        <PluginWaitNote connections={connections} selectedId={selectedId} />
        <div className="mt-4 grid gap-x-8 gap-y-2 border-t border-border/80 pt-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          <SyncRow label="آخرین ارتباط کلی" value={selected?.lastSyncAt ?? null} />
          <SyncRow label="آخرین همگام‌سازی کاتالوگ" value={selected?.lastCatalogueSyncAt ?? null} />
          <SyncRow label="آخرین همگام‌سازی سفارش‌ها" value={selected?.lastOrderSyncAt ?? null} />
          <SyncRow label="آخرین همگام‌سازی مشتریان" value={selected?.lastCustomerSyncAt ?? null} />
          <SyncRow label="آخرین همگام‌سازی محتوا" value={selected?.lastContentSyncAt ?? null} />
          <SyncRow
            label="آخرین مشاهدهٔ افزونه"
            value={selected?.linkMode === "plugin" ? selected?.lastPluginSeenAt ?? null : null}
          />
        </div>
      </SectionCard>

      {/* KPI state line: the tiles are only as current as their last read. */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground" aria-live="polite">
        {statsState.phase === "error" ? (
          <span role="alert" className="flex flex-wrap items-center gap-2 text-red-700 dark:text-red-300">
            <AlertTriangleIcon className="size-3.5" aria-hidden="true" />
            خواندن شمارنده‌ها ناموفق بود
            {statsState.stats ? "؛ مقادیر قبلی نمایش داده می‌شوند" : ""}
            {statsState.status === 403 ? " (دسترسی ندارید)" : statsState.status === 0 ? " (ارتباط برقرار نشد)" : ""}
            .
            <Button size="sm" variant="ghost" onClick={() => void loadStats(selectedId, { keep: true })}>
              تلاش دوباره
            </Button>
          </span>
        ) : statsState.phase === "loading" ? (
          <span>{statsState.stats ? "در حال به‌روزرسانی شمارنده‌ها…" : "شمارنده‌ها در حال خوانده‌شدن هستند…"}</span>
        ) : (
          <span>
            به‌روزرسانی شمارنده‌ها: {statsState.updatedAt ? formatJalali(statsState.updatedAt, { withTime: true }) : "—"}
          </span>
        )}
        <Button size="sm" variant="ghost" disabled={statsState.phase === "loading"} onClick={() => void loadStats(selectedId, { keep: true })}>
          <RefreshCwIcon className="size-3.5" />
          تازه‌کردن شمارنده‌ها
        </Button>
      </div>

      {/* KPI tiles */}
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <Kpi icon={ShoppingBagIcon} label="محصول همگام‌شده" value={stats?.products} href="/websites/wp/products" />
        <Kpi icon={ReceiptTextIcon} label="سفارش آنلاین" value={stats?.orders} href="/websites/wp/orders" />
        <Kpi icon={ContactIcon} label="مشتری فروشگاه" value={stats?.customers} href="/websites/wp/customers" />
        <Kpi icon={FolderTreeIcon} label="دسته/برچسب/ویژگی" value={stats?.terms} href="/websites/wp/taxonomies" />
        <Kpi
          icon={FileTextIcon}
          label="نوشته و برگه"
          value={stats ? (stats.content.posts ?? 0) + (stats.content.pages ?? 0) : null}
          href="/websites/wp/content"
        />
        <Kpi icon={ImageIcon} label="رسانه" value={stats?.content.media} href="/websites/wp/media" />
        <Kpi
          icon={RefreshCwIcon}
          label="در صف / در حال اجرا"
          value={inFlight}
          hint={
            queue
              ? `${tileNumber(queue.pending - queue.inboundPending)} خروجی · ${tileNumber(queue.processing)} در اجرا · ${tileNumber(queue.inboundPending)} ورودی`
              : undefined
          }
          href="/websites/wp/queue"
        />
        <Kpi
          icon={AlertTriangleIcon}
          label="نیازمند رسیدگی"
          value={attention}
          hint={
            queue
              ? `${tileNumber(queue.failed - queue.needsReview - queue.inboundFailed)} ناموفق · ${tileNumber(queue.needsReview)} بازبینی · ${tileNumber(queue.dead)} متوقف · ${tileNumber(queue.inboundFailed)} ورودی ناموفق`
              : undefined
          }
          tone={(attention ?? 0) > 0 ? "warn" : "default"}
          href="/websites/wp/queue"
        />
      </div>
    </div>
  );
}

/** One line under the buttons naming every sync this store/member cannot run, so a disabled button is never a mystery. */
function SyncLimits({ selected, can }: { selected: WpManagerConnection; can: (ability: WpAbility) => boolean }) {
  const reasons = (Object.keys(SYNC_LABELS) as SyncKind[])
    .map((kind) => ({ kind, availability: syncAvailability(selected, can, kind) }))
    .filter((item) => !item.availability.enabled);
  if (reasons.length === 0) return null;
  // Four identical reasons (no permission, paused) collapse to one sentence.
  const unique = Array.from(new Set(reasons.map((item) => item.availability.reason)));
  return (
    <ul className="mt-2 space-y-0.5 text-xs text-muted-foreground" aria-label="محدودیت‌های همگام‌سازی">
      {unique.map((reason) => (
        <li key={reason}>
          {reasons.length < 4 || unique.length > 1
            ? `${reasons
                .filter((item) => item.availability.reason === reason)
                .map((item) => SYNC_LABELS[item.kind])
                .join("، ")}: `
            : ""}
          {reason}
        </li>
      ))}
    </ul>
  );
}
