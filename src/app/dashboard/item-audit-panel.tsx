"use client";

import { LoadingSkeleton } from "@/app/dashboard/page-chrome";

/**
 * Phase 21 Wave 7 — the item-level audit trail, shared by the jewelry and
 * watch boards (both sell high-value goods where "who changed this, and
 * when" is a real question). Reads the same domain-event log the postings
 * came from, so a posted event shows its journal entry and a
 * recorded-only lifecycle event shows none.
 */
import { useCallback, useEffect, useState } from "react";
import { formatJalali } from "@/lib/jalali";
import { journalMemoForDisplay } from "@/lib/journal-memo";
import { api } from "./ui";

const EVENT_LABELS: Record<string, string> = {
  "item.created": "ثبت کالا",
  "item.cost_basis_changed": "تغییر بها/مشخصات",
  "item.stone_added": "افزودن سنگ",
  "item.stone_removed": "حذف سنگ",
  "item.consigned": "امانی شد",
  "item.stock_received": "ورود کالا",
  "item.price_changed": "تغییر قیمت فروش",
  "gold.sale_revenue": "فروش (درآمد)",
  "gold.sale_cogs": "فروش (بهای تمام‌شده)",
  "gold.consignment_sale_revenue": "فروش امانی",
  "watch.sale_revenue": "فروش (درآمد)",
  "watch.sale_cogs": "فروش (بهای تمام‌شده)",
  "watch.repair_revenue": "تعمیر (درآمد)",
  "watch.repair_cogs": "تعمیر (بهای قطعات)",
  "accessory.sale_revenue": "فروش (درآمد)",
  "accessory.sale_cogs": "فروش (بهای تمام‌شده)",
};

export interface ItemAuditEntry {
  id: string;
  eventType: string;
  entryId: string | null;
  entryDate: string | null;
  memo: string | null;
  sourceType: string | null;
  createdByName: string | null;
  createdAt: string;
}

export function ItemAuditPanel({ itemId }: { itemId: string }) {
  const [trail, setTrail] = useState<ItemAuditEntry[] | null>(null);

  const load = useCallback(() => {
    api<{ trail: ItemAuditEntry[] }>(`/api/industry/items/${itemId}/audit`).then(({ ok, data }) => {
      if (ok) setTrail(data.trail);
    });
  }, [itemId]);
  useEffect(load, [load]);

  return (
    <div className="rounded-xl bg-amber-50/60 dark:bg-amber-500/15 p-3 sm:p-4">
      {trail === null ? <LoadingSkeleton rows={3} compact /> : null}
      {trail?.length === 0 ? (
        <p className="text-xs text-muted-foreground">رویدادی ثبت نشده است.</p>
      ) : null}
      <ol className="space-y-2">
        {(trail ?? []).map((entry) => (
          <li key={entry.id} className="flex flex-wrap items-baseline justify-between gap-2 text-xs text-foreground/80">
            <span className="font-medium text-foreground">
              {EVENT_LABELS[entry.eventType] ?? entry.eventType}
              {entry.createdByName ? <span className="text-muted-foreground"> — {entry.createdByName}</span> : null}
            </span>
            <span className="text-muted-foreground">
              {formatJalali(entry.createdAt.slice(0, 10), { withMonthName: true })}
              {entry.entryId ? (
                <span className="ms-2 rounded-full bg-emerald-100 dark:bg-emerald-500/20 px-2 py-0.5 font-medium text-emerald-900 dark:text-emerald-100">
                  سند حسابداری{entry.memo ? `: ${journalMemoForDisplay(entry.memo, entry.sourceType)}` : ""}
                </span>
              ) : (
                <span className="ms-2 rounded-full bg-muted px-2 py-0.5 font-medium text-muted-foreground">
                  بدون اثر حسابداری
                </span>
              )}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
