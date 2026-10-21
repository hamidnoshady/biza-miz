"use client";

/**
 * The WP Manager میز کار: connection picker, sync watermarks, KPI tiles for
 * the mirrored catalogue/orders/customers/content, and quick actions
 * (همگام‌سازی) per connection. All numbers come from local mirrors so the
 * page behaves identically in plugin and REST link modes.
 */
import { useEffect, useState } from "react";
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
} from "lucide-react";
import { api, errorMessageOrRaw } from "@/app/dashboard/ui";
import { cardClass, EmptyState, SectionCard, SectionCardSkeleton, StatusBadge } from "@/app/dashboard/page-chrome";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import type { WpOverviewStats } from "@/lib/integrations/wp-manager-service";
import { PluginWaitNote } from "./plugin-wait-note";
import { useWpStore } from "./wp-store-context";

type SyncKind = "products" | "orders" | "customers" | "content";

const SYNC_LABELS: Record<SyncKind, string> = {
  products: "محصولات",
  orders: "سفارش‌ها",
  customers: "مشتریان",
  content: "محتوا",
};

function syncNow(connectionId: string, kind: SyncKind) {
  if (kind === "content") {
    return api(`/api/integrations/wp-manager/content`, {
      method: "POST",
      body: JSON.stringify({ connectionId }),
    });
  }
  return api(`/api/integrations/connections/${connectionId}/sync/${kind}`, { method: "POST" });
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
}: {
  icon: typeof PlugIcon;
  label: string;
  value: number | string | null | undefined;
  href?: string;
  tone?: "default" | "warn";
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

export function WpOverviewSection() {
  const { connections, selectedId, setSelectedId, selectedConnection: selected, reloadConnections, canSync, canEdit } = useWpStore();
  const [stats, setStats] = useState<WpOverviewStats | null>(null);
  const [busy, setBusy] = useState<SyncKind | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  // One stats fetch per selected connection — never a business-wide one
  // racing it. The tiles describe the store the member is looking at, and a
  // multi-store business used to see whichever response landed last. The
  // `statsKey` bump re-reads the same store's numbers after a sync.
  const [statsKey, setStatsKey] = useState(0);

  useEffect(() => {
    if (!selected) {
      setStats(null);
      return;
    }
    let alive = true;
    setStats(null);
    api<{ stats: WpOverviewStats }>(`/api/integrations/wp-manager/overview?connectionId=${selected.id}`).then((res) => {
      // A quick switch away and back must not let a slow first response
      // overwrite the second one's numbers.
      if (alive && res.ok) setStats(res.data.stats);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, statsKey]);

  async function runSync(kind: SyncKind) {
    if (!selected) return;
    setBusy(kind);
    setError("");
    setNotice("");
    const res = await syncNow(selected.id, kind);
    setBusy(null);
    if (!res.ok) {
      setError(errorMessageOrRaw(String(res.data?.error ?? "")) || "همگام‌سازی با خطا مواجه شد");
    } else if (res.data?.queued) {
      setNotice(`درخواست همگام‌سازی ${SYNC_LABELS[kind]} در صف قرار گرفت؛ افزونهٔ وردپرس آن را در اجرای بعدی اعمال می‌کند.`);
    } else {
      setNotice(`همگام‌سازی ${SYNC_LABELS[kind]} انجام شد.`);
    }
    setTimeout(() => void reloadConnections(), 400);
    setTimeout(() => setStatsKey((k) => k + 1), 600);
  }

  if (connections === null) {
    return <SectionCardSkeleton rows={6} />;
  }

  if (connections.length === 0) {
    return (
      <div className="space-y-4">
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

  const failedTotal = (stats?.failedJobs ?? 0) + (stats?.deadJobs ?? 0) + (stats?.failedInboxEvents ?? 0);

  return (
    <div className="space-y-4 sm:space-y-5">
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
            value={selected?.id ?? ""}
            onChange={(e) => setSelectedId(e.target.value)}
            aria-label="انتخاب فروشگاه"
          >
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} — {c.linkMode === "plugin" ? "افزونهٔ وردپرس" : "REST API"}
              </option>
            ))}
          </select>
          {selected ? (
            <StatusBadge tone={selected.status === "active" ? "positive" : selected.status === "error" ? "danger" : "neutral"}>
              {selected.status === "active" ? "فعال" : selected.status === "error" ? "خطا" : "متوقف"}
            </StatusBadge>
          ) : null}
          <span className="text-xs text-muted-foreground">
            {selected?.linkMode === "plugin"
              ? selected.pluginVersion
                ? `افزونه نسخهٔ ${toPersianDigits(selected.pluginVersion)}`
                : "حالت افزونه"
              : "حالت REST API"}
          </span>
          <div className="ms-auto flex flex-wrap gap-2">
            {(Object.keys(SYNC_LABELS) as SyncKind[]).map((kind) => {
              // The routes re-check these abilities server-side; a disabled
              // button with a reason beats a 403 after the click (#944
              // OVR-01). Content sync rides the edit tier until its route
              // stops multiplexing editing (#940).
              const allowed = kind === "content" ? canEdit : canSync;
              return (
                <Button
                  key={kind}
                  variant="outline"
                  size="sm"
                  disabled={busy !== null || !allowed}
                  title={allowed ? undefined : "برای این کار دسترسی کافی ندارید؛ از مدیر کسب‌وکار بخواهید دسترسی لازم ووکامرس را بدهد."}
                  onClick={() => void runSync(kind)}
                >
                  <RefreshCwIcon className="size-4" />
                  {busy === kind ? "در حال همگام‌سازی…" : SYNC_LABELS[kind]}
                </Button>
              );
            })}
          </div>
        </div>
        {error ? <p className="mt-3 text-xs text-red-600 dark:text-red-400">{error}</p> : null}
        {notice ? <p className="mt-3 text-xs text-teal-700 dark:text-teal-300">{notice}</p> : null}
        {selected?.lastError ? (
          <p className="mt-3 flex items-start gap-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-500/10 dark:text-red-300">
            <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" />
            آخرین خطا: {selected.lastError}
          </p>
        ) : null}
        <PluginWaitNote connections={connections} selectedId={selected?.id ?? ""} />
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
          label="کار در صف"
          value={stats?.pendingJobs}
          href="/websites/wp/queue"
        />
        <Kpi
          icon={AlertTriangleIcon}
          label="رویداد ناموفق"
          value={failedTotal}
          tone={failedTotal > 0 ? "warn" : "default"}
          href="/websites/wp/queue"
        />
      </div>
    </div>
  );
}
