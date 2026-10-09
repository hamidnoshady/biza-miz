"use client";

/**
 * #865 payroll runs: open a month (regular) or a correction (supplemental),
 * enter the month's overtime / unpaid leave — signed in a correction — then
 * calculate → review → approve → post → pay → close. Each step is the server's
 * own transition; the screen only offers the next legal one.
 */
import { useMemo, useState } from "react";
import { DataTable, DataTableBody, DataTableHead, DataTableRow, Td, Th } from "@/app/dashboard/data-table";
import { EmptyState, KpiCard, KpiRow, SectionCard, SectionCardSkeleton, StatusBadge } from "@/app/dashboard/page-chrome";
import { api, ErrorBox, Field, inputClass, SecondaryButton } from "@/app/dashboard/ui";
import { Button } from "@/components/ui/button";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useMoney } from "@/components/money/money-context";
import { toPersianDigits } from "@/lib/digits";
import { payrollError } from "./payroll-error";
import {
  currentPeriodKey,
  periodText,
  quantityText,
  recentPeriodKeys,
  RUN_STATUS,
  shamsi,
  useEngineData,
  type EngineRun,
  type EngineRunStatus,
  type Payslip,
  type PayrollProfile,
} from "./payroll-engine-shared";

type Action = "calculate" | "review" | "approve" | "post" | "pay" | "close" | "cancel";

/** The next steps a run in `status` may take, in the order the screen offers them. */
const NEXT: Record<EngineRunStatus, Action[]> = {
  draft: ["calculate", "cancel"],
  calculated: ["calculate", "review", "cancel"],
  reviewed: ["calculate", "approve", "cancel"],
  approved: ["post"],
  posted: ["pay"],
  paid: ["close"],
  closed: [],
  cancelled: [],
};

const ACTION_LABEL: Record<Action, string> = {
  calculate: "محاسبه",
  review: "بازبینی شد",
  approve: "تأیید",
  post: "ثبت در دفتر",
  pay: "پرداخت",
  close: "بستن دوره",
  cancel: "لغو",
};

interface InputDraft {
  overtimeHours: string;
  unpaidLeaveDays: string;
}

function parseQuantity(text: string): number | null {
  const t = text.trim().replace("−", "-");
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
}

export function PayrollEngineRuns({ canManage }: { canManage: boolean }) {
  const money = useMoney();
  const [reload, setReload] = useState(0);
  const runs = useEngineData<{ runs: EngineRun[] }>("/api/ledger/payroll/engine/runs", reload);
  const profiles = useEngineData<{ profiles: PayrollProfile[] }>("/api/ledger/payroll/engine/profiles", reload);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  const [periodKey, setPeriodKey] = useState(currentPeriodKey());
  const [runType, setRunType] = useState<"regular" | "supplemental">("regular");

  async function create() {
    setPending(true);
    setError("");
    const res = await api<{ run?: EngineRun; error?: string }>("/api/ledger/payroll/engine/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": `ui-${crypto.randomUUID()}` },
      body: JSON.stringify({ periodKey, runType }),
    });
    setPending(false);
    if (!res.ok || !res.data.run) return setError(payrollError(res.data.error));
    setSelected(res.data.run.id);
    setReload((n) => n + 1);
  }

  const list = runs.data?.runs ?? [];
  return (
    <div className="space-y-4">
      <ErrorBox>{error || runs.error}</ErrorBox>
      {canManage ? (
        <SectionCard title="اجرای جدید" description="ماه عادی یکبار اجرا می‌شود؛ برای اصلاح ماهِ تأییدشده، اجرای اصلاحی بسازید.">
          <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <Field label="دوره">
              <select className={inputClass} value={periodKey} onChange={(e) => setPeriodKey(e.target.value)}>
                {recentPeriodKeys().map((k) => (
                  <option key={k} value={k}>
                    {periodText(k)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="نوع اجرا">
              <select className={inputClass} value={runType} onChange={(e) => setRunType(e.target.value as "regular" | "supplemental")}>
                <option value="regular">عادی</option>
                <option value="supplemental">اصلاحی</option>
              </select>
            </Field>
            <Button type="button" onClick={() => void create()} disabled={pending}>
              ایجاد اجرا
            </Button>
          </div>
        </SectionCard>
      ) : null}

      {runs.loading && !runs.data ? (
        <SectionCardSkeleton rows={4} label="در حال بارگذاری اجراها" />
      ) : list.length === 0 ? (
        <SectionCard title="اجراهای حقوق">
          <EmptyState title="هنوز اجرایی ثبت نشده است">اولین ماه را از «اجرای جدید» باز کنید.</EmptyState>
        </SectionCard>
      ) : (
        <SectionCard title="اجراهای حقوق" flush>
          <DataTable caption="اجراهای حقوق" frame={false}>
            <DataTableHead>
              <DataTableRow>
                <Th>دوره</Th>
                <Th>نوع</Th>
                <Th>وضعیت</Th>
                <Th>تاریخ تعهد</Th>
                <Th numeric>خالص پرداختی</Th>
                <Th numeric>بدهی کارکنان</Th>
                <Th>
                  <span className="sr-only">باز کردن</span>
                </Th>
              </DataTableRow>
            </DataTableHead>
            <DataTableBody>
              {list.map((r) => (
                <DataTableRow key={r.id}>
                  <Td nowrap>{periodText(r.periodKey)}</Td>
                  <Td nowrap>{r.runType === "regular" ? "عادی" : `اصلاحی ${toPersianDigits(r.sequence - 1)}`}</Td>
                  <Td>
                    <StatusBadge tone={RUN_STATUS[r.status].tone}>{RUN_STATUS[r.status].label}</StatusBadge>
                  </Td>
                  <Td nowrap>{shamsi(r.accrualDate)}</Td>
                  <Td numeric>{r.totals ? money.formatText(r.totals.netPay) : "—"}</Td>
                  <Td numeric>{r.totals && r.totals.employeeDebt && r.totals.employeeDebt !== "0" ? money.formatText(r.totals.employeeDebt) : "—"}</Td>
                  <Td>
                    <SecondaryButton onClick={() => setSelected(selected === r.id ? null : r.id)}>
                      {selected === r.id ? "بستن" : "جزئیات"}
                    </SecondaryButton>
                  </Td>
                </DataTableRow>
              ))}
            </DataTableBody>
          </DataTable>
        </SectionCard>
      )}

      {selected ? (
        <RunDetail
          key={selected}
          runId={selected}
          canManage={canManage}
          profiles={profiles.data?.profiles ?? []}
          onChanged={() => setReload((n) => n + 1)}
        />
      ) : null}
    </div>
  );
}

function RunDetail({
  runId,
  canManage,
  profiles,
  onChanged,
}: {
  runId: string;
  canManage: boolean;
  profiles: PayrollProfile[];
  onChanged: () => void;
}) {
  const money = useMoney();
  const [reload, setReload] = useState(0);
  const detail = useEngineData<{ run: EngineRun; payslips: Payslip[] }>(`/api/ledger/payroll/engine/runs/${runId}`, reload);
  const [drafts, setDrafts] = useState<Record<string, InputDraft> | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [payMethod, setPayMethod] = useState<"bank" | "cash">("bank");

  const run = detail.data?.run;
  const supplemental = run?.runType === "supplemental";
  const editable = !!run && canManage && ["draft", "calculated", "reviewed"].includes(run.status);
  const active = useMemo(() => profiles.filter((p) => p.configured && p.isActive), [profiles]);

  const current: Record<string, InputDraft> = useMemo(() => {
    if (drafts) return drafts;
    const out: Record<string, InputDraft> = {};
    for (const p of active) {
      const i = run?.inputs?.[p.userId];
      out[p.userId] = {
        overtimeHours: i?.overtimeHours !== undefined ? String(i.overtimeHours) : "",
        unpaidLeaveDays: i?.unpaidLeaveDays !== undefined ? String(i.unpaidLeaveDays) : "",
      };
    }
    return out;
  }, [drafts, active, run]);

  function inputsBody(): Record<string, { overtimeHours?: number; unpaidLeaveDays?: number }> | string {
    const out: Record<string, { overtimeHours?: number; unpaidLeaveDays?: number }> = {};
    for (const [userId, d] of Object.entries(current)) {
      const ot = parseQuantity(d.overtimeHours);
      const leave = parseQuantity(d.unpaidLeaveDays);
      if (Number.isNaN(ot)) return "invalid_overtime_hours";
      if (Number.isNaN(leave)) return "invalid_unpaid_leave_days";
      const entry: { overtimeHours?: number; unpaidLeaveDays?: number } = {};
      if (ot !== null && ot !== 0) entry.overtimeHours = ot;
      if (leave !== null && leave !== 0) entry.unpaidLeaveDays = leave;
      // A regular run keeps every name; a correction carries only the members it corrects.
      if (Object.keys(entry).length > 0 || (!supplemental && run?.inputs?.[userId])) out[userId] = entry;
    }
    return out;
  }

  async function act(action: Action) {
    if (!run) return;
    setPending(true);
    setError("");
    if (action === "calculate" && drafts) {
      const inputs = inputsBody();
      if (typeof inputs === "string") {
        setPending(false);
        return setError(payrollError(inputs));
      }
      const saved = await api<{ error?: string }>(`/api/ledger/payroll/engine/runs/${run.id}`, { method: "PATCH", body: JSON.stringify({ inputs }) });
      if (!saved.ok) {
        setPending(false);
        return setError(payrollError(saved.data.error));
      }
    }
    const res = await api<{ error?: string }>(`/api/ledger/payroll/engine/runs/${run.id}/${action}`, {
      method: "POST",
      body: JSON.stringify(action === "pay" ? { method: payMethod } : {}),
    });
    setPending(false);
    if (!res.ok) return setError(payrollError(res.data.error));
    setDrafts(null);
    setReload((n) => n + 1);
    onChanged();
  }

  if (detail.loading && !detail.data) return <SectionCardSkeleton rows={5} label="در حال بارگذاری اجرا" />;
  if (!run) return <ErrorBox>{detail.error}</ErrorBox>;
  const slips = detail.data?.payslips ?? [];
  const t = run.totals;

  return (
    <SectionCard
      title={`${periodText(run.periodKey)} — ${supplemental ? "اجرای اصلاحی" : "اجرای عادی"}`}
      description={
        run.ruleSetVersion
          ? `قوانین نسخه ${toPersianDigits(run.ruleSetVersion)} · تاریخ تعهد ${shamsi(run.accrualDate)}`
          : `تاریخ تعهد ${shamsi(run.accrualDate)}`
      }
      actions={<StatusBadge tone={RUN_STATUS[run.status].tone}>{RUN_STATUS[run.status].label}</StatusBadge>}
    >
      <ErrorBox>{error}</ErrorBox>
      {t ? (
        <KpiRow>
          <KpiCard label="ناخالص" value={money.formatText(t.gross)} />
          <KpiCard label="بیمه و مالیات" value={money.formatText((BigInt(t.employeeInsurance) + BigInt(t.incomeTax)).toString())} />
          <KpiCard label="خالص پرداختی" value={money.formatText(t.netPay)} />
          <KpiCard label="بهای تمام‌شده کارفرما" value={money.formatText(t.employerCost)} />
        </KpiRow>
      ) : null}

      {editable ? (
        <div className="mt-4 space-y-2">
          <h3 className="text-sm font-semibold">کارکرد ماه</h3>
          <p className="text-xs text-muted-foreground">
            {supplemental
              ? "فقط تغییر نسبت به آنچه پرداخت شده را وارد کنید؛ عدد منفی یعنی کسر (مثلاً ۱۰- ساعت اضافه‌کاری که اشتباه پرداخت شده بود)."
              : "ساعت اضافه‌کاری و روز مرخصی بدون حقوق هر نفر را وارد کنید؛ خالی یعنی صفر."}
          </p>
          <DataTable caption="کارکرد ماه">
            <DataTableHead>
              <DataTableRow>
                <Th>کارمند</Th>
                <Th>اضافه‌کاری (ساعت)</Th>
                <Th>مرخصی بدون حقوق (روز)</Th>
              </DataTableRow>
            </DataTableHead>
            <DataTableBody>
              {active.map((p) => (
                <DataTableRow key={p.userId}>
                  <Td>{p.fullName}</Td>
                  {(["overtimeHours", "unpaidLeaveDays"] as const).map((k) => (
                    <Td key={k}>
                      <PersianNumberInput
                        className={inputClass}
                        dir="ltr"
                        inputMode="decimal"
                        allowDecimal
                        allowNegative={supplemental}
                        placeholder="۰"
                        aria-label={`${k === "overtimeHours" ? "اضافه‌کاری" : "مرخصی بدون حقوق"} ${p.fullName}`}
                        value={current[p.userId]?.[k] ?? ""}
                        onChange={(e) => setDrafts({ ...current, [p.userId]: { ...current[p.userId], [k]: e.target.value } })}
                      />
                    </Td>
                  ))}
                </DataTableRow>
              ))}
            </DataTableBody>
          </DataTable>
        </div>
      ) : null}

      {canManage && NEXT[run.status].length > 0 ? (
        <div className="mt-4 flex flex-wrap items-end gap-2">
          {run.status === "posted" ? (
            <Field label="روش پرداخت">
              <select className={inputClass} value={payMethod} onChange={(e) => setPayMethod(e.target.value as "bank" | "cash")}>
                <option value="bank">بانک</option>
                <option value="cash">صندوق</option>
              </select>
            </Field>
          ) : null}
          {NEXT[run.status].map((a) =>
            a === "cancel" ? (
              <SecondaryButton key={a} onClick={() => void act(a)} disabled={pending}>
                {ACTION_LABEL[a]}
              </SecondaryButton>
            ) : (
              <Button key={a} type="button" onClick={() => void act(a)} disabled={pending}>
                {ACTION_LABEL[a]}
              </Button>
            ),
          )}
        </div>
      ) : null}

      {slips.length > 0 ? (
        <div className="mt-4">
          <DataTable caption="فیش‌های حقوقی این اجرا">
            <DataTableHead>
              <DataTableRow>
                <Th>کارمند</Th>
                <Th numeric>روز کارکرد</Th>
                <Th numeric>اضافه‌کاری</Th>
                <Th numeric>مرخصی</Th>
                <Th numeric>ناخالص</Th>
                <Th numeric>بیمه سهم کارمند</Th>
                <Th numeric>مالیات</Th>
                <Th numeric>کسورات</Th>
                <Th numeric>خالص / بدهی</Th>
              </DataTableRow>
            </DataTableHead>
            <DataTableBody>
              {slips.map((s) => (
                <DataTableRow key={s.id}>
                  <Td>{s.employeeName}</Td>
                  <Td numeric>{toPersianDigits(s.workedDays)}</Td>
                  <Td numeric>{s.overtimeHours ? quantityText(s.overtimeHours) : "—"}</Td>
                  <Td numeric>{s.unpaidLeaveDays ? quantityText(s.unpaidLeaveDays) : "—"}</Td>
                  <Td numeric>{money.formatText(s.gross)}</Td>
                  <Td numeric>{money.formatText(s.employeeInsurance)}</Td>
                  <Td numeric>{money.formatText(s.incomeTax)}</Td>
                  <Td numeric>{money.formatText(s.totalDeductions)}</Td>
                  <Td numeric>
                    {s.employeeDebt !== "0" ? (
                      <StatusBadge tone="danger">بدهی {money.formatText(s.employeeDebt)}</StatusBadge>
                    ) : (
                      money.formatText(s.netPay)
                    )}
                  </Td>
                </DataTableRow>
              ))}
            </DataTableBody>
          </DataTable>
        </div>
      ) : null}
    </SectionCard>
  );
}
