"use client";

/**
 * The console home — a real operational overview (task section 3).
 *
 * Previously `/platform` was the business list; that has moved to
 * `/platform/businesses`, and this is now the dashboard an operator lands on:
 * an actionable alert list up top (only the things that are wrong), then
 * headline figures that each link into the section they summarise. One batched
 * request (`/api/platform/overview`), no wall of meaningless KPI cards.
 */
import Link from "next/link";
import {
  BuildingIcon,
  LifeBuoyIcon,
  BugIcon,
  CreditCardIcon,
  DatabaseBackupIcon,
  ServerIcon,
  AlertTriangleIcon,
  InfoIcon,
  ChevronLeftIcon,
} from "lucide-react";
import {
  PlatformPageHeader,
  PlatformPageContainer,
  PlatformStat,
  PlatformRefreshButton,
  PlatformLoadingState,
  PlatformErrorState,
} from "@/components/platform";
import { usePlatformQuery } from "./_lib/use-platform-data";
import { fmtRelative, formatPersianNumber } from "@/lib/platform-format";
import type { PlatformOverview } from "@/lib/platform-overview-service";

export default function OverviewPage() {
  const query = usePlatformQuery<{ overview: PlatformOverview }>("/api/platform/overview");
  const o = query.data?.overview;

  return (
    <PlatformPageContainer>
      <PlatformPageHeader
        title="نمای کلی"
        description="وضعیت عملیاتی سکو در یک نگاه"
        actions={<PlatformRefreshButton onClick={query.refetch} refreshing={query.refreshing} />}
      />

      {query.loading ? (
        <PlatformLoadingState rows={4} />
      ) : query.error && !o ? (
        <PlatformErrorState message={query.errorText} status={query.errorStatus} onRetry={query.refetch} />
      ) : o ? (
        <div className="space-y-6">
          <AlertList alerts={o.alerts} />

          <section>
            <h2 className="mb-3 text-sm font-semibold text-foreground">مشتریان</h2>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
              <PlatformStat
                label="کل کسب‌وکارها"
                value={formatPersianNumber(o.businesses.total)}
                icon={<BuildingIcon className="size-4" />}
                href="/platform/businesses"
                hint="فهرست کسب‌وکارها"
              />
              <PlatformStat label="فعال" value={formatPersianNumber(o.businesses.active)} tone="success" />
              <PlatformStat
                label="معلق"
                value={formatPersianNumber(o.businesses.suspended)}
                tone={o.businesses.suspended ? "warning" : "muted"}
                href="/platform/businesses?status=suspended"
                hint={o.businesses.suspended ? "بررسی" : undefined}
              />
              <PlatformStat label="بایگانی" value={formatPersianNumber(o.businesses.archived)} tone="muted" />
              <PlatformStat
                label="جدید (۳۰ روز)"
                value={formatPersianNumber(o.businesses.newLast30d)}
                tone="info"
                hint="رشد اخیر"
              />
            </div>
          </section>

          <section>
            <h2 className="mb-3 text-sm font-semibold text-foreground">پشتیبانی و کیفیت</h2>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
              <PlatformStat
                label="تیکت‌های باز"
                value={formatPersianNumber(o.support.open)}
                tone={o.support.open ? "info" : "muted"}
                icon={<LifeBuoyIcon className="size-4" />}
                href="/platform/support"
                hint="میز پشتیبانی"
              />
              <PlatformStat
                label="فوری باز"
                value={formatPersianNumber(o.support.urgentOpen)}
                tone={o.support.urgentOpen ? "danger" : "muted"}
                href="/platform/support?priority=urgent"
                hint={o.support.urgentOpen ? "رسیدگی فوری" : undefined}
              />
              <PlatformStat
                label="بدون مسئول"
                value={formatPersianNumber(o.support.unassignedOpen)}
                tone={o.support.unassignedOpen ? "warning" : "muted"}
                href="/platform/support"
              />
              <PlatformStat
                label="گزارش خطای جدید"
                value={formatPersianNumber(o.bugReports.new)}
                tone={o.bugReports.new ? "warning" : "muted"}
                icon={<BugIcon className="size-4" />}
                href="/platform/bug-reports"
                hint="صندوق گزارش‌ها"
              />
            </div>
          </section>

          <section>
            <h2 className="mb-3 text-sm font-semibold text-foreground">درآمد و سلامت سیستم</h2>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
              <PlatformStat
                label="پرداخت دستی در انتظار"
                value={formatPersianNumber(o.payments.manualPending)}
                tone={o.payments.manualPending ? "warning" : "muted"}
                icon={<CreditCardIcon className="size-4" />}
                href="/platform/billing"
                hint="بررسی پرداخت‌ها"
              />
              <PlatformStat
                label="پرداخت ناموفق (۷ روز)"
                value={formatPersianNumber(o.payments.failedLast7d)}
                tone={o.payments.failedLast7d ? "warning" : "muted"}
                href="/platform/billing"
              />
              <PlatformStat
                label="پشتیبان‌گیری"
                value={
                  o.backup.status === "ok"
                    ? "سالم"
                    : o.backup.status === "warning"
                      ? "هشدار"
                      : o.backup.status === "error"
                        ? "خطا"
                        : "نامشخص"
                }
                tone={
                  o.backup.status === "ok"
                    ? "success"
                    : o.backup.status === "warning"
                      ? "warning"
                      : o.backup.status === "error"
                        ? "danger"
                        : "muted"
                }
                icon={<DatabaseBackupIcon className="size-4" />}
                href="/platform/backup"
                hint={o.backup.lastSuccessAt ? `آخرین: ${fmtRelative(o.backup.lastSuccessAt)}` : "بررسی"}
              />
              <PlatformStat
                label="سلامت سیستم"
                value={
                  !o.system.migrationHeadline || o.system.migrationHeadline.tone === "unknown"
                    ? "نامشخص"
                    : o.system.migrationHeadline.tone === "ok" && o.system.rlsEffective
                      ? "سالم"
                      : o.system.migrationHeadline.label
                }
                tone={
                  !o.system.rlsEffective
                    ? "danger"
                    : o.system.migrationHeadline?.tone === "ok"
                      ? "success"
                      : o.system.migrationHeadline?.tone === "warn"
                        ? "warning"
                        : o.system.migrationHeadline?.tone === "unknown"
                          ? "muted"
                          : "danger"
                }
                icon={<ServerIcon className="size-4" />}
                href="/platform/system"
                hint={
                  !o.system.rlsEffective
                    ? "RLS بررسی شود"
                    : o.system.migrationHeadline?.summary ?? "وضعیت مهاجرت‌ها نامشخص است"
                }
              />
            </div>
          </section>
        </div>
      ) : null}
    </PlatformPageContainer>
  );
}

function AlertList({ alerts }: { alerts: PlatformOverview["alerts"] }) {
  if (alerts.length === 0) {
    return (
      <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 px-4 py-3 text-sm text-emerald-700 dark:text-emerald-300">
        همه‌چیز مرتب است؛ هشدار فعالی وجود ندارد.
      </div>
    );
  }
  return (
    <section aria-label="هشدارها" className="space-y-2">
      <h2 className="text-sm font-semibold text-foreground">نیازمند توجه</h2>
      <ul className="space-y-2">
        {alerts.map((a, i) => {
          const tone =
            a.level === "error"
              ? "border-red-500/30 bg-red-500/5 text-red-700 dark:text-red-300"
              : a.level === "warning"
                ? "border-amber-500/30 bg-amber-500/5 text-amber-700 dark:text-amber-300"
                : "border-sky-500/30 bg-sky-500/5 text-sky-700 dark:text-sky-300";
          return (
            <li key={i}>
              <Link
                href={a.href}
                className={`flex items-center justify-between gap-3 rounded-xl border px-4 py-3 text-sm transition-colors hover:brightness-105 ${tone}`}
              >
                <span className="flex min-w-0 items-center gap-2">
                  {a.level === "info" ? (
                    <InfoIcon className="size-4 shrink-0" aria-hidden="true" />
                  ) : (
                    <AlertTriangleIcon className="size-4 shrink-0" aria-hidden="true" />
                  )}
                  <span className="min-w-0">{a.title}</span>
                </span>
                <ChevronLeftIcon className="size-4 shrink-0 opacity-60" aria-hidden="true" />
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
