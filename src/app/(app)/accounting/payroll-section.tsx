"use client";

import { EmptyState, SectionCardSkeleton, StatusBadge } from "@/app/dashboard/page-chrome";

import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali, JALALI_MONTHS, todayJalali } from "@/lib/jalali";
import { useMoney } from "@/components/money/money-context";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { JalaliDatePicker } from "@/app/dashboard/jalali-date-picker";
import { api, errorMessage, inputClass, PrimaryButton, SecondaryButton } from "@/app/dashboard/ui";
import type { Runner } from "./accounting-manager";
import { cardClass } from "@/app/dashboard/page-chrome";
import {
  DataTable,
  DataTableBody,
  DataTableFoot,
  DataTableHead,
  DataTableRow,
  Td,
  Th,
} from "@/app/dashboard/data-table";
import { roleLabel } from "@/lib/role-labels";
import {
  computeGrossToNet,
  EMPTY_PAYROLL_SETTINGS,
  payrollSettingsApplyDeductions,
  type GrossToNetBreakdown,
  type PayrollSettings,
} from "@/lib/payroll-gross-to-net";
import { PayrollSettingsPanel } from "./payroll-settings-panel";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

interface StaffWage {
  id: string;
  fullName: string;
  role: string;
  monthlyWage: number | null;
  taxableAllowance: number;
  nonTaxableAllowance: number;
  fixedDeduction: number;
  advanceOutstanding: number;
}

interface PayrollRunLine extends Omit<GrossToNetBreakdown, "advanceCarriedRial"> {
  userId: string | null;
  fullName: string | null;
  amount: number;
}

type PayrollRunStatus = "accrued" | "paid" | "voided";

interface PayrollRun {
  id: string;
  periodKey: string | null;
  periodLabel: string;
  status: PayrollRunStatus;
  totalAmount: number;
  netAmount: number;
  accrualDate: string;
  paidDate: string | null;
  voidedDate: string | null;
  createdByName: string | null;
  lines: PayrollRunLine[];
}

interface PayrollAdvance {
  id: string;
  userId: string;
  fullName: string | null;
  amount: number;
  method: "cash" | "bank";
  advanceDate: string;
  note: string | null;
  status: "active" | "voided";
  createdByName: string | null;
}

/** The four standing figures a row edits, as typed (display unit, ASCII digits). */
interface TermsDraft {
  wage: string;
  taxable: string;
  nonTaxable: string;
  fixed: string;
}

const TERM_FIELDS: Array<{ key: keyof TermsDraft; label: string; api: string }> = [
  { key: "wage", label: "حقوق پایه ماهانه", api: "monthlyWage" },
  { key: "taxable", label: "مزایای مشمول مالیات", api: "taxableAllowance" },
  { key: "nonTaxable", label: "مزایای غیرمشمول", api: "nonTaxableAllowance" },
  { key: "fixed", label: "سایر کسور ثابت", api: "fixedDeduction" },
];

/**
 * The run statuses, as the shared `StatusBadge` tones rather than a private
 * palette. The badge is the primitive every other ledger surface uses for a
 * status pill (`installments`, `chart-of-accounts`).
 */
const STATUS_TONES: Record<PayrollRunStatus, { label: string; tone: "active" | "positive" | "neutral" }> = {
  paid: { label: "پرداخت‌شده", tone: "positive" },
  accrued: { label: "تعهدشده", tone: "active" },
  voided: { label: "ابطال‌شده", tone: "neutral" },
};

/** Payroll's own codes, read before the shared map (whose `invalid_period` means a domain's term). */
const PAYROLL_ERRORS: Record<string, string> = {
  invalid_period: "ماه حقوق معتبر نیست.",
  period_in_future: "این ماه هنوز شروع نشده است و حقوق آن قابل ثبت نیست.",
  period_already_accrued: "برای این ماه قبلاً تعهد حقوق ثبت شده است؛ برای ثبت دوباره ابتدا آن را ابطال کنید.",
  invalid_overtime: "مبلغ اضافه‌کار معتبر نیست.",
  deductions_exceed_gross: "کسور یکی از کارکنان از حقوق ناخالص او بیشتر است؛ کسور ثابت یا نرخ‌ها را بررسی کنید.",
  amount_too_large: "مبلغ حقوق بیش از حد بزرگ است.",
  invalid_amount: "مبلغ وارد‌شده معتبر نیست.",
  invalid_percent: "درصد باید بین ۰ تا ۱۰۰ و حداکثر با دو رقم اعشار باشد.",
  invalid_settings: "تنظیمات حقوق معتبر نیست.",
  invalid_brackets: "پله‌های مالیات معتبر نیست.",
  brackets_not_ascending: "سقف پله‌های مالیات باید صعودی و بیشتر از سقف معافیت باشد.",
  last_bracket_must_be_open: "فقط پلهٔ آخر مالیات باید بدون سقف باشد.",
  too_many_brackets: "تعداد پله‌های مالیات بیش از حد مجاز است.",
  advance_not_found: "مساعده پیدا نشد.",
  advance_already_recovered: "بخشی از این مساعده در حقوق کسر شده است؛ ابتدا تعهد حقوق آن ماه را ابطال کنید.",
  invalid_advance_date: "تاریخ مساعده معتبر نیست.",
  note_too_long: "توضیح مساعده بیش از حد طولانی است.",
  invalid_method: "حساب پرداخت معتبر نیست.",
  already_voided: "این مورد قبلاً ابطال شده است.",
};

function payrollError(code: string | undefined): string {
  return PAYROLL_ERRORS[code ?? ""] ?? errorMessage(code);
}

/**
 * A date the server sent, as Shamsi — or a dash when it is absent/unparseable.
 * `formatJalali` throws on an invalid date; a payroll row whose date somehow
 * arrived malformed should cost one dash, not the screen.
 */
function jalaliOrDash(value: string | null | undefined): string {
  if (!value) return "—";
  try {
    return toPersianDigits(formatJalali(value));
  } catch {
    return "—";
  }
}

/** «مرداد ۱۴۰۴» for a `YYYY-MM` key; an old run's free-text label otherwise. */
function runTitle(run: Pick<PayrollRun, "periodKey" | "periodLabel">): string {
  if (!run.periodKey) return run.periodLabel;
  const [y, m] = run.periodKey.split("-").map(Number);
  return JALALI_MONTHS[m - 1] ? `${JALALI_MONTHS[m - 1]} ${toPersianDigits(y)}` : run.periodLabel;
}

/** One overtime field as Rial: blank is 0, anything unparseable or negative is "bad". */
function parseOvertime(raw: string | undefined, parse: (input: string) => number): number | "bad" {
  const text = (raw ?? "").trim();
  if (!text) return 0;
  try {
    const rial = parse(text);
    return Number.isSafeInteger(rial) && rial >= 0 ? rial : "bad";
  } catch {
    return "bad";
  }
}

function termsFrom(s: StaffWage, toInput: (rial: number) => number): TermsDraft {
  const show = (rial: number) => (rial > 0 ? String(toInput(rial)) : "");
  return {
    wage: s.monthlyWage != null ? String(toInput(s.monthlyWage)) : "",
    taxable: show(s.taxableAllowance),
    nonTaxable: show(s.nonTaxableAllowance),
    fixed: show(s.fixedDeduction),
  };
}

/**
 * Payroll — gross-to-net per Jalali month (audit F11). The rates are the
 * business's own (the settings panel; empty means no deduction), each member
 * has standing terms (wage, allowances, fixed deductions), a run adds the
 * month's overtime and recovers salary advances, and posting goes through the
 * ledger's normal path. Restricted to owner and accountant: wages are
 * compensation data.
 */
export function PayrollSection({ busy, run, refreshKey }: { busy: boolean; run: Runner; refreshKey: number }) {
  const money = useMoney();
  const today = useMemo(() => todayJalali(), []);
  const [staff, setStaff] = useState<StaffWage[] | null>(null);
  const [runs, setRuns] = useState<PayrollRun[] | null>(null);
  const [advances, setAdvances] = useState<PayrollAdvance[] | null>(null);
  const [settings, setSettings] = useState<PayrollSettings | null>(null);
  const [termInputs, setTermInputs] = useState<Record<string, TermsDraft>>({});
  const [savingRow, setSavingRow] = useState<string | null>(null);
  /*
   * The rows the user has typed into since the last load — only these are
   * protected from being overwritten by a refresh. (Keeping every row's text
   * would show rial figures relabelled as toman after a unit switch.) Mirrored
   * in a ref so `load` keeps a stable identity while typing.
   */
  const [editedRows, setEditedRows] = useState<Set<string>>(() => new Set());
  const editedRowsRef = useRef(editedRows);
  useEffect(() => {
    editedRowsRef.current = editedRows;
  }, [editedRows]);

  const [periodYear, setPeriodYear] = useState(today.jy);
  const [periodMonth, setPeriodMonth] = useState(today.jm);
  const [accrualDate, setAccrualDate] = useState("");
  const [overtimeInputs, setOvertimeInputs] = useState<Record<string, string>>({});

  const [advanceUser, setAdvanceUser] = useState("");
  const [advanceAmount, setAdvanceAmount] = useState("");
  const [advanceMethod, setAdvanceMethod] = useState<"cash" | "bank">("cash");
  const [advanceDate, setAdvanceDate] = useState("");
  const [advanceNote, setAdvanceNote] = useState("");

  const [localError, setLocalError] = useState("");
  const [localNotice, setLocalNotice] = useState("");
  /** «پرداخت از» per run — the account the net payout leaves (cash or bank). */
  const [payMethod, setPayMethod] = useState<Record<string, "cash" | "bank">>({});
  /** Which row an action is in flight for, so only that row says «در حال ثبت…». */
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  /** The run «ابطال» is asking about — a real dialog, not `window.confirm`. */
  const [voidTarget, setVoidTarget] = useState<PayrollRun | null>(null);
  const [advanceVoidTarget, setAdvanceVoidTarget] = useState<PayrollAdvance | null>(null);
  const accrualFieldId = useId();
  const advanceDateId = useId();

  const load = useCallback(() => {
    api<{ staff: StaffWage[] }>("/api/ledger/payroll/staff").then(({ ok, data }) => {
      if (ok) {
        setStaff(data.staff);
        setTermInputs((prev) => {
          const next: Record<string, TermsDraft> = {};
          for (const s of data.staff) {
            const server = termsFrom(s, money.toInput);
            next[s.id] = editedRowsRef.current.has(s.id) ? (prev[s.id] ?? server) : server;
          }
          return next;
        });
        setEditedRows((prev) => {
          const live = new Set(data.staff.map((s) => s.id));
          const kept = [...prev].filter((id) => live.has(id));
          return kept.length === prev.size ? prev : new Set(kept);
        });
      } else {
        setStaff([]);
        setLocalError("بارگذاری فهرست کارکنان ناموفق بود.");
      }
    });
    api<{ runs: PayrollRun[] }>("/api/ledger/payroll/runs").then(({ ok, data }) => {
      if (ok) setRuns(data.runs);
      else {
        setRuns([]);
        setLocalError("بارگذاری تاریخچه حقوق ناموفق بود.");
      }
    });
    api<{ advances: PayrollAdvance[] }>("/api/ledger/payroll/advances").then(({ ok, data }) => {
      if (ok) setAdvances(data.advances);
      else {
        setAdvances([]);
        setLocalError("بارگذاری مساعده‌ها ناموفق بود.");
      }
    });
    api<{ settings: PayrollSettings }>("/api/ledger/payroll/settings").then(({ ok, data }) => {
      if (ok) setSettings(data.settings);
      else {
        // Never guess a rate: a failed read computes no deduction in the
        // preview, and says so, while the server keeps its own copy.
        setSettings({ ...EMPTY_PAYROLL_SETTINGS, taxBrackets: [] });
        setLocalError("بارگذاری تنظیمات بیمه و مالیات ناموفق بود.");
      }
    });
  }, [money]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  // A success notice describes something finished, so it should not outlive it.
  useEffect(() => {
    if (!localNotice) return;
    const timer = window.setTimeout(() => setLocalNotice(""), 6000);
    return () => window.clearTimeout(timer);
  }, [localNotice]);

  // Forget the «پرداخت از» choice for runs that are no longer listed.
  useEffect(() => {
    if (!runs) return;
    setPayMethod((prev) => {
      const live = new Set(runs.map((r) => r.id));
      const kept = Object.keys(prev).filter((id) => live.has(id));
      if (kept.length === Object.keys(prev).length) return prev;
      return Object.fromEntries(kept.map((id) => [id, prev[id]]));
    });
  }, [runs]);

  const isRowDirty = useCallback(
    (s: StaffWage) => {
      const current = termInputs[s.id];
      if (!current) return false;
      const saved = termsFrom(s, money.toInput);
      return TERM_FIELDS.some(({ key }) => current[key].trim() !== saved[key]);
    },
    [money, termInputs],
  );
  const dirtyCount = useMemo(() => (staff ?? []).filter(isRowDirty).length, [staff, isRowDirty]);

  // Unsaved terms must survive leaving the page as a warning, not silently.
  useEffect(() => {
    if (dirtyCount === 0) return;
    function onBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirtyCount]);

  // The staff who will actually be accrued: an active member with a positive
  // wage — the same WHERE clause accruePayroll uses.
  const payableStaff = useMemo(() => (staff ?? []).filter((s) => s.monthlyWage != null && s.monthlyWage > 0), [staff]);

  const periodKey = `${periodYear}-${String(periodMonth).padStart(2, "0")}`;
  const years = useMemo(() => [today.jy, today.jy - 1, today.jy - 2], [today.jy]);
  const monthInFuture = (jy: number, jm: number) => jy > today.jy || (jy === today.jy && jm > today.jm);
  const standingRunForPeriod = (runs ?? []).find((r) => r.status !== "voided" && r.periodKey === periodKey) ?? null;

  const overtimeRial = (userId: string) => parseOvertime(overtimeInputs[userId], money.parse);

  /*
   * The preview runs the *same* calculator the server posts with, over the
   * saved terms (not unsaved edits — those are not what a run would read).
   */
  const preview = useMemo(() => {
    const rules = settings ?? EMPTY_PAYROLL_SETTINGS;
    return payableStaff.map((s) => {
      const overtime = parseOvertime(overtimeInputs[s.id], money.parse);
      const result =
        overtime === "bad"
          ? ({ ok: false, error: "invalid_overtime" } as const)
          : computeGrossToNet(
              {
                baseSalaryRial: s.monthlyWage ?? 0,
                taxableAllowancesRial: s.taxableAllowance,
                nonTaxableAllowancesRial: s.nonTaxableAllowance,
                overtimeRial: overtime,
                otherDeductionsRial: s.fixedDeduction,
                advanceOutstandingRial: s.advanceOutstanding,
              },
              rules,
            );
      return { staff: s, result };
    });
  }, [payableStaff, settings, overtimeInputs, money]);
  const previewOk = preview.every((p) => p.result.ok);
  // The footer's per-column sums; the posting's own totals are payrollAccrualTotals on the server.
  const previewColumnTotals = useMemo(() => {
    if (!previewOk || preview.length === 0) return null;
    const lines = preview.map((p) => p.result as GrossToNetBreakdown);
    const sum = (pick: (l: GrossToNetBreakdown) => number) => lines.reduce((s, l) => s + pick(l), 0);
    return {
      gross: sum((l) => l.grossRial),
      employeeInsurance: sum((l) => l.employeeInsuranceRial),
      tax: sum((l) => l.incomeTaxRial),
      recoveries: sum((l) => l.advanceRecoveryRial + l.otherDeductionsRial),
      net: sum((l) => l.netPayRial),
      employer: sum((l) => l.employerInsuranceRial + l.unemploymentInsuranceRial),
    };
  }, [preview, previewOk]);

  async function saveTerms(userId: string) {
    setLocalError("");
    setLocalNotice("");
    const draft = termInputs[userId];
    if (!draft) return;
    const body: Record<string, number | null> = {};
    for (const { key, api: apiKey, label } of TERM_FIELDS) {
      const raw = draft[key].trim();
      if (!raw) {
        body[apiKey] = key === "wage" ? null : 0;
        continue;
      }
      let rial: number;
      try {
        rial = money.parse(raw);
      } catch {
        return setLocalError(`«${label}» معتبر نیست.`);
      }
      if (!Number.isSafeInteger(rial) || rial < 0) return setLocalError(`«${label}» معتبر نیست.`);
      body[apiKey] = rial;
    }
    setSavingRow(userId);
    const { ok, data } = await api("/api/ledger/payroll/staff/" + userId, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    setSavingRow(null);
    if (!ok) return setLocalError(payrollError((data as { error?: string }).error));
    const saved = staff?.find((s) => s.id === userId);
    setLocalNotice(saved ? `اطلاعات حقوقی «${saved.fullName}» ذخیره شد.` : "اطلاعات حقوقی ذخیره شد.");
    setEditedRows((prev) => {
      if (!prev.has(userId)) return prev;
      const next = new Set(prev);
      next.delete(userId);
      return next;
    });
    load();
  }

  async function saveSettings(next: PayrollSettings): Promise<string | null> {
    setLocalError("");
    setLocalNotice("");
    const { ok, data } = await api<{ settings?: PayrollSettings; error?: string }>("/api/ledger/payroll/settings", {
      method: "PUT",
      body: JSON.stringify(next),
    });
    if (!ok || !data.settings) return payrollError(data.error);
    setSettings(data.settings);
    setLocalNotice("تنظیمات بیمه و مالیات حقوق ذخیره شد.");
    return null;
  }

  async function accrue(e: React.FormEvent) {
    e.preventDefault();
    setLocalError("");
    setLocalNotice("");
    if (payableStaff.length === 0) return setLocalError("هیچ کارمندی حقوق تعیین‌شده ندارد.");
    if (monthInFuture(periodYear, periodMonth)) return setLocalError(PAYROLL_ERRORS.period_in_future);
    if (standingRunForPeriod) return setLocalError(PAYROLL_ERRORS.period_already_accrued);
    const overtime: Record<string, number> = {};
    for (const s of payableStaff) {
      const value = overtimeRial(s.id);
      if (value === "bad") return setLocalError(`اضافه‌کار «${s.fullName}» معتبر نیست.`);
      if (value > 0) overtime[s.id] = value;
    }
    const failing = preview.find((p) => !p.result.ok);
    if (failing && !failing.result.ok) {
      return setLocalError(`«${failing.staff.fullName}»: ${payrollError(failing.result.error)}`);
    }

    const title = runTitle({ periodKey, periodLabel: periodKey });
    const ok = await run(() =>
      api("/api/ledger/payroll/runs", {
        method: "POST",
        body: JSON.stringify({ periodKey, accrualDate: accrualDate || undefined, overtime }),
      }),
    );
    if (ok) {
      setAccrualDate("");
      setOvertimeInputs({});
      setLocalNotice(`تعهد حقوق «${title}» ثبت شد.`);
    }
  }

  async function pay(runId: string) {
    const method = payMethod[runId] ?? "cash";
    setLocalError("");
    setLocalNotice("");
    setRowBusy(runId);
    const ok = await run(() =>
      api("/api/ledger/payroll/runs/" + runId + "/pay", { method: "POST", body: JSON.stringify({ method }) }),
    );
    setRowBusy(null);
    if (ok) setLocalNotice("پرداخت خالص حقوق ثبت شد.");
  }

  async function confirmVoid() {
    const target = voidTarget;
    if (!target) return;
    setVoidTarget(null);
    setLocalError("");
    setLocalNotice("");
    setRowBusy(target.id);
    const ok = await run(() => api("/api/ledger/payroll/runs/" + target.id + "/void", { method: "POST" }));
    setRowBusy(null);
    if (ok) setLocalNotice(`تعهد «${runTitle(target)}» ابطال شد.`);
  }

  async function recordAdvance(e: React.FormEvent) {
    e.preventDefault();
    setLocalError("");
    setLocalNotice("");
    if (!advanceUser) return setLocalError("کارمند را انتخاب کنید.");
    let rial: number;
    try {
      rial = money.parse(advanceAmount.trim());
    } catch {
      return setLocalError("مبلغ مساعده معتبر نیست.");
    }
    if (!Number.isSafeInteger(rial) || rial <= 0) return setLocalError("مبلغ مساعده معتبر نیست.");
    const ok = await run(() =>
      api("/api/ledger/payroll/advances", {
        method: "POST",
        body: JSON.stringify({
          userId: advanceUser,
          amount: rial,
          method: advanceMethod,
          advanceDate: advanceDate || undefined,
          note: advanceNote.trim() || undefined,
        }),
      }),
    );
    if (ok) {
      setAdvanceAmount("");
      setAdvanceNote("");
      setAdvanceDate("");
      setLocalNotice("مساعده ثبت شد؛ در تعهد حقوق بعدی کسر می‌شود.");
    }
  }

  async function confirmAdvanceVoid() {
    const target = advanceVoidTarget;
    if (!target) return;
    setAdvanceVoidTarget(null);
    setLocalError("");
    setLocalNotice("");
    setRowBusy(target.id);
    const ok = await run(() => api("/api/ledger/payroll/advances/" + target.id + "/void", { method: "POST" }));
    setRowBusy(null);
    if (ok) setLocalNotice("مساعده ابطال شد.");
  }

  if (!staff || !runs || !advances || !settings) {
    return <SectionCardSkeleton rows={4} />;
  }

  const deductionsConfigured = payrollSettingsApplyDeductions(settings);

  return (
    <div className="space-y-5">
      {/* Both banners stay mounted as live regions so a screen reader announces them. */}
      <div aria-live="assertive" role="alert">
        {localError ? (
          <p className="rounded-xl border border-destructive/20 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {localError}
          </p>
        ) : null}
      </div>
      <div aria-live="polite" role="status">
        {localNotice ? (
          <p className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300">
            {localNotice}
          </p>
        ) : null}
      </div>

      <PayrollSettingsPanel settings={settings} onSave={saveSettings} />

      <section aria-labelledby="payroll-wages-heading" className={cardClass}>
        <header className="border-b border-border/80 px-4 py-4 sm:px-5">
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">حکم حقوقی</p>
          <h2 id="payroll-wages-heading" className="mt-1 text-base font-semibold text-foreground">حقوق و مزایای ماهانه کارکنان</h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            مبالغ ماهانه را به {money.unitLabel} وارد و برای هر نفر ذخیره کنید. اضافه‌کار هر ماه هنگام ثبت تعهد وارد می‌شود.
          </p>
        </header>

        <div className="p-4 sm:p-5">
          {staff.length === 0 ? (
            <EmptyState>عضو فعالی یافت نشد.</EmptyState>
          ) : (
            <>
              <ul className="space-y-3">
                {staff.map((s) => {
                  const dirty = isRowDirty(s);
                  const draft = termInputs[s.id] ?? termsFrom(s, money.toInput);
                  return (
                    <li key={s.id} className="space-y-3 rounded-xl border border-border/80 bg-muted/60 p-4">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="break-words font-semibold text-foreground">{s.fullName}</p>
                          <p className="mt-0.5 text-xs text-muted-foreground">{roleLabel(s.role)}</p>
                        </div>
                        {s.advanceOutstanding > 0 ? (
                          <StatusBadge tone="active">مساعده باز: {money.format(s.advanceOutstanding)}</StatusBadge>
                        ) : null}
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                        {TERM_FIELDS.map(({ key, label }) => (
                          <label key={key} className="block text-sm font-medium">
                            <span className="mb-1.5 block text-xs text-muted-foreground">
                              {label} ({money.unitLabel})
                            </span>
                            <PersianNumberInput
                              className={inputClass + " w-full"}
                              dir="ltr"
                              inputMode="numeric"
                              allowDecimal={false}
                              allowNegative={false}
                              value={draft[key]}
                              onChange={(e) => {
                                const value = e.target.value;
                                setTermInputs((prev) => ({ ...prev, [s.id]: { ...(prev[s.id] ?? draft), [key]: value } }));
                                setEditedRows((prev) => (prev.has(s.id) ? prev : new Set(prev).add(s.id)));
                              }}
                              placeholder="۰"
                              aria-label={`${label} ${s.fullName}`}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                  e.preventDefault();
                                  if (!busy && savingRow !== s.id && dirty) void saveTerms(s.id);
                                }
                              }}
                            />
                          </label>
                        ))}
                      </div>
                      <div className="flex items-center gap-2">
                        <SecondaryButton onClick={() => saveTerms(s.id)} disabled={busy || savingRow === s.id || !dirty}>
                          {savingRow === s.id ? "در حال ذخیره…" : "ذخیره"}
                        </SecondaryButton>
                        {dirty ? <span className="text-xs text-amber-700 dark:text-amber-300">ذخیره‌نشده</span> : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
              {dirtyCount > 0 ? (
                <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
                  {toPersianDigits(dirtyCount)} تغییر ذخیره‌نشده دارید؛ تا «ذخیره» نزنید در تعهد حقوق اعمال نمی‌شود.
                </p>
              ) : null}
            </>
          )}
        </div>
      </section>

      <section aria-labelledby="payroll-advances-heading" className={cardClass}>
        <header className="border-b border-border/80 px-4 py-4 sm:px-5">
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">علی‌الحساب</p>
          <h2 id="payroll-advances-heading" className="mt-1 text-base font-semibold text-foreground">مساعده کارکنان</h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            مساعده از صندوق یا بانک پرداخت و در تعهد حقوق بعدی از خالص پرداختی کسر می‌شود؛ مازاد به ماه بعد منتقل می‌شود.
          </p>
        </header>
        <form onSubmit={recordAdvance} className="grid gap-3 p-4 sm:grid-cols-2 sm:p-5 lg:grid-cols-[minmax(10rem,1fr)_minmax(8rem,12rem)_minmax(8rem,10rem)_minmax(9rem,11rem)_auto] lg:items-end">
          <label className="block text-sm font-medium">
            <span className="mb-1.5 block text-xs text-muted-foreground">کارمند</span>
            <SearchableSelect
              value={advanceUser}
              onChange={setAdvanceUser}
              ariaLabel="کارمند دریافت‌کنندهٔ مساعده"
              placeholder="انتخاب کنید"
              options={staff.map((s) => ({ value: s.id, label: s.fullName }))}
            />
          </label>
          <label className="block text-sm font-medium">
            <span className="mb-1.5 block text-xs text-muted-foreground">مبلغ ({money.unitLabel})</span>
            <PersianNumberInput
              className={inputClass + " w-full"}
              dir="ltr"
              inputMode="numeric"
              allowDecimal={false}
              value={advanceAmount}
              onChange={(e) => setAdvanceAmount(e.target.value)}
              placeholder="۰"
              aria-label="مبلغ مساعده"
            />
          </label>
          <label className="block text-sm font-medium">
            <span className="mb-1.5 block text-xs text-muted-foreground">پرداخت از</span>
            <SearchableSelect
              value={advanceMethod}
              onChange={(value) => setAdvanceMethod(value as "cash" | "bank")}
              ariaLabel="حساب پرداخت مساعده"
              options={[
                { value: "cash", label: "صندوق (نقدی)" },
                { value: "bank", label: "بانکی" },
              ]}
            />
          </label>
          <div className="block text-sm font-medium">
            <span className="mb-1.5 block text-xs text-muted-foreground" id={advanceDateId}>
              تاریخ <span className="font-normal">(اختیاری)</span>
            </span>
            <JalaliDatePicker value={advanceDate} onChange={setAdvanceDate} placeholder="امروز" labelledBy={advanceDateId} />
          </div>
          <div className="min-w-32">
            <PrimaryButton disabled={busy || !advanceUser || !advanceAmount.trim()}>
              {busy ? "در حال ثبت…" : "ثبت مساعده"}
            </PrimaryButton>
          </div>
          <label className="block text-sm font-medium sm:col-span-2 lg:col-span-5">
            <span className="mb-1.5 block text-xs text-muted-foreground">توضیح (اختیاری)</span>
            <input
              className={inputClass}
              value={advanceNote}
              onChange={(e) => setAdvanceNote(e.target.value)}
              maxLength={200}
            />
          </label>
        </form>
        <div className="px-4 pb-4 sm:px-5 sm:pb-5">
          {advances.length === 0 ? (
            <EmptyState>مساعده‌ای ثبت نشده است.</EmptyState>
          ) : (
            <ul className="grid gap-2 sm:grid-cols-2">
              {advances.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-muted/60 px-3 py-2.5 text-sm">
                  <div className="min-w-0">
                    <p className="truncate font-medium text-foreground">{a.fullName ?? "عضو حذف‌شده"}</p>
                    <p className="text-xs text-muted-foreground">
                      {jalaliOrDash(a.advanceDate)} — {a.method === "cash" ? "صندوق" : "بانک"}
                      {a.note ? ` — ${a.note}` : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={"font-semibold tabular-nums " + (a.status === "voided" ? "text-muted-foreground line-through" : "text-foreground")}>
                      {money.format(a.amount)}
                    </span>
                    {a.status === "voided" ? (
                      <StatusBadge tone="neutral">ابطال‌شده</StatusBadge>
                    ) : (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setAdvanceVoidTarget(a)}
                        disabled={busy || rowBusy === a.id}
                        aria-label={`ابطال مساعده ${a.fullName ?? ""}`}
                      >
                        ابطال
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section aria-labelledby="payroll-accrual-heading" className={cardClass}>
        <header className="border-b border-border/80 px-4 py-4 sm:px-5">
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">ثبت ماه</p>
          <h2 id="payroll-accrual-heading" className="mt-1 text-base font-semibold text-foreground">تعهد حقوق و دستمزد ماهانه</h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {deductionsConfigured
              ? "ناخالص به خالص با نرخ‌های ثبت‌شده در «تنظیمات بیمه و مالیات حقوق» محاسبه و در یک سند ثبت می‌شود."
              : "نرخ بیمه و مالیاتی وارد نشده است؛ تعهد بدون کسور قانونی ثبت می‌شود (فقط مساعده و کسور ثابت کسر می‌شوند)."}
          </p>
        </header>
        <form onSubmit={accrue} className="space-y-4 p-4 sm:p-5">
          <div className="grid gap-4 md:grid-cols-[minmax(14rem,18rem)_12rem_auto] md:items-end">
            <div className="block text-sm font-medium">
              <span className="mb-1.5 block text-xs text-muted-foreground">ماه حقوق</span>
              <div className="grid grid-cols-2 gap-2">
                <select
                  className={inputClass}
                  aria-label="ماه"
                  value={periodMonth}
                  onChange={(e) => setPeriodMonth(Number(e.target.value))}
                >
                  {JALALI_MONTHS.map((month, i) => (
                    <option key={month} value={i + 1} disabled={monthInFuture(periodYear, i + 1)}>
                      {month}
                    </option>
                  ))}
                </select>
                <select
                  className={inputClass}
                  aria-label="سال"
                  value={periodYear}
                  onChange={(e) => {
                    const year = Number(e.target.value);
                    setPeriodYear(year);
                    if (monthInFuture(year, periodMonth)) setPeriodMonth(today.jm);
                  }}
                >
                  {years.map((y) => (
                    <option key={y} value={y}>
                      {toPersianDigits(y)}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="block text-sm font-medium">
              <span className="mb-1.5 block text-xs text-muted-foreground" id={accrualFieldId}>
                تاریخ سند <span className="font-normal">(اختیاری)</span>
              </span>
              <JalaliDatePicker
                value={accrualDate}
                onChange={setAccrualDate}
                placeholder="پایان ماه"
                labelledBy={accrualFieldId}
              />
            </div>
            <div className="min-w-40">
              <PrimaryButton disabled={busy || payableStaff.length === 0 || standingRunForPeriod !== null || !previewOk}>
                {busy ? "در حال ثبت…" : "ثبت تعهد"}
              </PrimaryButton>
            </div>
          </div>
          {standingRunForPeriod ? (
            <p className="text-xs text-amber-700 dark:text-amber-300">
              برای «{runTitle(standingRunForPeriod)}» قبلاً تعهد ثبت شده است؛ برای ثبت دوباره ابتدا آن را ابطال کنید.
            </p>
          ) : null}

          {payableStaff.length === 0 ? (
            <EmptyState>هیچ کارمندی حقوق تعیین‌شده ندارد؛ ابتدا در بخش بالا حقوق پایه را وارد کنید.</EmptyState>
          ) : (
            <DataTable caption="پیش‌نمایش ناخالص به خالص" tableClassName="min-w-[44rem]">
              <DataTableHead>
                <Th>کارمند</Th>
                <Th>اضافه‌کار ({money.unitLabel})</Th>
                <Th numeric>ناخالص</Th>
                <Th numeric>بیمه کارگر</Th>
                <Th numeric>مالیات</Th>
                <Th numeric>مساعده و سایر کسور</Th>
                <Th numeric>خالص پرداختی</Th>
                <Th numeric>بیمه کارفرما</Th>
              </DataTableHead>
              <DataTableBody>
                {preview.map(({ staff: s, result }) => (
                  <DataTableRow key={s.id}>
                    <Td>
                      <span className="block max-w-[10rem] truncate" title={s.fullName}>{s.fullName}</span>
                    </Td>
                    <Td>
                      <PersianNumberInput
                        className={inputClass + " w-32"}
                        dir="ltr"
                        inputMode="numeric"
                        allowDecimal={false}
                        value={overtimeInputs[s.id] ?? ""}
                        onChange={(e) => setOvertimeInputs((prev) => ({ ...prev, [s.id]: e.target.value }))}
                        placeholder="۰"
                        aria-label={`اضافه‌کار ${s.fullName}`}
                      />
                    </Td>
                    {result.ok ? (
                      <>
                        <Td numeric>{money.format(result.grossRial)}</Td>
                        <Td numeric>{money.format(result.employeeInsuranceRial)}</Td>
                        <Td numeric>{money.format(result.incomeTaxRial)}</Td>
                        <Td numeric>{money.format(result.advanceRecoveryRial + result.otherDeductionsRial)}</Td>
                        <Td numeric className="font-semibold">{money.format(result.netPayRial)}</Td>
                        <Td numeric muted>
                          {money.format(result.employerInsuranceRial + result.unemploymentInsuranceRial)}
                        </Td>
                      </>
                    ) : (
                      <Td colSpan={6} className="text-destructive">
                        {payrollError(result.error)}
                      </Td>
                    )}
                  </DataTableRow>
                ))}
              </DataTableBody>
              {previewColumnTotals ? (
                <DataTableFoot>
                  <tr>
                    <Th scope="row" className="text-start">
                      جمع ({toPersianDigits(payableStaff.length)} نفر)
                    </Th>
                    <Td />
                    <Td numeric>{money.format(previewColumnTotals.gross)}</Td>
                    <Td numeric>{money.format(previewColumnTotals.employeeInsurance)}</Td>
                    <Td numeric>{money.format(previewColumnTotals.tax)}</Td>
                    <Td numeric>{money.format(previewColumnTotals.recoveries)}</Td>
                    <Td numeric>{money.format(previewColumnTotals.net)}</Td>
                    <Td numeric>{money.format(previewColumnTotals.employer)}</Td>
                  </tr>
                </DataTableFoot>
              ) : null}
            </DataTable>
          )}
        </form>
      </section>

      <section aria-labelledby="payroll-history-heading" className={cardClass}>
        <header className="border-b border-border/80 px-4 py-4 sm:px-5">
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">سوابق</p>
          <h2 id="payroll-history-heading" className="mt-1 text-base font-semibold text-foreground">تاریخچه حقوق و دستمزد</h2>
        </header>

        <div className="p-4 sm:p-5">
          {runs.length === 0 ? (
            <EmptyState>هنوز تعهدی ثبت نشده است.</EmptyState>
          ) : (
            <ul className="space-y-3">
              {runs.map((r) => {
                const status = STATUS_TONES[r.status] ?? { label: r.status, tone: "neutral" as const };
                const rowWorking = rowBusy === r.id;
                const title = runTitle(r);
                return (
                  <li key={r.id} className="rounded-xl border border-border/80 bg-muted/60 p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-3">
                      <div className="min-w-0">
                        <h3 className="break-words font-semibold text-foreground">{title}</h3>
                        <p className="mt-1 text-xs text-muted-foreground">
                          تاریخ تعهد: {jalaliOrDash(r.accrualDate)}
                          {r.status === "paid" && r.paidDate ? ` — پرداخت: ${jalaliOrDash(r.paidDate)}` : ""}
                          {r.status === "voided" && r.voidedDate ? ` — ابطال: ${jalaliOrDash(r.voidedDate)}` : ""}
                        </p>
                        {r.createdByName ? (
                          <p className="mt-0.5 text-xs text-muted-foreground">ثبت توسط: {r.createdByName}</p>
                        ) : null}
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={"text-xs text-muted-foreground " + (r.status === "voided" ? "line-through" : "")}>
                          ناخالص {money.format(r.totalAmount)}
                        </span>
                        <span className={"font-bold tabular-nums " + (r.status === "voided" ? "text-muted-foreground line-through" : "text-foreground")}>
                          خالص {money.format(r.netAmount)}
                        </span>
                        <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
                      </div>
                    </div>

                    <div className="mt-3 grid gap-2 sm:grid-cols-2">
                      {r.lines.map((l, i) => (
                        <details key={l.userId ?? `line-${i}`} className="rounded-lg bg-muted/60 px-3 py-2.5 text-sm">
                          <summary className="flex cursor-pointer items-center justify-between gap-3">
                            <span className="min-w-0 truncate text-muted-foreground" title={l.fullName ?? undefined}>
                              {l.fullName ?? "عضو حذف‌شده"}
                            </span>
                            <span className="shrink-0 font-semibold tabular-nums text-foreground">{money.format(l.netPayRial)}</span>
                          </summary>
                          <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                            <dt className="text-muted-foreground">حقوق پایه</dt>
                            <dd className="text-end tabular-nums">{money.format(l.baseSalaryRial)}</dd>
                            <dt className="text-muted-foreground">مزایا و اضافه‌کار</dt>
                            <dd className="text-end tabular-nums">
                              {money.format(l.taxableAllowancesRial + l.nonTaxableAllowancesRial + l.overtimeRial)}
                            </dd>
                            <dt className="text-muted-foreground">ناخالص</dt>
                            <dd className="text-end tabular-nums">{money.format(l.grossRial)}</dd>
                            <dt className="text-muted-foreground">بیمه کارگر</dt>
                            <dd className="text-end tabular-nums">{money.format(l.employeeInsuranceRial)}</dd>
                            <dt className="text-muted-foreground">مالیات حقوق</dt>
                            <dd className="text-end tabular-nums">{money.format(l.incomeTaxRial)}</dd>
                            <dt className="text-muted-foreground">کسر مساعده</dt>
                            <dd className="text-end tabular-nums">{money.format(l.advanceRecoveryRial)}</dd>
                            <dt className="text-muted-foreground">سایر کسور</dt>
                            <dd className="text-end tabular-nums">{money.format(l.otherDeductionsRial)}</dd>
                            <dt className="font-medium text-foreground">خالص پرداختی</dt>
                            <dd className="text-end font-medium tabular-nums">{money.format(l.netPayRial)}</dd>
                            <dt className="text-muted-foreground">بیمه سهم کارفرما و بیکاری</dt>
                            <dd className="text-end tabular-nums">
                              {money.format(l.employerInsuranceRial + l.unemploymentInsuranceRial)}
                            </dd>
                          </dl>
                        </details>
                      ))}
                    </div>

                    {r.status === "accrued" ? (
                      <div className="mt-4 grid gap-3 border-t border-border pt-3 sm:grid-cols-[minmax(0,12rem)_minmax(0,14rem)_auto] sm:items-end">
                        <label className="block text-sm font-medium">
                          <span className="mb-1.5 block text-xs text-muted-foreground">پرداخت خالص از</span>
                          <SearchableSelect
                            value={payMethod[r.id] ?? "cash"}
                            onChange={(value) => setPayMethod((prev) => ({ ...prev, [r.id]: value as "cash" | "bank" }))}
                            ariaLabel={`حساب پرداخت حقوق ${title}`}
                            options={[
                              { value: "cash", label: "صندوق (نقدی)" },
                              { value: "bank", label: "بانکی" },
                            ]}
                          />
                        </label>
                        <SecondaryButton onClick={() => pay(r.id)} disabled={busy || rowWorking}>
                          {rowWorking ? "در حال ثبت…" : "ثبت پرداخت حقوق"}
                        </SecondaryButton>
                        <Button
                          type="button"
                          variant="destructive"
                          onClick={() => setVoidTarget(r)}
                          disabled={busy || rowWorking}
                          aria-label={`ابطال تعهد ${title}`}
                        >
                          ابطال تعهد
                        </Button>
                      </div>
                    ) : null}

                    {r.status === "paid" ? (
                      <div className="mt-4 flex justify-end border-t border-border pt-3">
                        <Button
                          type="button"
                          variant="destructive"
                          onClick={() => setVoidTarget(r)}
                          disabled={busy || rowWorking}
                          aria-label={`ابطال تعهد و پرداخت ${title}`}
                        >
                          {rowWorking ? "در حال ابطال…" : "ابطال (برگشت تعهد و پرداخت)"}
                        </Button>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>

      <Dialog open={voidTarget !== null} onOpenChange={(open) => !open && setVoidTarget(null)}>
        <DialogContent dir="rtl" className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>ابطال تعهد حقوق</DialogTitle>
            <DialogDescription className="leading-6">
              {voidTarget ? (
                <>
                  تعهد «{runTitle(voidTarget)}» به مبلغ ناخالص{" "}
                  <span className="font-semibold text-foreground">{money.format(voidTarget.totalAmount)}</span>{" "}
                  {voidTarget.status === "paid"
                    ? "ابطال می‌شود؛ هم سند تعهد و هم سند پرداخت با اسناد معکوس (به تاریخ امروز) برگشت می‌خورند."
                    : "ابطال می‌شود؛ سند تعهد با یک سند معکوس (به تاریخ امروز) برگشت می‌خورد."}{" "}
                  مساعده‌های کسرشده در این تعهد دوباره باز می‌شوند. این کار قابل بازگشت نیست.
                </>
              ) : null}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:justify-start">
            <Button type="button" variant="destructive" onClick={confirmVoid} disabled={busy}>
              ابطال تعهد
            </Button>
            <Button type="button" variant="outline" onClick={() => setVoidTarget(null)}>
              انصراف
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={advanceVoidTarget !== null} onOpenChange={(open) => !open && setAdvanceVoidTarget(null)}>
        <DialogContent dir="rtl" className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>ابطال مساعده</DialogTitle>
            <DialogDescription className="leading-6">
              {advanceVoidTarget ? (
                <>
                  مساعدهٔ «{advanceVoidTarget.fullName ?? "عضو حذف‌شده"}» به مبلغ{" "}
                  <span className="font-semibold text-foreground">{money.format(advanceVoidTarget.amount)}</span> با یک سند
                  معکوس (به تاریخ امروز) ابطال می‌شود.
                </>
              ) : null}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:justify-start">
            <Button type="button" variant="destructive" onClick={confirmAdvanceVoid} disabled={busy}>
              ابطال مساعده
            </Button>
            <Button type="button" variant="outline" onClick={() => setAdvanceVoidTarget(null)}>
              انصراف
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
