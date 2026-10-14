"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { LoadingSkeleton, StatusBadge } from "@/app/dashboard/page-chrome";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { roleLabel } from "@/lib/role-labels";
import { useMoney } from "@/components/money/money-context";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Button } from "@/components/ui/button";
import { JalaliDatePicker } from "@/app/dashboard/jalali-date-picker";
import { api, SecondaryButton } from "@/app/dashboard/ui";
import type {
  PayrollPaymentAccount,
  PayrollRun,
  PayrollRunLine,
  PayrollRunStatus,
  PayrollRunSummary,
} from "@/lib/payroll-types";

/**
 * The run statuses, as the shared `StatusBadge` tones rather than a private
 * palette. The badge is the primitive every other ledger surface uses for a
 * status pill (`installments`, `chart-of-accounts`).
 */
export const STATUS_TONES: Record<PayrollRunStatus, { label: string; tone: "active" | "positive" | "neutral" }> = {
  paid: { label: "پرداخت‌شده", tone: "positive" },
  accrued: { label: "تعهدشده", tone: "active" },
  voided: { label: "ابطال‌شده", tone: "neutral" },
};

/**
 * A date the server sent, as Shamsi — or a dash when it is absent/unparseable.
 *
 * `formatJalali` throws a `RangeError` on an invalid date, and a throw inside
 * a client component's render takes the whole section down to an error
 * boundary. A payroll row whose date somehow arrived malformed should cost one
 * dash, not the screen.
 */
function jalaliOrDash(value: string | null | undefined): string {
  if (!value) return "—";
  try {
    return toPersianDigits(formatJalali(value));
  } catch {
    return "—";
  }
}

/** What the person chose to pay from: a real account, or (only if the chart offers none) the old cash/bank shorthand. */
export interface PayChoice {
  paymentAccountId: string | null;
  method: "cash" | "bank";
  /** ISO date, or "" for today. */
  paidDate: string;
}

/**
 * One payroll run in the history.
 *
 * Collapsed it is a summary — period, dates, who, the amount, the status — and
 * nothing else has been read for it. Opening the details fetches the run's
 * per-employee lines on demand (`GET /api/ledger/payroll/runs/:id`), so years
 * of history never load every employee row up front; they are kept once read,
 * because a line is an immutable snapshot and cannot go stale.
 *
 * A run in «تعهدشده» offers the payment controls — the account it leaves, and
 * the payment date (optional, today by default, never before the accrual date).
 */
export function PayrollRunItem({
  run,
  canManage,
  busy,
  working,
  paymentAccounts,
  onPay,
  onVoid,
}: {
  run: PayrollRunSummary;
  canManage: boolean;
  busy: boolean;
  working: boolean;
  paymentAccounts: PayrollPaymentAccount[];
  onPay: (run: PayrollRunSummary, choice: PayChoice) => void;
  onVoid: (run: PayrollRunSummary) => void;
}) {
  const money = useMoney();
  const status = STATUS_TONES[run.status] ?? { label: run.status, tone: "neutral" as const };
  const detailsId = useId();
  const dateId = useId();

  const [open, setOpen] = useState(false);
  const [details, setDetails] = useState<{ state: "idle" | "loading" | "failed" | "ready"; lines: PayrollRunLine[] }>({
    state: "idle",
    lines: [],
  });
  const [accountId, setAccountId] = useState("");
  const [paidDate, setPaidDate] = useState("");
  const [dateError, setDateError] = useState("");

  // Lazy: the lines are read when the details are first opened (or retried
  // after a failure) — in a handler, not an effect, so nothing is fetched for a
  // run nobody opens, and a late reply for an unmounted row is dropped.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const loadDetails = useCallback(async () => {
    setDetails({ state: "loading", lines: [] });
    const { ok, data } = await api<{ run: PayrollRun }>(`/api/ledger/payroll/runs/${run.id}`);
    if (!mounted.current) return;
    setDetails(ok ? { state: "ready", lines: data.run.lines } : { state: "failed", lines: [] });
  }, [run.id]);

  function toggleDetails() {
    const next = !open;
    setOpen(next);
    if (next && (details.state === "idle" || details.state === "failed")) void loadDetails();
  }

  // The default payment source is the till (صندوق); with no cash account the first one the chart offers.
  const effectiveAccountId =
    accountId ||
    paymentAccounts.find((account) => account.role === "cash")?.id ||
    paymentAccounts[0]?.id ||
    "cash";

  const accountOptions =
    paymentAccounts.length > 0
      ? paymentAccounts.map((account) => ({ value: account.id, label: `${toPersianDigits(account.code)} — ${account.name}` }))
      : [
          { value: "cash", label: "صندوق (نقدی)" },
          { value: "bank", label: "بانک" },
        ];

  function submitPayment() {
    setDateError("");
    // The server enforces this too; saying so here names the field before a round trip.
    if (paidDate && paidDate < run.accrualDate) {
      return setDateError("تاریخ پرداخت نمی‌تواند پیش از تاریخ تعهد (" + jalaliOrDash(run.accrualDate) + ") باشد.");
    }
    const legacy = effectiveAccountId === "cash" || effectiveAccountId === "bank";
    onPay(run, {
      paymentAccountId: legacy ? null : effectiveAccountId,
      method: effectiveAccountId === "bank" ? "bank" : "cash",
      paidDate,
    });
  }

  const hasCommission = run.commissionTotal !== "0";
  const canAct = canManage && run.status !== "voided";

  return (
    <li className="rounded-xl border border-border/80 bg-muted/60 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-3">
        <div className="min-w-0">
          <h3 className="break-words font-semibold text-foreground">{run.periodLabel}</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            تاریخ تعهد: {jalaliOrDash(run.accrualDate)}
            {run.status === "paid" && run.paidDate ? ` — پرداخت: ${jalaliOrDash(run.paidDate)}` : ""}
            {run.status === "voided" && run.voidedDate ? ` — ابطال: ${jalaliOrDash(run.voidedDate)}` : ""}
          </p>
          {run.createdByName ? <p className="mt-0.5 text-xs text-muted-foreground">ثبت توسط: {run.createdByName}</p> : null}
        </div>
        <div className="flex flex-col items-end gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">پرداختنی</span>
            <span
              className={"font-bold tabular-nums " + (run.status === "voided" ? "text-muted-foreground line-through" : "text-foreground")}
            >
              {money.formatText(run.payableAmount)}
            </span>
            <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
          </div>
          {/* What the payable amount is made of: the gross wage bill, the net left after the
              withholdings, and — when the run settles any — the commission. */}
          <p className="text-xs tabular-nums text-muted-foreground">
            ناخالص {money.formatText(run.totalAmount, { withUnit: false })} · خالص {money.formatText(run.netAmount, { withUnit: false })}
            {hasCommission ? ` + پورسانت ${money.formatText(run.commissionTotal, { withUnit: false })}` : ""}
          </p>
        </div>
      </div>

      {run.status === "paid" ? (
        <p className="mt-2 text-xs leading-5 text-muted-foreground">
          پرداخت‌شده یعنی خالص حقوق{hasCommission ? " و پورسانتِ" : " (بدون پورسانت)"} واردشده در همین لیست تسویه شده است؛ بیمه، مالیات و
          سایر کسوری که نگه داشته شده در حساب پرداختنی خود می‌ماند تا کسب‌وکار آن را بپردازد، و پورسانت‌های دیگر در «وضعیت حساب حقوق
          پرداختنی» بالای صفحه دیده می‌شوند.
        </p>
      ) : null}

      <div className="mt-3">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-expanded={open}
          aria-controls={detailsId}
          onClick={toggleDetails}
        >
          {open ? "بستن جزئیات" : `جزئیات (${toPersianDigits(run.lineCount)} نفر)`}
        </Button>
      </div>

      {open ? (
        <div id={detailsId} className="mt-2" aria-live="polite">
          {details.state === "failed" ? (
            <div className="flex flex-wrap items-center gap-3 text-sm text-destructive">
              <span role="alert">بارگذاری جزئیات ناموفق بود.</span>
              <SecondaryButton onClick={() => void loadDetails()}>تلاش دوباره</SecondaryButton>
            </div>
          ) : details.state !== "ready" ? (
            <LoadingSkeleton rows={2} compact label="در حال بارگذاری جزئیات لیست حقوق" />
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {details.lines.map((line, index) => (
                <LineDetails key={line.userId ?? `line-${index}`} line={line} />
              ))}
            </div>
          )}
        </div>
      ) : null}

      {run.status === "accrued" && canAct ? (
        <div className="mt-4 grid gap-3 border-t border-border pt-3 sm:grid-cols-[minmax(0,14rem)_minmax(0,12rem)_auto_auto] sm:items-end">
          <label className="block text-sm font-medium">
            <span className="mb-1.5 block text-xs text-muted-foreground">پرداخت از</span>
            <SearchableSelect
              value={effectiveAccountId}
              onChange={setAccountId}
              ariaLabel={`حساب پرداخت حقوق دوره ${run.periodLabel}`}
              options={accountOptions}
            />
          </label>
          <div className="block text-sm font-medium">
            <span className="mb-1.5 block text-xs text-muted-foreground" id={dateId}>
              تاریخ پرداخت <span className="font-normal">(اختیاری)</span>
            </span>
            <JalaliDatePicker
              value={paidDate}
              onChange={(value) => {
                setPaidDate(value);
                setDateError("");
              }}
              placeholder="امروز"
              labelledBy={dateId}
            />
          </div>
          <SecondaryButton onClick={submitPayment} disabled={busy || working}>
            {working ? "در حال ثبت…" : "ثبت پرداخت حقوق"}
          </SecondaryButton>
          <Button
            type="button"
            variant="destructive"
            onClick={() => onVoid(run)}
            disabled={busy || working}
            aria-label={`ابطال تعهد دوره ${run.periodLabel}`}
          >
            ابطال تعهد
          </Button>
          {dateError ? (
            <p role="alert" className="text-xs text-destructive sm:col-span-4">
              {dateError}
            </p>
          ) : null}
        </div>
      ) : null}

      {run.status === "paid" && canAct ? (
        <div className="mt-4 flex justify-end border-t border-border pt-3">
          <Button
            type="button"
            variant="destructive"
            onClick={() => onVoid(run)}
            disabled={busy || working}
            aria-label={`ابطال تعهد و پرداخت دوره ${run.periodLabel}`}
          >
            {working ? "در حال ابطال…" : "ابطال (برگشت تعهد و پرداخت)"}
          </Button>
        </div>
      ) : null}
    </li>
  );
}

/**
 * One employee's line: the name, role and code recorded when the run was
 * accrued (a rename or a removal afterwards does not change them) and, opened,
 * the whole month — pay, deductions, net, and the employer's own cost.
 *
 * Every figure is the run's snapshot: what the standing terms and the business's
 * rates produced that month, not what they would produce today.
 */
function LineDetails({ line }: { line: PayrollRunLine }) {
  const money = useMoney();
  const fmt = (value: string) => money.formatText(value, { withUnit: false });
  const allowances = (BigInt(line.taxableAllowancesRial) + BigInt(line.nonTaxableAllowancesRial) + BigInt(line.overtimeRial)).toString();
  const employerShares = (BigInt(line.employerInsuranceRial) + BigInt(line.unemploymentInsuranceRial)).toString();
  const hasCommission = line.commissionAmount !== "0";

  return (
    <details className="rounded-lg bg-muted/60 px-3 py-2.5 text-sm">
      <summary className="flex cursor-pointer items-center justify-between gap-3">
        <span className="min-w-0">
          {/* The name is the snapshot taken when the run was accrued. Only a legacy line whose
              member was already gone has no name. */}
          <span className="block truncate text-foreground" title={line.fullName ?? undefined}>
            {line.fullName ?? "عضو حذف‌شده"}
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {[line.role ? roleLabel(line.role) : null, line.employeeCode ? `کد ${toPersianDigits(line.employeeCode)}` : null]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </span>
        <span className="shrink-0 text-end">
          <span className="block font-semibold tabular-nums text-foreground">{money.formatText(line.payableAmount)}</span>
          {hasCommission ? (
            <span className="block text-xs tabular-nums text-muted-foreground">
              خالص {fmt(line.netPayRial)} + پورسانت {fmt(line.commissionAmount)}
            </span>
          ) : null}
        </span>
      </summary>
      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">حقوق پایه</dt>
        <dd className="text-end tabular-nums">{fmt(line.baseSalaryRial)}</dd>
        <dt className="text-muted-foreground">مزایا و اضافه‌کار</dt>
        <dd className="text-end tabular-nums">{fmt(allowances)}</dd>
        <dt className="text-muted-foreground">ناخالص</dt>
        <dd className="text-end tabular-nums">{fmt(line.grossRial)}</dd>
        <dt className="text-muted-foreground">بیمه کارگر</dt>
        <dd className="text-end tabular-nums">{fmt(line.employeeInsuranceRial)}</dd>
        <dt className="text-muted-foreground">مالیات حقوق</dt>
        <dd className="text-end tabular-nums">{fmt(line.incomeTaxRial)}</dd>
        <dt className="text-muted-foreground">کسر مساعده</dt>
        <dd className="text-end tabular-nums">{fmt(line.advanceRecoveryRial)}</dd>
        <dt className="text-muted-foreground">سایر کسور</dt>
        <dd className="text-end tabular-nums">{fmt(line.otherDeductionsRial)}</dd>
        <dt className="font-medium text-foreground">خالص حقوق</dt>
        <dd className="text-end font-medium tabular-nums">{fmt(line.netPayRial)}</dd>
        {hasCommission ? (
          <>
            <dt className="text-muted-foreground">پورسانت تسویه‌شده</dt>
            <dd className="text-end tabular-nums">{fmt(line.commissionAmount)}</dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">بیمه سهم کارفرما و بیکاری</dt>
        <dd className="text-end tabular-nums">{fmt(employerShares)}</dd>
      </dl>
    </details>
  );
}
