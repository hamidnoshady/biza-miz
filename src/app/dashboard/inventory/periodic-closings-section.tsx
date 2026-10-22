"use client";

/**
 * سیستم ادواری — بستن دوره انبار.
 *
 * Shown only to a business whose setup chose the periodic system. The user
 * enters the period-end date and the counted quantity of every item; the
 * server values the count under the locked method (میانگین موزون کلاسیک /
 * FIFO / LIFO ادواری) and posts COGS = اول دوره + خرید − پایان دوره in one
 * closing entry (see periodic-closing-service.ts).
 */
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useCallback, useEffect, useState } from "react";
import { formatQuantity } from "@/lib/digits";
import { useMoney } from "@/components/money/money-context";
import { formatJalali } from "@/lib/jalali";
import { api, Field, inputClass } from "../ui";
import { Button } from "@/components/ui/button";
import { JalaliDatePicker } from "../jalali-date-picker";
import type { InventoryItem, Runner } from "./inventory-manager";
import { LoadingSkeleton, EmptyState, SectionCard } from "../page-chrome";

interface ClosingRow {
  id: string;
  periodEnd: string;
  method: string;
  beginningValueRial: string;
  purchasesValueRial: string;
  endingValueRial: string;
  cogsValueRial: string;
  note: string | null;
  createdAt: string;
}

const METHOD_LABELS: Record<string, string> = {
  fifo: "FIFO (ادواری)",
  lifo: "LIFO (ادواری)",
  weighted_average: "میانگین موزون",
};

export function PeriodicClosingsSection({
  items,
  busy,
  run,
}: {
  items: InventoryItem[];
  busy: boolean;
  run: Runner;
}) {
  const money = useMoney();
  const [closings, setClosings] = useState<ClosingRow[] | null>(null);
  const [periodEnd, setPeriodEnd] = useState("");
  const [note, setNote] = useState("");
  const [counts, setCounts] = useState<Record<string, string>>({});

  const loadClosings = useCallback(() => {
    void api<{ closings: ClosingRow[] }>("/api/inventory/periodic-closings")
      .then(({ ok, data }) => setClosings(ok ? data.closings : []))
      .catch(() => setClosings([]));
  }, []);
  useEffect(loadClosings, [loadClosings]);

  const activeItems = items.filter((i) => i.is_active);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!periodEnd) return;
    const lines = activeItems.map((item) => ({
      inventoryItemId: item.id,
      countedQty: (counts[item.id] ?? "").trim() || "0",
    }));
    const ok = await run(() =>
      api("/api/inventory/periodic-closings", {
        method: "POST",
        body: JSON.stringify({ periodEnd, note: note.trim() || undefined, lines }),
      }),
    );
    if (ok) {
      setCounts({});
      setNote("");
      setPeriodEnd("");
      loadClosings();
    }
  }

  return (
    <div className="space-y-4 sm:space-y-5">
      <SectionCard
        title={
          <div>
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">سیستم ادواری</p>
            <h2 className="mt-1 font-semibold text-foreground">بستن دوره انبار</h2>
          </div>
        }
        description="موجودی پایان دوره را بشمارید؛ بهای تمام‌شدهٔ دوره به صورت «اول دوره + خرید − پایان دوره» محاسبه و سند آن صادر می‌شود. کالایی که موجود نیست را صفر بگذارید."
      >
        <form onSubmit={submit} className="space-y-4">
          <div className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <Field label="تاریخ پایان دوره">
              <JalaliDatePicker value={periodEnd} onChange={setPeriodEnd} placeholder="انتخاب تاریخ" />
            </Field>
            <Field label="یادداشت">
              <input className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} placeholder="اختیاری" />
            </Field>
          </div>
          {activeItems.length === 0 ? (
            <EmptyState>هنوز قلمی در انبار تعریف نشده است.</EmptyState>
          ) : (
            <div className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {activeItems.map((item) => (
                <Field key={item.id} label={`${item.name} (${item.unit})`}>
                  <PersianNumberInput
                    className={inputClass}
                    dir="ltr"
                    inputMode="decimal"
                    value={counts[item.id] ?? ""}
                    onChange={(e) => setCounts((prev) => ({ ...prev, [item.id]: e.target.value }))}
                    placeholder="۰"
                  />
                </Field>
              ))}
            </div>
          )}
          <Button type="submit" disabled={busy || !periodEnd || activeItems.length === 0} size="lg" className="px-5 font-semibold">
            ثبت بستن دوره
          </Button>
        </form>
      </SectionCard>

      <SectionCard
        title={
          <div>
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">سوابق</p>
            <h2 className="mt-1 font-semibold text-foreground">دوره‌های بسته‌شده</h2>
          </div>
        }
        flush
      >
        {closings === null ? (
          <div className="p-4 sm:p-5">
            <LoadingSkeleton rows={3} label="در حال بارگذاری دوره‌ها" />
          </div>
        ) : closings.length === 0 ? (
          <div className="p-4 sm:p-5">
            <EmptyState>هنوز دوره‌ای بسته نشده است.</EmptyState>
          </div>
        ) : (
          <ul className="divide-y divide-border/80">
            {closings.map((c) => (
              <li key={c.id} className="min-w-0 space-y-1 px-4 py-3 text-sm">
                <div className="flex min-w-0 flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                  <span className="font-medium text-foreground">
                    پایان دوره: {formatJalali(c.periodEnd)}
                    <span className="text-muted-foreground"> ({METHOD_LABELS[c.method] ?? c.method})</span>
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">{formatJalali(c.createdAt)}</span>
                </div>
                <div className="text-xs leading-6 text-muted-foreground">
                  اول دوره: <span className="font-medium text-foreground">{money.formatText(c.beginningValueRial)}</span>
                  {" — "}خرید طی دوره: <span className="font-medium text-foreground">{money.formatText(c.purchasesValueRial)}</span>
                  {" — "}پایان دوره: <span className="font-medium text-foreground">{money.formatText(c.endingValueRial)}</span>
                  {" — "}بهای تمام‌شده: <span className="font-medium text-foreground">{money.formatText(c.cogsValueRial)}</span>
                </div>
                {c.note ? <div className="text-xs text-muted-foreground">{c.note}</div> : null}
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
