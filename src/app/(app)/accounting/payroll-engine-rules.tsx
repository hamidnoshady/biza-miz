"use client";

/**
 * #865 rules and components. Rule sets are versioned and append-only: a change
 * is a new version from a date, and every run keeps the version it was
 * calculated with. The statutory percentages are prefilled; the insurance
 * ceiling, the tax exemption and the brackets are entered by the business from
 * the year's official circular.
 */
import { useState } from "react";
import { DataTable, DataTableBody, DataTableHead, DataTableRow, Td, Th } from "@/app/dashboard/data-table";
import { JalaliDatePicker } from "@/app/dashboard/jalali-date-picker";
import { EmptyState, SectionCard, SectionCardSkeleton, StatusBadge } from "@/app/dashboard/page-chrome";
import { api, ErrorBox, Field, InfoBox, inputClass, SecondaryButton } from "@/app/dashboard/ui";
import { Button } from "@/components/ui/button";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { useMoney } from "@/components/money/money-context";
import { toPersianDigits } from "@/lib/digits";
import type { PayrollRuleSet } from "@/lib/payroll-engine-calc";
import { payrollError } from "./payroll-error";
import { shamsi, useEngineData, type PayrollComponent, type PayrollRuleSetVersion } from "./payroll-engine-shared";

const KIND_LABEL: Record<PayrollComponent["kind"], string> = {
  earning: "مزایا",
  deduction: "کسور",
  employer_contribution: "سهم کارفرما",
};

const PERCENT_FIELDS = [
  ["employeeInsurancePercent", "بیمه سهم کارمند (٪)"],
  ["employerInsurancePercent", "بیمه سهم کارفرما (٪)"],
  ["unemploymentInsurancePercent", "بیمه بیکاری (٪)"],
  ["overtimeFactorPercent", "ضریب اضافه‌کاری (٪)"],
  ["monthDays", "روزهای ماه"],
  ["monthlyHours", "ساعت کار ماهانه"],
] as const;

interface ComponentAccount {
  id: string;
  code: string;
  name: string;
  type: "asset" | "liability" | "equity" | "revenue" | "expense";
}

const ACCOUNT_TYPE_LABEL: Record<ComponentAccount["type"], string> = {
  asset: "دارایی",
  liability: "بدهی",
  equity: "سرمایه",
  revenue: "درآمد",
  expense: "هزینه",
};

export function PayrollEngineRules({ canManage }: { canManage: boolean }) {
  const [reload, setReload] = useState(0);
  const rules = useEngineData<{ ruleSets: PayrollRuleSetVersion[]; template: PayrollRuleSet }>("/api/ledger/payroll/engine/rule-sets", reload);
  const components = useEngineData<{ components: PayrollComponent[]; accounts: ComponentAccount[] }>("/api/ledger/payroll/engine/components", reload);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [editingComponent, setEditingComponent] = useState<PayrollComponent | null>(null);
  const [creatingComponent, setCreatingComponent] = useState(false);
  const [historyComponent, setHistoryComponent] = useState<string | null>(null);

  if ((rules.loading && !rules.data) || (components.loading && !components.data)) return <SectionCardSkeleton rows={6} label="در حال بارگذاری قوانین" />;
  const versions = rules.data?.ruleSets ?? [];
  const latest = versions[0]?.rules ?? rules.data?.template;
  return (
    <div className="space-y-4">
      <ErrorBox>{error || rules.error || components.error}</ErrorBox>
      <SectionCard
        title="نسخه‌های قوانین حقوق"
        description="هر تغییر، نسخهٔ تازه‌ای از یک تاریخ است؛ اجراهای قبلی نسخهٔ خودشان را نگه می‌دارند."
        actions={canManage && !creating ? <SecondaryButton onClick={() => setCreating(true)}>نسخهٔ جدید</SecondaryButton> : null}
      >
        {versions.length === 0 ? (
          <EmptyState title="هنوز قانونی ثبت نشده است">پیش از اولین محاسبه، نسخهٔ قوانین سال را وارد کنید.</EmptyState>
        ) : (
          <DataTable caption="نسخه‌های قوانین حقوق">
            <DataTableHead>
              <Th numeric>نسخه</Th><Th>عنوان</Th><Th>از تاریخ</Th><Th>بیمه کارمند / کارفرما / بیکاری</Th><Th numeric>سقف بیمه</Th><Th numeric>معافیت مالیاتی</Th>
            </DataTableHead>
            <DataTableBody>{versions.map((version) => <RuleRow key={version.id} v={version} />)}</DataTableBody>
          </DataTable>
        )}
        {creating && latest ? (
          <RuleSetForm
            start={latest}
            onCancel={() => setCreating(false)}
            onSaved={() => {
              setCreating(false);
              setReload((n) => n + 1);
            }}
          />
        ) : null}
      </SectionCard>

      <SectionCard
        title="اجزای حقوق"
        description="اجزای قانونی با کلید سیستمی، نوع، رفتار مالیاتی/بیمه‌ای و بازهٔ اعتبار قفل‌اند. اجزای سازمانی را اینجا بسازید و نگاشت حساب دفتر را ثبت کنید."
        actions={canManage && !creatingComponent ? <SecondaryButton onClick={() => setCreatingComponent(true)}>جزء تازه</SecondaryButton> : null}
        flush
      >
        <DataTable caption="اجزای حقوق" frame={false}>
          <DataTableHead>
            <Th>کد</Th><Th>عنوان</Th><Th>نوع</Th><Th>مالیات</Th><Th>بیمه</Th><Th>حساب بدهکار / بستانکار</Th><Th>اعتبار</Th><Th>وضعیت / عملیات</Th>
          </DataTableHead>
          <DataTableBody>
            {(components.data?.components ?? []).map((component) => (
              <DataTableRow key={component.id}>
                <Td nowrap>{component.code}</Td>
                <Td>{component.name}{component.systemKey ? <div className="text-xs text-muted-foreground">جزء سیستمی</div> : null}</Td>
                <Td nowrap>{KIND_LABEL[component.kind]}</Td>
                <Td>{component.taxable ? "مشمول" : "معاف"}</Td>
                <Td>{component.insurable ? "مشمول" : "غیرمشمول"}</Td>
                <Td nowrap muted>{toPersianDigits(`${component.debitAccountCode} / ${component.creditAccountCode}`)}</Td>
                <Td nowrap>{shamsi(component.effectiveFrom)}{component.effectiveTo ? ` تا ${shamsi(component.effectiveTo)}` : " به بعد"}</Td>
                <Td>
                  <div className="flex flex-wrap items-center gap-1">
                    <StatusBadge tone={component.isActive ? "active" : "neutral"}>{component.isActive ? "فعال" : "غیرفعال"}</StatusBadge>
                    {canManage ? <SecondaryButton onClick={() => { setEditingComponent(component); setCreatingComponent(false); }}>ویرایش</SecondaryButton> : null}
                    <SecondaryButton onClick={() => setHistoryComponent(historyComponent === component.id ? null : component.id)}>
                      {historyComponent === component.id ? "بستن سابقه" : "سابقه"}
                    </SecondaryButton>
                  </div>
                </Td>
              </DataTableRow>
            ))}
          </DataTableBody>
        </DataTable>
        {creatingComponent ? (
          <ComponentEditor
            key="new-component"
            accounts={components.data?.accounts ?? []}
            onCancel={() => setCreatingComponent(false)}
            onSaved={() => { setCreatingComponent(false); setReload((n) => n + 1); }}
          />
        ) : null}
        {editingComponent ? (
          <ComponentEditor
            key={editingComponent.id}
            component={editingComponent}
            accounts={components.data?.accounts ?? []}
            onCancel={() => setEditingComponent(null)}
            onSaved={() => { setEditingComponent(null); setReload((n) => n + 1); }}
          />
        ) : null}
        {historyComponent ? <ComponentAudit key={historyComponent} componentId={historyComponent} /> : null}
      </SectionCard>
    </div>
  );
}

function ComponentEditor({
  component,
  accounts,
  onCancel,
  onSaved,
}: {
  component?: PayrollComponent;
  accounts: ComponentAccount[];
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [code, setCode] = useState(component?.code ?? "");
  const [name, setName] = useState(component?.name ?? "");
  const [kind, setKind] = useState<PayrollComponent["kind"]>(component?.kind ?? "earning");
  const [taxable, setTaxable] = useState(component?.taxable ?? true);
  const [insurable, setInsurable] = useState(component?.insurable ?? false);
  const [debit, setDebit] = useState(component?.debitAccountCode ?? accounts.find((account) => account.code === "5200")?.code ?? accounts[0]?.code ?? "");
  const [credit, setCredit] = useState(component?.creditAccountCode ?? accounts.find((account) => account.code === "2300")?.code ?? accounts[0]?.code ?? "");
  const [effectiveFrom, setEffectiveFrom] = useState(component?.effectiveFrom ?? "");
  const [effectiveTo, setEffectiveTo] = useState(component?.effectiveTo ?? "");
  const [isActive, setIsActive] = useState(component?.isActive ?? true);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const systemLocked = !!component?.systemKey;
  const accountOptions = accounts.map((account) => ({
    value: account.code,
    label: `${account.code} — ${account.name} · ${ACCOUNT_TYPE_LABEL[account.type]}`,
  }));

  async function save() {
    setPending(true);
    setError("");
    const body = { code: code.trim().toUpperCase(), name: name.trim(), kind, taxable, insurable, debitAccountCode: debit, creditAccountCode: credit, effectiveFrom, effectiveTo: effectiveTo || null, isActive };
    const res = await api<{ error?: string }>(
      component ? `/api/ledger/payroll/engine/components/${component.id}` : "/api/ledger/payroll/engine/components",
      { method: component ? "PATCH" : "POST", body: JSON.stringify(body) },
    );
    setPending(false);
    if (!res.ok) return setError(payrollError(res.data.error));
    onSaved();
  }

  return (
    <div className="mt-4 space-y-3 border-t border-border pt-4">
      <h3 className="text-sm font-semibold">{component ? `ویرایش جزء ${component.name}` : "ایجاد جزء سازمانی"}</h3>
      {systemLocked ? <InfoBox>این جزء سیستمی است؛ نوع، مشمولیت قانونی و تاریخ اعتبار قفل‌اند. نگاشت دفتر و عنوان با سابقهٔ تغییر ذخیره می‌شوند.</InfoBox> : null}
      <ErrorBox>{error}</ErrorBox>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="کد جزء حقوق">
          <input className={inputClass} maxLength={32} value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="مثلاً MEAL" />
        </Field>
        <Field label="عنوان">
          <input className={inputClass} maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="نوع جزء">
          <select className={inputClass} value={kind} disabled={systemLocked} onChange={(e) => setKind(e.target.value as PayrollComponent["kind"])}>
            <option value="earning">مزایا / درآمد</option>
            <option value="deduction">کسور</option>
          </select>
        </Field>
        <Field label="از تاریخ اعتبار" as="div">
          <JalaliDatePicker value={effectiveFrom} onChange={setEffectiveFrom} ariaLabel="شروع اعتبار جزء حقوق" disabled={systemLocked} />
        </Field>
        <Field label="تا تاریخ اعتبار" as="div">
          <JalaliDatePicker value={effectiveTo} onChange={setEffectiveTo} ariaLabel="پایان اعتبار جزء حقوق" clearable disabled={systemLocked} />
        </Field>
        <Field label="حساب بدهکار" as="div">
          <SearchableSelect value={debit} onChange={setDebit} options={accountOptions} ariaLabel="حساب بدهکار جزء حقوق" placeholder="حساب بدهکار" />
        </Field>
        <Field label="حساب بستانکار" as="div">
          <SearchableSelect value={credit} onChange={setCredit} options={accountOptions} ariaLabel="حساب بستانکار جزء حقوق" placeholder="حساب بستانکار" />
        </Field>
        <div className="flex flex-col justify-end gap-2 text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={taxable} disabled={systemLocked} onChange={(e) => setTaxable(e.target.checked)} /> مشمول مالیات
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={insurable} disabled={systemLocked} onChange={(e) => setInsurable(e.target.checked)} /> مشمول بیمه
          </label>
          {!systemLocked ? (
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} /> فعال
            </label>
          ) : null}
        </div>
      </div>
      <div className="flex gap-2">
        <Button type="button" onClick={() => void save()} disabled={pending || !code.trim() || !name.trim() || !debit || !credit || !effectiveFrom}>
          ذخیره جزء
        </Button>
        <SecondaryButton onClick={onCancel}>انصراف</SecondaryButton>
      </div>
    </div>
  );
}

interface ComponentChange {
  before: PayrollComponent | null;
  after: PayrollComponent;
  changedByName: string | null;
  changedAt: string;
}

function ComponentAudit({ componentId }: { componentId: string }) {
  const history = useEngineData<{ changes: ComponentChange[] }>(`/api/ledger/payroll/engine/components/${componentId}`);
  if (history.loading && !history.data) return <SectionCardSkeleton rows={2} label="در حال بارگذاری سابقهٔ جزء" />;
  const changes = history.data?.changes ?? [];
  return (
    <div className="mt-3 rounded-xl border border-border p-3">
      <ErrorBox>{history.error}</ErrorBox>
      {changes.length === 0 ? <p className="text-sm text-muted-foreground">سابقه‌ای برای این جزء ثبت نشده است.</p> : (
        <DataTable caption="تاریخچهٔ تغییر اجزای حقوق">
          <DataTableHead><Th>قبل</Th><Th>بعد</Th><Th>عامل</Th><Th>زمان</Th></DataTableHead>
          <DataTableBody>
            {changes.map((change, index) => (
              <DataTableRow key={`${change.changedAt}-${index}`}>
                <Td>{change.before ? `${change.before.code} · ${change.before.debitAccountCode}/${change.before.creditAccountCode}` : "ایجاد"}</Td>
                <Td>{change.after.code} · {change.after.taxable ? "مشمول مالیات" : "معاف"} / {change.after.insurable ? "مشمول بیمه" : "غیرمشمول"} · {toPersianDigits(`${change.after.debitAccountCode}/${change.after.creditAccountCode}`)}</Td>
                <Td>{change.changedByName ?? "کاربر حذف‌شده"}</Td>
                <Td nowrap>{shamsi(change.changedAt)}</Td>
              </DataTableRow>
            ))}
          </DataTableBody>
        </DataTable>
      )}
    </div>
  );
}

function RuleRow({ v }: { v: PayrollRuleSetVersion }) {
  const money = useMoney();
  const r = v.rules;
  return (
    <DataTableRow>
      <Td numeric>{toPersianDigits(v.version)}</Td>
      <Td>{v.title}</Td>
      <Td nowrap>{shamsi(v.effectiveFrom)}</Td>
      <Td nowrap>{toPersianDigits(`${r.employeeInsurancePercent}٪ / ${r.employerInsurancePercent}٪ / ${r.unemploymentInsurancePercent}٪`)}</Td>
      <Td numeric>{r.insuranceCeilingRial === null ? "بدون سقف" : money.format(r.insuranceCeilingRial)}</Td>
      <Td numeric>{money.format(r.taxExemptMonthlyRial)}</Td>
    </DataTableRow>
  );
}

interface BracketDraft {
  upTo: string;
  rate: string;
}

function RuleSetForm({ start, onCancel, onSaved }: { start: PayrollRuleSet; onCancel: () => void; onSaved: () => void }) {
  const money = useMoney();
  const [title, setTitle] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState("");
  const [nums, setNums] = useState<Record<string, string>>(() => Object.fromEntries(PERCENT_FIELDS.map(([k]) => [k, String(start[k])])));
  const [ceiling, setCeiling] = useState(start.insuranceCeilingRial === null ? "" : money.toInputText(String(start.insuranceCeilingRial)));
  const [exemption, setExemption] = useState(money.toInputText(String(start.taxExemptMonthlyRial)));
  const [brackets, setBrackets] = useState<BracketDraft[]>(
    start.taxBrackets.map((b) => ({ upTo: b.upToRial === null ? "" : money.toInputText(String(b.upToRial)), rate: String(b.ratePercent) })),
  );
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function save() {
    setPending(true);
    setError("");
    const rules = {
      ...start,
      ...Object.fromEntries(PERCENT_FIELDS.map(([k]) => [k, Number(nums[k])])),
      insuranceCeilingRial: ceiling.trim() === "" ? null : Number(money.parseText(ceiling)),
      taxExemptMonthlyRial: Number(money.parseText(exemption || "0")),
      taxBrackets: brackets.map((b, i) => ({
        upToRial: i === brackets.length - 1 || b.upTo.trim() === "" ? null : Number(money.parseText(b.upTo)),
        ratePercent: Number(b.rate),
      })),
    };
    const res = await api<{ error?: string }>("/api/ledger/payroll/engine/rule-sets", {
      method: "POST",
      body: JSON.stringify({ title, effectiveFrom, rules }),
    });
    setPending(false);
    if (!res.ok) return setError(payrollError(res.data.error));
    onSaved();
  }

  return (
    <div className="mt-4 space-y-3 border-t border-border pt-4">
      <ErrorBox>{error}</ErrorBox>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="عنوان">
          <input className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="مثلاً قوانین ۱۴۰۵" />
        </Field>
        <Field label="از تاریخ" as="div">
          <JalaliDatePicker value={effectiveFrom} onChange={setEffectiveFrom} ariaLabel="تاریخ شروع اعتبار" />
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {PERCENT_FIELDS.map(([k, label]) => (
          <Field key={k} label={label}>
            <PersianNumberInput className={inputClass} dir="ltr" inputMode="decimal" allowDecimal allowNegative={false} value={nums[k]} onChange={(e) => setNums({ ...nums, [k]: e.target.value })} />
          </Field>
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={`سقف ماهانه حقوق مشمول بیمه (${money.unitLabel})`} hint="خالی یعنی بدون سقف">
          <PersianNumberInput className={inputClass} dir="ltr" inputMode="numeric" allowDecimal={false} allowNegative={false} value={ceiling} onChange={(e) => setCeiling(e.target.value)} />
        </Field>
        <Field label={`معافیت مالیاتی ماهانه (${money.unitLabel})`}>
          <PersianNumberInput className={inputClass} dir="ltr" inputMode="numeric" allowDecimal={false} allowNegative={false} value={exemption} onChange={(e) => setExemption(e.target.value)} />
        </Field>
      </div>
      <div className="space-y-2">
        <h3 className="text-sm font-semibold">پله‌های مالیات (مبالغ ماهانه، صعودی؛ آخرین پله بی‌سقف)</h3>
        {brackets.map((b, i) => (
          <div key={i} className="grid gap-2 sm:grid-cols-[1fr_8rem_auto] sm:items-end">
            <Field label={`تا مبلغ (${money.unitLabel})`}>
              <PersianNumberInput
                className={inputClass}
                dir="ltr"
                inputMode="numeric"
                allowDecimal={false}
                allowNegative={false}
                disabled={i === brackets.length - 1}
                placeholder={i === brackets.length - 1 ? "بی‌سقف" : ""}
                value={i === brackets.length - 1 ? "" : b.upTo}
                onChange={(e) => setBrackets(brackets.map((x, j) => (j === i ? { ...x, upTo: e.target.value } : x)))}
              />
            </Field>
            <Field label="نرخ (٪)">
              <PersianNumberInput className={inputClass} dir="ltr" inputMode="decimal" allowDecimal allowNegative={false} value={b.rate} onChange={(e) => setBrackets(brackets.map((x, j) => (j === i ? { ...x, rate: e.target.value } : x)))} />
            </Field>
            <SecondaryButton onClick={() => setBrackets(brackets.filter((_, j) => j !== i))}>حذف</SecondaryButton>
          </div>
        ))}
        <SecondaryButton onClick={() => setBrackets([...brackets, { upTo: "", rate: "" }])}>افزودن پله</SecondaryButton>
      </div>
      <div className="flex gap-2">
        <Button type="button" onClick={() => void save()} disabled={pending || !title.trim() || !effectiveFrom}>
          ثبت نسخه
        </Button>
        <SecondaryButton onClick={onCancel}>انصراف</SecondaryButton>
      </div>
    </div>
  );
}
