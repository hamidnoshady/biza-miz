"use client";

import { SectionCardSkeleton } from "@/app/dashboard/page-chrome";

/**
 * Growth & Marketing data as accounting sees it (Phase 36b, revised).
 *
 * Shared by the Reports entry and the Accounting (ledger) section — both want the
 * same view of growth's money: the bridge balances (۲۴۱۰ / ۲۴۲۰ / ۲۳۰۰ / ۵۲۱۰)
 * and the rolling KPIs. The growth app never links here; the data simply lands in
 * the ledger in the backend, and these surfaces read it back out of the books.
 */

import { useCallback, useEffect, useState } from "react";
import { useMoney } from "@/components/money/money-context";
import { formatPersianNumber, toPersianDigits } from "@/lib/digits";
import { SectionCard, cardClass } from "@/app/dashboard/page-chrome";
import { api, ErrorBox } from "@/app/dashboard/ui";

interface BridgeRow {
  code: string;
  name: string;
  type: string;
  balance: number;
}

interface ProjectCostRow {
  projectId: string; name: string; status: string; ownerName: string | null;
  spentRial: number; budgetRial: number | null; remainingBudgetRial: number | null; campaigns: number;
}

interface CampaignRoiRow {
  campaignId: string; campaignName: string; promotionId: string; promotionName: string;
  sentCount: number; spentRial: number; attributableSales: number;
  attributableRevenueRial: number; discountRial: number; roiPercent: number | null;
}

interface GrowthAccountingData {
  window: { from: string; to: string };
  bridge: BridgeRow[];
  campaigns: { discountRial: number; applications: number; counts: Record<string, number> };
  giftCards: { outstandingRial: number; issued30d: number; issuedValue30d: number };
  loyalty: { pointsOutstanding: number; pointsValueEstimate: number; customersWithPoints: number; customersTotal: number };
  /** `null` without `commission.view` — removed server-side (growth-access.ts). */
  commission: { accrued30d: number; top: { employeeId: string; employeeName: string; amount: number }[] } | null;
}

function KpiTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className={`min-w-0 p-4 sm:p-5 ${cardClass}`}>
      <p className="text-xs font-medium leading-5 text-muted-foreground">{label}</p>
      <p className="mt-2 truncate text-xl font-bold tracking-tight text-foreground sm:text-2xl">{value}</p>
      {hint ? <p className="mt-1 text-xs leading-5 text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function GrowthAccountingView() {
  const money = useMoney();
  const [data, setData] = useState<GrowthAccountingData | null>(null);
  /*
   * `null` means "not readable", which is not the same as "empty" (issue #819).
   * Both reports are consolidated and need `reports.business_wide`; a member
   * without it is refused, and painting «پروژهٔ فعالی با هزینهٔ کمپین ندارید» on
   * top of that refusal states as fact something the member was never shown.
   * So the cards are drawn from what actually arrived.
   */
  const [projectCosts, setProjectCosts] = useState<ProjectCostRow[] | null>(null);
  const [campaignRoi, setCampaignRoi] = useState<CampaignRoiRow[] | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    api<GrowthAccountingData>("/api/growth/accounting")
      .then(({ ok, data: body }) => {
        if (ok) setData(body);
        else setError("بارگذاری داده‌های رشد ناموفق بود.");
      })
      .catch(() => setError("بارگذاری داده‌های رشد ناموفق بود."));
    api<{ rows: ProjectCostRow[] }>("/api/reports/project-costs")
      .then(({ ok, data: body }) => setProjectCosts(ok ? (body.rows ?? []) : null))
      .catch(() => setProjectCosts(null));
    api<{ rows: CampaignRoiRow[] }>("/api/reports/message-campaign-roi")
      .then(({ ok, data: body }) => setCampaignRoi(ok ? (body.rows ?? []) : null))
      .catch(() => setCampaignRoi(null));
  }, []);
  useEffect(load, [load]);

  if (error) return <ErrorBox>{error}</ErrorBox>;
  if (!data) {
    return (
      <SectionCardSkeleton rows={4} />
    );
  }

  return (
    <div className="space-y-4 sm:space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <KpiTile
          label="بدهی کارت هدیه (۲۴۲۰)"
          value={money.format(data.giftCards.outstandingRial)}
          hint={`${formatPersianNumber(data.giftCards.issued30d)} کارت در ۳۰ روز گذشته صادر شد`}
        />
        <KpiTile
          label="اعتبار فروشگاهی مشتریان (۲۴۱۰)"
          value={money.format(
            data.bridge.find((row) => row.code === "2410")?.balance ?? 0,
          )}
          hint={`${formatPersianNumber(data.loyalty.customersWithPoints)} مشتری صاحب امتیاز`}
        />
        {data.commission ? (
          <KpiTile
            label="پورسانت فروشندگان · ۳۰ روز گذشته"
            value={money.format(data.commission.accrued30d)}
            hint="هزینه ۵۲۱۰، بدهی حقوق ۲۳۰۰"
          />
        ) : null}
        <KpiTile
          label="تخفیف کمپین‌ها · ۳۰ روز گذشته"
          value={money.format(data.campaigns.discountRial)}
          hint={`${formatPersianNumber(data.campaigns.applications)} بار اعمال روی فروش`}
        />
        <KpiTile
          label="امتیاز در گردش"
          value={formatPersianNumber(data.loyalty.pointsOutstanding)}
          hint={`ارزش تخمینی بازخرید ${money.format(data.loyalty.pointsValueEstimate)}`}
        />
      </div>

      <SectionCard
        title="تراز حساب‌های رشد"
        description="ماندهٔ حساب‌هایی که برنامهٔ رشد در دفتر کل می‌سازد — بازسازی‌شده از اسناد، نه از خود برنامه."
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-[28rem] text-sm">
            <thead>
              <tr className="border-b border-border/80 text-xs text-muted-foreground">
                <th className="px-3 py-2 text-right font-medium">حساب</th>
                <th className="px-3 py-2 text-right font-medium">نام</th>
                <th className="px-3 py-2 text-left font-medium" dir="ltr">کد</th>
                <th className="px-3 py-2 text-left font-medium">مانده</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/80">
              {data.bridge.map((row) => (
                <tr key={row.code}>
                  <td className="px-3 py-2.5 text-foreground">{row.name}</td>
                  <td className="px-3 py-2.5 text-muted-foreground">{row.type === "liability" ? "بدهی" : row.type === "expense" ? "هزینه" : row.type}</td>
                  <td className="px-3 py-2.5 text-left text-muted-foreground" dir="ltr">{toPersianDigits(row.code)}</td>
                  <td className="px-3 py-2.5 text-left font-semibold text-foreground">{money.format(row.balance)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>

      {projectCosts === null ? null : (
      <SectionCard title="هزینهٔ پروژه‌ها" description="خرج هر پروژه از اسناد هزینهٔ قطعیِ کمپین پیام بازسازی می‌شود؛ کمپین بدون سند هزینه، خرج ثبت‌شده ندارد.">
        {projectCosts.length === 0 ? <p className="text-sm text-muted-foreground">پروژهٔ فعالی با هزینهٔ کمپین ندارید.</p> : <ul className="divide-y divide-border/80 text-sm">{projectCosts.map((project) => <li key={project.projectId} className="flex flex-wrap items-center justify-between gap-2 py-2.5"><div><b>{project.name}</b><p className="text-xs text-muted-foreground">{project.ownerName ?? "بدون مالک"} · {formatPersianNumber(project.campaigns)} کمپین · {project.status === "active" ? "فعال" : project.status === "paused" ? "متوقف" : "تکمیل‌شده"}</p></div><div className="text-left"><b>{money.format(project.spentRial)}</b><p className="text-xs text-muted-foreground">{project.remainingBudgetRial === null ? "بدون بودجه" : `مانده ${money.format(project.remainingBudgetRial)}`}</p></div></li>)}</ul>}
      </SectionCard>
      )}

      {campaignRoi === null ? null : (
      <SectionCard title="بازدهِ قابل‌انتساب کمپین پیام" description="فقط سفارش‌هایی شمرده می‌شوند که پروموشن اختصاصیِ همان کمپین را پس از شروع آن اعمال کرده‌اند. بدون پروموشن اختصاصی، هیچ فروشی حدس زده نمی‌شود.">
        {campaignRoi.length === 0 ? <p className="text-sm text-muted-foreground">هنوز کمپینی با پروموشن اختصاصی برای گزارش بازده ثبت نشده است.</p> : <ul className="divide-y divide-border/80 text-sm">{campaignRoi.map((row) => <li key={row.campaignId} className="flex flex-wrap items-center justify-between gap-3 py-3"><div><b>{row.campaignName}</b><p className="mt-1 text-xs text-muted-foreground">پروموشن: {row.promotionName} · {formatPersianNumber(row.attributableSales)} فروشِ ثبت‌شده · {formatPersianNumber(row.sentCount)} ارسال</p></div><div className="text-left"><b>{row.roiPercent === null ? "در انتظار ثبت هزینه" : `${formatPersianNumber(row.roiPercent)}٪ بازده`}</b><p className="text-xs text-muted-foreground">فروش {money.format(row.attributableRevenueRial)} · هزینه {money.format(row.spentRial)} · تخفیف {money.format(row.discountRial)}</p></div></li>)}</ul>}
      </SectionCard>
      )}

      {data.commission && data.commission.top.length > 0 ? (
        <SectionCard title="برترین فروشندگان" description="پورسانت انباشته در ۳۰ روز گذشته">
          <ul className="divide-y divide-border/80 text-sm">
            {data.commission.top.map((row) => (
              <li key={row.employeeId} className="flex items-center justify-between gap-3 py-2.5">
                <span className="min-w-0 font-medium text-foreground">{row.employeeName}</span>
                <span className="shrink-0 font-semibold text-emerald-700 dark:text-emerald-300">{money.format(row.amount)}</span>
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}
    </div>
  );
}
