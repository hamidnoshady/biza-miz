"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useMoney } from "@/components/money/money-context";
import { formatQuantity, toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { PURITY_LABELS, type Purity } from "../jewelry/jewelry-manager";
import { EmptyState, SectionCard, SectionCardSkeleton } from "../page-chrome";
import { api } from "../ui";

type Count = { id: string; countDate: string; purity: Purity; countedWeight: string; systemWeight: string; variance: string; variancePercent: number | null };
type Reconciliation = { purity: Purity; systemWeight: string; pieces: number; lastCount: Count | null };
type Summary = { consignorId: string; name: string; itemsOnHand: number; totalOwed: number; totalPaid: number; balance: number };
type Data = { reconciliation: Reconciliation[]; counts: Count[]; summaries: Summary[] };

/** Native report reads only. Counting and payouts remain in the specialist workflow. */
export function JewelryReports() {
  const [data, setData] = useState<Data | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const money = useMoney();
  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setFailed(false);
    const [counts, consignors] = await Promise.all([
      api<{ reconciliation?: Reconciliation[]; counts?: Count[] }>("/api/jewelry/reports/weight-counts", { signal }),
      api<{ summaries?: Summary[] }>("/api/jewelry/reports/consignors", { signal }),
    ]);
    if (signal?.aborted) return;
    if (!counts.ok || !consignors.ok || !Array.isArray(counts.data.reconciliation) || !Array.isArray(counts.data.counts) || !Array.isArray(consignors.data.summaries)) {
      setFailed(true);
    } else {
      setData({ reconciliation: counts.data.reconciliation, counts: counts.data.counts, summaries: consignors.data.summaries });
    }
    setLoading(false);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);
  if (loading) return <SectionCardSkeleton rows={5} />;
  if (failed || !data) return <SectionCard title="گزارش‌های طلا و جواهر"><div role="alert" className="space-y-2 text-sm"><p>گزارش کامل دریافت نشد؛ اتصال و دسترسی را بررسی کنید.</p><Button variant="outline" onClick={() => void load()}>تلاش دوباره</Button></div></SectionCard>;
  return (
    <div className="space-y-4">
      <SectionCard title="تطبیق وزنی شعبهٔ فعال" description="مغایرت به‌صورت خودکار به حساب‌ها نمی‌رود.">
        {data.reconciliation.length === 0 ? <EmptyState>کالای وزنی موجودی ثبت نشده است.</EmptyState> : <ul className="divide-y divide-border/80">{data.reconciliation.map((row) => <li key={row.purity} className="space-y-1 py-3 text-sm"><h3 className="font-semibold">{PURITY_LABELS[row.purity] ?? row.purity}</h3><p>{formatQuantity(row.systemWeight)} گرم در {toPersianDigits(row.pieces)} قطعه</p><p>{row.lastCount ? `آخرین شمارش ${formatQuantity(row.lastCount.countedWeight)} گرم · مغایرت ${formatQuantity(row.lastCount.variance)} گرم` : "شمارشی ثبت نشده است."}</p></li>)}</ul>}
      </SectionCard>
      <SectionCard title="تاریخچهٔ شمارش شعبهٔ فعال">
        {data.counts.length === 0 ? <EmptyState>شمارشی ثبت نشده است.</EmptyState> : <ul className="divide-y divide-border/80">{data.counts.map((count) => <li key={count.id} className="space-y-1 py-3 text-sm"><p>{formatJalali(count.countDate, { withMonthName: true })} — {PURITY_LABELS[count.purity] ?? count.purity}</p><p>شمارش {formatQuantity(count.countedWeight)} / سیستم {formatQuantity(count.systemWeight)} گرم · مغایرت {formatQuantity(count.variance)}{count.variancePercent != null ? ` (${toPersianDigits(count.variancePercent)}٪)` : ""}</p></li>)}</ul>}
      </SectionCard>
      <SectionCard title="صورت‌حساب امانت‌گذاران" description="ماندهٔ امانی در سطح کسب‌وکار؛ شامل همهٔ شعب.">
        {data.summaries.length === 0 ? <EmptyState>امانت‌گذاری ثبت نشده است.</EmptyState> : <ul className="divide-y divide-border/80">{data.summaries.map((summary) => <li key={summary.consignorId} className="space-y-1 py-3 text-sm"><h3 className="break-words font-semibold">{summary.name}</h3><p>{toPersianDigits(summary.itemsOnHand)} قطعهٔ موجود · بدهی {money.format(summary.totalOwed)} · پرداخت {money.format(summary.totalPaid)} · مانده {money.format(summary.balance)}</p></li>)}</ul>}
      </SectionCard>
    </div>
  );
}
