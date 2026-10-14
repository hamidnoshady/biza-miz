"use client";

/**
 * نمای کلی — the high-signal commercial dashboard: subscription health, this
 * month's billed amount, payment outcomes, outstanding invoices, wallet
 * liabilities, AI/messaging/media usage and gateway health. Every card links
 * into the Billing tab that owns the number.
 */
import Link from "next/link";
import {
  AlertTriangleIcon,
  BadgeCheckIcon,
  CreditCardIcon,
  FileTextIcon,
  MessageSquareIcon,
  SparklesIcon,
  HardDriveIcon,
} from "lucide-react";
import { usePlatformQuery } from "../../_lib/use-platform-data";
import { Card, EmptyState, ErrorBox, SkeletonRows, StatCard, fmtDate } from "../../ui";
import { tomanLabel, formatRial } from "@/lib/platform-money";

interface Overview {
  subscriptions: { active: number; trialing: number; pastDue: number; cancelled: number; expired: number };
  money: {
    month: string | null;
    timezone?: string;
    billedRial: number;
    collectedRevenueRial?: number;
    netUsageSpendRial?: number;
    successfulPayments: number;
    failedPayments: number;
  };
  invoices: { outstandingCount: number; outstandingRial: number };
  wallets: { liabilityRial: number; aiDebtRial?: number; netLiabilityRial?: number; count: number };
  ai: {
    allowanceGrantedRial: number;
    allowanceUsedRial: number;
    walletChargedRial: number;
    debtRial?: number;
    costingEnabled: boolean;
  };
  messaging: {
    creditBalanceRial: number;
    grossUsageRialThisMonth?: number;
    refundedRialThisMonth?: number;
    usageRialThisMonth: number;
  };
  media: { businesses: number; storedBytes: number; chargesRialThisMonth: number };
  gateway: { configured: string; sandbox: boolean; currency: string; merchantIdSet: boolean; lastSuccessfulPayment: string | null };
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} گیگابایت`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} مگابایت`;
  return `${Math.max(1, Math.round(bytes / 1024))} کیلوبایت`;
}

export function BillingOverviewTab() {
  const { data, loading, error, errorText } = usePlatformQuery<Overview>(
    "/api/platform/billing/overview",
  );

  if (loading) {
    return (
      <Card title="نمای کلی درآمد">
        <SkeletonRows rows={6} />
      </Card>
    );
  }
  if (error || !data) {
    return <ErrorBox>{errorText ?? "بارگذاری نمای کلی ممکن نشد."}</ErrorBox>;
  }

  const allowanceUsedPct =
    data.ai.allowanceGrantedRial > 0
      ? Math.round((data.ai.allowanceUsedRial / data.ai.allowanceGrantedRial) * 100)
      : null;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="اشتراک فعال"
          value={String(data.subscriptions.active)}
          tone="ok"
          icon={<BadgeCheckIcon className="size-4" />}
          hint={`${data.subscriptions.trialing} در دورهٔ آزمایشی · ${data.subscriptions.pastDue} عقب‌افتاده`}
        />
        <StatCard
          label="مبلغ صورتحساب این ماه"
          value={tomanLabel(data.money.billedRial)}
          icon={<CreditCardIcon className="size-4" />}
          hint={`وصول‌شده: ${tomanLabel(data.money.collectedRevenueRial ?? 0)} · ${data.money.successfulPayments} موفق / ${data.money.failedPayments} ناموفق`}
        />
        <StatCard
          label="فاکتورهای باز"
          value={String(data.invoices.outstandingCount)}
          tone={data.invoices.outstandingCount > 0 ? "warn" : "neutral"}
          icon={<FileTextIcon className="size-4" />}
          hint={data.invoices.outstandingRial > 0 ? `${tomanLabel(data.invoices.outstandingRial)} مطالبات باز` : "مطالبات بازی نیست"}
        />
        <StatCard
          label="بدهی کیف پول‌ها"
          value={tomanLabel(data.wallets.liabilityRial)}
          icon={<WalletLiability />}
          hint={`${data.wallets.count} کیف پول فعال${
            (data.wallets.aiDebtRial ?? 0) > 0
              ? ` · بدهی AI: ${tomanLabel(data.wallets.aiDebtRial ?? 0)}`
              : ""
          }`}
        />
      </div>

      {data.subscriptions.pastDue > 0 && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-200">
          <span className="flex items-center gap-2">
            <AlertTriangleIcon className="size-4" />
            {String(data.subscriptions.pastDue)} اشتراک عقب‌افتاده است — پس از پایان مهلت، دسترسی پلن قطع می‌شود.{" "}
            <Link href="/platform/billing?tab=subscriptions" className="font-semibold underline">
              بررسی اشتراک‌ها
            </Link>
          </span>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="مصرف هوش مصنوعی (این ماه)">
          <ul className="space-y-2 text-sm">
            <li className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">اعتبار پلن مصرف‌شده</span>
              <span className="font-semibold tabular-nums">{tomanLabel(data.ai.allowanceUsedRial)}</span>
            </li>
            <li className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">از اعتبار ماهانهٔ پلن‌ها</span>
              <span className="tabular-nums">{tomanLabel(data.ai.allowanceGrantedRial)}</span>
            </li>
            <li className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">شارژ از کیف پول</span>
              <span className="tabular-nums">{tomanLabel(data.ai.walletChargedRial)}</span>
            </li>
            {(data.ai.debtRial ?? 0) > 0 && (
              <li className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">بدهی معوق هوش مصنوعی</span>
                <span className="font-medium tabular-nums text-amber-700 dark:text-amber-300">
                  {tomanLabel(data.ai.debtRial ?? 0)}
                </span>
              </li>
            )}
          </ul>
          {allowanceUsedPct != null && (
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={allowanceUsedPct} aria-valuemin={0} aria-valuemax={100}>
              <div className="h-full rounded-full bg-violet-500/70" style={{ width: `${Math.min(100, allowanceUsedPct)}%` }} />
            </div>
          )}
          <p className="mt-3 text-xs text-muted-foreground">
            <SparklesIcon className="ml-1 inline size-3.5" />
            {data.ai.costingEnabled ? "هزینه‌گذاری بر پایهٔ LiteLLM فعال است" : "هزینه‌گذاری بر پایهٔ LiteLLM تنظیم نشده"} —{" "}
            <Link href="/platform/billing?tab=usage" className="underline">مدیریت تعرفه‌ها</Link>
          </p>
        </Card>

        <Card title="کیف پول و پیام‌رسانی">
          <ul className="space-y-2 text-sm">
            <li className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">ماندهٔ کیف پول پلتفرم</span>
              <span className="font-semibold tabular-nums">{tomanLabel(data.messaging.creditBalanceRial)}</span>
            </li>
            <li className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">هزینهٔ خالص پیام این ماه</span>
              <span className="tabular-nums">{tomanLabel(data.messaging.usageRialThisMonth)}</span>
            </li>
            {(data.messaging.refundedRialThisMonth ?? 0) > 0 && (
              <li className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">برگشت وجه پیام‌های ناموفق</span>
                <span className="tabular-nums text-emerald-700 dark:text-emerald-300">
                  {tomanLabel(data.messaging.refundedRialThisMonth ?? 0)}
                </span>
              </li>
            )}
            <li className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">مجموع مصرف خالص این ماه</span>
              <span className="tabular-nums">{tomanLabel(data.money.netUsageSpendRial ?? 0)}</span>
            </li>
          </ul>
          <p className="mt-3 text-xs text-muted-foreground">
            <MessageSquareIcon className="ml-1 inline size-3.5" />
            تعرفه هر قطعه پیامک و بسته‌های اعتبار در{" "}
            <Link href="/platform/billing?tab=usage" className="underline">تعرفه مصرف و اعتبار</Link> مدیریت می‌شوند.
          </p>
        </Card>

        <Card title="رسانه و فضای ابری">
          <ul className="space-y-2 text-sm">
            <li className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">حجم ذخیره‌شده</span>
              <span className="font-semibold tabular-nums">{formatBytes(data.media.storedBytes)}</span>
            </li>
            <li className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">کسب‌وکارهای دارای رسانه</span>
              <span className="tabular-nums">{String(data.media.businesses)}</span>
            </li>
            <li className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">درآمد تعرفهٔ این ماه</span>
              <span className="tabular-nums">{tomanLabel(data.media.chargesRialThisMonth)}</span>
            </li>
          </ul>
          <p className="mt-3 text-xs text-muted-foreground">
            <HardDriveIcon className="ml-1 inline size-3.5" />
            تعرفهٔ نگهداری روزانه در{" "}
            <Link href="/platform/billing?tab=usage" className="underline">تعرفه مصرف و اعتبار</Link> مدیریت می‌شود.
          </p>
        </Card>
      </div>

      <Card title="درگاه پرداخت">
        {data.gateway.configured === "zarinpal" && !data.gateway.merchantIdSet ? (
          <EmptyState
            title="زرین‌پال انتخاب شده اما مرچنت کد ثبت نشده"
            hint="پرداخت‌های آنلاین تا ثبت مرچنت کد در «درگاه‌های پرداخت» انجام نمی‌شود."
            action={
              <Link href="/platform/billing?tab=gateways" className="text-sm font-semibold text-sky-700 underline dark:text-sky-300">
                تنظیم درگاه
              </Link>
            }
          />
        ) : (
          <ul className="grid gap-2 text-sm sm:grid-cols-2">
            <li className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">درگاه فعال</span>
              <span className="font-semibold">
                {data.gateway.configured === "zarinpal" ? "زرین‌پال" : "پرداخت دستی / کارت‌به‌کارت"}
              </span>
            </li>
            <li className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">حالت</span>
              <span>{data.gateway.configured === "zarinpal" ? (data.gateway.sandbox ? "تستی (Sandbox)" : "عملیاتی") : "تأیید دستی مدیر"}</span>
            </li>
            <li className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">واحد پولی درگاه</span>
              <span>{data.gateway.currency === "IRT" ? "تومان" : "ریال"}</span>
            </li>
            <li className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">آخرین پرداخت موفق</span>
              <span>{data.gateway.lastSuccessfulPayment ? fmtDate(data.gateway.lastSuccessfulPayment) : "—"}</span>
            </li>
          </ul>
        )}
      </Card>

      <p className="text-xs text-muted-foreground">
        همهٔ مبالغ فروش و تعرفه‌ها به ریال نگهداری و به تومان نمایش داده می‌شوند؛ مجموع شارژ کیف پول‌ها: {formatRial(data.wallets.liabilityRial)} ریال.
      </p>
    </div>
  );
}

function WalletLiability() {
  return <CreditCardIcon className="size-4" />;
}
