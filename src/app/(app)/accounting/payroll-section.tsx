"use client";

import { EmptyState, KpiCard, KpiRow, SectionCardSkeleton, StatusBadge, cardClass } from "@/app/dashboard/page-chrome";

import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import { JALALI_MONTHS, todayJalali } from "@/lib/jalali";
import { useMoney } from "@/components/money/money-context";
import { sumRialText } from "@/lib/money";
import { JalaliDatePicker } from "@/app/dashboard/jalali-date-picker";
import { FilterChip, FilterChipRow } from "@/app/dashboard/filters";
import { api, inputClass, SecondaryButton } from "@/app/dashboard/ui";
import type { Runner } from "./accounting-manager";
import { roleLabel } from "@/lib/role-labels";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { UnsavedChangesDialog, useUnsavedChangesGuard } from "@/components/navigation/unsaved-changes-guard";
import { forgetDrafts, recallDrafts, rememberDrafts } from "@/lib/payroll-draft-memory";
import {
  dirtyTerms,
  termDisplayText,
  termsBody,
  type AmountDraft,
  type TermDrafts,
} from "@/lib/payroll-amount-drafts";
import { EMPTY_PAYROLL_SETTINGS, type PayrollSettings } from "@/lib/payroll-gross-to-net";
import {
  PAY_TERMS,
  type PayTerm,
  type PayrollAdvance,
  type PayrollCommissionPreview,
  type PayrollLiability,
  type PayrollPaymentAccount,
  type PayrollRunStatus,
  type PayrollRunSummary,
  type StaffWage,
} from "@/lib/payroll-types";
import { PayrollAccrualPanel, type AccrualRequest } from "./payroll-accrual-panel";
import { PayrollAdvancesPanel } from "./payroll-advances-panel";
import { payrollError } from "./payroll-error";
import { PayrollRunItem, STATUS_TONES, type PayChoice } from "./payroll-run-item";
import { PayrollSettingsPanel } from "./payroll-settings-panel";
import { TermHistory } from "./payroll-term-history";
import { TERM_LABELS } from "./payroll-term-labels";

/** Runs shown per page of the history; the server bounds it too. */
const HISTORY_PAGE_SIZE = 20;

type StatusFilter = "" | PayrollRunStatus;

interface HistoryFilters {
  status: StatusFilter;
  /** ISO accrual-date bounds, "" = open. */
  from: string;
  to: string;
}

/** What the database knows that the saved terms cannot tell: commission, the 2300 tie-out, the accounts to pay from. */
interface Overview {
  commission: PayrollCommissionPreview;
  liability: PayrollLiability;
  paymentAccounts: PayrollPaymentAccount[];
}

/**
 * A key that names one *attempt* to accrue, kept across a retry of the same
 * attempt (a dropped connection, a double click) so the server can recognise it
 * and return the run it already made instead of a second one.
 */
function newAttemptKey(): string {
  const webCrypto = globalThis.crypto;
  if (webCrypto && typeof webCrypto.randomUUID === "function") return webCrypto.randomUUID();
  return `attempt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
}

/**
 * Payroll — a Jalali month's gross-to-net, advances and commission, as ledger
 * entries (audit F11 + issue #835).
 *
 * The rates are the business's own (the settings panel; empty means no
 * deduction). Each member has four standing terms — wage, two allowances, a
 * fixed deduction — a run adds the month's overtime, recovers salary advances
 * and settles the commission nobody has paid, and posting goes through the
 * ledger's normal path. It is not a payslip or filing tool.
 *
 * Who may use it is a capability question, not a role one: reading needs
 * `payroll.view`, changing anything needs `payroll.manage` (`canManage`). The
 * server enforces both; `canManage` only decides which controls are drawn.
 *
 * Every amount box is a draft that remembers the unit it was typed in
 * (`payroll-amount-drafts.ts`), so a Rial↔Toman switch converts the amount
 * instead of re-reading its digits; unsaved terms are guarded against in-app
 * navigation (`unsaved-changes-guard.tsx`) and, for the one exit that cannot be
 * guarded (browser Back), kept in memory for the member (`payroll-draft-memory.ts`).
 */
export function PayrollSection({
  busy,
  run,
  refreshKey,
  canManage = true,
  ownerKey,
}: {
  busy: boolean;
  run: Runner;
  refreshKey: number;
  /** May this member change payroll? `undefined` (unknown) draws the controls and lets the API decide. */
  canManage?: boolean;
  /** The signed-in member's id — the key unsaved drafts are remembered under. Absent: nothing is remembered. */
  ownerKey?: string;
}) {
  const money = useMoney();
  const readOnly = !canManage;

  const [staff, setStaff] = useState<StaffWage[] | null>(null);
  const [settings, setSettings] = useState<PayrollSettings | null>(null);
  const [advances, setAdvances] = useState<PayrollAdvance[] | null>(null);
  /** `undefined` while loading, `null` when the read failed (so a failure is not an endless skeleton). */
  const [overview, setOverview] = useState<Overview | null | undefined>(undefined);
  const [runs, setRuns] = useState<PayrollRunSummary[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [filters, setFilters] = useState<HistoryFilters>({ status: "", from: "", to: "" });
  /** Bumped after a term is saved, so the commission preview and the open histories re-read. */
  const [termVersion, setTermVersion] = useState(0);

  // --- pay-term drafts -----------------------------------------------------
  const [initialDrafts] = useState<Record<string, TermDrafts>>(() => (ownerKey ? recallDrafts(ownerKey) : {}));
  const [drafts, setDrafts] = useState<Record<string, TermDrafts>>(initialDrafts);
  const [restoredCount] = useState(() => Object.keys(initialDrafts).length);
  const [savingRow, setSavingRow] = useState<string | null>(null);

  // --- accrual form --------------------------------------------------------
  const today = useMemo(() => todayJalali(), []);
  const [period, setPeriod] = useState({ year: today.jy, month: today.jm });
  const periodKey = `${period.year}-${String(period.month).padStart(2, "0")}`;
  const [accrualDate, setAccrualDate] = useState("");
  const [includeCommission, setIncludeCommission] = useState(true);
  const [accruing, setAccruing] = useState(false);
  const attemptKey = useRef<string | null>(null);

  const [localError, setLocalError] = useState("");
  const [localNotice, setLocalNotice] = useState("");
  /** Which run or advance a per-row action is in flight for — only that row's buttons lock, not the whole screen. */
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  /** The run «ابطال» is asking about — a real dialog, not `window.confirm`. */
  const [voidTarget, setVoidTarget] = useState<PayrollRunSummary | null>(null);
  /** The run that already stands for the month somebody tried to accrue again. */
  const [duplicate, setDuplicate] = useState<{ periodLabel: string; status: PayrollRunStatus } | null>(null);

  const fromFieldId = useId();
  const toFieldId = useId();

  // Latest values for the unmount cleanup and the stale-response checks, which
  // must not re-run when these change.
  const staffRef = useRef<StaffWage[] | null>(null);
  const draftsRef = useRef(drafts);
  const discarded = useRef(false);
  const runsRequest = useRef(0);
  useEffect(() => {
    staffRef.current = staff;
    draftsRef.current = drafts;
  });

  /** Which of a member's terms are edited away from what the server holds? Compared as Rial — see `isDraftDirty`. */
  const dirtyOf = useCallback((s: StaffWage) => dirtyTerms(drafts[s.id], s), [drafts]);
  const dirtyCount = useMemo(() => (staff ?? []).filter((s) => dirtyOf(s).length > 0).length, [staff, dirtyOf]);

  const guard = useUnsavedChangesGuard(dirtyCount > 0, {
    onDiscard: () => {
      discarded.current = true;
      setDrafts({});
      if (ownerKey) forgetDrafts(ownerKey);
    },
  });

  // Leaving by any path the guard cannot stop (browser Back) must not lose the
  // work: keep what is genuinely unsaved, in memory, for this member.
  useEffect(() => {
    return () => {
      if (!ownerKey || discarded.current) return;
      const current = staffRef.current;
      const unsaved: Record<string, TermDrafts> = {};
      for (const [userId, memberDrafts] of Object.entries(draftsRef.current)) {
        const member = current?.find((s) => s.id === userId);
        if (!member) continue;
        const kept: TermDrafts = {};
        for (const term of dirtyTerms(memberDrafts, member)) kept[term] = memberDrafts[term];
        if (Object.keys(kept).length > 0) unsaved[userId] = kept;
      }
      rememberDrafts(ownerKey, unsaved);
    };
  }, [ownerKey]);

  // --- loading -------------------------------------------------------------
  const loadStaff = useCallback(async () => {
    const { ok, data } = await api<{ staff: StaffWage[] }>("/api/ledger/payroll/staff");
    if (!ok) {
      // An endless skeleton reads as "still loading"; name the failure.
      setStaff([]);
      return setLocalError("بارگذاری فهرست کارکنان ناموفق بود.");
    }
    setStaff(data.staff);
    // Drop drafts for people who are no longer listed, and terms that now equal
    // what is saved (somebody else made the same change), so nothing stale lingers.
    setDrafts((prev) => {
      const next: Record<string, TermDrafts> = {};
      for (const s of data.staff) {
        const memberDrafts = prev[s.id];
        if (!memberDrafts) continue;
        const kept: TermDrafts = {};
        for (const term of dirtyTerms(memberDrafts, s)) kept[term] = memberDrafts[term];
        if (Object.keys(kept).length > 0) next[s.id] = kept;
      }
      return JSON.stringify(next) === JSON.stringify(prev) ? prev : next;
    });
  }, []);

  const loadSettings = useCallback(async () => {
    const { ok, data } = await api<{ settings: PayrollSettings }>("/api/ledger/payroll/settings");
    if (!ok) {
      // Never guess a rate: a failed read computes no deduction in the preview,
      // and says so, while the server keeps its own copy.
      setSettings({ ...EMPTY_PAYROLL_SETTINGS, taxBrackets: [] });
      return setLocalError("بارگذاری تنظیمات بیمه و مالیات ناموفق بود.");
    }
    setSettings(data.settings);
  }, []);

  const loadAdvances = useCallback(async () => {
    const { ok, data } = await api<{ advances: PayrollAdvance[] }>("/api/ledger/payroll/advances");
    if (!ok) {
      setAdvances([]);
      return setLocalError("بارگذاری مساعده‌ها ناموفق بود.");
    }
    setAdvances(data.advances);
  }, []);

  const loadOverview = useCallback(async (key: string, date: string, withCommission: boolean) => {
    const query = new URLSearchParams({ periodKey: key, includeCommission: String(withCommission) });
    if (date) query.set("accrualDate", date);
    const { ok, data } = await api<Overview>(`/api/ledger/payroll/preview?${query}`);
    if (!ok) {
      setOverview(null);
      return setLocalError("بارگذاری پیش‌نمایش تعهد حقوق ناموفق بود.");
    }
    setOverview(data);
  }, []);

  const loadRuns = useCallback(async (f: HistoryFilters, cursor: string | null) => {
    const request = ++runsRequest.current;
    setHistoryBusy(true);
    const query = new URLSearchParams({ limit: String(HISTORY_PAGE_SIZE) });
    if (f.status) query.set("status", f.status);
    if (f.from) query.set("from", f.from);
    if (f.to) query.set("to", f.to);
    if (cursor) query.set("cursor", cursor);
    const { ok, data } = await api<{ runs: PayrollRunSummary[]; nextCursor: string | null }>(
      `/api/ledger/payroll/runs?${query}`,
    );
    // A newer request (another filter, a refresh) superseded this one: drop it.
    if (request !== runsRequest.current) return;
    setHistoryBusy(false);
    if (!ok) {
      setRuns((prev) => prev ?? []);
      return setLocalError("بارگذاری تاریخچه حقوق ناموفق بود.");
    }
    setRuns((prev) => (cursor && prev ? [...prev, ...data.runs] : data.runs));
    setNextCursor(data.nextCursor);
  }, []);

  useEffect(() => {
    void loadStaff();
  }, [loadStaff, refreshKey]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings, refreshKey]);

  useEffect(() => {
    void loadAdvances();
  }, [loadAdvances, refreshKey]);

  useEffect(() => {
    void loadOverview(periodKey, accrualDate, includeCommission);
  }, [loadOverview, periodKey, accrualDate, includeCommission, refreshKey, termVersion]);

  useEffect(() => {
    void loadRuns(filters, null);
  }, [loadRuns, filters, refreshKey]);

  // A new attempt is a new intent: any change to what would be accrued gets a fresh key.
  useEffect(() => {
    attemptKey.current = null;
  }, [periodKey, accrualDate, includeCommission]);

  /*
   * A success notice is about something that has finished, so it should not
   * outlive it. Without this the banner sat there until the next action —
   * «حقوق ذخیره شد.» still on screen minutes later, describing a save the user
   * had long since moved on from.
   */
  useEffect(() => {
    if (!localNotice) return;
    const timer = window.setTimeout(() => setLocalNotice(""), 6000);
    return () => window.clearTimeout(timer);
  }, [localNotice]);

  // --- pay terms -----------------------------------------------------------
  function editTerm(userId: string, term: PayTerm, text: string) {
    discarded.current = false; // typing again after a discard: protect this work too
    // The draft remembers the unit it is typed in, so a later Rial↔Toman switch
    // converts it instead of re-reading it.
    const draft: AmountDraft = { text, unit: money.unit };
    setDrafts((prev) => ({ ...prev, [userId]: { ...prev[userId], [term]: draft } }));
  }

  async function saveTerms(userId: string) {
    const member = staff?.find((s) => s.id === userId);
    const memberDrafts = drafts[userId];
    if (!member || !memberDrafts) return;
    setLocalError("");
    setLocalNotice("");

    // Only the terms that changed are sent, and each amount is read through the
    // unit it was typed in, never the current one; a malformed amount or one a
    // JSON number would round is refused here, naming the term.
    const body = termsBody(memberDrafts, member);
    if (!body.ok) {
      const label = TERM_LABELS[body.term];
      return setLocalError(body.reason === "too_large" ? `مبلغ «${label}» بیش از حد مجاز است.` : `«${label}» معتبر نیست.`);
    }
    if (body.terms.length === 0) return;

    setSavingRow(userId);
    // The digits are already in the body as written — no amount passes through `Number`.
    const { ok, data } = await api<{ error?: string }>("/api/ledger/payroll/staff/" + userId, {
      method: "PATCH",
      body: body.json,
    });
    setSavingRow(null);
    if (!ok) return setLocalError(payrollError(data.error));

    setLocalNotice(`اطلاعات حقوقی «${member.fullName}» ذخیره شد.`);
    // Drop this member's drafts so the reload can adopt the server's values.
    setDrafts((prev) => {
      const next = { ...prev };
      delete next[userId];
      return next;
    });
    setTermVersion((v) => v + 1);
    void loadStaff();
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
    setTermVersion((v) => v + 1);
    setLocalNotice("تنظیمات بیمه و مالیات حقوق ذخیره شد.");
    return null;
  }

  // --- accrual -------------------------------------------------------------
  async function accrue({ overtime }: AccrualRequest): Promise<boolean> {
    setLocalError("");
    setLocalNotice("");

    const label = `${JALALI_MONTHS[period.month - 1]} ${toPersianDigits(period.year)}`;
    setAccruing(true);
    const key = (attemptKey.current ??= newAttemptKey());
    const { ok, data } = await api<{
      error?: string;
      run?: { periodLabel: string; status: PayrollRunStatus };
      idempotentReplay?: boolean;
    }>("/api/ledger/payroll/runs", {
      method: "POST",
      body: JSON.stringify({
        periodKey,
        accrualDate: accrualDate || undefined,
        includeCommission,
        overtime,
        idempotencyKey: key,
      }),
    });
    setAccruing(false);

    if (!ok) {
      // The server — not this screen — is what stops a month being booked twice;
      // this only explains it.
      if (data.error === "period_already_accrued" && data.run) {
        setDuplicate({ periodLabel: data.run.periodLabel, status: data.run.status });
        return false;
      }
      setLocalError(payrollError(data.error));
      return false;
    }

    attemptKey.current = null;
    setAccrualDate("");
    setLocalNotice(
      data.idempotentReplay
        ? `تعهد «${label}» پیش‌تر ثبت شده بود؛ همان لیست نمایش داده شد.`
        : `تعهد حقوق «${label}» ثبت شد.`,
    );
    setTermVersion((v) => v + 1);
    void loadRuns(filters, null);
    void loadStaff();
    void loadAdvances();
    return true;
  }

  // --- payment, void and advances ------------------------------------------
  async function pay(target: PayrollRunSummary, choice: PayChoice) {
    setLocalError("");
    setLocalNotice("");
    setRowBusy(target.id);
    const body: Record<string, unknown> = choice.paymentAccountId
      ? { paymentAccountId: choice.paymentAccountId }
      : { method: choice.method };
    if (choice.paidDate) body.paidDate = choice.paidDate;
    const ok = await run(() =>
      api("/api/ledger/payroll/runs/" + target.id + "/pay", { method: "POST", body: JSON.stringify(body) }),
    );
    setRowBusy(null);
    if (ok) setLocalNotice(`پرداخت حقوق «${target.periodLabel}» ثبت شد.`);
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
    if (ok) setLocalNotice(`تعهد «${target.periodLabel}» ابطال شد.`);
  }

  async function recordAdvance(body: string): Promise<boolean> {
    setLocalError("");
    setLocalNotice("");
    const ok = await run(() => api("/api/ledger/payroll/advances", { method: "POST", body }));
    if (ok) setLocalNotice("مساعده ثبت شد؛ در تعهد حقوق بعدی کسر می‌شود.");
    return ok;
  }

  async function voidAdvance(target: PayrollAdvance): Promise<boolean> {
    setLocalError("");
    setLocalNotice("");
    setRowBusy(target.id);
    const ok = await run(() => api("/api/ledger/payroll/advances/" + target.id + "/void", { method: "POST" }));
    setRowBusy(null);
    if (ok) setLocalNotice("مساعده ابطال شد.");
    return ok;
  }

  // --- derived -------------------------------------------------------------
  const payableStaff = useMemo(() => (staff ?? []).filter((s) => s.monthlyWage !== null && s.monthlyWage !== "0"), [staff]);
  const monthlyWageBill = useMemo(() => sumRialText(payableStaff.map((s) => s.monthlyWage as string)), [payableStaff]);

  const hasFilters = filters.status !== "" || filters.from !== "" || filters.to !== "";
  const unsettledCommission = overview ? BigInt(overview.liability.unsettledCommission) : 0n;

  if (!staff || !runs || !advances || !settings || overview === undefined) {
    return <SectionCardSkeleton rows={4} />;
  }

  const liability = overview?.liability ?? null;
  const paymentAccounts = overview?.paymentAccounts ?? [];

  return (
    <div className="space-y-5">
      {/*
        * Both banners are live regions that stay mounted, so a screen reader
        * announces a save or a failure. Rendering them only when there is a
        * message means the region is *created* with its text already in it,
        * which many readers never announce at all.
        */}
      <div aria-live="assertive" role="alert">
        {localError ? (
          <p className="rounded-xl border border-destructive/20 bg-destructive/5 px-3 py-2 text-sm text-destructive">{localError}</p>
        ) : null}
      </div>
      <div aria-live="polite" role="status">
        {localNotice ? (
          <p className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300">
            {localNotice}
          </p>
        ) : null}
      </div>

      {/* What this screen is — accurately, and what it is not. */}
      <p className="text-xs leading-6 text-muted-foreground">
        ثبت تعهد ماهانهٔ حقوق و دستمزد (ناخالص به خالص با نرخ‌های خود کسب‌وکار)، مساعده و پورسانت در سطح سند حسابداری. فیش حقوقی،
        فهرست بیمه و اظهارنامهٔ مالیاتی در این بخش صادر نمی‌شود و پرداخت بیمه و مالیاتِ نگه‌داشته‌شده جداگانه انجام می‌شود. لیست
        حقوق برای کل کسب‌وکار ثبت می‌شود و به شعبهٔ فعال بستگی ندارد.
      </p>

      {restoredCount > 0 && dirtyCount > 0 ? (
        <p
          role="status"
          className="rounded-xl border border-amber-500/20 bg-amber-50/60 px-3 py-2 text-sm text-amber-800 dark:bg-amber-500/10 dark:text-amber-200"
        >
          تغییرات ذخیره‌نشدهٔ پیشین شما بازیابی شد؛ آن‌ها را ذخیره کنید یا مقدار را به حالت قبل برگردانید.
        </p>
      ) : null}

      {liability ? (
        <section aria-labelledby="payroll-liability-heading" className="space-y-3">
          <h2 id="payroll-liability-heading" className="text-sm font-semibold text-foreground">
            وضعیت حساب حقوق پرداختنی (۲۳۰۰)
          </h2>
          <KpiRow>
            <KpiCard label="مانده در دفتر کل" value={money.formatText(liability.ledgerBalance)} />
            <KpiCard
              label="در انتظار پرداخت"
              value={money.formatText(liability.awaitingPayment)}
              hint="لیست‌های تعهدشده (خالص حقوق و پورسانت)"
            />
            <KpiCard
              label="پورسانتِ واردنشده در هیچ لیست"
              value={money.formatText(liability.unsettledCommission)}
              hint="با ثبت تعهد بعدی تسویه می‌شود"
            />
            <KpiCard
              label="مغایرت"
              value={money.formatText(liability.difference)}
              hint={
                liability.difference === "0"
                  ? "مانده با لیست‌ها و پورسانت‌ها تطبیق دارد"
                  : "سند دستی یا تسویهٔ خارج از حقوق روی این حساب ثبت شده است"
              }
            />
          </KpiRow>
        </section>
      ) : null}

      <PayrollSettingsPanel settings={settings} onSave={saveSettings} readOnly={readOnly} />

      <section aria-labelledby="payroll-wages-heading" className={cardClass}>
        <header className="border-b border-border/80 px-4 py-4 sm:px-5">
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">حکم حقوقی</p>
          <h2 id="payroll-wages-heading" className="mt-1 text-base font-semibold text-foreground">حقوق و مزایای ماهانه کارکنان</h2>
          {/* The unit is the business's own choice (ریال/تومان), so it comes from
              the money context rather than being asserted in the copy. */}
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {readOnly
              ? "شما فقط مجاز به مشاهدهٔ حقوق و مزایا هستید."
              : `مبالغ ماهانه را به ${money.unitLabel} وارد و برای هر نفر ذخیره کنید. اضافه‌کار هر ماه هنگام ثبت تعهد وارد می‌شود.`}
          </p>
        </header>

        <div className="p-4 sm:p-5">
          {staff.length === 0 ? (
            <EmptyState>عضو فعالی یافت نشد.</EmptyState>
          ) : (
            <>
              <ul className="space-y-3">
                {staff.map((s) => {
                  const dirty = dirtyOf(s).length > 0;
                  return (
                    <li key={s.id} className="space-y-3 rounded-xl border border-border/80 bg-muted/60 p-4">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                          {/* A long Persian name has to wrap rather than push the grid
                              wider than the card on a narrow screen. */}
                          <p className="break-words font-semibold text-foreground">{s.fullName}</p>
                          <p className="mt-0.5 text-xs text-muted-foreground">{roleLabel(s.role)}</p>
                        </div>
                        {s.advanceOutstanding !== "0" ? (
                          <StatusBadge tone="active">مساعده باز: {money.formatText(s.advanceOutstanding)}</StatusBadge>
                        ) : null}
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                        {PAY_TERMS.map((term) => (
                          <label key={term} className="block text-sm font-medium">
                            <span className="mb-1.5 block text-xs text-muted-foreground">
                              {TERM_LABELS[term]} ({money.unitLabel})
                            </span>
                            <PersianNumberInput
                              className={inputClass + " w-full"}
                              dir="ltr"
                              inputMode="numeric"
                              // These are whole, non-negative amounts: decimals and
                              // negatives are not pay, and the API refuses both — so
                              // don't let them be typed.
                              allowDecimal={false}
                              allowNegative={false}
                              disabled={readOnly}
                              value={termDisplayText(term, drafts[s.id]?.[term], s, money.unit)}
                              onChange={(e) => editTerm(s.id, term, e.target.value)}
                              // «۰» is what every other money field in the ledger shows.
                              placeholder="۰"
                              aria-label={`${TERM_LABELS[term]} ${s.fullName}`}
                              // Enter saves the row the caret is in, the way a one-field
                              // form does — reaching for the mouse per row is the whole
                              // friction of this list.
                              onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                  e.preventDefault();
                                  if (!busy && savingRow !== s.id && dirty && !readOnly) void saveTerms(s.id);
                                }
                              }}
                            />
                          </label>
                        ))}
                      </div>
                      <div className="flex items-center gap-2">
                        {readOnly ? null : (
                          <SecondaryButton
                            onClick={() => void saveTerms(s.id)}
                            // Saving an untouched row posts a no-op and reports a save
                            // that did not happen.
                            disabled={busy || savingRow === s.id || !dirty}
                          >
                            {savingRow === s.id ? "در حال ذخیره…" : "ذخیره"}
                          </SecondaryButton>
                        )}
                        {dirty ? <span className="text-xs text-amber-700 dark:text-amber-300">ذخیره‌نشده</span> : null}
                      </div>
                      <TermHistory staffId={s.id} version={termVersion} />
                    </li>
                  );
                })}
              </ul>

              {/* The month's wage bill at a glance: how many people carry a wage, and
                  the base-wage sum a «ثبت تعهد» would start from. */}
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-500/20 bg-amber-50/60 px-4 py-3 dark:bg-amber-500/10">
                <span className="text-sm text-muted-foreground">
                  {toPersianDigits(payableStaff.length)} نفر از {toPersianDigits(staff.length)} کارمند حقوق تعیین‌شده دارند
                </span>
                <span className="text-sm font-semibold tabular-nums text-foreground">
                  جمع حقوق پایه ماهانه: {money.formatText(monthlyWageBill)}
                </span>
              </div>
              {dirtyCount > 0 ? (
                <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
                  {toPersianDigits(dirtyCount)} تغییر ذخیره‌نشده دارید؛ تا زمانی که «ذخیره» نزنید در تعهد حقوق اعمال نمی‌شود.
                </p>
              ) : null}
            </>
          )}
        </div>
      </section>

      <PayrollAdvancesPanel
        staff={staff}
        advances={advances}
        paymentAccounts={paymentAccounts}
        readOnly={readOnly}
        busy={busy}
        workingId={rowBusy}
        onRecord={recordAdvance}
        onVoid={voidAdvance}
        onError={setLocalError}
      />

      {readOnly ? null : (
        <PayrollAccrualPanel
          staff={staff}
          settings={settings}
          commission={overview?.commission ?? null}
          unsettledCommission={unsettledCommission}
          today={today}
          period={period}
          onPeriodChange={(year, month) => setPeriod({ year, month })}
          accrualDate={accrualDate}
          onAccrualDateChange={setAccrualDate}
          includeCommission={includeCommission}
          onIncludeCommissionChange={setIncludeCommission}
          busy={busy}
          accruing={accruing}
          onAccrue={accrue}
          onError={setLocalError}
        />
      )}

      <section aria-labelledby="payroll-history-heading" className={cardClass}>
        <header className="border-b border-border/80 px-4 py-4 sm:px-5">
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">سوابق</p>
          <h2 id="payroll-history-heading" className="mt-1 text-base font-semibold text-foreground">تاریخچه حقوق و دستمزد</h2>
        </header>

        <div className="space-y-4 p-4 sm:p-5">
          {/* Server-side filters: the list below is a page of the history, newest first. */}
          <div className="flex flex-wrap items-end gap-3">
            <FilterChipRow label="فیلتر وضعیت">
              {([["", "همه"], ["accrued", STATUS_TONES.accrued.label], ["paid", STATUS_TONES.paid.label], ["voided", STATUS_TONES.voided.label]] as const).map(
                ([value, label]) => (
                  <FilterChip key={value || "all"} selected={filters.status === value} onClick={() => setFilters((f) => ({ ...f, status: value }))}>
                    {label}
                  </FilterChip>
                ),
              )}
            </FilterChipRow>
            <div className="block min-w-40 text-sm font-medium">
              <span className="mb-1.5 block text-xs text-muted-foreground" id={fromFieldId}>از تاریخ تعهد</span>
              <JalaliDatePicker value={filters.from} onChange={(from) => setFilters((f) => ({ ...f, from }))} placeholder="ابتدا" labelledBy={fromFieldId} />
            </div>
            <div className="block min-w-40 text-sm font-medium">
              <span className="mb-1.5 block text-xs text-muted-foreground" id={toFieldId}>تا تاریخ تعهد</span>
              <JalaliDatePicker value={filters.to} onChange={(to) => setFilters((f) => ({ ...f, to }))} placeholder="امروز" labelledBy={toFieldId} />
            </div>
            {hasFilters ? (
              <SecondaryButton onClick={() => setFilters({ status: "", from: "", to: "" })}>پاک کردن فیلترها</SecondaryButton>
            ) : null}
          </div>

          {runs.length === 0 ? (
            <EmptyState>{hasFilters ? "تعهدی با این فیلترها یافت نشد." : "هنوز تعهدی ثبت نشده است."}</EmptyState>
          ) : (
            <ul className="space-y-3" aria-busy={historyBusy}>
              {runs.map((r) => (
                <PayrollRunItem
                  key={r.id}
                  run={r}
                  canManage={!readOnly}
                  busy={busy}
                  working={rowBusy === r.id}
                  paymentAccounts={paymentAccounts}
                  onPay={pay}
                  onVoid={setVoidTarget}
                />
              ))}
            </ul>
          )}

          {nextCursor ? (
            <div className="flex justify-center">
              <SecondaryButton onClick={() => void loadRuns(filters, nextCursor)} disabled={historyBusy}>
                {historyBusy ? "در حال بارگذاری…" : "نمایش موارد قدیمی‌تر"}
              </SecondaryButton>
            </div>
          ) : null}
        </div>
      </section>

      {/*
        * «ابطال» asks in a real dialog rather than `window.confirm`: the native
        * one is unstyled, LTR, unreadable on a phone, and shows the raw string
        * with no emphasis on the amount being reversed. This one names the
        * month, the amount and exactly which entries will be mirrored.
        */}
      <Dialog open={voidTarget !== null} onOpenChange={(open) => !open && setVoidTarget(null)}>
        <DialogContent dir="rtl" className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>ابطال تعهد حقوق</DialogTitle>
            <DialogDescription className="leading-6">
              {voidTarget ? (
                <>
                  «{voidTarget.periodLabel}» با ناخالص{" "}
                  <span className="font-semibold text-foreground">{money.formatText(voidTarget.totalAmount)}</span>{" "}
                  {voidTarget.status === "paid"
                    ? "ابطال می‌شود؛ هم سند تعهد و هم سند پرداخت با اسناد معکوس (به تاریخ امروز) برگشت می‌خورند."
                    : "ابطال می‌شود؛ سند تعهد با یک سند معکوس (به تاریخ امروز) برگشت می‌خورد."}{" "}
                  مساعده‌ای که در این لیست کسر شده دوباره باز می‌شود.{" "}
                  {voidTarget.commissionTotal !== "0"
                    ? "پورسانتِ واردشده در این لیست دوباره تسویه‌نشده می‌شود و در لیست بعدی قرار می‌گیرد. "
                    : ""}
                  این کار قابل بازگشت نیست.
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

      {/*
        * A month that already has a standing run is refused by the *server*; this
        * dialog only explains it. It replaces the native `window.confirm` that used
        * to ask «تعهد دیگری ثبت شود؟» — which let the accountant say yes, and which
        * no stale tab, retry or direct API call ever saw.
        */}
      <Dialog open={duplicate !== null} onOpenChange={(open) => !open && setDuplicate(null)}>
        <DialogContent dir="rtl" className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>برای این ماه قبلاً لیست حقوق ثبت شده است</DialogTitle>
            <DialogDescription className="leading-6">
              {duplicate ? (
                <>
                  برای «{duplicate.periodLabel}» یک لیست حقوق در وضعیت «{STATUS_TONES[duplicate.status]?.label ?? duplicate.status}» وجود
                  دارد و ثبت دوبارهٔ آن ممکن نیست. اگر آن لیست اشتباه است، ابتدا آن را در تاریخچه ابطال کنید و سپس دوباره ثبت کنید.
                </>
              ) : null}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:justify-start">
            <Button type="button" onClick={() => setDuplicate(null)} autoFocus>
              متوجه شدم
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Leaving with unsaved terms: stay, or discard and go — never silently. */}
      <UnsavedChangesDialog guard={guard}>
        {toPersianDigits(dirtyCount)} تغییر در حقوق یا مزایا ذخیره نشده است. اگر این صفحه را ترک کنید، این تغییرات از بین می‌روند.
      </UnsavedChangesDialog>
    </div>
  );
}
