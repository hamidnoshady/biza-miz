"use client";

/**
 * #865 payroll runs: create a regular/correction run, edit complete employee
 * inputs (including manual components), then calculate → review → approve →
 * post → pay → close. API writes merge typed input fields unless removal or a
 * full replacement is explicit, preserving the immutable run-create identity.
 */
import { useMemo, useState } from "react";
import { DataTable, DataTableBody, DataTableHead, DataTableRow, Td, Th } from "@/app/dashboard/data-table";
import { JalaliDatePicker } from "@/app/dashboard/jalali-date-picker";
import { EmptyState, KpiCard, KpiRow, SectionCard, SectionCardSkeleton, StatusBadge } from "@/app/dashboard/page-chrome";
import { api, ErrorBox, Field, InfoBox, inputClass, SecondaryButton } from "@/app/dashboard/ui";
import { Button } from "@/components/ui/button";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { SearchableSelect } from "@/components/ui/searchable-select";
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
  type PayrollComponent,
  type PayrollPaymentAccount,
  type PayrollProfile,
} from "./payroll-engine-shared";

type Action = "calculate" | "review" | "approve" | "post" | "pay" | "close" | "cancel";

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

interface ItemDraft {
  rowKey: string;
  code: string;
  amount: string;
}

interface InputDraft {
  overtimeHours: string;
  unpaidLeaveDays: string;
  items: ItemDraft[];
}

function parseQuantity(text: string): number | null {
  const t = text.trim().replace("−", "-");
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
}

function signedMoneyInput(money: ReturnType<typeof useMoney>, amount: string): string {
  const negative = amount.startsWith("-");
  const magnitude = negative ? amount.slice(1) : amount;
  return `${negative ? "-" : ""}${money.toInputText(magnitude)}`;
}

function enterableComponent(component: PayrollComponent, accrualDate: string): boolean {
  const effective = component.effectiveFrom <= accrualDate && (!component.effectiveTo || component.effectiveTo >= accrualDate);
  return component.isActive && effective && component.kind !== "employer_contribution" && (!component.systemKey || ["bonus", "loan_installment"].includes(component.systemKey));
}

export function PayrollEngineRuns({ canManage }: { canManage: boolean }) {
  const money = useMoney();
  const [reload, setReload] = useState(0);
  const runs = useEngineData<{ runs: EngineRun[] }>("/api/ledger/payroll/engine/runs", reload);
  const profiles = useEngineData<{ profiles: PayrollProfile[] }>("/api/ledger/payroll/engine/profiles", reload);
  const catalog = useEngineData<{ components: PayrollComponent[] }>("/api/ledger/payroll/engine/components", reload);
  const payout = useEngineData<{ paymentAccounts: PayrollPaymentAccount[] }>("/api/ledger/payroll/preview?includeCommission=false", reload);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  const [periodKey, setPeriodKey] = useState(currentPeriodKey());
  const [runType, setRunType] = useState<"regular" | "supplemental">("regular");
  const [accrualDate, setAccrualDate] = useState("");
  const [includeCommission, setIncludeCommission] = useState(false);
  const [createRetry, setCreateRetry] = useState<{ signature: string; key: string } | null>(null);

  async function create() {
    setPending(true);
    setError("");
    const body = { periodKey, runType, accrualDate: accrualDate || null, includeCommission };
    const signature = JSON.stringify(body);
    const idempotencyKey = createRetry?.signature === signature ? createRetry.key : `ui-${crypto.randomUUID()}`;
    setCreateRetry({ signature, key: idempotencyKey });
    const res = await api<{ run?: EngineRun; error?: string }>("/api/ledger/payroll/engine/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
      body: JSON.stringify(body),
    });
    setPending(false);
    if (!res.ok || !res.data.run) return setError(payrollError(res.data.error));
    setCreateRetry(null);
    setSelected(res.data.run.id);
    setReload((n) => n + 1);
  }

  const list = runs.data?.runs ?? [];
  return (
    <div className="space-y-4">
      <ErrorBox>{error || runs.error || profiles.error || catalog.error || payout.error}</ErrorBox>
      {canManage ? (
        <SectionCard title="اجرای جدید" description="ماه عادی یکبار اجرا می‌شود؛ برای اصلاح ماهِ تأییدشده، اجرای اصلاحی بسازید. در تلاش مجدد همان درخواست، کلید تکرار ثابت می‌ماند.">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 lg:items-end">
            <Field label="دوره">
              <select className={inputClass} value={periodKey} onChange={(e) => setPeriodKey(e.target.value)}>
                {recentPeriodKeys().map((key) => <option key={key} value={key}>{periodText(key)}</option>)}
              </select>
            </Field>
            <Field label="نوع اجرا">
              <select className={inputClass} value={runType} onChange={(e) => setRunType(e.target.value as "regular" | "supplemental")}>
                <option value="regular">عادی</option>
                <option value="supplemental">اصلاحی</option>
              </select>
            </Field>
            <Field label="تاریخ تعهد (اختیاری)" as="div" hint="در صورت خالی‌بودن، سامانه تاریخ پیش‌فرض ماه را ثبت می‌کند.">
              <JalaliDatePicker value={accrualDate} onChange={setAccrualDate} ariaLabel="تاریخ تعهد اجرای حقوق" clearable />
            </Field>
            <label className="mb-4 flex min-h-10 items-center gap-2 text-sm">
              <input type="checkbox" checked={includeCommission} onChange={(e) => setIncludeCommission(e.target.checked)} />
              تسویهٔ پورسانت‌های پرداخت‌نشده در این اجرا
            </label>
          </div>
          <Button type="button" onClick={() => void create()} disabled={pending}>
            ایجاد اجرا
          </Button>
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
              <Th>دوره</Th>
              <Th>نوع</Th>
              <Th>وضعیت</Th>
              <Th>تاریخ تعهد</Th>
              <Th numeric>خالص پرداختی</Th>
              <Th numeric>بدهی کارکنان</Th>
              <Th><span className="sr-only">باز کردن</span></Th>
            </DataTableHead>
            <DataTableBody>
              {list.map((run) => (
                <DataTableRow key={run.id}>
                  <Td nowrap>{periodText(run.periodKey)}</Td>
                  <Td nowrap>{run.runType === "regular" ? "عادی" : `اصلاحی ${toPersianDigits(run.sequence - 1)}`}</Td>
                  <Td><StatusBadge tone={RUN_STATUS[run.status].tone}>{RUN_STATUS[run.status].label}</StatusBadge></Td>
                  <Td nowrap>{shamsi(run.accrualDate)}</Td>
                  <Td numeric>{run.totals ? money.formatText(run.totals.netPay) : "—"}</Td>
                  <Td numeric>{run.totals && run.totals.employeeDebt && run.totals.employeeDebt !== "0" ? money.formatText(run.totals.employeeDebt) : "—"}</Td>
                  <Td>
                    <SecondaryButton onClick={() => setSelected(selected === run.id ? null : run.id)}>
                      {selected === run.id ? "بستن" : "جزئیات"}
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
          components={catalog.data?.components ?? []}
          paymentAccounts={payout.data?.paymentAccounts ?? []}
          payoutLoading={payout.loading}
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
  components,
  paymentAccounts,
  payoutLoading,
  onChanged,
}: {
  runId: string;
  canManage: boolean;
  profiles: PayrollProfile[];
  components: PayrollComponent[];
  paymentAccounts: PayrollPaymentAccount[];
  payoutLoading: boolean;
  onChanged: () => void;
}) {
  const money = useMoney();
  const [reload, setReload] = useState(0);
  const detail = useEngineData<{ run: EngineRun; payslips: Payslip[] }>(`/api/ledger/payroll/engine/runs/${runId}`, reload);
  const [drafts, setDrafts] = useState<Record<string, InputDraft> | null>(null);
  const [includeCommissionDraft, setIncludeCommissionDraft] = useState<boolean | null>(null);
  const [removeHiddenInputs, setRemoveHiddenInputs] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [payMethod, setPayMethod] = useState<"bank" | "cash">("bank");
  const [paymentAccountId, setPaymentAccountId] = useState("");
  const [paidDate, setPaidDate] = useState("");

  const run = detail.data?.run;
  const supplemental = run?.runType === "supplemental";
  const editable = !!run && canManage && ["draft", "calculated", "reviewed"].includes(run.status);
  const active = useMemo(() => profiles.filter((profile) => profile.configured && profile.isActive), [profiles]);

  const current: Record<string, InputDraft> = useMemo(() => {
    if (drafts) return drafts;
    const out: Record<string, InputDraft> = {};
    for (const [userId, input] of Object.entries(run?.inputs ?? {})) {
      out[userId] = {
        overtimeHours: input.overtimeHours !== undefined ? String(input.overtimeHours) : "",
        unpaidLeaveDays: input.unpaidLeaveDays !== undefined ? String(input.unpaidLeaveDays) : "",
        items: (input.items ?? []).map((item, index) => ({
          rowKey: `${userId}-${item.code}-${index}`,
          code: item.code,
          amount: signedMoneyInput(money, item.amount),
        })),
      };
    }
    for (const profile of active) {
      if (!out[profile.userId]) out[profile.userId] = { overtimeHours: "", unpaidLeaveDays: "", items: [] };
    }
    return out;
  }, [drafts, active, money, run]);

  const editableItems = components.filter((component) => run && enterableComponent(component, run.accrualDate));
  const baseItemOptions = editableItems.map((component) => ({ value: component.code, label: `${component.code} — ${component.name}` }));
  const hiddenInputCount = run ? Object.keys(run.inputs ?? {}).filter((userId) => !active.some((profile) => profile.userId === userId)).length : 0;
  const dirty = drafts !== null || includeCommissionDraft !== null || removeHiddenInputs;

  function itemOptions(code: string) {
    if (!code || baseItemOptions.some((option) => option.value === code)) return baseItemOptions;
    const old = components.find((component) => component.code === code);
    return [...baseItemOptions, { value: code, label: old ? `${code} — ${old.name} (خارج از فهرست فعال)` : `${code} (حفظ‌شده)` }];
  }

  function buildInputsUpdate(): { inputs: Record<string, Record<string, unknown>>; removeEmployeeIds: string[] } | string {
    if (!run) return "run_not_found";
    const inputs: Record<string, Record<string, unknown>> = {};
    const removeEmployeeIds: string[] = removeHiddenInputs
      ? Object.keys(run.inputs ?? {}).filter((userId) => !active.some((profile) => profile.userId === userId))
      : [];
    for (const profile of active) {
      const draft = current[profile.userId] ?? { overtimeHours: "", unpaidLeaveDays: "", items: [] };
      const overtime = parseQuantity(draft.overtimeHours);
      const leave = parseQuantity(draft.unpaidLeaveDays);
      if (Number.isNaN(overtime)) return "invalid_overtime_hours";
      if (Number.isNaN(leave)) return "invalid_unpaid_leave_days";
      const items: Array<{ code: string; amount: string }> = [];
      for (const item of draft.items) {
        if (!item.amount.trim()) continue;
        if (!item.code) return "invalid_inputs";
        try {
          const amount = money.parseText(item.amount);
          if (BigInt(amount) !== 0n) items.push({ code: item.code, amount });
        } catch {
          return "invalid_amount";
        }
      }
      const hasFinancialInput = (overtime !== null && overtime !== 0) || (leave !== null && leave !== 0) || items.length > 0;
      const alreadyIncluded = Object.hasOwn(run.inputs ?? {}, profile.userId);
      if (supplemental) {
        if (hasFinancialInput) {
          inputs[profile.userId] = { overtimeHours: overtime, unpaidLeaveDays: leave, items };
        } else if (alreadyIncluded) {
          removeEmployeeIds.push(profile.userId);
        }
      } else {
        // The full form state covers every active employee and all manual items.
        // Hidden/deactivated ids stay absent from this merge and are preserved.
        inputs[profile.userId] = { overtimeHours: overtime, unpaidLeaveDays: leave, items };
      }
    }
    return { inputs, removeEmployeeIds };
  }

  async function saveInputs() {
    if (!run) return false;
    const update = buildInputsUpdate();
    if (typeof update === "string") {
      setError(payrollError(update));
      return false;
    }
    const res = await api<{ error?: string }>(`/api/ledger/payroll/engine/runs/${run.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        inputMode: "merge",
        inputs: update.inputs,
        removeEmployeeIds: update.removeEmployeeIds,
        includeCommission: includeCommissionDraft ?? run.includeCommission,
      }),
    });
    if (!res.ok) {
      setError(payrollError(res.data.error));
      return false;
    }
    setDrafts(null);
    setIncludeCommissionDraft(null);
    setRemoveHiddenInputs(false);
    setReload((n) => n + 1);
    onChanged();
    return true;
  }

  async function act(action: Action) {
    if (!run) return;
    setPending(true);
    setError("");
    if (action === "calculate" && dirty) {
      const saved = await saveInputs();
      if (!saved) {
        setPending(false);
        return;
      }
    } else if (dirty && action !== "cancel") {
      setPending(false);
      return setError(payrollError("save_inputs_before_transition"));
    }
    const res = await api<{ error?: string }>(`/api/ledger/payroll/engine/runs/${run.id}/${action}`, {
      method: "POST",
      body: JSON.stringify(action === "pay" ? {
        method: payMethod,
        paidDate: paidDate || undefined,
        paymentAccountId: paymentAccountId || undefined,
      } : {}),
    });
    setPending(false);
    if (!res.ok) return setError(payrollError(res.data.error));
    setDrafts(null);
    setIncludeCommissionDraft(null);
    setRemoveHiddenInputs(false);
    setReload((n) => n + 1);
    onChanged();
  }

  if (detail.loading && !detail.data) return <SectionCardSkeleton rows={5} label="در حال بارگذاری اجرا" />;
  if (!run) return <ErrorBox>{detail.error}</ErrorBox>;
  const slips = detail.data?.payslips ?? [];
  const totals = run.totals;
  const hiddenMessage = hiddenInputCount > 0
    ? `ورودی‌های ${toPersianDigits(hiddenInputCount)} کارمندِ غیرفعال یا پنهان بدون تغییر نگه داشته می‌شوند.`
    : "";
  const methodAccounts = paymentAccounts.filter((account) => payMethod === "bank" ? account.role === "bank" : account.role !== "bank");
  const payAccountOptions = [
    { value: "", label: "حساب پیش‌فرض همین روش" },
    ...methodAccounts.map((account) => ({ value: account.id, label: `${account.code} — ${account.name}` })),
  ];

  return (
    <SectionCard
      title={`${periodText(run.periodKey)} — ${supplemental ? "اجرای اصلاحی" : "اجرای عادی"}`}
      description={run.ruleSetVersion ? `قوانین نسخه ${toPersianDigits(run.ruleSetVersion)} · تاریخ تعهد ${shamsi(run.accrualDate)}` : `تاریخ تعهد ${shamsi(run.accrualDate)}`}
      actions={<StatusBadge tone={RUN_STATUS[run.status].tone}>{RUN_STATUS[run.status].label}</StatusBadge>}
    >
      <ErrorBox>{error}</ErrorBox>
      {totals ? (
        <KpiRow>
          <KpiCard label="ناخالص" value={money.formatText(totals.gross)} />
          <KpiCard label="بیمه و مالیات" value={money.formatText((BigInt(totals.employeeInsurance) + BigInt(totals.incomeTax)).toString())} />
          <KpiCard label="خالص پرداختی" value={money.formatText(totals.netPay)} />
          <KpiCard label="بهای تمام‌شده کارفرما" value={money.formatText(totals.employerCost)} />
        </KpiRow>
      ) : null}

      {editable ? (
        <div className="mt-4 space-y-3">
          <h3 className="text-sm font-semibold">ورودی‌های کامل اجرای حقوق</h3>
          <p className="text-xs text-muted-foreground">
            {supplemental
              ? "مقادیر، اصلاح نسبت به ماه تأییدشده‌اند؛ عدد منفی یعنی برگشت. با پاک‌کردن همهٔ اقلام، آن کارمند صریحاً از اجرای اصلاحی خارج می‌شود."
              : "ساعت اضافه‌کاری، مرخصی بدون حقوق و اقلام دستی را ویرایش کنید؛ اقلام تکرارشونده از پروندهٔ هر کارمند می‌آیند."}
          </p>
          {hiddenMessage ? (
            <InfoBox>
              {hiddenMessage}
              <div className="mt-2">
                <SecondaryButton onClick={() => setRemoveHiddenInputs((current) => !current)}>
                  {removeHiddenInputs ? "بازگرداندن ورودی‌های پنهان" : "حذف صریح ورودی‌های پنهان"}
                </SecondaryButton>
                {removeHiddenInputs ? <span className="ms-2 text-xs">این حذف فقط پس از ذخیرهٔ ورودی‌ها انجام می‌شود.</span> : null}
              </div>
            </InfoBox>
          ) : null}
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={includeCommissionDraft ?? run.includeCommission}
              onChange={(e) => setIncludeCommissionDraft(e.target.checked)}
            />
            تسویهٔ پورسانت‌های پرداخت‌نشده در این اجرا
          </label>
          <DataTable caption="کارکرد و اقلام دستی ماه">
            <DataTableHead>
              <Th>کارمند</Th>
              <Th>اضافه‌کاری (ساعت)</Th>
              <Th>مرخصی بدون حقوق (روز)</Th>
              <Th>اقلام دستی و اصلاحی</Th>
            </DataTableHead>
            <DataTableBody>
              {active.map((profile) => {
                const draft = current[profile.userId] ?? { overtimeHours: "", unpaidLeaveDays: "", items: [] };
                return (
                  <DataTableRow key={profile.userId}>
                    <Td>{profile.fullName}</Td>
                    {(["overtimeHours", "unpaidLeaveDays"] as const).map((key) => (
                      <Td key={key}>
                        <PersianNumberInput
                          className={inputClass}
                          dir="ltr"
                          inputMode="decimal"
                          allowDecimal
                          allowNegative={supplemental}
                          placeholder="۰"
                          aria-label={`${key === "overtimeHours" ? "اضافه‌کاری" : "مرخصی بدون حقوق"} ${profile.fullName}`}
                          value={draft[key]}
                          onChange={(e) => setDrafts({ ...current, [profile.userId]: { ...draft, [key]: e.target.value } })}
                        />
                      </Td>
                    ))}
                    <Td>
                      <div className="space-y-2">
                        {draft.items.map((item) => (
                          <div key={item.rowKey} className="grid gap-1 sm:grid-cols-[minmax(9rem,1fr)_minmax(8rem,1fr)_auto] sm:items-center">
                            <SearchableSelect
                              value={item.code}
                              onChange={(code) => setDrafts({
                                ...current,
                                [profile.userId]: { ...draft, items: draft.items.map((row) => row.rowKey === item.rowKey ? { ...row, code } : row) },
                              })}
                              options={itemOptions(item.code)}
                              ariaLabel={`جزء حقوق ${profile.fullName}`}
                              placeholder="انتخاب جزء حقوق"
                            />
                            <PersianNumberInput
                              className={inputClass}
                              dir="ltr"
                              inputMode="numeric"
                              allowDecimal={false}
                              allowNegative={supplemental}
                              aria-label={`مبلغ ${item.code || "قلم دستی"} برای ${profile.fullName} (${money.unitLabel})`}
                              value={item.amount}
                              onChange={(e) => setDrafts({
                                ...current,
                                [profile.userId]: { ...draft, items: draft.items.map((row) => row.rowKey === item.rowKey ? { ...row, amount: e.target.value } : row) },
                              })}
                            />
                            <SecondaryButton onClick={() => setDrafts({ ...current, [profile.userId]: { ...draft, items: draft.items.filter((row) => row.rowKey !== item.rowKey) } })}>
                              حذف
                            </SecondaryButton>
                          </div>
                        ))}
                        <SecondaryButton
                          disabled={editableItems.length === 0}
                          onClick={() => setDrafts({
                            ...current,
                            [profile.userId]: {
                              ...draft,
                              items: [...draft.items, { rowKey: crypto.randomUUID(), code: editableItems[0]?.code ?? "", amount: "" }],
                            },
                          })}
                        >
                          افزودن قلم دستی
                        </SecondaryButton>
                      </div>
                    </Td>
                  </DataTableRow>
                );
              })}
            </DataTableBody>
          </DataTable>
          {dirty ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" onClick={() => void saveInputs()} disabled={pending}>ذخیرهٔ ورودی‌ها</Button>
              <span className="text-xs text-muted-foreground">بعد از ذخیره، برای ساختن snapshot تازه «محاسبه» را بزنید.</span>
            </div>
          ) : null}
          {dirty ? <InfoBox>با تغییر ورودی‌ها، وضعیت اجرا به پیش‌نویس برمی‌گردد؛ بازبینی یا تأیید تا محاسبهٔ دوباره در دسترس نیست.</InfoBox> : null}
        </div>
      ) : hiddenMessage ? <InfoBox>{hiddenMessage}</InfoBox> : null}

      {canManage && NEXT[run.status].length > 0 ? (
        <div className="mt-4 flex flex-wrap items-end gap-2">
          {run.status === "posted" ? (
            <>
              <Field label="روش پرداخت">
                <select
                  className={inputClass}
                  value={payMethod}
                  onChange={(e) => {
                    const nextMethod = e.target.value as "bank" | "cash";
                    setPayMethod(nextMethod);
                    if (!paymentAccounts.some((account) => account.id === paymentAccountId && (nextMethod === "bank" ? account.role === "bank" : account.role !== "bank"))) {
                      setPaymentAccountId("");
                    }
                  }}
                >
                  <option value="bank">بانک</option>
                  <option value="cash">صندوق / تنخواه</option>
                </select>
              </Field>
              <Field label="حساب پرداخت" as="div">
                <SearchableSelect
                  value={paymentAccountId}
                  onChange={setPaymentAccountId}
                  options={payAccountOptions}
                  loading={payoutLoading}
                  disabled={payoutLoading}
                  ariaLabel="حساب پرداخت اجرای حقوق"
                  placeholder="حساب پرداخت را انتخاب کنید"
                />
              </Field>
              <Field label="تاریخ پرداخت" as="div" hint="خالی یعنی تاریخ امروزِ کسب‌وکار.">
                <JalaliDatePicker value={paidDate} onChange={setPaidDate} ariaLabel="تاریخ پرداخت اجرای حقوق" clearable />
              </Field>
            </>
          ) : null}
          {NEXT[run.status].map((action) => {
            const disabledByDirty = dirty && action !== "calculate" && action !== "cancel";
            return action === "cancel" ? (
              <SecondaryButton key={action} onClick={() => void act(action)} disabled={pending}>{ACTION_LABEL[action]}</SecondaryButton>
            ) : (
              <Button key={action} type="button" onClick={() => void act(action)} disabled={pending || disabledByDirty || (action === "pay" && payoutLoading)}>
                {ACTION_LABEL[action]}
              </Button>
            );
          })}
        </div>
      ) : null}

      {slips.length > 0 ? (
        <div className="mt-4">
          <DataTable caption="فیش‌های حقوقی این اجرا">
            <DataTableHead>
              <Th>کارمند</Th>
              <Th numeric>روز کارکرد</Th>
              <Th numeric>اضافه‌کاری</Th>
              <Th numeric>مرخصی</Th>
              <Th numeric>ناخالص</Th>
              <Th numeric>بیمه سهم کارمند</Th>
              <Th numeric>مالیات</Th>
              <Th numeric>کسورات</Th>
              <Th numeric>خالص / بدهی</Th>
            </DataTableHead>
            <DataTableBody>
              {slips.map((slip) => (
                <DataTableRow key={slip.id}>
                  <Td>{slip.employeeName}</Td>
                  <Td numeric>{toPersianDigits(slip.workedDays)}</Td>
                  <Td numeric>{slip.overtimeHours ? quantityText(slip.overtimeHours) : "—"}</Td>
                  <Td numeric>{slip.unpaidLeaveDays ? quantityText(slip.unpaidLeaveDays) : "—"}</Td>
                  <Td numeric>{money.formatText(slip.gross)}</Td>
                  <Td numeric>{money.formatText(slip.employeeInsurance)}</Td>
                  <Td numeric>{money.formatText(slip.incomeTax)}</Td>
                  <Td numeric>{money.formatText(slip.totalDeductions)}</Td>
                  <Td numeric>
                    {slip.employeeDebt !== "0" ? <StatusBadge tone="danger">بدهی {money.formatText(slip.employeeDebt)}</StatusBadge> : money.formatText(slip.netPay)}
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
