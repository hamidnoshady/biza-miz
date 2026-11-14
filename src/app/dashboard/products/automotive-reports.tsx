"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useMoney } from "@/components/money/money-context";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { SectionCard, SectionCardSkeleton } from "../page-chrome";
import { api } from "../ui";

type Overview = { onDate: string; summary: { inStock: number; reserved: number; sold: number; soldThisMonth: number; averageAgeDays: number | null; slowCount: number; deadCount: number; stockValueRial?: number; askingValueRial?: number; potentialMarginRial?: number; revenueThisMonthRial?: number; grossProfitThisMonthRial?: number } };

/** Read the dealership's own redacted stock and sale summary, never variant reports. */
export function AutomotiveReports({ canSeeCost }: { canSeeCost: boolean }) {
  const money = useMoney();
  const [data, setData] = useState<Overview | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(async (signal?: AbortSignal) => {
    setFailed(false); setData(null);
    const result = await api<Overview>("/api/automotive/overview", { signal });
    if (signal?.aborted) return;
    if (!result.ok || !result.data?.summary || !result.data.onDate || !Number.isFinite(Date.parse(result.data.onDate))) setFailed(true);
    else setData(result.data);
  }, []);
  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); }, [load]);
  if (failed) return <SectionCard title="گزارش خودرو"><div role="alert" className="space-y-2"><p>گزارش دریافت نشد.</p><Button variant="outline" onClick={() => void load()}>تلاش دوباره</Button></div></SectionCard>;
  if (!data) return <SectionCardSkeleton rows={4} />;
  const s = data.summary;
  return <div className="space-y-4"><SectionCard title="موجودی شعبهٔ فعال" description={`تا تاریخ ${formatJalali(data.onDate)}`}>
    <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {[["موجود", s.inStock], ["رزرو شده", s.reserved], ["فروخته‌شده", s.sold], ["فروش این ماه", s.soldThisMonth], ["خودروهای کم‌گردش", s.slowCount], ["خودروهای راکد", s.deadCount], ["میانگین روز در موجودی", s.averageAgeDays]].map(([label, value]) => <div key={label} className="min-w-0 rounded-lg border border-border p-3"><dt className="text-sm text-muted-foreground">{label}</dt><dd className="mt-1 font-semibold">{value == null ? "—" : toPersianDigits(value)}</dd></div>)}
    </dl>
  </SectionCard>{canSeeCost ? <SectionCard title="ارزش و سود" description="مبالغ هزینه‌محور فقط با دسترسی مشاهدهٔ بهای خودرو نمایش داده می‌شوند."><dl className="grid gap-3 sm:grid-cols-2">{[["ارزش موجودی", s.stockValueRial], ["جمع قیمت‌های پیشنهادی", s.askingValueRial], ["سود بالقوه", s.potentialMarginRial], ["درآمد این ماه", s.revenueThisMonthRial], ["سود ناخالص این ماه", s.grossProfitThisMonthRial]].map(([label, value]) => <div key={label} className="min-w-0 rounded-lg border border-border p-3"><dt className="text-sm text-muted-foreground">{label}</dt><dd className="mt-1 font-semibold">{typeof value === "number" ? money.format(value) : "—"}</dd></div>)}</dl></SectionCard> : null}</div>;
}
