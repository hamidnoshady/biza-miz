"use client";

import {LoadingSkeleton, cardClass } from "@/app/dashboard/page-chrome";

import { useCallback, useEffect, useState } from "react";
import { formatQuantity } from "@/lib/digits";
import { useMoney } from "@/components/money/money-context";
import { api } from "../ui";

interface VariantSalesRow {
  itemId: string;
  itemName: string;
  parentName: string | null;
  attributes: { name: string; value: string }[];
  quantitySold: string;
  netRevenue: number;
  cogs: number;
  margin: number;
}

export function ReportsSection({ apiBase = "/api/accessories" }: { apiBase?: string }) {
  const money = useMoney();
  const [rows, setRows] = useState<VariantSalesRow[] | null>(null);

  const load = useCallback(() => {
    api<{ rows: VariantSalesRow[] }>(`${apiBase}/reports`).then(({ ok, data }) => {
      if (ok) setRows(data.rows);
    });
  }, [apiBase]);
  useEffect(load, [load]);

  if (!rows) return <LoadingSkeleton rows={3} />;

  return (
    <section aria-labelledby="accessories-reports-heading" className={`min-w-0 overflow-hidden ${cardClass} `}>
      <div className="border-b border-border/80 px-4 py-4 sm:px-5">
        <h2 id="accessories-reports-heading" className="font-semibold text-foreground">
          تحلیل فروش تنوع‌ها
        </h2>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          شامل فروش صندوق و فروش وب‌سایت (ووکامرس و فروشگاه سایت) است. فروشی که بهای تمام‌شده‌اش ثبت
          نشده، با بهای صفر در حاشیه آمده و سود آن موقت است.
        </p>
      </div>

      <ul className="divide-y divide-border/80">
        {rows.map((row) => (
          <li key={row.itemId} className="flex min-w-0 flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-5">
            <div className="min-w-0">
              <h3 className="font-semibold text-foreground">{row.itemName}</h3>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {row.parentName ? (
                  <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{row.parentName}</span>
                ) : null}
                {row.attributes.map((attribute) => (
                  <span
                    key={attribute.name}
                    className="rounded-full bg-amber-100 dark:bg-amber-500/20 px-2 py-0.5 text-xs font-medium text-amber-950 dark:text-amber-200"
                  >
                    {attribute.name}: {attribute.value}
                  </span>
                ))}
              </div>
            </div>
            <div className="text-xs text-muted-foreground">
              فروش {formatQuantity(row.quantitySold)} عدد — درآمد {money.format(row.netRevenue)} / بهای تمام‌شده{" "}
              {money.format(row.cogs)}
              <span className="ms-2 font-semibold text-foreground">حاشیه {money.format(row.margin)}</span>
            </div>
          </li>
        ))}
        {rows.length === 0 ? (
          <li className="px-4 py-5 text-sm text-muted-foreground sm:px-5">هنوز فروشی ثبت نشده است.</li>
        ) : null}
      </ul>
    </section>
  );
}
