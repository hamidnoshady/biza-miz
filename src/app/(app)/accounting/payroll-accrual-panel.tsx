"use client";

import { useId, useMemo, useState } from "react";
import { EmptyState, LoadingSkeleton, cardClass } from "@/app/dashboard/page-chrome";
import {
  DataTable,
  DataTableBody,
  DataTableFoot,
  DataTableHead,
  DataTableRow,
  Td,
  Th,
} from "@/app/dashboard/data-table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { JalaliDatePicker } from "@/app/dashboard/jalali-date-picker";
import { inputClass, PrimaryButton, SecondaryButton } from "@/app/dashboard/ui";
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
import { DIMENSION_KINDS, type DimensionKind, type LineDimensions } from "@/lib/accounting-dimensions";
import { DimensionFields, useDimensionCatalog } from "./dimension-fields";
import {
  dimensionValueLabel,
  enabledDimensionKinds,
  enabledKindLabel,
  type DimensionDraft,
} from "./dimension-catalog";
import { payrollError } from "./payroll-error";

/** What the accrual form hands the section to post: the month's overtime per member, as exact Rial text. */
export interface AccrualRequest {
  /** Only members with overtime above zero; the digits are canonical, never a rounded number. */
  overtime: Record<string, string>;
  /**
   * Issue #868 — per-run allocation overrides (`[{ userId, shares: [...] }]`,
   * shareBp integers summing to 10 000 per member). A member with no entry
   * posts to their employee default tuple.
   */
  allocations: unknown[];
}

/**
 * Issue #868 — one allocation share as the form edits it: a percent of the
 * member's salary expense (whole 0.01 steps), the tuple it is charged to, and
 * an optional note. Sent as shareBp integers (`percent × 100`).
 */
interface ShareDraft {
  percent: string;
  label: string;
  dims: DimensionDraft;
}

/** The request-body field names `parsePayrollAllocations` reads per kind. */
const ALLOCATION_FIELD: Record<DimensionKind, string> = {
  cost_center: "costCenterId",
  profit_center: "profitCenterId",
  department: "departmentId",
  detail: "detailDimensionId",
};

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
  // Issue #868 — per-run allocation overrides, edited per member in a dialog.
  const { catalog: dimCatalog, loaded: dimCatalogLoaded, error: dimCatalogError, retry: retryDimCatalog } = useDimensionCatalog();
  const [allocDrafts, setAllocDrafts] = useState<Record<string, ShareDraft[]>>({});
  const [allocOpen, setAllocOpen] = useState<string | null>(null);
  const allocatableKinds = dimCatalog ? enabledDimensionKinds(dimCatalog.settings) : [];

  function sharesOf(userId: string): ShareDraft[] {
    return allocDrafts[userId] ?? [];
  }

  function shareBpOf(share: ShareDraft): number | null {
    const percent = Number(share.percent.trim());
    if (!Number.isFinite(percent) || percent <= 0 || percent > 100) return null;
    const bp = Math.round(percent * 100);
    return bp > 0 ? bp : null;
  }

  /** A member's override is valid when every share is well-formed and the shares total exactly 100%. */
  function sharesValid(shares: ShareDraft[]): boolean {
    if (shares.length === 0) return true;
    if (shares.some((share) => shareBpOf(share) === null)) return false;
    return shares.reduce((total, share) => total + (shareBpOf(share) ?? 0), 0) === 10_000;
  }

  /** The member's standing default tuple, read for the dialog's comparison line. */
  function defaultTupleText(dimensions: LineDimensions): string {
    if (!dimCatalog) return "—";
    const parts: string[] = [];
    for (const kind of DIMENSION_KINDS) {
      const id = dimensions[kind];
      if (!id) continue;
      parts.push(`${enabledKindLabel(dimCatalog.settings, kind)}: ${dimensionValueLabel(dimCatalog.allValues, id)}`);
    }
    return parts.length > 0 ? parts.join("، ") : "بدون انتساب (کل هزینه بدون بُعد ثبت می‌شود)";
  }

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

  // A run can only be offered when every line computed, the commission is
  // known, and every allocation override on screen is well-formed (issue #868).
  const badAlloc = rows.find((row) => !sharesValid(sharesOf(row.userId)));
  const ready = rows.length > 0 && failing === undefined && commission !== null && badAlloc === undefined;

  function failureMessage(): string {
    if (failing && failing.result && !failing.result.ok) return `«${failing.fullName}»: ${payrollError(failing.result.error)}`;
    if (badAlloc) return `تخصیص هزینهٔ «${badAlloc.fullName}» معتبر نیست؛ سهم‌ها باید مثبت و جمعشان دقیقاً ۱۰۰٪ باشد.`;
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
    // Issue #868 — only members with an override ride the request; everybody
    // else falls back to their employee default tuple server-side.
    const allocations: unknown[] = [];
    for (const row of rows) {
      const shares = sharesOf(row.userId).filter((share) => shareBpOf(share) !== null);
      if (shares.length === 0) continue;
      allocations.push({
        userId: row.userId,
        shares: shares.map((share) => ({
          shareBp: shareBpOf(share),
          label: share.label.trim() || null,
          ...Object.fromEntries(
            DIMENSION_KINDS.map((kind) => [ALLOCATION_FIELD[kind], share.dims[kind] ?? null]),
          ),
        })),
      });
    }
    if (await onAccrue({ overtime, allocations })) {
      setOvertimeDrafts({});
      setAllocDrafts({});
    }
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
                      {/* Issue #868 — the per-run allocation override. Offered only
                          while the business uses at least one dimension kind (and
                          while the catalogue has loaded — a failure is visible,
                          never a silently absent control). */}
                      {allocatableKinds.length > 0 || sharesOf(row.userId).length > 0 ? (
                        <button
                          type="button"
                          className={`mt-1 rounded-full border px-2 py-0.5 text-[11px] transition-colors ${
                            sharesOf(row.userId).length > 0
                              ? "border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                              : "border-border/80 text-muted-foreground hover:border-primary/50 hover:text-foreground"
                          }`}
                          onClick={() => setAllocOpen(row.userId)}
                          aria-label={`تخصیص هزینه ${row.fullName}`}
                        >
                          {sharesOf(row.userId).length > 0 ? "تخصیص سفارشی" : "تخصیص هزینه"}
                        </button>
                      ) : dimCatalogError ? (
                        <button type="button" className="mt-1 text-[11px] text-destructive underline" onClick={retryDimCatalog}>
                          ابعاد بارگذاری نشد — تلاش دوباره
                        </button>
                      ) : !dimCatalogLoaded ? (
                        <LoadingSkeleton rows={1} compact label="در حال بارگذاری ابعاد تحلیلی" />
                      ) : null}
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

        {/* Issue #868 — the per-run allocation dialog: how this ONE month's
            salary expense for this member is split. Empty shares = the
            employee's default tuple. The split is exact to the Rial
            server-side; what must hold here is shares summing to exactly
            100% when any exist. */}
        <Dialog open={allocOpen !== null} onOpenChange={(open) => !open && setAllocOpen(null)}>
          <DialogContent className="max-w-2xl" showCloseButton>
            {(() => {
              const member = rows.find((row) => row.userId === allocOpen) ?? null;
              const memberWage = staff.find((s) => s.id === allocOpen) ?? null;
              if (!member) return null;
              const shares = sharesOf(member.userId);
              const totalBp = shares.reduce((total, share) => total + (shareBpOf(share) ?? 0), 0);
              const updateShare = (index: number, patch: Partial<ShareDraft>) =>
                setAllocDrafts((prev) => ({
                  ...prev,
                  [member.userId]: (prev[member.userId] ?? []).map((s, i) => (i === index ? { ...s, ...patch } : s)),
                }));
              return (
                <>
                  <DialogHeader>
                    <DialogTitle>تخصیص هزینهٔ «{member.fullName}» برای این ماه</DialogTitle>
                    <DialogDescription>
                      هزینهٔ حقوق این نفر در این لیست بین سهم‌ها تقسیم می‌شود (دقیق تا ریال)؛ بدهی و پرداخت بدون
                      بُعد ثبت می‌شوند. سهمی اضافه نکنید تا از انتساب پیش‌فرض او استفاده شود. این تخصیص فقط همین
                      لیست را می‌سازد و تاریخچهٔ لیست‌های قبلی را تغییر نمی‌دهد.
                    </DialogDescription>
                  </DialogHeader>
                  <p className="text-xs leading-5 text-muted-foreground">
                    انتساب پیش‌فرض: {memberWage ? defaultTupleText(memberWage.defaultDimensions) : "—"}
                  </p>
                  <div className="max-h-[40vh] space-y-3 overflow-y-auto pl-2">
                    {shares.map((share, index) => (
                      <div key={index} className="space-y-2 rounded-xl border border-border/80 p-3">
                        <div className="flex flex-wrap items-end gap-2">
                          <label className="block">
                            <span className="mb-1 block text-xs font-medium text-foreground">درصد سهم</span>
                            <PersianNumberInput
                              className={inputClass + " w-28"}
                              dir="ltr"
                              inputMode="decimal"
                              allowDecimal
                              allowNegative={false}
                              value={share.percent}
                              onChange={(e) => updateShare(index, { percent: e.target.value })}
                              placeholder="۰"
                              aria-label={`درصد سهم ${toPersianDigits(String(index + 1))} ${member.fullName}`}
                            />
                          </label>
                          <label className="block min-w-40 flex-1">
                            <span className="mb-1 block text-xs font-medium text-foreground">یادداشت سهم (اختیاری)</span>
                            <input
                              className={inputClass}
                              maxLength={80}
                              value={share.label}
                              onChange={(e) => updateShare(index, { label: e.target.value })}
                              aria-label={`یادداشت سهم ${toPersianDigits(String(index + 1))} ${member.fullName}`}
                            />
                          </label>
                          <SecondaryButton
                            className="text-destructive"
                            onClick={() =>
                              setAllocDrafts((prev) => ({
                                ...prev,
                                [member.userId]: (prev[member.userId] ?? []).filter((_, i) => i !== index),
                              }))
                            }
                          >
                            حذف سهم
                          </SecondaryButton>
                        </div>
                        <DimensionFields
                          idPrefix={`alloc-${member.userId}-${index}`}
                          catalog={dimCatalog}
                          locationId={null}
                          value={share.dims}
                          onChange={(next) => updateShare(index, { dims: next })}
                          rowLabel={`سهم ${toPersianDigits(String(index + 1))}`}
                        />
                      </div>
                    ))}
                    {shares.length === 0 ? (
                      <p className="rounded-lg border border-dashed border-border/80 px-3 py-2 text-xs text-muted-foreground">
                        سهمی ثبت نشده است؛ هزینهٔ این نفر با انتساب پیش‌فرض او ثبت می‌شود.
                      </p>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <SecondaryButton
                      onClick={() =>
                        setAllocDrafts((prev) => ({
                          ...prev,
                          [member.userId]: [
                            ...(prev[member.userId] ?? []),
                            { percent: "", label: "", dims: {} },
                          ],
                        }))
                      }
                    >
                      افزودن سهم
                    </SecondaryButton>
                    <span className={`text-sm font-semibold ${sharesValid(shares) ? "text-foreground" : "text-destructive"}`}>
                      جمع سهم‌ها: {toPersianDigits(String(Math.round(totalBp) / 100))}٪
                      {shares.length > 0 && !sharesValid(shares) ? " — باید دقیقاً ۱۰۰٪ باشد" : ""}
                    </span>
                  </div>
                  <DialogFooter>
                    {shares.length > 0 ? (
                      <Button
                        type="button"
                        variant="destructive"
                        onClick={() => {
                          setAllocDrafts((prev) => ({ ...prev, [member.userId]: [] }));
                          setAllocOpen(null);
                        }}
                      >
                        حذف تخصیص
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      disabled={!sharesValid(shares)}
                      onClick={() => setAllocOpen(null)}
                    >
                      اعمال
                    </Button>
                  </DialogFooter>
                </>
              );
            })()}
          </DialogContent>
        </Dialog>
      </form>
    </section>
  );
}
