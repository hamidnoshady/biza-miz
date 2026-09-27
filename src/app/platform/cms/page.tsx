"use client";

/**
 * «سایت‌ساز ← میز فرمان» — the whole website platform, on one screen.
 *
 * The report is assembled from two sources and says which is which: the CMS's live
 * fleet report when it answers, and the local mirror (`platform_cms_sites`) always.
 * That is deliberate — a console that shows nothing while the CMS restarts is a
 * console an operator stops trusting, and last-known-good figures with the time
 * they were read is more useful than a blank page with an error on it.
 *
 * Money is per currency and never summed across them: a site snapshots the
 * currency it sold in, so one total would be a number nobody could reconcile.
 * Every figure goes through `formatPersianNumber` and every instant through
 * `fmtDate`, which is Shamsi — the console is not exempt from either rule.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  CloudOff,
  Database,
  Globe,
  RefreshCw,
  ShoppingCart,
  TriangleAlert,
} from "lucide-react";

import { formatPersianNumber, toPersianDigits } from "@/lib/digits";
import { CMS_FINDING_LABELS, type CmsFleetFinding, type MirroredCmsSite } from "@/lib/cms/platform-control";
import type { MaskedCmsControlConfig } from "@/lib/cms/platform-control";
import type { SyncRunRow } from "@/lib/cms/platform-control";
import type { CmsOverview } from "@/lib/cms/platform-client";
import {
  api,
  Button,
  Card,
  EmptyState,
  ErrorBox,
  fmtDate,
  InfoBox,
  SkeletonRows,
  StatCard,
  useCan,
} from "../ui";
import { cmsErrorText, syncStatusTone } from "./text";

interface OverviewResponse {
  billingHealth?: Record<string, unknown> | null;
  billingHealthError?: null | string;
  config?: MaskedCmsControlConfig;
  error?: string;
  findings?: CmsFleetFinding[];
  mirrorStale?: boolean;
  mirroredAt?: null | string;
  overview?: CmsOverview | null;
  overviewError?: null | string;
  runs?: SyncRunRow[];
  saasOverview?: Record<string, unknown> | null;
  saasOverviewError?: null | string;
  sites?: MirroredCmsSite[];
}

const CURRENCY_LABELS: Record<string, string> = {
  IRR: "ریال",
  IRT: "تومان",
};

export default function CmsOverviewPage() {
  const can = useCan();
  const [data, setData] = useState<OverviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<null | string>(null);

  const load = useCallback(async () => {
    const { ok, data: body } = await api<OverviewResponse>("/api/platform/cms/overview");
    if (!ok) setError(cmsErrorText(body.error));
    else setError(null);
    setData(body);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function refreshMirror() {
    setBusy(true);
    const { ok, data: body } = await api<{ error?: string }>("/api/platform/cms/sync", {
      body: JSON.stringify({ kind: "mirror" }),
      method: "POST",
    });
    if (!ok) setError(cmsErrorText(body.error));
    await load();
    setBusy(false);
  }

  if (loading) return <SkeletonRows label="در حال خواندن وضعیت سایت‌ساز" rows={6} />;

  const config = data?.config;
  const overview = data?.overview ?? null;
  const sites = data?.sites ?? [];
  const findings = data?.findings ?? [];
  const runs = data?.runs ?? [];

  if (!config?.usable) {
    return (
      <div className="space-y-4">
        {error ? <ErrorBox>{error}</ErrorBox> : null}
        <EmptyState
          action={
            <Link href="/platform/cms/connection">
              <Button>تنظیم اتصال</Button>
            </Link>
          }
          hint="نشانی سایت‌ساز و کلید پلتفرم را در بخش «اتصال» وارد کنید. تا آن زمان هیچ درخواستی به سایت‌ساز فرستاده نمی‌شود."
          title="سایت‌ساز به این کنسول وصل نیست"
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {error ? <ErrorBox>{error}</ErrorBox> : null}

      {data?.overviewError ? (
        <InfoBox>
          گزارش زندهٔ سایت‌ساز در دسترس نیست ({cmsErrorText(data.overviewError)}). اعداد زیر از
          آخرین آینه‌برداری{" "}
          {data.mirroredAt ? `در ${fmtDate(data.mirroredAt)}` : "— که هنوز انجام نشده —"} است.
        </InfoBox>
      ) : null}

      {data?.mirrorStale && !data?.overviewError ? (
        <InfoBox>
          آینهٔ سایت‌ها بیش از دو دورهٔ زمان‌بندی به‌روز نشده است؛ آخرین بار{" "}
          {config.lastMirrorAt ? fmtDate(config.lastMirrorAt) : "هرگز"}.
        </InfoBox>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-bold">میز فرمان سایت‌ساز</h1>
          <p className="mt-1 text-xs text-muted-foreground">
            {config.label || config.baseUrl}
            {config.verifiedAt ? ` · آخرین تأیید: ${fmtDate(config.verifiedAt)}` : " · تأییدنشده"}
          </p>
        </div>
        {can("cms.manage") ? (
          <Button disabled={busy} onClick={refreshMirror} variant="ghost">
            <RefreshCw className="size-4" />
            {busy ? "در حال به‌روزرسانی…" : "به‌روزرسانی آینه"}
          </Button>
        ) : null}
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          hint={`${formatPersianNumber(overview?.sites.verified ?? sites.filter((s) => s.domainVerified).length)} دامنهٔ تأییدشده`}
          icon={<Globe className="size-4" />}
          label="سایت‌ها"
          value={formatPersianNumber(overview?.sites.total ?? sites.length)}
        />
        <StatCard
          hint={`${formatPersianNumber(overview?.content.pagesPublished ?? 0)} صفحهٔ منتشرشده`}
          icon={<Database className="size-4" />}
          label="صفحه‌ها و نوشته‌ها"
          value={formatPersianNumber(
            (overview?.content.pages ?? 0) + (overview?.content.posts ?? 0),
          )}
        />
        <StatCard
          hint={`${formatPersianNumber(overview?.commerce.byStatus.paid ?? 0)} سفارش پرداخت‌شده`}
          icon={<ShoppingCart className="size-4" />}
          label="سفارش‌های فروشگاهی"
          value={formatPersianNumber(overview?.commerce.orders ?? 0)}
        />
        <StatCard
          hint={
            overview?.infrastructure.jobs.available
              ? `${formatPersianNumber(overview.infrastructure.jobs.failed)} کار ناموفق`
              : "صف کارها خوانده نشد"
          }
          icon={<AlertTriangle className="size-4" />}
          label="کارهای در صف"
          tone={
            (overview?.infrastructure.jobs.failed ?? 0) > 0
              ? "bad"
              : (overview?.infrastructure.jobs.queued ?? 0) > 0
                ? "warn"
                : "ok"
          }
          value={formatPersianNumber(overview?.infrastructure.jobs.queued ?? 0)}
        />
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card title="اجرای تجاری (سایت‌ساز)">
          {data?.saasOverviewError ? (
            <p className="text-sm text-muted-foreground">{cmsErrorText(data.saasOverviewError)}</p>
          ) : data?.saasOverview ? (
            <pre className="max-h-48 overflow-auto rounded-lg bg-muted p-2 text-xs" dir="ltr">
              {JSON.stringify(data.saasOverview, null, 2)}
            </pre>
          ) : (
            <p className="text-sm text-muted-foreground">گزارش در دسترس نیست.</p>
          )}
        </Card>
        <Card title="سلامت یکپارچگی صورتحساب">
          {data?.billingHealthError ? (
            <p className="text-sm text-muted-foreground">{cmsErrorText(data.billingHealthError)}</p>
          ) : data?.billingHealth ? (
            <pre className="max-h-48 overflow-auto rounded-lg bg-muted p-2 text-xs" dir="ltr">
              {JSON.stringify(data.billingHealth, null, 2)}
            </pre>
          ) : (
            <p className="text-sm text-muted-foreground">—</p>
          )}
          <Link className="mt-2 inline-block text-sm text-teal-700 dark:text-teal-300" href="/platform/cms/billing-sync">
            جزئیات همگام‌سازی
          </Link>
        </Card>
      </div>

      {findings.length ? (
        <Card title="یافته‌ها">
          <ul className="space-y-2">
            {findings.map((finding) => (
              <li
                className={
                  finding.severity === "warn"
                    ? "flex flex-wrap items-baseline gap-2 rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-sm text-amber-800 dark:text-amber-200"
                    : "flex flex-wrap items-baseline gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm text-muted-foreground"
                }
                key={finding.kind}
              >
                <TriangleAlert className="size-4 shrink-0" />
                <span className="font-medium">{CMS_FINDING_LABELS[finding.kind]}</span>
                <span className="tabular-nums">{formatPersianNumber(finding.count)}</span>
                {finding.detail ? (
                  <span className="text-xs text-muted-foreground">{toPersianDigits(finding.detail)}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>
      ) : (
        <InfoBox>هیچ یافتهٔ هشداری در سایت‌های این سکو نیست.</InfoBox>
      )}

      {overview ? (
        <div className="grid gap-3 lg:grid-cols-2">
          <Card title={`درآمد پرداخت‌شده (${toPersianDigits(overview.commerce.windowDays)} روز)`}>
            {overview.commerce.revenue.length === 0 ? (
              <p className="text-sm text-muted-foreground">در این بازه سفارش پرداخت‌شده‌ای ثبت نشده است.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {overview.commerce.revenue.map((row) => (
                  <li className="flex items-baseline justify-between gap-3" key={row.code}>
                    <span className="text-muted-foreground">
                      {CURRENCY_LABELS[row.code] ?? row.code}
                      <span className="ms-2 text-xs text-muted-foreground">
                        {formatPersianNumber(row.orders)} سفارش
                      </span>
                    </span>
                    <span className="font-semibold tabular-nums">
                      {formatPersianNumber(row.minorTotal)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {overview.commerce.revenueTruncated ? (
              <p className="mt-3 text-xs text-amber-700/80 dark:text-amber-300/80">
                این جمع از سقف پیمایش گذشته و کامل نیست؛ بازهٔ کوتاه‌تری انتخاب کنید.
              </p>
            ) : null}
            {/* Two currencies are never added together: an order snapshots the
                currency it sold in, so one total would be a fabricated number. */}
            <p className="mt-3 text-xs leading-6 text-muted-foreground">
              مبالغ به واحد خردِ همان سایت است و بین واحدهای پول جمع نمی‌شود.
            </p>
          </Card>

          <Card title="زیرساخت">
            <dl className="space-y-2 text-sm">
              <Row
                label="فضای ذخیره‌سازی ابری"
                tone={
                  overview.infrastructure.storage.usable
                    ? "ok"
                    : overview.infrastructure.storage.enabled
                      ? "bad"
                      : "warn"
                }
                value={
                  overview.infrastructure.storage.usable
                    ? (overview.infrastructure.storage.bucket ?? "فعال")
                    : overview.infrastructure.storage.enabled
                      ? "فعال است اما کلید آن خوانده نمی‌شود"
                      : "فعال نیست (فایل‌ها روی دیسک)"
                }
              />
              <Row
                label="کلیدهای API"
                value={`${formatPersianNumber(overview.infrastructure.keys.total)} کلید، ${formatPersianNumber(overview.infrastructure.keys.disabled)} لغوشده`}
              />
              <Row
                label="زون‌های CDN"
                value={formatPersianNumber(overview.infrastructure.cdnZones)}
              />
              <Row
                label="کاربران سایت‌ساز"
                value={formatPersianNumber(overview.infrastructure.users)}
              />
              <Row
                label="گزارش تولیدشده در"
                value={fmtDate(overview.generatedAt)}
              />
            </dl>
          </Card>

          <Card title="درگاه‌های پرداخت">
            {overview.gateways.moduleEnabled ? null : (
              <p className="mb-3 text-xs text-amber-700/80 dark:text-amber-300/80">
                ماژول پرداخت در سایت‌ساز خاموش است؛ هیچ سایتی پرداخت آنلاین نمی‌گیرد.
              </p>
            )}
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs text-muted-foreground">
                  <tr>
                    <th className="pb-2 text-start font-normal">درگاه</th>
                    <th className="pb-2 text-start font-normal">ردیف</th>
                    <th className="pb-2 text-start font-normal">فعال</th>
                    <th className="pb-2 text-start font-normal">خودآزمایی</th>
                  </tr>
                </thead>
                <tbody>
                  {overview.gateways.table.map((row) => (
                    <tr className="border-t border-border" key={row.gateway}>
                      <td className="py-2">
                        {row.label}
                        {row.allowed ? null : (
                          <span className="ms-2 text-xs text-muted-foreground">(مجاز نشده)</span>
                        )}
                      </td>
                      <td className="py-2 tabular-nums">{formatPersianNumber(row.rows)}</td>
                      <td className="py-2 tabular-nums">{formatPersianNumber(row.enabled)}</td>
                      <td className="py-2">
                        <span className="text-emerald-700 dark:text-emerald-300">
                          {formatPersianNumber(row.passingSelfTest)}
                        </span>
                        <span className="mx-1 text-muted-foreground">/</span>
                        <span className={row.failingSelfTest ? "text-red-700 dark:text-red-300" : "text-muted-foreground"}>
                          {formatPersianNumber(row.failingSelfTest)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <Card title="آخرین همگام‌سازی‌ها">
            {runs.length === 0 ? (
              <p className="text-sm text-muted-foreground">هنوز همگام‌سازی‌ای ثبت نشده است.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {runs.slice(0, 6).map((run) => (
                  <li className="flex flex-wrap items-baseline justify-between gap-2" key={run.id}>
                    <span className="text-muted-foreground">
                      {run.kind}
                      {run.dryRun ? <span className="ms-1 text-xs">(آزمایشی)</span> : null}
                    </span>
                    <span className={syncStatusTone(run.status)}>
                      {formatPersianNumber(run.items)} مورد
                    </span>
                    <span className="text-xs text-muted-foreground">{fmtDate(run.createdAt)}</span>
                  </li>
                ))}
              </ul>
            )}
            <Link
              className="mt-3 inline-block text-xs text-sky-700 dark:text-sky-300 hover:underline"
              href="/platform/cms/sync"
            >
              همهٔ همگام‌سازی‌ها
            </Link>
          </Card>
        </div>
      ) : (
        <Card title="گزارش زنده">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <CloudOff className="size-4" />
            گزارش زندهٔ سایت‌ساز خوانده نشد.
          </div>
        </Card>
      )}
    </div>
  );
}

function Row({
  label,
  tone = "neutral",
  value,
}: {
  label: string;
  tone?: "bad" | "neutral" | "ok" | "warn";
  value: string;
}) {
  const toneCls = {
    bad: "text-red-700 dark:text-red-300",
    neutral: "text-foreground",
    ok: "text-emerald-700 dark:text-emerald-300",
    warn: "text-amber-700 dark:text-amber-300",
  }[tone];
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={`font-medium ${toneCls}`}>{value}</dd>
    </div>
  );
}
