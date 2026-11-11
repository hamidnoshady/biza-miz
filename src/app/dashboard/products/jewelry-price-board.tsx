"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Button, buttonVariants } from "@/components/ui/button";
import { useMoney } from "@/components/money/money-context";
import { formatJalali } from "@/lib/jalali";
import { PURITY_LABELS, type GoldPriceRow } from "../jewelry/jewelry-manager";
import { EmptyState, SectionCard, SectionCardSkeleton } from "../page-chrome";
import { api } from "../ui";

/** Native gold prices are a separate rate per purity, not variant prices. */
export function JewelryPriceBoard({ canEdit }: { canEdit: boolean }) {
  const [prices, setPrices] = useState<GoldPriceRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const money = useMoney();
  const load = useCallback(async () => {
    setFailed(false);
    const response = await api<{ prices?: GoldPriceRow[] }>("/api/jewelry/prices");
    if (!response.ok || !Array.isArray(response.data.prices)) setFailed(true);
    else setPrices(response.data.prices);
  }, []);
  useEffect(() => { void load(); }, [load]);
  return (
    <SectionCard title="تابلوی نرخ روز طلا" description="نرخ هر گرم بر اساس عیار است و بهای تمام‌شده یا قیمت نهایی هر قطعه نیست. تغییر نرخ از بخش تخصصی طلا انجام می‌شود.">
      {failed ? <div role="alert" className="space-y-2 text-sm"><p>نرخ‌ها دریافت نشدند؛ اتصال و دسترسی را بررسی کنید.</p><Button variant="outline" onClick={() => void load()}>تلاش دوباره</Button></div> : prices === null ? <SectionCardSkeleton rows={3} /> : prices.length === 0 ? <EmptyState>نرخی ثبت نشده است.</EmptyState> : <ul className="divide-y divide-border/80">{prices.map((price) => <li key={price.id} className="flex flex-wrap items-center justify-between gap-3 py-4"><div><h3 className="font-semibold">{PURITY_LABELS[price.purity]}</h3><p className="text-sm text-muted-foreground">{formatJalali(price.priceDate, { withMonthName: true })} · {price.source === "external" ? "سرویس بیرونی" : "ثبت دستی"}</p></div><span>{money.format(price.pricePerGram)} / گرم</span></li>)}</ul>}
      {canEdit ? <Link className={`${buttonVariants({ variant: "outline" })} mt-4`} href="/accounting/jewelry">بخش تخصصی طلا و جواهر</Link> : null}
    </SectionCard>
  );
}
