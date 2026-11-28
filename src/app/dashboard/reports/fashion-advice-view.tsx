"use client";

/**
 * GH #1567 Phase 6E — «پیشنهادهای خرید و چیدمان (مشورتی)».
 *
 * Display only: every row shows what to consider, the numbers behind it and
 * the rule that produced it. There is deliberately no button here — no
 * "order", no "apply markdown" — because the advice is advisory and every
 * stock or money write already has its own reviewed screen.
 */
import { InfoIcon } from "lucide-react";
import { formatPersianNumber, toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import type { AdviceConfidence, AdviceKind, AdviceReport, AdviceRow } from "@/lib/fashion-merchandising-advice";
import { EmptyState, StatusBadge } from "../page-chrome";
import { ReportTable } from "./report-table";
import { StatStrip } from "./trade-report-views";

export const ADVICE_KIND_LABEL: Record<AdviceKind, string> = {
  reorder: "سفارش دوباره",
  size_gap: "تکمیل سری سایز",
  overstock: "مازاد موجودی",
  markdown_review: "بررسی تخفیف",
};

const KIND_TONE: Record<AdviceKind, "active" | "positive" | "neutral" | "danger"> = {
  reorder: "positive",
  size_gap: "active",
  overstock: "neutral",
  markdown_review: "danger",
};

const CONFIDENCE_LABEL: Record<AdviceConfidence, string> = { high: "زیاد", medium: "متوسط", low: "کم" };

export function FashionAdviceView({ report }: { report: AdviceReport }) {
  const rows = report.rows ?? [];
  const summary = report.summary;
  return (
    <div className="min-w-0 space-y-3">
      <p role="note" className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 p-3 text-sm">
        <InfoIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <span>{report.notice}</span>
      </p>
      {summary ? (
        <StatStrip
          stats={[
            { label: ADVICE_KIND_LABEL.reorder, value: formatPersianNumber(summary.reorder) },
            { label: ADVICE_KIND_LABEL.size_gap, value: formatPersianNumber(summary.size_gap) },
            { label: ADVICE_KIND_LABEL.overstock, value: formatPersianNumber(summary.overstock) },
            { label: ADVICE_KIND_LABEL.markdown_review, value: formatPersianNumber(summary.markdown_review) },
          ]}
        />
      ) : null}
      <ReportTable<AdviceRow>
        caption="پیشنهادهای مشورتی خرید و چیدمان"
        rows={rows}
        rowKey={(row) => `${row.kind}:${row.itemId}`}
        empty={<EmptyState>در این بازه پیشنهادی نیست.</EmptyState>}
        cardTitle={(row) => `${row.styleName} — ${row.variantLabel}`}
        breakpoint="lg"
        columns={[
          { key: "kind", header: "پیشنهاد", cell: (row) => <StatusBadge tone={KIND_TONE[row.kind]}>{ADVICE_KIND_LABEL[row.kind]}</StatusBadge> },
          { key: "item", header: "مدل / تنوع", cell: (row) => <span><span className="block">{row.styleName}</span><span className="block text-xs text-muted-foreground">{row.variantLabel}</span></span> },
          { key: "qty", header: "تعداد پیشنهادی", numeric: true, align: "end", cell: (row) => (row.suggestedQuantity != null ? formatPersianNumber(row.suggestedQuantity) : "—") },
          { key: "sold", header: "فروش خالص", numeric: true, align: "end", cell: (row) => formatPersianNumber(row.metrics.soldUnits) },
          { key: "onHand", header: "موجودی", numeric: true, align: "end", cell: (row) => formatPersianNumber(row.metrics.onHand) },
          { key: "cover", header: "پوشش (هفته)", numeric: true, align: "end", cell: (row) => (row.metrics.coverWeeks != null ? toPersianDigits(String(row.metrics.coverWeeks)) : "—") },
          { key: "confidence", header: "اطمینان", muted: true, cell: (row) => CONFIDENCE_LABEL[row.confidence] },
          {
            key: "why",
            header: "چرا",
            cell: (row) => (
              <details>
                <summary className="cursor-pointer text-sm">{row.reason}</summary>
                <dl className="mt-1 space-y-0.5 text-xs text-muted-foreground" aria-label={`مبنای پیشنهاد ${row.variantLabel}`}>
                  <div><dt className="inline">قاعده: </dt><dd className="inline" dir="ltr">{row.provenance.rule}</dd></div>
                  <div><dt className="inline">محاسبه: </dt><dd className="inline" dir="ltr">{row.provenance.formula}</dd></div>
                </dl>
              </details>
            ),
          },
        ]}
      />
      <p className="text-xs text-muted-foreground">
        بازه: {toPersianDigits(formatJalali(`${report.window.from}T12:00:00Z`))} تا {toPersianDigits(formatJalali(`${report.window.to}T12:00:00Z`))} ({formatPersianNumber(report.window.days)} روز)
        {" — "}منابع: {report.sources.join("، ")}
        {summary?.excludedConsigned ? ` — ${formatPersianNumber(summary.excludedConsigned)} تنوع امانی کنار گذاشته شد.` : ""}
      </p>
    </div>
  );
}
