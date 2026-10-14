"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { useMoney } from "@/components/money/money-context";
import { api, ErrorBox } from "../../ui";
import { formatJalali } from "@/lib/jalali";
import type {
  BillingEventStatus,
  BillingReconciliationRow,
  BillingReconciliationResponse,
} from "@/lib/platform-company-types";

const STATUS_LABELS: Record<BillingEventStatus, string> = {
  pending: "در صف",
  processing: "در حال پردازش",
  posted: "ثبت‌شده",
  failed: "ناموفق",
  ignored: "نادیده‌گرفته‌شده",
};

const STATUS_CLASSES: Record<BillingEventStatus, string> = {
  pending: "bg-muted/60 text-muted-foreground border-border",
  processing: "bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30",
  posted: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30",
  failed: "bg-destructive/10 text-destructive border-destructive/30",
  ignored: "bg-muted/60 text-muted-foreground border-border",
};

const KIND_LABELS: Record<string, string> = {
  invoice_issued: "صدور صورتحساب",
  invoice_payment: "وصول صورتحساب",
  invoice_void: "ابطال صورتحساب",
  invoice_refund: "بازپرداخت نقدی",
  credit_note: "اعتبار اصلاحی",
  wallet_top_up: "شارژ کیف پول",
  wallet_spend: "مصرف کیف پول",
  wallet_refund: "بازگشت به کیف پول",
  wallet_noncash_credit: "اعتبار غیرنقدی",
  provider_cost: "هزینهٔ تأمین‌کننده",
  adjustment: "تعدیل",
};

const SETTLEMENT_LABELS: Record<string, string> = {
  wallet: "کیف پول",
  gateway: "درگاه",
  manual: "پرداخت دستی",
  other: "سایر",
};

const FILTERS: { value: "" | BillingEventStatus | "needs_attention"; label: string }[] = [
  { value: "", label: "همه" },
  { value: "pending", label: "در صف" },
  { value: "processing", label: "در حال پردازش" },
  { value: "posted", label: "ثبت‌شده" },
  { value: "failed", label: "ناموفق" },
  { value: "ignored", label: "نادیده‌گرفته‌شده" },
  { value: "needs_attention", label: "نیازمند توجه" },
];

const PAGE_SIZE = 50;

/**
 * Billing → Accounting reconciliation.
 *
 * Six states are distinguishable at a glance (در صف / در حال پردازش / ثبت‌شده /
 * ناموفق / نادیده‌گرفته‌شده / نیازمند توجه), every amount goes through the
 * business's own money unit, every date through the Jalali formatter, and a
 * retry button is only offered for a failure that a retry could actually fix —
 * an event blocked by a missing account or mapping says what is missing
 * instead.
 */
export function BillingReconciliation() {
  const money = useMoney();
  const [data, setData] = useState<BillingReconciliationResponse | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<"" | BillingEventStatus | "needs_attention">("");
  const [offset, setOffset] = useState(0);

  const load = async () => {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
    if (status) params.set("status", status);
    const result = await api<BillingReconciliationResponse & { error?: string }>(
      `/api/platform/company/accounting/reconciliation?${params.toString()}`,
    );
    if (result.ok) {
      setData(result.data);
      setError("");
    } else setError(result.data.error ?? "خطا در تطبیق");
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, offset]);

  const retry = async (id: string) => {
    setBusy(id);
    setError("");
    const result = await api<{ error?: string }>("/api/platform/company/accounting/reconciliation", {
      method: "POST",
      body: JSON.stringify({ eventId: id }),
    });
    setBusy(null);
    if (!result.ok) setError(result.data.error ?? "تلاش مجدد ناموفق بود");
    else await load();
  };

  const events = data?.events ?? [];
  const counts = data?.counts;
  const shown = useMemo(() => offset + events.length, [offset, events.length]);
  const total = data?.total ?? 0;

  return (
    <section className="rounded-2xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="font-bold">تطبیق Billing با دفتر</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            MRR عملیاتی است؛ فقط رویدادهای «ثبت‌شده» درآمد دفتری هستند.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor="reconciliation-status">
            وضعیت
          </label>
          <select
            id="reconciliation-status"
            className="h-9 rounded-lg border border-border bg-background px-3 text-sm"
            value={status}
            onChange={(event) => {
              setStatus(event.target.value as typeof status);
              setOffset(0);
            }}
          >
            {FILTERS.map((filter) => (
              <option key={filter.value} value={filter.value}>
                {filter.label}
              </option>
            ))}
          </select>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            به‌روزرسانی
          </Button>
        </div>
      </div>

      {counts ? (
        <dl className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-5">
          {(Object.keys(STATUS_LABELS) as BillingEventStatus[]).map((key) => (
            <div key={key} className="rounded-xl bg-muted/60 px-3 py-2">
              <dt className="text-muted-foreground">{STATUS_LABELS[key]}</dt>
              <dd className="mt-0.5 font-semibold">{counts[key] ?? 0}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      {error ? (
        <div className="mt-3">
          <ErrorBox>{error}</ErrorBox>
        </div>
      ) : null}

      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[54rem] text-sm">
          <thead>
            <tr className="border-b text-start text-muted-foreground">
              <th className="p-2 text-start">منبع</th>
              <th className="p-2 text-start">نوع</th>
              <th className="p-2 text-start">مبلغ</th>
              <th className="p-2 text-start">تاریخ</th>
              <th className="p-2 text-start">وضعیت</th>
              <th className="p-2 text-start">اقدام</th>
            </tr>
          </thead>
          <tbody>
            {events.map((event) => (
              <ReconciliationRow
                key={event.id}
                event={event}
                retrying={busy === event.id}
                onRetry={() => void retry(event.id)}
                formatMoney={(rial) => money.format(rial)}
              />
            ))}
          </tbody>
        </table>
        {events.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {status
              ? "رویدادی با این وضعیت وجود ندارد."
              : "هنوز رویداد جدیدی پس از راه‌اندازی دریافت نشده است."}
          </p>
        ) : null}
      </div>

      {total > PAGE_SIZE ? (
        <div className="mt-3 flex items-center justify-between gap-2 text-sm">
          <span className="text-muted-foreground">
            {shown} از {total}
          </span>
          <div className="flex gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            >
              قبلی
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={shown >= total}
              onClick={() => setOffset(offset + PAGE_SIZE)}
            >
              بعدی
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function ReconciliationRow({
  event,
  retrying,
  onRetry,
  formatMoney,
}: {
  event: BillingReconciliationRow;
  retrying: boolean;
  onRetry: () => void;
  formatMoney: (rial: number) => string;
}) {
  const failed = event.status === "failed";
  // A failure the bridge knows a retry cannot fix gets an explanation, not a
  // button that will only fail again.
  const retryable = failed && event.failureKind !== "permanent";
  return (
    <tr className="border-b border-border/70 align-top">
      <td className="p-2">
        <span className="font-mono text-xs" dir="ltr">
          {event.source}
        </span>
        {event.customerName ? (
          <div className="text-xs text-muted-foreground">{event.customerName}</div>
        ) : null}
      </td>
      <td className="p-2">
        {KIND_LABELS[event.kind] ?? event.kind}
        {event.settlementMethod ? (
          <div className="text-xs text-muted-foreground">
            تسویه: {SETTLEMENT_LABELS[event.settlementMethod] ?? event.settlementMethod}
          </div>
        ) : null}
      </td>
      <td className="p-2 whitespace-nowrap">{formatMoney(event.amountRial)}</td>
      <td className="p-2 whitespace-nowrap">{formatJalali(event.occurredAt)}</td>
      <td className="p-2">
        <span
          className={`inline-block rounded-full border px-2 py-0.5 text-xs ${STATUS_CLASSES[event.status]}`}
        >
          {STATUS_LABELS[event.status]}
        </span>
        {event.attempts > 1 && event.status !== "posted" ? (
          <div className="text-xs text-muted-foreground">{event.attempts} تلاش</div>
        ) : null}
        {event.blockedReason ? (
          <div className="mt-1 max-w-xs text-xs text-destructive">{event.blockedReason}</div>
        ) : null}
      </td>
      <td className="p-2">
        {retryable ? (
          <Button size="sm" variant="outline" disabled={retrying} onClick={onRetry}>
            {retrying ? "در حال تلاش…" : "تلاش مجدد"}
          </Button>
        ) : event.journalEntryId ? (
          <span className="text-xs text-muted-foreground">سند ثبت شد</span>
        ) : event.status === "ignored" ? (
          <span className="text-xs text-muted-foreground">بی‌اثر دفتری</span>
        ) : (
          "—"
        )}
      </td>
    </tr>
  );
}
