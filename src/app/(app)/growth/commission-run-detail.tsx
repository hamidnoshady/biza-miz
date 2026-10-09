"use client";

/**
 * One commission settlement run (issue #869): what it contains, who it pays, the
 * source sales behind every amount, the payouts made against it, and the trail of
 * who did what. Every action on it is offered only when the server would accept
 * it for this person (the run's `actions`), and refused in the same words here.
 *
 * Money is shown in the business's unit; dates are Shamsi; a payout posts once,
 * keyed by an idempotency key that is reused on a retry of the same attempt.
 */

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useMoney } from "@/components/money/money-context";
import { Button } from "@/components/ui/button";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { DataTable, DataTableBody, DataTableHead, DataTableRow, Td, Th } from "@/app/dashboard/data-table";
import { JalaliDatePicker } from "@/app/dashboard/jalali-date-picker";
import {
  CardTitle,
  EmptyState,
  KpiCard,
  KpiRow,
  LoadingSkeleton,
  PageHeader,
  PageShell,
  SectionCard,
  StatusBadge,
} from "@/app/dashboard/page-chrome";
import { api, ErrorBox, Field, InfoBox, inputClass } from "@/app/dashboard/ui";
import { accountingSectionHref } from "@/app/(app)/accounting/accounting-routes";
import { formatPersianNumber } from "@/lib/digits";
import type { CommissionRunAction, CommissionRunStatus } from "@/lib/commission-settlement-lifecycle";
import type { PlanWarning } from "@/lib/commission-settlement-plan";
import { commissionSettlementErrorMessage, commissionWarningText } from "./commission-settlement-messages";
import {
  actionLabel,
  actionNeedsConfirmation,
  actionRequiresReason,
  actionVariant,
  allocationsFromForm,
  eventLabel,
  lineKindLabel,
  methodLabel,
  parsePaymentChoice,
  payoutKindLabel,
  runStatusLabel,
  runStatusTone,
  shamsiDate,
  shamsiDateTime,
  type PayoutFormRow,
} from "./commission-run-view";

interface Employee {
  employeeId: string;
  employeeName: string;
  employeeCode: string | null;
  employeeActive: boolean;
  lineCount: number;
  owed: string;
  paid: string;
  outstanding: string;
}

interface Allocation {
  employeeId: string;
  employeeName: string;
  amount: string;
}

interface Payout {
  id: string;
  kind: "payout" | "reversal";
  reversesPayoutId: string | null;
  amount: string;
  paymentMethod: "cash" | "bank";
  paymentAccountId: string;
  paidDate: string;
  memo: string | null;
  entryId: string | null;
  createdAt: string;
  allocations: Allocation[];
}

interface RunEvent {
  id: string;
  action: string;
  fromStatus: string | null;
  toStatus: string;
  payoutId: string | null;
  actorName: string | null;
  note: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}

interface RunDetailData {
  id: string;
  runNumber: number;
  title: string | null;
  periodFrom: string;
  periodTo: string;
  status: CommissionRunStatus;
  lineCount: number;
  employeeCount: number;
  commissionTotal: string;
  paidTotal: string;
  outstandingTotal: string;
  warnings: PlanWarning[];
  createdAt: string;
  calculatedAt: string | null;
  approvedAt: string | null;
  paidAt: string | null;
  closedAt: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  employees: Employee[];
  payouts: Payout[];
  events: RunEvent[];
  actions: CommissionRunAction[];
  today: string;
}

interface LineRow {
  id: string;
  ordinal: number;
  lineKind: "accrual" | "carry_forward";
  employeeId: string;
  employeeName: string;
  sourceLabel: string;
  orderNumber: string | null;
  itemName: string | null;
  saleDate: string | null;
  entryId: string | null;
  ruleVersion: string | null;
  ruleTerms: { kind?: string; basis?: string; value?: string } | null;
  basisAmount: string;
  amount: string;
}

interface PaymentAccount {
  id: string;
  code: string;
  name: string;
  role: "cash" | "bank" | "petty_cash";
}

interface StatementData {
  employee: { id: string; fullName: string; employeeCode: string | null; isActive: boolean };
  totals: { accrued: string; paidThroughPayroll: string; paidThroughRuns: string; unpaid: string };
  accruals: { id: string; saleDate: string | null; sourceLabel: string; orderNumber: string | null; amount: string; settledRef: string | null }[];
  payouts: { payoutId: string; runNumber: number; kind: "payout" | "reversal"; amount: string; paidDate: string; entryId: string | null }[];
  truncated: boolean;
}

const PAGE_SIZE = 100;

/** Each action's endpoint, by the action name the server returns. */
const ACTION_PATH: Record<CommissionRunAction, string> = {
  calculate: "calculate",
  review: "review",
  approve: "approve",
  reject: "reject",
  release: "release",
  void: "void",
  pay: "payouts",
  reverse_payout: "",
  close: "close",
};

const ACTION_DONE: Partial<Record<CommissionRunAction, string>> = {
  calculate: "دوره محاسبه شد.",
  review: "دوره بازبینی شد.",
  approve: "دوره تأیید شد.",
  reject: "دوره به پیش‌نویس بازگشت.",
  release: "دوره برای پرداخت آزاد شد.",
  void: "دوره ابطال شد.",
  close: "دوره بسته شد.",
};

function newIdempotencyKey(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function journalHref(entryId: string | null): string | null {
  return entryId ? `${accountingSectionHref("entries")}?entry=${entryId}` : null;
}

function ruleLabel(terms: LineRow["ruleTerms"], formatMoney: (rial: string) => string): string {
  if (!terms) return "—";
  const basis = terms.basis === "margin" ? "روی سود" : "روی مبلغ خط";
  if (terms.kind === "percent") return `${formatPersianNumber(Number(terms.value ?? 0))}٪ ${basis}`;
  return `${formatMoney(terms.value ?? "0")} ${basis}`;
}

/** The message a refused payout names the member for, when the server says which one. */
function refusalText(error: string | undefined, details: Record<string, unknown> | undefined, names: Map<string, string>, formatMoney: (rial: string) => string): string {
  const base = commissionSettlementErrorMessage(error);
  const employeeId = typeof details?.employeeId === "string" ? details.employeeId : null;
  const name = employeeId ? names.get(employeeId) : undefined;
  if (error === "allocation_exceeds_outstanding" && name && typeof details?.outstanding === "string") {
    return `${base} ${name}: مانده ${formatMoney(details.outstanding)}.`;
  }
  if (name && (error === "nothing_outstanding" || error === "employee_not_in_run")) return `${base} (${name})`;
  return base;
}

export function CommissionRunDetailView({ runId, permissions }: { runId: string; permissions: readonly string[] }) {
  const money = useMoney();
  const can = useMemo(() => new Set(permissions), [permissions]);

  const [run, setRun] = useState<RunDetailData | null>(null);
  const [loadError, setLoadError] = useState("");
  const [accounts, setAccounts] = useState<PaymentAccount[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [actionError, setActionError] = useState("");
  const [note, setNote] = useState("");
  const [confirming, setConfirming] = useState<CommissionRunAction | null>(null);
  const [reverseTarget, setReverseTarget] = useState<string | null>(null);
  const [reversingId, setReversingId] = useState<string | null>(null);
  const [showPayout, setShowPayout] = useState(false);
  const [payoutError, setPayoutError] = useState("");
  const [statementFor, setStatementFor] = useState<string | null>(null);
  const [statement, setStatement] = useState<StatementData | null>(null);
  const [statementError, setStatementError] = useState("");

  const loadRun = useCallback(async () => {
    setLoadError("");
    const { ok, data } = await api<{ run?: RunDetailData; error?: string }>(`/api/commission/runs/${runId}`);
    if (ok && data.run) setRun(data.run);
    else setLoadError(commissionSettlementErrorMessage(data.error));
  }, [runId]);

  useEffect(() => {
    void loadRun();
  }, [loadRun]);

  useEffect(() => {
    if (!can.has("commission.payout")) return;
    void api<{ accounts?: PaymentAccount[] }>("/api/commission/payment-accounts").then(({ ok, data }) => {
      if (ok && data.accounts) setAccounts(data.accounts);
    });
  }, [can]);

  useEffect(() => {
    if (!statementFor) {
      setStatement(null);
      return;
    }
    setStatementError("");
    setStatement(null);
    void api<StatementData & { error?: string }>(`/api/commission/statement?employeeId=${statementFor}`).then(({ ok, data }) => {
      if (ok) setStatement(data);
      else setStatementError(commissionSettlementErrorMessage(data.error));
    });
  }, [statementFor]);

  const names = useMemo(() => new Map((run?.employees ?? []).map((e) => [e.employeeId, e.employeeName])), [run]);
  const formatMoney = (rial: string) => money.formatText(rial);

  async function perform(action: CommissionRunAction) {
    if (!run) return;
    setActionError("");
    setNotice("");
    if (actionRequiresReason(action) && note.trim() === "") {
      setActionError(commissionSettlementErrorMessage("void_reason_required"));
      return;
    }
    setBusy(action);
    const { ok, data } = await api<{ run?: RunDetailData; error?: string; details?: Record<string, unknown> }>(
      `/api/commission/runs/${run.id}/${ACTION_PATH[action]}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: note.trim() || null }),
      },
    );
    setBusy(null);
    setConfirming(null);
    if (!ok || !data.run) {
      setActionError(commissionSettlementErrorMessage(data.error));
      return;
    }
    setRun(data.run);
    setNote("");
    setShowPayout(false);
    setNotice(ACTION_DONE[action] ?? "انجام شد.");
  }

  async function reversePayout(payout: Payout) {
    setActionError("");
    setNotice("");
    setReversingId(payout.id);
    const { ok, data } = await api<{ run?: RunDetailData; replayed?: boolean; error?: string }>(
      `/api/commission/payouts/${payout.id}/reverse`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ note: note.trim() || null }) },
    );
    setReversingId(null);
    setReverseTarget(null);
    if (!ok || !data.run) {
      setActionError(commissionSettlementErrorMessage(data.error));
      return;
    }
    setRun(data.run);
    setNote("");
    setNotice(data.replayed ? "این پرداخت قبلاً ابطال شده بود." : "پرداخت ابطال شد.");
  }

  if (loadError) {
    return (
      <PageShell>
        <div className="space-y-4">
          <ErrorBox>{loadError}</ErrorBox>
          <Button variant="outline" className="min-h-11" onClick={() => void loadRun()}>
            تلاش دوباره
          </Button>
        </div>
      </PageShell>
    );
  }
  if (!run) {
    return (
      <PageShell>
        <LoadingSkeleton rows={6} />
      </PageShell>
    );
  }

  const canPay = run.actions.includes("pay");
  const warnings = run.warnings.map((warning) => commissionWarningText(warning, (n) => formatPersianNumber(n)));
  const period = `${shamsiDate(run.periodFrom)} تا ${shamsiDate(run.periodTo)}`;

  return (
    <PageShell>
      <PageHeader
        title={`دورهٔ تسویه شماره ${formatPersianNumber(run.runNumber)}`}
        description={[run.title, period].filter(Boolean).join(" · ")}
        actions={
          <>
            <StatusBadge tone={runStatusTone(run.status)}>{runStatusLabel(run.status)}</StatusBadge>
            <Button variant="outline" className="min-h-11" asChild>
              <Link href="/growth/commission/runs">همهٔ دوره‌ها</Link>
            </Button>
            <Button variant="outline" className="min-h-11" asChild>
              <a href={`/api/commission/runs/${run.id}/lines?format=csv`} download>
                خروجی ردیف‌ها
              </a>
            </Button>
          </>
        }
      />

      <div className="space-y-4 sm:space-y-5">
        {notice ? <InfoBox>{notice}</InfoBox> : null}
        {actionError ? <ErrorBox>{actionError}</ErrorBox> : null}

        {warnings.length > 0 ? (
          <SectionCard title={<CardTitle eyebrow="هشدارها" title="نکات این دوره" />}>
            <ul className="list-disc space-y-1 pe-5 text-sm text-foreground">
              {warnings.map((text, index) => (
                <li key={index}>{text}</li>
              ))}
            </ul>
          </SectionCard>
        ) : null}

        <KpiRow>
          <KpiCard label="کل پورسانت دوره" value={money.formatText(run.commissionTotal)} hint={`${formatPersianNumber(run.lineCount)} ردیف`} />
          <KpiCard label="پرداخت‌شده" value={money.formatText(run.paidTotal)} />
          <KpiCard label="باقی‌مانده" value={money.formatText(run.outstandingTotal)} hint={run.status === "closed" ? "به دورهٔ بعد منتقل شد" : undefined} />
          <KpiCard label="فروشندگان" value={formatPersianNumber(run.employeeCount)} />
        </KpiRow>

        <SectionCard
          title={<CardTitle eyebrow="اقدام" title="مراحل این دوره" />}
          description="هر مرحله جداگانه ثبت می‌شود و با نام شما در گزارش دوره می‌ماند."
        >
          {run.actions.length === 0 ? (
            <EmptyState>
              {run.status === "closed" || run.status === "voided"
                ? "این دوره بسته یا ابطال شده است و دیگر اقدامی ندارد."
                : "برای این دوره با حساب شما اقدامی در دسترس نیست."}
            </EmptyState>
          ) : (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2">
                {run.actions.filter((action) => action !== "pay" && action !== "reverse_payout").map((action) => (
                  <Button
                    key={action}
                    variant={actionVariant(action)}
                    className="min-h-11"
                    disabled={busy !== null}
                    onClick={() => {
                      setActionError("");
                      setNotice("");
                      if (actionNeedsConfirmation(action)) setConfirming(action);
                      else void perform(action);
                    }}
                  >
                    {actionLabel(action)}
                  </Button>
                ))}
                {canPay ? (
                  <Button className="min-h-11" disabled={busy !== null} onClick={() => setShowPayout((open) => !open)}>
                    {showPayout ? "بستن فرم پرداخت" : "پرداخت به فروشندگان"}
                  </Button>
                ) : null}
              </div>
              {confirming ? (
                <div className="space-y-3 rounded-lg border border-border/80 p-3">
                  <p className="text-sm text-foreground">
                    {actionRequiresReason(confirming)
                      ? "دلیل ابطال را بنویسید؛ این دوره با همین دلیل در تاریخچه می‌ماند."
                      : `«${actionLabel(confirming)}» را تأیید می‌کنید؟`}
                  </p>
                  <Field label={actionRequiresReason(confirming) ? "دلیل ابطال" : "یادداشت (اختیاری)"}>
                    <input className={inputClass} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
                  </Field>
                  <div className="flex flex-wrap gap-2">
                    <Button variant={actionVariant(confirming)} className="min-h-11" disabled={busy !== null} onClick={() => void perform(confirming)}>
                      {busy === confirming ? "در حال ثبت…" : `تأیید: ${actionLabel(confirming)}`}
                    </Button>
                    <Button variant="ghost" className="min-h-11" onClick={() => setConfirming(null)}>
                      انصراف
                    </Button>
                  </div>
                </div>
              ) : null}
              {run.status === "voided" && run.voidReason ? (
                <InfoBox>دلیل ابطال: {run.voidReason}</InfoBox>
              ) : null}
            </div>
          )}
        </SectionCard>

        <MembersCard run={run} money={money} onStatement={(id) => setStatementFor(id)} selected={statementFor} />

        {showPayout && canPay ? (
          <PayoutFormCard
            run={run}
            accounts={accounts}
            busy={busy === "pay"}
            onDone={(next, message) => {
              setRun(next);
              setShowPayout(false);
              setNotice(message);
            }}
            onError={(message) => setPayoutError(message)}
            error={payoutError}
            clearError={() => setPayoutError("")}
            refusalText={(error, details) => refusalText(error, details, names, formatMoney)}
          />
        ) : null}

        <PayoutsCard
          run={run}
          canReverse={can.has("commission.reverse")}
          reversingId={reversingId}
          reverseTarget={reverseTarget}
          onAskReverse={(id) => {
            setActionError("");
            setNotice("");
            setNote("");
            setConfirming(null);
            setReverseTarget(id);
          }}
          onCancelReverse={() => {
            setReverseTarget(null);
            setNote("");
          }}
          onReverse={(payout) => void reversePayout(payout)}
          note={note}
          onNote={setNote}
        />

        {statementFor ? (
          <StatementCard
            statement={statement}
            error={statementError}
            money={money}
            onClose={() => setStatementFor(null)}
          />
        ) : null}

        <LinesCard runId={run.id} employees={run.employees} money={money} />

        <EventsCard events={run.events} money={money} />
      </div>
    </PageShell>
  );
}

type MoneyApi = ReturnType<typeof useMoney>;

function MembersCard({
  run,
  money,
  onStatement,
  selected,
}: {
  run: RunDetailData;
  money: MoneyApi;
  onStatement: (employeeId: string) => void;
  selected: string | null;
}) {
  if (run.employees.length === 0) {
    return (
      <SectionCard title={<CardTitle eyebrow="فروشندگان" title="چه کسانی پورسانت می‌گیرند" />}>
        <EmptyState>این دوره هنوز فروشنده‌ای ندارد. پیش از محاسبه، پیش‌نویس را بازبینی کنید.</EmptyState>
      </SectionCard>
    );
  }
  return (
    <SectionCard flush title={<CardTitle eyebrow="فروشندگان" title="چه کسانی پورسانت می‌گیرند" />}>
      <DataTable caption="فروشندگان این دوره" frame={false}>
        <DataTableHead>
          <Th>فروشنده</Th>
          <Th numeric>ردیف</Th>
          <Th numeric>سهم</Th>
          <Th numeric>پرداخت‌شده</Th>
          <Th numeric>باقی‌مانده</Th>
          <Th>صورت‌حساب</Th>
        </DataTableHead>
        <DataTableBody>
          {run.employees.map((employee) => (
            <DataTableRow key={employee.employeeId} selected={selected === employee.employeeId}>
              <Td>
                <span className="font-medium text-foreground">{employee.employeeName}</span>
                {employee.employeeActive ? null : <StatusBadge tone="neutral">غیرفعال</StatusBadge>}
              </Td>
              <Td numeric>{formatPersianNumber(employee.lineCount)}</Td>
              <Td numeric>{money.formatText(employee.owed)}</Td>
              <Td numeric>{money.formatText(employee.paid)}</Td>
              <Td numeric>{money.formatText(employee.outstanding)}</Td>
              <Td>
                <Button variant="ghost" size="sm" onClick={() => onStatement(employee.employeeId)}>
                  نمایش
                </Button>
              </Td>
            </DataTableRow>
          ))}
        </DataTableBody>
      </DataTable>
    </SectionCard>
  );
}

function PayoutFormCard({
  run,
  accounts,
  busy,
  onDone,
  onError,
  error,
  clearError,
  refusalText: explain,
}: {
  run: RunDetailData;
  accounts: PaymentAccount[];
  busy: boolean;
  onDone: (run: RunDetailData, message: string) => void;
  onError: (message: string) => void;
  error: string;
  clearError: () => void;
  refusalText: (error: string | undefined, details: Record<string, unknown> | undefined) => string;
}) {
  const money = useMoney();
  const payable = useMemo(() => run.employees.filter((e) => BigInt(e.outstanding) > 0n), [run.employees]);
  const [rows, setRows] = useState<Record<string, PayoutFormRow>>(() =>
    Object.fromEntries(payable.map((e) => [e.employeeId, { all: true, text: money.toInputText(e.outstanding) }])),
  );
  const [choice, setChoice] = useState(() => (accounts[0] ? `account:${accounts[0].id}` : "method:bank"));
  const [paidDate, setPaidDate] = useState(run.today);
  const [memo, setMemo] = useState("");
  // One key for this form, reused by a retry after a dropped connection, so the same payout is never made twice.
  const keyRef = useRef(newIdempotencyKey("commission-payout"));
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    clearError();
    let allocations: ReturnType<typeof allocationsFromForm>;
    try {
      allocations = allocationsFromForm(
        Object.fromEntries(payable.map((e) => [e.employeeId, rows[e.employeeId] ?? { all: false, text: "" }])),
        (text) => money.parseText(text),
      );
    } catch {
      onError(commissionSettlementErrorMessage("invalid_amount"));
      return;
    }
    if (allocations.length === 0) {
      onError(commissionSettlementErrorMessage("no_allocations"));
      return;
    }
    const payment = parsePaymentChoice(choice);
    if (payment.paymentAccountId === null && payment.method === null) {
      onError(commissionSettlementErrorMessage("invalid_method"));
      return;
    }
    setSubmitting(true);
    const { ok, data } = await api<{ run?: RunDetailData; replayed?: boolean; error?: string; details?: Record<string, unknown> }>(
      `/api/commission/runs/${run.id}/payouts`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": keyRef.current },
        body: JSON.stringify({
          allocations,
          paymentAccountId: payment.paymentAccountId,
          method: payment.method,
          paidDate: paidDate || null,
          memo: memo.trim() || null,
        }),
      },
    );
    setSubmitting(false);
    if (!ok || !data.run) {
      onError(explain(data.error, data.details));
      return;
    }
    keyRef.current = newIdempotencyKey("commission-payout");
    onDone(data.run, data.replayed ? "این پرداخت قبلاً ثبت شده بود." : "پرداخت ثبت شد.");
  }

  return (
    <SectionCard title={<CardTitle eyebrow="پرداخت" title="پرداخت به فروشندگان" />} description="مبلغ هر فروشنده را بگذارید «همهٔ مانده» یا مبلغ دلخواه؛ بیش از مانده‌ی او پذیرفته نمی‌شود.">
      {payable.length === 0 ? (
        <EmptyState>هیچ فروشنده‌ای در این دوره مانده‌ای برای پرداخت ندارد.</EmptyState>
      ) : (
        <form onSubmit={submit} className="space-y-4" noValidate>
          {error ? <ErrorBox>{error}</ErrorBox> : null}
          <DataTable caption="مبلغ پرداخت به هر فروشنده" frame>
            <DataTableHead>
              <Th>فروشنده</Th>
              <Th numeric>مانده</Th>
              <Th>همهٔ مانده</Th>
              <Th>مبلغ پرداخت</Th>
            </DataTableHead>
            <DataTableBody>
              {payable.map((employee) => {
                const row = rows[employee.employeeId] ?? { all: true, text: "" };
                return (
                  <DataTableRow key={employee.employeeId}>
                    <Td>{employee.employeeName}</Td>
                    <Td numeric>{money.formatText(employee.outstanding)}</Td>
                    <Td>
                      <input
                        type="checkbox"
                        className="size-4"
                        aria-label={`همهٔ مانده برای ${employee.employeeName}`}
                        checked={row.all}
                        onChange={(e) =>
                          setRows((current) => ({
                            ...current,
                            [employee.employeeId]: { ...row, all: e.target.checked, text: money.toInputText(employee.outstanding) },
                          }))
                        }
                      />
                    </Td>
                    <Td>
                      <PersianNumberInput
                        aria-label={`مبلغ پرداخت به ${employee.employeeName}`}
                        className={inputClass}
                        disabled={row.all}
                        value={row.all ? money.toInputText(employee.outstanding) : row.text}
                        onChange={(e) =>
                          setRows((current) => ({ ...current, [employee.employeeId]: { all: false, text: e.target.value } }))
                        }
                      />
                    </Td>
                  </DataTableRow>
                );
              })}
            </DataTableBody>
          </DataTable>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="پرداخت از">
              <select className={inputClass} value={choice} onChange={(e) => setChoice(e.target.value)}>
                {accounts.map((account) => (
                  <option key={account.id} value={`account:${account.id}`}>
                    {account.name} ({account.code})
                  </option>
                ))}
                <option value="method:cash">{methodLabel("cash")} (پیش‌فرض)</option>
                <option value="method:bank">{methodLabel("bank")}</option>
              </select>
            </Field>
            <Field label="تاریخ پرداخت">
              <JalaliDatePicker value={paidDate} onChange={setPaidDate} ariaLabel="تاریخ پرداخت" />
            </Field>
            <Field label="یادداشت (اختیاری)">
              <input className={inputClass} value={memo} maxLength={500} onChange={(e) => setMemo(e.target.value)} />
            </Field>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" className="min-h-11" disabled={busy || submitting}>
              {busy || submitting ? "در حال ثبت پرداخت…" : "ثبت پرداخت"}
            </Button>
          </div>
        </form>
      )}
    </SectionCard>
  );
}

function PayoutsCard({
  run,
  canReverse,
  reversingId,
  reverseTarget,
  onAskReverse,
  onCancelReverse,
  onReverse,
  note,
  onNote,
}: {
  run: RunDetailData;
  canReverse: boolean;
  reversingId: string | null;
  reverseTarget: string | null;
  onAskReverse: (payoutId: string) => void;
  onCancelReverse: () => void;
  onReverse: (payout: Payout) => void;
  note: string;
  onNote: (value: string) => void;
}) {
  const money = useMoney();
  const reversed = new Set(run.payouts.map((p) => p.reversesPayoutId).filter((id): id is string => id !== null));
  if (run.payouts.length === 0) {
    return (
      <SectionCard title={<CardTitle eyebrow="پرداخت‌ها" title="پرداخت‌های این دوره" />}>
        <EmptyState>هنوز پرداختی برای این دوره ثبت نشده است.</EmptyState>
      </SectionCard>
    );
  }
  return (
    <SectionCard flush title={<CardTitle eyebrow="پرداخت‌ها" title="پرداخت‌های این دوره" />}>
      <DataTable caption="پرداخت‌های این دوره" frame={false}>
        <DataTableHead>
          <Th>تاریخ پرداخت</Th>
          <Th>نوع</Th>
          <Th numeric>مبلغ</Th>
          <Th>از</Th>
          <Th>فروشندگان</Th>
          <Th>یادداشت</Th>
          <Th>سند</Th>
          <Th>عملیات</Th>
        </DataTableHead>
        <DataTableBody>
          {run.payouts.map((payout) => {
            const href = journalHref(payout.entryId);
            const canUndo = canReverse && payout.kind === "payout" && !reversed.has(payout.id) && run.status !== "closed";
            return (
              <DataTableRow key={payout.id}>
                <Td nowrap>{shamsiDate(payout.paidDate)}</Td>
                <Td>
                  <StatusBadge tone={payout.kind === "payout" ? "positive" : "danger"}>{payoutKindLabel(payout.kind)}</StatusBadge>
                </Td>
                <Td numeric>{money.formatText(payout.amount)}</Td>
                <Td>{methodLabel(payout.paymentMethod)}</Td>
                <Td>{payout.allocations.map((a) => `${a.employeeName} (${money.formatText(a.amount)})`).join("، ")}</Td>
                <Td>{payout.memo ?? "—"}</Td>
                <Td>{href ? <Link href={href} className="text-primary underline-offset-4 hover:underline">سند دفتر</Link> : "—"}</Td>
                <Td>
                  {canUndo ? (
                    reverseTarget === payout.id ? (
                      <div className="space-y-2">
                        <input className={inputClass} placeholder="دلیل ابطال" value={note} maxLength={500} onChange={(e) => onNote(e.target.value)} />
                        <div className="flex gap-2">
                          <Button variant="destructive" size="sm" disabled={reversingId === payout.id} onClick={() => onReverse(payout)}>
                            تأیید ابطال
                          </Button>
                          <Button variant="ghost" size="sm" onClick={onCancelReverse}>
                            انصراف
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <Button variant="outline" size="sm" onClick={() => onAskReverse(payout.id)}>
                        ابطال
                      </Button>
                    )
                  ) : reversed.has(payout.id) ? (
                    <span className="text-xs text-muted-foreground">ابطال شده</span>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </Td>
              </DataTableRow>
            );
          })}
        </DataTableBody>
      </DataTable>
    </SectionCard>
  );
}

function StatementCard({
  statement,
  error,
  money,
  onClose,
}: {
  statement: StatementData | null;
  error: string;
  money: MoneyApi;
  onClose: () => void;
}) {
  return (
    <SectionCard
      title={<CardTitle eyebrow="صورت‌حساب" title={statement ? `صورت‌حساب ${statement.employee.fullName}` : "صورت‌حساب فروشنده"} />}
      actions={
        <Button variant="ghost" size="sm" onClick={onClose}>
          بستن
        </Button>
      }
    >
      {error ? (
        <ErrorBox>{error}</ErrorBox>
      ) : !statement ? (
        <LoadingSkeleton rows={3} compact />
      ) : (
        <div className="space-y-4">
          <KpiRow>
            <KpiCard label="کل پورسانت ثبت‌شده" value={money.formatText(statement.totals.accrued)} />
            <KpiCard label="پرداخت از طریق حقوق" value={money.formatText(statement.totals.paidThroughPayroll)} />
            <KpiCard label="پرداخت از طریق دوره‌های تسویه" value={money.formatText(statement.totals.paidThroughRuns)} />
            <KpiCard label="هنوز پرداخت‌نشده" value={money.formatText(statement.totals.unpaid)} />
          </KpiRow>
          {statement.accruals.length === 0 ? (
            <EmptyState>برای این فروشنده هنوز پورسانتی ثبت نشده است.</EmptyState>
          ) : (
            <DataTable caption="ردیف‌های پورسانت فروشنده" frame>
              <DataTableHead>
                <Th>تاریخ فروش</Th>
                <Th>منبع</Th>
                <Th numeric>مبلغ</Th>
                <Th>وضعیت</Th>
              </DataTableHead>
              <DataTableBody>
                {statement.accruals.map((row) => (
                  <DataTableRow key={row.id}>
                    <Td nowrap>{shamsiDate(row.saleDate)}</Td>
                    <Td>{row.sourceLabel}</Td>
                    <Td numeric>{money.formatText(row.amount)}</Td>
                    <Td>{row.settledRef ?? "در انتظار تسویه"}</Td>
                  </DataTableRow>
                ))}
              </DataTableBody>
            </DataTable>
          )}
          {statement.truncated ? <InfoBox>فقط بخشی از ردیف‌ها نمایش داده شده است؛ برای همهٔ آن‌ها از گزارش استفاده کنید.</InfoBox> : null}
        </div>
      )}
    </SectionCard>
  );
}

function LinesCard({ runId, employees, money }: { runId: string; employees: Employee[]; money: MoneyApi }) {
  const [employeeId, setEmployeeId] = useState("");
  const [offset, setOffset] = useState(0);
  const [lines, setLines] = useState<LineRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
    if (employeeId) params.set("employeeId", employeeId);
    const { ok, data } = await api<{ lines?: LineRow[]; total?: number; error?: string }>(
      `/api/commission/runs/${runId}/lines?${params}`,
    );
    if (ok && data.lines) {
      setLines(data.lines);
      setTotal(data.total ?? data.lines.length);
    } else {
      setError(commissionSettlementErrorMessage(data.error));
    }
  }, [runId, employeeId, offset]);

  useEffect(() => {
    void load();
  }, [load]);

  const csvHref = `/api/commission/runs/${runId}/lines?format=csv${employeeId ? `&employeeId=${employeeId}` : ""}`;
  return (
    <SectionCard
      flush
      title={<CardTitle eyebrow="ردیف‌ها" title="فروش‌های پشت هر مبلغ" />}
      description="هر ردیف یک فروش (یا برگشت آن) است که پورسانتش در این دوره آمده؛ با قانون و سند دفتر آن."
      actions={
        <div className="flex flex-wrap items-end gap-2">
          <div className="w-52">
            <Field label="فروشنده">
              <select className={inputClass} value={employeeId} onChange={(e) => { setOffset(0); setEmployeeId(e.target.value); }}>
                <option value="">همهٔ فروشندگان</option>
                {employees.map((e) => (
                  <option key={e.employeeId} value={e.employeeId}>
                    {e.employeeName}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Button variant="outline" size="sm" asChild>
            <a href={csvHref} download>
              خروجی CSV
            </a>
          </Button>
        </div>
      }
    >
      {error ? (
        <div className="p-4">
          <ErrorBox>{error}</ErrorBox>
        </div>
      ) : lines === null ? (
        <div className="p-4">
          <LoadingSkeleton rows={4} compact />
        </div>
      ) : lines.length === 0 ? (
        <div className="p-4">
          <EmptyState>ردیفی برای این انتخاب نیست.</EmptyState>
        </div>
      ) : (
        <>
          <DataTable caption="ردیف‌های تسویه" frame={false}>
            <DataTableHead>
              <Th>تاریخ فروش</Th>
              <Th>فروشنده</Th>
              <Th>نوع</Th>
              <Th>منبع</Th>
              <Th>کالا</Th>
              <Th numeric>مبنا</Th>
              <Th numeric>پورسانت</Th>
              <Th>قانون</Th>
              <Th>سند</Th>
            </DataTableHead>
            <DataTableBody>
              {lines.map((line) => {
                const href = journalHref(line.entryId);
                return (
                  <DataTableRow key={line.id}>
                    <Td nowrap>{line.saleDate ? shamsiDate(line.saleDate) : "—"}</Td>
                    <Td>{line.employeeName}</Td>
                    <Td>{lineKindLabel(line.lineKind)}</Td>
                    <Td>{line.sourceLabel}</Td>
                    <Td>{line.itemName ?? "—"}</Td>
                    <Td numeric>{money.formatText(line.basisAmount)}</Td>
                    <Td numeric>{money.formatText(line.amount)}</Td>
                    <Td>{ruleLabel(line.ruleTerms, (rial) => money.formatText(rial))}</Td>
                    <Td>{href ? <Link href={href} className="text-primary underline-offset-4 hover:underline">سند</Link> : "—"}</Td>
                  </DataTableRow>
                );
              })}
            </DataTableBody>
          </DataTable>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/80 p-3 text-sm text-muted-foreground">
            <span>
              {formatPersianNumber(offset + 1)} تا {formatPersianNumber(Math.min(offset + PAGE_SIZE, total))} از {formatPersianNumber(total)}
            </span>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
                قبلی
              </Button>
              <Button variant="outline" size="sm" disabled={offset + PAGE_SIZE >= total} onClick={() => setOffset(offset + PAGE_SIZE)}>
                بعدی
              </Button>
            </div>
          </div>
        </>
      )}
    </SectionCard>
  );
}

function EventsCard({ events, money }: { events: RunEvent[]; money: MoneyApi }) {
  return (
    <SectionCard title={<CardTitle eyebrow="تاریخچه" title="چه کسی چه کاری کرد" />}>
      {events.length === 0 ? (
        <EmptyState>هنوز رویدادی ثبت نشده است.</EmptyState>
      ) : (
        <ol className="space-y-3 text-sm">
          {events.map((event) => {
            const amount = typeof event.details.amount === "string" ? event.details.amount : null;
            return (
              <li key={event.id} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-border/60 pb-3 last:border-0">
                <div className="min-w-0 flex-1">
                  <span className="font-medium text-foreground">{eventLabel(event.action)}</span>
                  <span className="mr-2 text-xs text-muted-foreground">
                    {event.fromStatus ? `${runStatusLabel(event.fromStatus as CommissionRunStatus)} ← ` : ""}
                    {runStatusLabel(event.toStatus as CommissionRunStatus)}
                  </span>
                  {event.note ? <p className="mt-1 text-xs text-muted-foreground">{event.note}</p> : null}
                </div>
                <div className="shrink-0 text-xs text-muted-foreground">
                  {amount !== null ? <span className="ml-2 text-foreground">{money.formatText(amount)}</span> : null}
                  {event.actorName ?? "—"} · {shamsiDateTime(event.createdAt)}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </SectionCard>
  );
}
