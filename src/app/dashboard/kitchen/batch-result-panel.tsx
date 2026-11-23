"use client";

import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  ClockIcon,
  MinusCircleIcon,
  XCircleIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { toPersianDigits } from "@/lib/digits";
import { ORDER_ITEM_STATUS_LABELS, type OrderItemStatus } from "@/lib/order-item-status";
import type { BatchActionStatus } from "./batch-action-dialog";

export type KitchenBatchOutcomeKind =
  | "applied"
  | "already_applied"
  | "conflict"
  | "ineligible"
  | "missing"
  | "queued";

export interface KitchenBatchOutcomeItem {
  itemId: string;
  outcome: KitchenBatchOutcomeKind;
  currentStatus: OrderItemStatus | null;
  nameSnapshot: string | null;
  quantity: number | null;
}

export interface KitchenBatchOutcome {
  orderNumber: number;
  status: BatchActionStatus;
  items: KitchenBatchOutcomeItem[];
  /** True only when the request never reached the server and was queued. */
  queued: boolean;
}

const OUTCOME_META: Record<
  KitchenBatchOutcomeKind,
  { label: string; className: string; icon: typeof CheckCircle2Icon }
> = {
  applied: {
    label: "ثبت شد",
    className: "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300",
    icon: CheckCircle2Icon,
  },
  already_applied: {
    label: "قبلاً ثبت شده بود",
    className: "border-border bg-muted text-muted-foreground",
    icon: MinusCircleIcon,
  },
  conflict: {
    label: "توسط همکار دیگر تغییر کرده بود",
    className: "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/15 dark:text-amber-300",
    icon: AlertTriangleIcon,
  },
  ineligible: {
    label: "قابل تغییر نبود",
    className: "border-border bg-muted text-muted-foreground",
    icon: XCircleIcon,
  },
  missing: {
    label: "پیدا نشد",
    className: "border-destructive/30 bg-destructive/5 text-destructive",
    icon: XCircleIcon,
  },
  queued: {
    label: "در صف همگام‌سازی",
    className: "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/15 dark:text-amber-300",
    icon: ClockIcon,
  },
};

/**
 * Truthful result for a ticket-wide action. It reports exactly what the
 * server (or the offline queue) said, per line, and never turns a partial
 * outcome into a green "everything succeeded" banner.
 */
export function KitchenBatchResultPanel({
  outcome,
  onDismiss,
}: {
  outcome: KitchenBatchOutcome;
  onDismiss: () => void;
}) {
  const counts = {
    applied: 0,
    already: 0,
    conflict: 0,
    ineligible: 0,
    missing: 0,
    queued: 0,
  };
  for (const item of outcome.items) {
    if (item.outcome === "applied") counts.applied += 1;
    else if (item.outcome === "already_applied") counts.already += 1;
    else if (item.outcome === "conflict") counts.conflict += 1;
    else if (item.outcome === "ineligible") counts.ineligible += 1;
    else if (item.outcome === "missing") counts.missing += 1;
    else counts.queued += 1;
  }

  const hasProblem = counts.conflict + counts.ineligible + counts.missing > 0;
  const tone = outcome.queued
    ? "border-amber-200 bg-amber-50/60 dark:border-amber-500/30 dark:bg-amber-500/10"
    : hasProblem
      ? "border-amber-200 bg-amber-50/60 dark:border-amber-500/30 dark:bg-amber-500/10"
      : "border-emerald-200 bg-emerald-50/60 dark:border-emerald-800 dark:bg-emerald-500/10";

  const parts = outcome.queued
    ? [`${toPersianDigits(counts.queued)} قلم در صف همگام‌سازی است و هنوز روی سرور اعمال نشده است.`]
    : [
        counts.applied ? `${toPersianDigits(counts.applied)} قلم ثبت شد.` : "",
        counts.already ? `${toPersianDigits(counts.already)} قلم از قبل در همین وضعیت بود.` : "",
        counts.conflict ? `${toPersianDigits(counts.conflict)} قلم توسط همکار دیگر تغییر کرده بود.` : "",
        counts.ineligible ? `${toPersianDigits(counts.ineligible)} قلم سروشده/باطل/در انتظار قابل تغییر نبود.` : "",
        counts.missing ? `${toPersianDigits(counts.missing)} قلم پیدا نشد.` : "",
      ].filter(Boolean);

  return (
    <section
      className={`rounded-xl border p-4 ${tone}`}
      role={hasProblem || outcome.queued ? "alert" : "status"}
      aria-live="polite"
      aria-label="نتیجهٔ اقدام گروهی آشپزخانه"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-bold text-foreground">
            {outcome.queued ? "اقدام گروهی در صف همگام‌سازی" : "نتیجهٔ اقدام گروهی"}
          </h2>
          <p className="mt-1 text-sm text-foreground/80">
            سفارش {toPersianDigits(outcome.orderNumber)} ·{" "}
            {outcome.status === "ready" ? "علامت‌گذاری به‌عنوان آماده" : "شروع آماده‌سازی"}
          </p>
        </div>
        <Button type="button" variant="outline" className="min-h-10" onClick={onDismiss}>
          بستن نتیجه
        </Button>
      </div>

      <p className="mt-3 text-sm font-medium text-foreground/80">
        {parts.length > 0 ? parts.join(" ") : "هیچ قلمی واجد شرایط این اقدام نبود."}
      </p>

      {outcome.items.length > 0 ? (
        <ul className="mt-3 divide-y divide-border rounded-xl border border-border bg-card">
          {outcome.items.map((item) => {
            const meta = OUTCOME_META[item.outcome];
            const Icon = meta.icon;
            return (
              <li key={item.itemId} className="flex flex-wrap items-start justify-between gap-2 p-3">
                <div className="min-w-0">
                  <p className="break-words font-semibold text-foreground/80">
                    {item.quantity !== null ? `${toPersianDigits(item.quantity)}× ` : ""}
                    {item.nameSnapshot ?? "قلم ناشناخته"}
                  </p>
                  {item.currentStatus ? (
                    <p className="mt-1 text-xs text-muted-foreground">
                      وضعیت فعلی: {ORDER_ITEM_STATUS_LABELS[item.currentStatus]}
                    </p>
                  ) : null}
                </div>
                <span
                  className={`inline-flex shrink-0 items-center gap-1.5 rounded-xl border px-2 py-1 text-xs font-semibold ${meta.className}`}
                >
                  <Icon className="size-3.5" aria-hidden="true" />
                  {meta.label}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
