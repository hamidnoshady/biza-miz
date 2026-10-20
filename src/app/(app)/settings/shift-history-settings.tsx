"use client";

import { EmptyState, LoadingSkeleton, SectionCard } from "@/app/dashboard/page-chrome";

import { PersianNumberInput } from "@/components/ui/persian-number-input";
/**
 * Phase 20 Wave 5 — admin review of every employee's shift history.
 *
 * Issue #933 rebuilt this screen around what a reviewer is actually there to
 * do: find the shift that is still open and close it honestly, find the night
 * the drawer came up short, and see who did what.
 *
 *   * **Filters** — branch, employee, business-date range, shift id, status,
 *     "has a variance" and "closed without a count". The old screen filtered on
 *     status alone, which made a month of history a scroll rather than a query.
 *   * **The finalized cash-up, not a recomputation** — each row shows the
 *     snapshot's expected/counted/variance, every tender class (SnapFood and
 *     cheque included), cash movements and any audited corrections. When today's
 *     payments no longer add up to what the shift recorded, the *restated* figure
 *     is shown beside the snapshot, never in place of it.
 *   * **Force-close cannot invent a count** — the expected amount is read-only,
 *     the counted field starts empty, and "close without a count" is a separate,
 *     reasoned action that records an unresolved cash-up.
 *   * **Corrections are their own records** — an adjustment needs a reason and
 *     leaves the original variance visible.
 *   * **CSV export** of the loaded rows, in the business's display unit, so the
 *     shift can leave the screen without reusing the report engine (#819 owns
 *     the report builder).
 *
 * Self-service clock-in/out is the sidebar's ShiftButton (shift-panel.tsx);
 * this tab never opens or ends a shift on the employee's behalf except when
 * force-closing one they left open.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ClockIcon } from "lucide-react";
import { formatJalali } from "@/lib/jalali";
import { toPersianDigits } from "@/lib/digits";
import { formatMoney, moneyToExportText, type MoneyUnit } from "@/lib/money";
import { useMoney } from "@/components/money/money-context";
import { ErrorBox, InfoBox, api, errorMessage, inputClass } from "@/app/dashboard/ui";
import { Button } from "@/components/ui/button";
import { JalaliDatePicker } from "@/app/dashboard/jalali-date-picker";
import { newIdempotencyKey } from "@/lib/idempotency";

interface TenderTotals {
  cash: number;
  card: number;
  cardToCard: number;
  online: number;
  credit: number;
  snappfood: number;
  cheque: number;
  other: number;
  total: number;
}

interface CashSummary {
  orderCount: number;
  grossTotal: number;
  cashTotal: number;
  cardTotal: number;
  onlineTotal: number;
  creditTotal: number;
  tenders: TenderTotals;
  cashMovementsIn: number;
  cashMovementsOut: number;
}

interface Cashup {
  id: string;
  closeMode: "counted" | "unresolved";
  reason: string | null;
  closedByName: string | null;
  openingFloat: number | null;
  expectedCash: number | null;
  countedCash: number | null;
  variance: number | null;
  cashIn: number;
  cashOut: number;
  orderCount: number;
  grossTotal: number;
  tenders: TenderTotals;
  tieOut: { grossTotal: number; tenderedTotal: number; difference: number; explainsGross: boolean };
  createdAt: string;
}

interface Adjustment {
  id: string;
  beforeVariance: number | null;
  afterVariance: number | null;
  delta: number | null;
  reason: string;
  createdByName: string | null;
  createdAt: string;
}

interface Shift {
  id: string;
  employeeName: string;
  locationName: string | null;
  businessDate: string;
  openingFloat: number | null;
  closingFloat: number | null;
  startedAt: string;
  endedAt: string | null;
  closeMode: "counted" | "unresolved" | null;
  cashSummary: CashSummary;
  reconciliation: { expectedCash: number | null; variance: number | null; status: string };
  cashup: Cashup | null;
  cashSource: "finalized" | "live";
  restated: { orderCount: number; grossTotal: number; cashTotal: number; variance: number | null } | null;
  adjustments: Adjustment[];
}

interface FilterOptions {
  locations: { id: string; name: string }[];
  employees: { id: string; name: string }[];
}

interface ShiftResponse {
  shifts: Shift[];
  hasMore?: boolean;
  options?: FilterOptions;
  capabilities?: { canForceClose: boolean; canAdjust: boolean };
  error?: string;
}

type StatusFilter = "" | "open" | "closed";

const PAGE_SIZE = 25;

const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: "", label: "همه" },
  { value: "open", label: "باز" },
  { value: "closed", label: "بسته‌شده" },
];

interface Filters {
  status: StatusFilter;
  locationId: string;
  employeeId: string;
  from: string;
  to: string;
  shiftId: string;
  onlyVariance: boolean;
  onlyUnresolved: boolean;
}

const EMPTY_FILTERS: Filters = {
  status: "",
  locationId: "",
  employeeId: "",
  from: "",
  to: "",
  shiftId: "",
  onlyVariance: false,
  onlyUnresolved: false,
};

/** The same chip the audit-log tab uses, so the two sibling panels filter identically. */
function filterChipClass(active: boolean): string {
  return (
    "min-h-9 rounded-lg border px-3 text-xs font-medium transition-colors " +
    (active
      ? "border-amber-200 dark:border-amber-500/30 bg-amber-100 dark:bg-amber-500/20 text-amber-950 dark:text-amber-200"
      : "border-border/80 text-muted-foreground hover:bg-muted")
  );
}

function formatMoment(iso: string): string {
  return toPersianDigits(formatJalali(iso, { withMonthName: true, withTime: true }));
}

function formatBusinessDate(iso: string): string {
  return toPersianDigits(formatJalali(iso, { withMonthName: true }));
}

/** A shift's end reads as a time alone when it finished on the day it started — the date above it already said which day. */
function formatEnd(shift: Shift): string {
  if (!shift.endedAt) return "در حال انجام";
  const sameDay =
    formatJalali(shift.startedAt, { withMonthName: true }) ===
    formatJalali(shift.endedAt, { withMonthName: true });
  return toPersianDigits(
    sameDay
      ? formatJalali(shift.endedAt, { withTime: true }).split(" ").pop() ?? ""
      : formatJalali(shift.endedAt, { withMonthName: true, withTime: true }),
  );
}

/** «۷ ساعت و ۲۰ دقیقه» — the figure a reviewer checking a forgotten clock-out is looking for. */
function formatDuration(shift: Shift): string {
  const end = shift.endedAt ? Date.parse(shift.endedAt) : Date.now();
  const start = Date.parse(shift.startedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return "";
  const minutes = Math.floor((end - start) / 60_000);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${toPersianDigits(rest)} دقیقه`;
  if (rest === 0) return `${toPersianDigits(hours)} ساعت`;
  return `${toPersianDigits(hours)} ساعت و ${toPersianDigits(rest)} دقیقه`;
}

function formatFloat(value: number | null, unit: MoneyUnit): string {
  return value === null ? "—" : toPersianDigits(formatMoney(value, unit));
}

function formatVariance(variance: number | null, unit: MoneyUnit): string {
  if (variance === null) return "نامشخص";
  const amount = toPersianDigits(formatMoney(Math.abs(variance), unit));
  if (variance === 0) return "بدون کسری/اضافه";
  return variance > 0 ? `${amount} اضافه` : `${amount} کسری`;
}

/** A fact of the shift: label above, value below — the same two-line shape the shift-orders report uses. */
function Fact({ label, value, tone }: { label: string; value: string; tone?: "warn" | "good" }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd
        className={
          "truncate text-xs font-semibold tabular-nums " +
          (tone === "warn"
            ? "text-destructive"
            : tone === "good"
              ? "text-emerald-700 dark:text-emerald-400"
              : "text-foreground")
        }
      >
        {value}
      </dd>
    </div>
  );
}

function Badge({ children, tone }: { children: React.ReactNode; tone: "open" | "warn" | "info" }) {
  const className =
    tone === "open"
      ? "bg-amber-100 text-amber-950 dark:bg-amber-500/20 dark:text-amber-200"
      : tone === "warn"
        ? "bg-destructive/10 text-destructive"
        : "bg-muted text-muted-foreground";
  return (
    <span className={`inline-flex items-center gap-1 rounded-xl px-2 py-0.5 text-[11px] font-semibold ${className}`}>
      {children}
    </span>
  );
}

/** A complete UUID. A half-typed id must not empty the list on every keystroke. */
function isUuidText(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function csvCell(value: string | number | null): string {
  const text = value === null ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function ShiftHistorySettings() {
  const money = useMoney();
  const [shifts, setShifts] = useState<Shift[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [options, setOptions] = useState<FilterOptions>({ locations: [], employees: [] });
  const [canAdjust, setCanAdjust] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [closingId, setClosingId] = useState<string | null>(null);
  const [closingAmount, setClosingAmount] = useState("");
  const [closingWithoutCount, setClosingWithoutCount] = useState(false);
  const [closingReason, setClosingReason] = useState("");
  const [closingConfirmed, setClosingConfirmed] = useState(false);
  /**
   * One key per force-close attempt. A retried request (a timeout, a double
   * click) returns the committed cash-up instead of `no_active_shift`.
   */
  const [closingKey, setClosingKey] = useState<string | null>(null);
  const [adjustingId, setAdjustingId] = useState<string | null>(null);
  const [adjustDelta, setAdjustDelta] = useState("");
  const [adjustReason, setAdjustReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  // Every fetch here ends in a setState, and this panel unmounts the moment the
  // member picks another settings section — see the same guard in
  // business-day-settings.tsx.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /** Only the newest filter/page read may write state (#933 item 12). */
  const requestSeq = useRef(0);

  const queryString = useCallback((current: Filters, offset: number) => {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
    if (current.status) params.set("status", current.status);
    if (current.locationId) params.set("locationId", current.locationId);
    if (current.employeeId) params.set("employeeId", current.employeeId);
    if (current.from) params.set("from", current.from);
    if (current.to) params.set("to", current.to);
    if (current.shiftId && isUuidText(current.shiftId)) params.set("shiftId", current.shiftId);
    if (current.onlyVariance) params.set("onlyVariance", "1");
    if (current.onlyUnresolved) params.set("onlyUnresolved", "1");
    return params.toString();
  }, []);

  const fetchPage = useCallback(
    async (current: Filters, offset: number) =>
      api<ShiftResponse>(`/api/shifts?${queryString(current, offset)}`),
    [queryString],
  );

  const load = useCallback(
    async (current: Filters) => {
      const seq = ++requestSeq.current;
      const { ok, data } = await fetchPage(current, 0);
      if (!alive.current || seq !== requestSeq.current) return;
      if (ok) {
        setShifts(data.shifts);
        setHasMore(Boolean(data.hasMore));
        if (data.options) setOptions(data.options);
        setCanAdjust(Boolean(data.capabilities?.canAdjust));
        // Cleared on success: an error from a previous attempt that has since
        // succeeded must not stay on screen contradicting the list below it.
        setError("");
      } else {
        setShifts([]);
        setHasMore(false);
        setError(errorMessage(data.error));
      }
    },
    [fetchPage],
  );

  useEffect(() => {
    setShifts(null);
    void load(filters);
  }, [load, filters]);

  async function loadMore() {
    if (!shifts) return;
    const seq = ++requestSeq.current;
    setLoadingMore(true);
    const { ok, data } = await fetchPage(filters, shifts.length);
    if (!alive.current || seq !== requestSeq.current) return;
    setLoadingMore(false);
    if (!ok) {
      setError(errorMessage(data.error));
      return;
    }
    setShifts((current) => [...(current ?? []), ...data.shifts]);
    setHasMore(Boolean(data.hasMore));
  }

  function beginClose(shift: Shift) {
    setClosingId(shift.id);
    // Deliberately empty: the expected figure is shown read-only, and a count
    // nobody performed must never be what gets submitted (#933 item 10).
    setClosingAmount("");
    setClosingWithoutCount(false);
    setClosingReason("");
    setClosingConfirmed(false);
    setClosingKey(newIdempotencyKey("force-close"));
    setAdjustingId(null);
    setNotice("");
    setError("");
  }

  function expectedFor(shift: Shift): number | null {
    if (shift.reconciliation.expectedCash !== null) return shift.reconciliation.expectedCash;
    if (shift.openingFloat === null) return null;
    return shift.openingFloat + shift.cashSummary.cashTotal + shift.cashSummary.cashMovementsIn - shift.cashSummary.cashMovementsOut;
  }

  function countedPreview(shift: Shift): number | null {
    if (!closingAmount.trim()) return null;
    try {
      return money.parse(closingAmount);
    } catch {
      return null;
    }
  }

  async function forceClose(shift: Shift) {
    setBusy(true);
    setError("");
    setNotice("");
    let countedCash: number | undefined;
    if (!closingWithoutCount && closingAmount.trim()) {
      try {
        countedCash = money.parse(closingAmount);
      } catch {
        setBusy(false);
        setError(errorMessage("invalid_amount"));
        return;
      }
      if (countedCash < 0) {
        setBusy(false);
        setError("موجودی صندوق نمی‌تواند منفی باشد.");
        return;
      }
    }
    if (!closingWithoutCount && countedCash === undefined) {
      setBusy(false);
      setError("مبلغ شمرده‌شده را وارد کنید، یا گزینهٔ «صندوق شمرده نشده است» را انتخاب کنید.");
      return;
    }
    if (closingWithoutCount && !closingReason.trim()) {
      setBusy(false);
      setError("برای بستن بدون شمارش، دلیل آن را بنویسید.");
      return;
    }
    if (!closingConfirmed) {
      setBusy(false);
      setError("پیش از بستن، تأییدیه را علامت بزنید.");
      return;
    }
    // No silent fallback: an uncounted close is always the explicit action,
    // with the operator's own reason. A canned reason would make the audit row
    // look like somebody explained a decision nobody made.
    const body = closingWithoutCount
      ? { withoutCount: true, reason: closingReason.trim() }
      : { countedCash: countedCash as number, reason: closingReason.trim() || null };

    const { ok, data } = await api<{
      error?: string;
      reconciliation?: { expectedCash: number | null; variance: number | null } | null;
      replayed?: boolean;
    }>(`/api/shifts/${shift.id}/close`, {
      method: "POST",
      headers: closingKey ? { "Idempotency-Key": closingKey } : undefined,
      body: JSON.stringify(body),
    });
    if (!alive.current) return;
    setBusy(false);
    if (!ok) {
      setError(errorMessage(data.error));
      return;
    }
    setNotice(
      data.reconciliation && data.reconciliation.variance !== null
        ? `شیفت بسته شد — ${formatVariance(data.reconciliation.variance, money.unit)}${data.replayed ? " (نتیجهٔ ثبت‌شدهٔ قبلی)" : ""}.`
        : "شیفت بدون شمارش صندوق بسته شد؛ اختلاف صندوق «نامشخص» ثبت شد.",
    );
    setClosingId(null);
    setClosingAmount("");
    setClosingWithoutCount(false);
    setClosingReason("");
    setClosingConfirmed(false);
    setClosingKey(null);
    await load(filters);
  }

  async function submitAdjustment(shift: Shift) {
    setBusy(true);
    setError("");
    setNotice("");
    let delta: number;
    try {
      delta = money.parse(adjustDelta);
    } catch {
      setBusy(false);
      setError(errorMessage("invalid_amount"));
      return;
    }
    if (!delta) {
      setBusy(false);
      setError("مبلغ اصلاح نمی‌تواند صفر باشد.");
      return;
    }
    if (!adjustReason.trim()) {
      setBusy(false);
      setError("دلیل اصلاح را بنویسید.");
      return;
    }
    // The adjustment is a *correction to the variance*: a positive delta moves
    // it towards "over", a negative one towards "short". The sign is explicit in
    // the form rather than inferred.
    const { ok, data } = await api<{ error?: string }>(`/api/shifts/${shift.id}/adjustments`, {
      method: "POST",
      body: JSON.stringify({ delta, reason: adjustReason.trim() }),
    });
    if (!alive.current) return;
    setBusy(false);
    if (!ok) {
      setError(errorMessage(data.error));
      return;
    }
    setNotice("اصلاح مستند ثبت شد؛ تصویر اصلی شیفت تغییر نکرد.");
    setAdjustingId(null);
    setAdjustDelta("");
    setAdjustReason("");
    await load(filters);
  }

  const csv = useMemo(() => {
    if (!shifts || shifts.length === 0) return "";
    const header = [
      "شناسه شیفت",
      "کارمند",
      "شعبه",
      "روز کاری",
      "شروع",
      "پایان",
      "وضعیت",
      "موجودی اول",
      "مبلغ مورد انتظار",
      "شمارش‌شده",
      "اختلاف",
      "نقدی",
      "کارت‌خوان",
      "کارت‌به‌کارت",
      "آنلاین",
      "نسیه",
      "اسنپ‌فود",
      "چک",
      "ورود نقدی",
      "خروج نقدی",
      "فروش کل",
      "تعداد فاکتور",
      "دلیل/یادداشت",
    ];
    // Money in the CSV must be in the business's display unit (toman vs rial),
    // not raw Rial — otherwise a Toman business sees 10× the on-screen figure.
    const moneyForCsv = (rial: number | null): string => {
      if (rial === null || rial === undefined) return "";
      // Use export text so 1 rial in Toman is "0.1" rather than silently 0.
      return moneyToExportText(String(rial), money.unit);
    };
    const rows = shifts.map((shift) => [
      shift.id,
      shift.employeeName,
      shift.locationName ?? "",
      // Business day and instants are shown in Jalali — Gregorian dates in a
      // Persian-facing export are the wrong calendar (AGENTS.md date rule).
      formatJalali(shift.businessDate),
      formatJalali(shift.startedAt, { withTime: true }),
      shift.endedAt ? formatJalali(shift.endedAt, { withTime: true }) : "",
      shift.endedAt ? (shift.cashup?.closeMode ?? "closed") : "open",
      moneyForCsv(shift.openingFloat),
      moneyForCsv(shift.reconciliation.expectedCash),
      moneyForCsv(shift.cashup?.countedCash ?? null),
      moneyForCsv(shift.reconciliation.variance),
      moneyForCsv(shift.cashSummary.tenders.cash),
      moneyForCsv(shift.cashSummary.tenders.card),
      moneyForCsv(shift.cashSummary.tenders.cardToCard),
      moneyForCsv(shift.cashSummary.tenders.online),
      moneyForCsv(shift.cashSummary.tenders.credit),
      moneyForCsv(shift.cashSummary.tenders.snappfood),
      moneyForCsv(shift.cashSummary.tenders.cheque),
      moneyForCsv(shift.cashSummary.cashMovementsIn),
      moneyForCsv(shift.cashSummary.cashMovementsOut),
      moneyForCsv(shift.cashSummary.grossTotal),
      String(shift.cashSummary.orderCount),
      shift.cashup?.reason ?? "",
    ]);
    return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
  }, [shifts, money.unit]);

  function downloadCsv() {
    if (!csv) return;
    // The BOM is what makes Excel open a UTF-8 CSV as Persian instead of
    // mojibake; it is the one convention every other export in this app uses.
    const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `shift-cashups-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  const activeFilterCount = [
    filters.status !== "",
    filters.locationId !== "",
    filters.employeeId !== "",
    filters.from !== "",
    filters.to !== "",
    filters.shiftId !== "",
    filters.onlyVariance,
    filters.onlyUnresolved,
  ].filter(Boolean).length;

  return (
    <div className="space-y-6">
      <SectionCard
        title={
          <div>
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">عملکرد پرسنل</p>
            <h2 className="mt-1 text-base sm:text-lg font-semibold text-foreground">شیفت‌ها</h2>
          </div>
        }
        description="تاریخچهٔ ورود/خروج کارکنان، تصویر بستهٔ صندوق هر شیفت و اصلاح‌های مستند آن. شیفت بازمانده را می‌توانید از همین‌جا ببندید — با شمارش واقعی یا به‌صورت «بدون شمارش» با دلیل."
      >
        <ErrorBox>{error}</ErrorBox>
        {notice ? <InfoBox>{notice}</InfoBox> : null}

        <div className="mb-4 flex flex-wrap items-center gap-2">
          {STATUS_FILTERS.map((filter) => (
            <button
              key={filter.value || "all"}
              type="button"
              onClick={() => setFilters((current) => ({ ...current, status: filter.value }))}
              aria-pressed={filters.status === filter.value}
              className={filterChipClass(filters.status === filter.value)}
            >
              {filter.label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setFilters((current) => ({ ...current, onlyVariance: !current.onlyVariance }))}
            aria-pressed={filters.onlyVariance}
            className={filterChipClass(filters.onlyVariance)}
          >
            دارای اختلاف
          </button>
          <button
            type="button"
            onClick={() => setFilters((current) => ({ ...current, onlyUnresolved: !current.onlyUnresolved }))}
            aria-pressed={filters.onlyUnresolved}
            className={filterChipClass(filters.onlyUnresolved)}
          >
            بدون شمارش / نامشخص
          </button>
          {activeFilterCount > 0 ? (
            <Button type="button" variant="ghost" size="xs" onClick={() => setFilters(EMPTY_FILTERS)}>
              پاک‌کردن فیلترها ({toPersianDigits(activeFilterCount)})
            </Button>
          ) : null}
          <div className="ms-auto">
            <Button type="button" variant="outline" size="xs" onClick={downloadCsv} disabled={!csv}>
              دریافت CSV همین صفحه
            </Button>
          </div>
        </div>

        <div className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          <label className="flex min-w-0 flex-col gap-1 text-xs">
            <span className="text-muted-foreground">شعبه</span>
            <select
              className={inputClass}
              value={filters.locationId}
              onChange={(event) => setFilters((current) => ({ ...current, locationId: event.target.value }))}
            >
              <option value="">همهٔ شعبه‌های مجاز</option>
              {options.locations.map((location) => (
                <option key={location.id} value={location.id}>
                  {location.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex min-w-0 flex-col gap-1 text-xs">
            <span className="text-muted-foreground">کارمند</span>
            <select
              className={inputClass}
              value={filters.employeeId}
              onChange={(event) => setFilters((current) => ({ ...current, employeeId: event.target.value }))}
            >
              <option value="">همهٔ کارکنان</option>
              {options.employees.map((employee) => (
                <option key={employee.id} value={employee.id}>
                  {employee.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex min-w-0 flex-col gap-1 text-xs">
            <span className="text-muted-foreground">شناسهٔ شیفت</span>
            <input
              className={inputClass + " tabular-nums"}
              dir="ltr"
              value={filters.shiftId}
              onChange={(event) => setFilters((current) => ({ ...current, shiftId: event.target.value.trim() }))}
              placeholder="xxxxxxxx-xxxx-…"
              aria-describedby="shift-id-hint"
            />
            {filters.shiftId && !isUuidText(filters.shiftId) ? (
              <span id="shift-id-hint" className="text-[11px] text-muted-foreground">
                شناسهٔ کامل شیفت را وارد کنید؛ تا آن زمان فیلتر اعمال نمی‌شود.
              </span>
            ) : null}
          </label>
          <label className="flex min-w-0 flex-col gap-1 text-xs">
            <span className="text-muted-foreground">از روز کاری</span>
            <JalaliDatePicker
              value={filters.from}
              onChange={(iso) => setFilters((current) => ({ ...current, from: iso }))}
              placeholder="انتخاب تاریخ"
            />
          </label>
          <label className="flex min-w-0 flex-col gap-1 text-xs">
            <span className="text-muted-foreground">تا روز کاری</span>
            <JalaliDatePicker
              value={filters.to}
              onChange={(iso) => setFilters((current) => ({ ...current, to: iso }))}
              placeholder="انتخاب تاریخ"
            />
          </label>
        </div>

        {shifts === null && <LoadingSkeleton rows={3} label="در حال بارگذاری تاریخچهٔ شیفت‌ها" />}
        {shifts !== null && shifts.length === 0 && !error && (
          <EmptyState>
            {activeFilterCount > 0
              ? "هیچ شیفتی با این فیلترها پیدا نشد."
              : filters.status === "open"
                ? "هیچ شیفت بازی وجود ندارد."
                : filters.status === "closed"
                  ? "هنوز شیفت بسته‌شده‌ای ثبت نشده است."
                  : "هنوز شیفتی ثبت نشده است."}
          </EmptyState>
        )}
        {shifts !== null && shifts.length === 0 && error ? (
          <div className="mt-2">
            <Button type="button" variant="outline" size="sm" onClick={() => void load(filters)}>
              تلاش دوباره
            </Button>
          </div>
        ) : null}

        {shifts !== null && shifts.length > 0 && (
          <ul className="space-y-2">
            {shifts.map((shift) => {
              const open = !shift.endedAt;
              const variance = shift.reconciliation.variance;
              const unresolved = !open && shift.reconciliation.status === "unresolved";
              const tenderLines: { label: string; value: number }[] = [
                { label: "نقدی", value: shift.cashSummary.tenders.cash },
                { label: "کارت‌خوان", value: shift.cashSummary.tenders.card },
                { label: "کارت‌به‌کارت", value: shift.cashSummary.tenders.cardToCard },
                { label: "آنلاین", value: shift.cashSummary.tenders.online },
                { label: "نسیه", value: shift.cashSummary.tenders.credit },
                { label: "اسنپ‌فود", value: shift.cashSummary.tenders.snappfood },
                { label: "چک", value: shift.cashSummary.tenders.cheque },
                { label: "سایر", value: shift.cashSummary.tenders.other },
              ].filter((line) => line.value !== 0);
              return (
                <li key={shift.id} className="rounded-xl border border-input px-3 py-3 text-sm">
                  <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-2 font-medium">
                        <span className="min-w-0 break-words">{shift.employeeName}</span>
                        {open ? (
                          <Badge tone="open">
                            <ClockIcon aria-hidden="true" className="size-3" />
                            شیفت باز
                          </Badge>
                        ) : null}
                        {unresolved ? <Badge tone="info">بدون شمارش</Badge> : null}
                        {!open && variance !== null && variance !== 0 ? (
                          <Badge tone="warn">{formatVariance(variance, money.unit)}</Badge>
                        ) : null}
                        {shift.adjustments.length > 0 ? <Badge tone="info">اصلاح‌شده</Badge> : null}
                        {shift.locationName ? (
                          <span className="text-xs font-normal text-muted-foreground">{shift.locationName}</span>
                        ) : (
                          <span className="text-xs font-normal text-muted-foreground">شعبه نامشخص</span>
                        )}
                      </p>
                      <p className="mt-0.5 text-xs break-words text-muted-foreground">
                        روز کاری {formatBusinessDate(shift.businessDate)} · {formatMoment(shift.startedAt)} تا{" "}
                        {formatEnd(shift)}
                        {formatDuration(shift) ? ` · ${formatDuration(shift)}` : ""}
                        {shift.cashup?.closedByName ? ` · بسته‌شده توسط ${shift.cashup.closedByName}` : ""}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center gap-2">
                      {!open ? (
                        <a
                          className="text-xs font-medium text-amber-700 underline-offset-4 hover:underline dark:text-amber-300"
                          href={`/accounting/reports?tab=shift-orders&shift=${shift.id}`}
                        >
                          سفارش‌های شیفت
                        </a>
                      ) : null}
                      {open && closingId !== shift.id && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                          onClick={() => beginClose(shift)}
                        >
                          بستن شیفت
                        </Button>
                      )}
                      {!open && shift.cashup && canAdjust && adjustingId !== shift.id ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          onClick={() => {
                            setAdjustingId(shift.id);
                            setClosingId(null);
                            setAdjustDelta("");
                            setAdjustReason("");
                            setNotice("");
                            setError("");
                          }}
                        >
                          اصلاح تطبیق
                        </Button>
                      ) : null}
                    </div>
                  </div>

                  <dl className="mt-2.5 grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-4">
                    <Fact label="موجودی اول" value={formatFloat(shift.openingFloat, money.unit)} />
                    <Fact
                      label="مبلغ مورد انتظار"
                      value={formatFloat(shift.reconciliation.expectedCash, money.unit)}
                    />
                    <Fact
                      label={open ? "موجودی آخر" : "شمارش‌شده"}
                      value={open ? "—" : formatFloat(shift.cashup?.countedCash ?? shift.closingFloat, money.unit)}
                    />
                    <Fact
                      label="اختلاف"
                      value={formatVariance(variance, money.unit)}
                      tone={variance === null ? undefined : variance === 0 ? "good" : "warn"}
                    />
                    <Fact
                      label="فروش کل"
                      value={toPersianDigits(formatMoney(shift.cashSummary.grossTotal, money.unit))}
                    />
                    <Fact label="تعداد فاکتور" value={toPersianDigits(shift.cashSummary.orderCount)} />
                    <Fact
                      label="ورود/خروج نقدی"
                      value={`${toPersianDigits(formatMoney(shift.cashSummary.cashMovementsIn, money.unit))} / ${toPersianDigits(formatMoney(shift.cashSummary.cashMovementsOut, money.unit))}`}
                    />
                    <Fact
                      label="منبع ارقام"
                      value={shift.cashSource === "finalized" ? "تصویر بستهٔ ثبت‌شده" : open ? "جاری" : "بازخوانی از سفارش‌ها"}
                    />
                  </dl>

                  {tenderLines.length > 0 ? (
                    <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                      {tenderLines.map((line) => (
                        <span key={line.label}>
                          {line.label}:{" "}
                          <span className="tabular-nums text-foreground">
                            {toPersianDigits(formatMoney(line.value, money.unit))}
                          </span>
                        </span>
                      ))}
                    </p>
                  ) : null}

                  {shift.cashup && !shift.cashup.tieOut.explainsGross ? (
                    <p className="mt-2 text-[11px] text-amber-700 dark:text-amber-300">
                      جمع روش‌های پرداخت با فروش کل برابر نیست (اختلاف{" "}
                      {toPersianDigits(formatMoney(shift.cashup.tieOut.difference, money.unit))}). علت رایج: نسیه،
                      اسنپ‌فود، یا اصلاح سفارش پس از تسویه.
                    </p>
                  ) : null}

                  {shift.cashup && shift.cashSource === "finalized" && shift.restated &&
                  (shift.restated.cashTotal !== shift.cashSummary.tenders.cash ||
                    shift.restated.variance !== shift.reconciliation.variance) ? (
                    <p className="mt-2 text-[11px] text-muted-foreground">
                      بازخوانی امروز از سفارش‌ها: نقدی{" "}
                      {toPersianDigits(formatMoney(shift.restated.cashTotal, money.unit))}، اختلاف{" "}
                      {formatVariance(shift.restated.variance, money.unit)} — تصویر بستهٔ ثبت‌شده تغییر نمی‌کند.
                    </p>
                  ) : null}

                  {shift.cashup?.reason ? (
                    <p className="mt-2 text-[11px] break-words text-muted-foreground">
                      دلیل بستن: {shift.cashup.reason}
                    </p>
                  ) : null}

                  {shift.adjustments.length > 0 ? (
                    <ul className="mt-2 space-y-1 border-t border-border/70 pt-2 text-[11px] text-muted-foreground">
                      {shift.adjustments.map((adjustment) => (
                        <li key={adjustment.id} className="break-words">
                          اصلاح {formatMoment(adjustment.createdAt)}
                          {adjustment.createdByName ? ` توسط ${adjustment.createdByName}` : ""}: از{" "}
                          {formatVariance(adjustment.beforeVariance, money.unit)} به{" "}
                          {formatVariance(adjustment.afterVariance, money.unit)} — {adjustment.reason}
                        </li>
                      ))}
                    </ul>
                  ) : null}

                  {closingId === shift.id && (
                    <div className="mt-3 rounded-lg border border-dashed border-border p-3">
                      <p className="mb-1 text-xs font-medium">بستن شیفت {shift.employeeName}</p>
                      <p className="mb-2 text-[11px] text-muted-foreground">
                        مبلغ مورد انتظار صندوق (فقط خواندنی):{" "}
                        <span className="font-semibold text-foreground tabular-nums">
                          {formatFloat(expectedFor(shift), money.unit)}
                        </span>
                        . شمارش واقعی را خودتان وارد کنید؛ عدد مورد انتظار هرگز به‌جای شمارش ثبت نمی‌شود.
                      </p>
                      <label className="mb-1 block text-xs font-medium" htmlFor={`closing-float-${shift.id}`}>
                        موجودی شمرده‌شدهٔ صندوق ({money.unitLabel})
                      </label>
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                        <PersianNumberInput
                          id={`closing-float-${shift.id}`}
                          className={inputClass + " tabular-nums sm:flex-1"}
                          dir="ltr"
                          inputMode="numeric"
                          allowNegative={false}
                          value={closingAmount}
                          onChange={(e) => {
                            if (!busy) setClosingKey(newIdempotencyKey("force-close"));
                            setClosingAmount(e.target.value);
                          }}
                          placeholder="خالی = بدون شمارش"
                          disabled={busy || closingWithoutCount}
                        />
                      </div>
                      {countedPreview(shift) !== null && expectedFor(shift) !== null ? (
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          اختلاف پیش‌بینی‌شده:{" "}
                          <span className="font-semibold text-foreground">
                            {formatVariance((countedPreview(shift) ?? 0) - (expectedFor(shift) ?? 0), money.unit)}
                          </span>
                        </p>
                      ) : null}

                      <label className="mt-3 flex items-start gap-2 text-xs">
                        <input
                          type="checkbox"
                          className="mt-0.5"
                          checked={closingWithoutCount}
                          onChange={(event) => {
                            if (!busy) setClosingKey(newIdempotencyKey("force-close"));
                            setClosingWithoutCount(event.target.checked);
                            if (event.target.checked) setClosingAmount("");
                          }}
                          disabled={busy}
                        />
                        <span>صندوق شمرده نشده است؛ بستن به‌صورت «نامشخص» با ثبت دلیل</span>
                      </label>

                      <label className="mt-2 flex flex-col gap-1 text-xs">
                        <span className="text-muted-foreground">
                          دلیل / یادداشت {closingWithoutCount ? "(الزامی)" : "(اختیاری)"}
                        </span>
                        <input
                          className={inputClass}
                          value={closingReason}
                          onChange={(event) => {
                            if (!busy) setClosingKey(newIdempotencyKey("force-close"));
                            setClosingReason(event.target.value);
                          }}
                          maxLength={500}
                          disabled={busy}
                          placeholder="مثلاً: کارمند فراموش کرده ببندد؛ صندوق فردا شمرده می‌شود."
                        />
                      </label>

                      <label className="mt-2 flex items-start gap-2 text-xs">
                        <input
                          type="checkbox"
                          className="mt-0.5"
                          checked={closingConfirmed}
                          onChange={(event) => setClosingConfirmed(event.target.checked)}
                          disabled={busy}
                        />
                        <span>می‌دانم این کار شیفت را برای همیشه می‌بندد و در سابقهٔ حسابرسی ثبت می‌شود.</span>
                      </label>

                      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                        <Button
                          type="button"
                          size="sm"
                          className="flex-1 sm:flex-none"
                          onClick={() => void forceClose(shift)}
                          disabled={busy || !closingConfirmed}
                        >
                          {busy ? "در حال ثبت…" : closingWithoutCount ? "بستن بدون شمارش" : "تأیید و بستن"}
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="flex-1 sm:flex-none"
                          disabled={busy}
                          onClick={() => {
                            setClosingId(null);
                            setClosingAmount("");
                            setClosingReason("");
                            setClosingWithoutCount(false);
                            setClosingConfirmed(false);
                          }}
                        >
                          انصراف
                        </Button>
                      </div>
                    </div>
                  )}

                  {adjustingId === shift.id && shift.cashup && (
                    <div className="mt-3 rounded-lg border border-dashed border-border p-3">
                      <p className="mb-1 text-xs font-medium">اصلاح مستند تطبیق صندوق</p>
                      <p className="mb-2 text-[11px] text-muted-foreground">
                        تصویر بستهٔ شیفت تغییر نمی‌کند؛ یک رکورد اصلاح با دلیل و مقادیر قبل/بعد ثبت می‌شود.
                        اختلاف فعلی: {formatVariance(shift.reconciliation.variance, money.unit)}.
                      </p>
                      <label className="mb-1 block text-xs font-medium" htmlFor={`adjust-delta-${shift.id}`}>
                        مقدار اصلاح ({money.unitLabel}) — مثبت: به سمت اضافه، منفی: به سمت کسری
                      </label>
                      <PersianNumberInput
                        id={`adjust-delta-${shift.id}`}
                        className={inputClass + " tabular-nums"}
                        dir="ltr"
                        inputMode="numeric"
                        allowNegative
                        value={adjustDelta}
                        onChange={(event) => setAdjustDelta(event.target.value)}
                        disabled={busy}
                      />
                      <label className="mt-2 flex flex-col gap-1 text-xs">
                        <span className="text-muted-foreground">دلیل اصلاح (الزامی)</span>
                        <input
                          className={inputClass}
                          value={adjustReason}
                          onChange={(event) => setAdjustReason(event.target.value)}
                          maxLength={500}
                          disabled={busy}
                          placeholder="مثلاً: یک فاکتور پرداخت‌شده بعداً باطل شد."
                        />
                      </label>
                      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                        <Button
                          type="button"
                          size="sm"
                          className="flex-1 sm:flex-none"
                          onClick={() => void submitAdjustment(shift)}
                          disabled={busy}
                        >
                          {busy ? "در حال ثبت…" : "ثبت اصلاح"}
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="flex-1 sm:flex-none"
                          disabled={busy}
                          onClick={() => {
                            setAdjustingId(null);
                            setAdjustDelta("");
                            setAdjustReason("");
                          }}
                        >
                          انصراف
                        </Button>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {shifts !== null && hasMore ? (
          <div className="mt-4 flex justify-center">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={loadMore}
              disabled={loadingMore}
            >
              {loadingMore ? "در حال بارگذاری…" : "نمایش شیفت‌های قدیمی‌تر"}
            </Button>
          </div>
        ) : null}
      </SectionCard>
    </div>
  );
}
