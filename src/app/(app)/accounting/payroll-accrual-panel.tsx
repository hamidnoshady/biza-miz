"use client";

import { useId, useMemo, useState } from "react";
import { EmptyState, cardClass } from "@/app/dashboard/page-chrome";
import {
  DataTable,
  DataTableBody,
  DataTableFoot,
  DataTableHead,
  DataTableRow,
  Td,
  Th,
} from "@/app/dashboard/data-table";
import { JalaliDatePicker } from "@/app/dashboard/jalali-date-picker";
import { inputClass, PrimaryButton } from "@/app/dashboard/ui";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Checkbox } from "@/components/ui/checkbox";
import { useMoney } from "@/components/money/money-context";
import { toPersianDigits } from "@/lib/digits";
import { JALALI_MONTHS, type JalaliDate } from "@/lib/jalali";
import { INVALID_DRAFT, draftDisplayText, draftRial, type AmountDraft } from "@/lib/payroll-amount-drafts";
import {
  computeGrossToNet,
  payrollSettingsApplyDeductions,
  type GrossToNetBreakdown,
  type PayrollSettings,
} from "@/lib/payroll-gross-to-net";
import type { PayrollCommissionPreview, StaffWage } from "@/lib/payroll-types";
import { payrollError } from "./payroll-error";

/** What the accrual form hands the section to post: the month's overtime per member, as exact Rial text. */
export interface AccrualRequest {
  /** Only members with overtime above zero; the digits are canonical, never a rounded number. */
  overtime: Record<string, string>;
}

/** A line's gross-to-net, or the code of why it cannot be computed (the calculator's, or `invalid_overtime`). */
type RowResult = ({ ok: true } & GrossToNetBreakdown) | { ok: false; error: string };

/** One line of the preview: a member's gross-to-net, and the commission this run would settle for them. */
interface PreviewRow {
  userId: string;
  fullName: string;
  /** False for a member who is only owed commission (no payable wage), who has no gross-to-net line. */
  hasWage: boolean;
  result: RowResult | null;
  commission: bigint;
}

/** One overtime box as Rial: blank is zero, anything that is not a whole amount is invalid. */
function overtimeRial(draft: AmountDraft | undefined): string | typeof INVALID_DRAFT {
  if (!draft) return "0";
  const rial = draftRial(draft);
  return rial === null ? "0" : rial;
}

const sum = <T,>(items: readonly T[], pick: (item: T) => bigint): bigint => items.reduce((total, item) => total + pick(item), 0n);

/**
 * «ثبت تعهد» — accrue one Jalali month.
 *
 * The preview is the pure gross-to-net calculator the server posts with, run
 * over the *saved* terms (an unsaved edit is not what a run would read) and the
 * overtime typed here, so the figures on screen are the figures the accrual
 * books. Commission is the one thing only the database knows, so it arrives as
 * `commission` — computed by the code that claims it — and is added per member.
 *
 * Overtime is a draft that remembers the unit it was typed in, exactly as a
 * wage box does (`payroll-amount-drafts.ts`): switching Rial↔Toman converts the
 * amount instead of re-reading its digits, and the request carries the Rial
 * digits as text, so no amount here passes through `Number`.
 *
 * Posting, the idempotency key and the duplicate dialog are the section's
 * (`onAccrue`): this component draws the form and decides when it may submit.
 */
export function PayrollAccrualPanel({
  staff,
  settings,
  commission,
  unsettledCommission,
  today,
  period,
  onPeriodChange,
  accrualDate,
  onAccrualDateChange,
  includeCommission,
  onIncludeCommissionChange,
  busy,
  accruing,
  onAccrue,
  onError,
}: {
  staff: StaffWage[];
  settings: PayrollSettings;
  /** The commission an accrual with these choices would settle; `null` while it is unknown (loading, or the read failed). */
  commission: PayrollCommissionPreview | null;
  unsettledCommission: bigint;
  today: JalaliDate;
  period: { year: number; month: number };
  onPeriodChange: (year: number, month: number) => void;
  /** ISO date, or "" for the default (the month's last day, or today while it is running). */
  accrualDate: string;
  onAccrualDateChange: (date: string) => void;
  includeCommission: boolean;
  onIncludeCommissionChange: (include: boolean) => void;
  busy: boolean;
  accruing: boolean;
  /** Posts the accrual. Resolves true once a run exists for the month, so the overtime typed for it is cleared. */
  onAccrue: (request: AccrualRequest) => Promise<boolean>;
  onError: (message: string) => void;
}) {
  const money = useMoney();
  const accrualFieldId = useId();
  const [overtimeDrafts, setOvertimeDrafts] = useState<Record<string, AmountDraft>>({});

  const deductionsConfigured = payrollSettingsApplyDeductions(settings);
  const monthIsRunning = period.year === today.jy && period.month === today.jm;

  const yearOptions = useMemo(
    () => [today.jy, today.jy - 1, today.jy - 2, today.jy - 3].map((year) => ({ value: String(year), label: toPersianDigits(year) })),
    [today.jy],
  );
  // A month that has not started cannot be accrued (the server says `period_in_future`); do not offer it.
  const monthOptions = useMemo(
    () =>
      JALALI_MONTHS.map((name, index) => ({ value: String(index + 1), label: name })).filter(
        (option) => period.year !== today.jy || Number(option.value) <= today.jm,
      ),
    [period.year, today.jy, today.jm],
  );

  const rows = useMemo<PreviewRow[]>(() => {
    const commissionBy = new Map((commission?.lines ?? []).map((line) => [line.userId, line]));
    const payable = staff.filter((member) => member.monthlyWage !== null && member.monthlyWage !== "0");
    const out: PreviewRow[] = payable.map((member) => {
      const overtime = overtimeRial(overtimeDrafts[member.id]);
      const result: RowResult =
        overtime === INVALID_DRAFT
          ? { ok: false, error: "invalid_overtime" }
          : computeGrossToNet(
              {
                baseSalaryRial: BigInt(member.monthlyWage as string),
                taxableAllowancesRial: BigInt(member.taxableAllowance),
                nonTaxableAllowancesRial: BigInt(member.nonTaxableAllowance),
                overtimeRial: BigInt(overtime),
                otherDeductionsRial: BigInt(member.fixedDeduction),
                advanceOutstandingRial: BigInt(member.advanceOutstanding),
              },
              settings,
            );
      return {
        userId: member.id,
        fullName: member.fullName,
        hasWage: true,
        result,
        commission: BigInt(commissionBy.get(member.id)?.amount ?? "0"),
      };
    });
    // Somebody owed commission but with no payable wage is still paid by this run.
    const listed = new Set(out.map((row) => row.userId));
    for (const line of commission?.lines ?? []) {
      if (listed.has(line.userId)) continue;
      out.push({ userId: line.userId, fullName: line.fullName, hasWage: false, result: null, commission: BigInt(line.amount) });
    }
    return out;
  }, [staff, settings, commission, overtimeDrafts]);

  const failing = rows.find((row) => row.result !== null && !row.result.ok);
  const wageRows = rows.filter((row): row is PreviewRow & { result: { ok: true } & GrossToNetBreakdown } => row.result !== null && row.result.ok);
  const hasCommission = rows.some((row) => row.commission !== 0n);
  const totals = useMemo(
    () => ({
      gross: sum(wageRows, (row) => row.result.grossRial),
      employeeInsurance: sum(wageRows, (row) => row.result.employeeInsuranceRial),
      tax: sum(wageRows, (row) => row.result.incomeTaxRial),
      recoveries: sum(wageRows, (row) => row.result.advanceRecoveryRial + row.result.otherDeductionsRial),
      net: sum(wageRows, (row) => row.result.netPayRial),
      employer: sum(wageRows, (row) => row.result.employerInsuranceRial + row.result.unemploymentInsuranceRial),
      commission: sum(rows, (row) => row.commission),
    }),
    [rows, wageRows],
  );

  // A run can only be offered when every line computed and the commission is known.
  const ready = rows.length > 0 && failing === undefined && commission !== null;

  function failureMessage(): string {
    if (failing && failing.result && !failing.result.ok) return `«${failing.fullName}»: ${payrollError(failing.result.error)}`;
    if (rows.length === 0) return "هیچ کارمندی حقوق تعیین‌شده یا پورسانت تسویه‌نشده ندارد.";
    return "پیش‌نمایش پورسانت در دسترس نیست؛ صفحه را تازه کنید.";
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!ready) return onError(failureMessage());
    const overtime: Record<string, string> = {};
    for (const row of rows) {
      if (!row.hasWage) continue;
      const value = overtimeRial(overtimeDrafts[row.userId]);
      if (value !== INVALID_DRAFT && value !== "0") overtime[row.userId] = value;
    }
    if (await onAccrue({ overtime })) setOvertimeDrafts({});
  }

  return (
    <section aria-labelledby="payroll-accrual-heading" className={cardClass}>
      <header className="border-b border-border/80 px-4 py-4 sm:px-5">
        <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">ثبت ماه</p>
        <h2 id="payroll-accrual-heading" className="mt-1 text-base font-semibold text-foreground">تعهد حقوق و دستمزد ماهانه</h2>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          {deductionsConfigured
            ? "ناخالص به خالص با نرخ‌های ثبت‌شده در «تنظیمات بیمه و مالیات حقوق» محاسبه و در یک سند ثبت می‌شود."
            : "نرخ بیمه و مالیاتی وارد نشده است؛ تعهد بدون کسور قانونی ثبت می‌شود (فقط مساعده و کسور ثابت کسر می‌شوند)."}{" "}
          برای هر ماه فقط یک لیست فعال می‌تواند وجود داشته باشد، و لیست برای کل کسب‌وکار ثبت می‌شود، نه برای شعبهٔ فعال.
        </p>
      </header>

      <form onSubmit={submit} className="space-y-4 p-4 sm:p-5">
        <div className="grid gap-4 md:grid-cols-[minmax(14rem,18rem)_12rem_auto] md:items-end">
          <div className="block text-sm font-medium">
            <span className="mb-1.5 block text-xs text-muted-foreground">ماه حقوق</span>
            <div className="grid grid-cols-2 gap-2">
              <SearchableSelect
                value={String(period.month)}
                onChange={(month) => onPeriodChange(period.year, Number(month))}
                options={monthOptions}
                ariaLabel="ماه"
              />
              <SearchableSelect
                value={String(period.year)}
                onChange={(year) => {
                  const next = Number(year);
                  // Moving to the current year must not leave a month that has not started selected.
                  onPeriodChange(next, next === today.jy && period.month > today.jm ? today.jm : period.month);
                }}
                options={yearOptions}
                ariaLabel="سال"
              />
            </div>
          </div>
          <div className="block text-sm font-medium">
            {/*
              * The picker is a button + popover, not an <input>, so wrapping it
              * in a <label> gave it no accessible name at all. A real <label>
              * beside it plus the picker's own aria-label is what names it.
              */}
            <span className="mb-1.5 block text-xs text-muted-foreground" id={accrualFieldId}>
              تاریخ سند <span className="font-normal">(اختیاری)</span>
            </span>
            <JalaliDatePicker
              value={accrualDate}
              onChange={onAccrualDateChange}
              placeholder={monthIsRunning ? "امروز" : "پایان ماه"}
              labelledBy={accrualFieldId}
            />
          </div>
          <div className="min-w-40">
            <PrimaryButton disabled={busy || accruing || !ready}>{accruing ? "در حال ثبت…" : "ثبت تعهد"}</PrimaryButton>
          </div>
        </div>

        {unsettledCommission !== 0n || !includeCommission ? (
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={includeCommission} onCheckedChange={(value) => onIncludeCommissionChange(value === true)} />
            <span>
              پورسانت‌های تسویه‌نشده هم در همین لیست پرداخت شود
              {unsettledCommission !== 0n ? (
                <span className="text-muted-foreground"> ({money.formatText(unsettledCommission.toString())})</span>
              ) : null}
            </span>
          </label>
        ) : null}

        {rows.length === 0 ? (
          <EmptyState>
            هیچ کارمندی حقوق تعیین‌شده یا پورسانت تسویه‌نشده ندارد؛ ابتدا در بخش بالا حقوق پایه را وارد کنید.
          </EmptyState>
        ) : (
          <DataTable caption="پیش‌نمایش ناخالص به خالص" tableClassName={hasCommission ? "min-w-[56rem]" : "min-w-[44rem]"}>
            <DataTableHead>
              <Th>کارمند</Th>
              <Th>اضافه‌کار ({money.unitLabel})</Th>
              <Th numeric>ناخالص</Th>
              <Th numeric>بیمه کارگر</Th>
              <Th numeric>مالیات</Th>
              <Th numeric>مساعده و سایر کسور</Th>
              <Th numeric>خالص حقوق</Th>
              {hasCommission ? <Th numeric>پورسانت</Th> : null}
              {hasCommission ? <Th numeric>پرداختنی</Th> : null}
              <Th numeric>بیمه کارفرما</Th>
            </DataTableHead>
            <DataTableBody>
              {rows.map((row) => {
                const result = row.result;
                return (
                  <DataTableRow key={row.userId}>
                    <Td>
                      <span className="block max-w-[10rem] truncate" title={row.fullName}>
                        {row.fullName}
                      </span>
                    </Td>
                    <Td>
                      {row.hasWage ? (
                        <PersianNumberInput
                          className={inputClass + " w-32"}
                          dir="ltr"
                          inputMode="numeric"
                          allowDecimal={false}
                          allowNegative={false}
                          value={overtimeDrafts[row.userId] ? draftDisplayText(overtimeDrafts[row.userId], money.unit) : ""}
                          onChange={(e) => {
                            const text = e.target.value;
                            setOvertimeDrafts((prev) => ({ ...prev, [row.userId]: { text, unit: money.unit } }));
                          }}
                          placeholder="۰"
                          aria-label={`اضافه‌کار ${row.fullName}`}
                        />
                      ) : (
                        <span className="text-xs text-muted-foreground">بدون حقوق ثابت</span>
                      )}
                    </Td>
                    {result === null ? (
                      <>
                        <Td numeric muted>—</Td>
                        <Td numeric muted>—</Td>
                        <Td numeric muted>—</Td>
                        <Td numeric muted>—</Td>
                        <Td numeric muted>—</Td>
                      </>
                    ) : result.ok ? (
                      <>
                        <Td numeric>{money.formatText(result.grossRial.toString())}</Td>
                        <Td numeric>{money.formatText(result.employeeInsuranceRial.toString())}</Td>
                        <Td numeric>{money.formatText(result.incomeTaxRial.toString())}</Td>
                        <Td numeric>{money.formatText((result.advanceRecoveryRial + result.otherDeductionsRial).toString())}</Td>
                        <Td numeric className="font-semibold">{money.formatText(result.netPayRial.toString())}</Td>
                      </>
                    ) : (
                      <Td colSpan={5} className="text-destructive">
                        {payrollError(result.error)}
                      </Td>
                    )}
                    {hasCommission ? <Td numeric>{money.formatText(row.commission.toString())}</Td> : null}
                    {hasCommission ? (
                      <Td numeric className="font-semibold">
                        {result?.ok
                          ? money.formatText((result.netPayRial + row.commission).toString())
                          : result === null
                            ? money.formatText(row.commission.toString())
                            : "—"}
                      </Td>
                    ) : null}
                    <Td numeric muted>
                      {result?.ok ? money.formatText((result.employerInsuranceRial + result.unemploymentInsuranceRial).toString()) : "—"}
                    </Td>
                  </DataTableRow>
                );
              })}
            </DataTableBody>
            {failing === undefined ? (
              <DataTableFoot>
                <tr>
                  <Th scope="row" className="text-start">
                    جمع ({toPersianDigits(rows.length)} نفر)
                  </Th>
                  <Td />
                  <Td numeric>{money.formatText(totals.gross.toString())}</Td>
                  <Td numeric>{money.formatText(totals.employeeInsurance.toString())}</Td>
                  <Td numeric>{money.formatText(totals.tax.toString())}</Td>
                  <Td numeric>{money.formatText(totals.recoveries.toString())}</Td>
                  <Td numeric>{money.formatText(totals.net.toString())}</Td>
                  {hasCommission ? <Td numeric>{money.formatText(totals.commission.toString())}</Td> : null}
                  {hasCommission ? <Td numeric>{money.formatText((totals.net + totals.commission).toString())}</Td> : null}
                  <Td numeric>{money.formatText(totals.employer.toString())}</Td>
                </tr>
              </DataTableFoot>
            ) : null}
          </DataTable>
        )}
      </form>
    </section>
  );
}
