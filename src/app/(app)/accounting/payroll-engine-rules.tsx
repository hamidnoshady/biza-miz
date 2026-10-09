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
import { api, ErrorBox, Field, inputClass, SecondaryButton } from "@/app/dashboard/ui";
import { Button } from "@/components/ui/button";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
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

export function PayrollEngineRules({ canManage }: { canManage: boolean }) {
  const [reload, setReload] = useState(0);
  const rules = useEngineData<{ ruleSets: PayrollRuleSetVersion[]; template: PayrollRuleSet }>("/api/ledger/payroll/engine/rule-sets", reload);
  const components = useEngineData<{ components: PayrollComponent[] }>("/api/ledger/payroll/engine/components", reload);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);

  async function toggle(c: PayrollComponent, patch: Partial<Pick<PayrollComponent, "taxable" | "insurable" | "isActive">>) {
    setError("");
    const res = await api<{ error?: string }>(`/api/ledger/payroll/engine/components/${c.id}`, { method: "PATCH", body: JSON.stringify(patch) });
    if (!res.ok) return setError(payrollError(res.data.error));
    setReload((n) => n + 1);
  }

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
              <DataTableRow>
                <Th numeric>نسخه</Th>
                <Th>عنوان</Th>
                <Th>از تاریخ</Th>
                <Th>بیمه کارمند / کارفرما / بیکاری</Th>
                <Th numeric>سقف بیمه</Th>
                <Th numeric>معافیت مالیاتی</Th>
              </DataTableRow>
            </DataTableHead>
            <DataTableBody>
              {versions.map((v) => (
                <RuleRow key={v.id} v={v} />
              ))}
            </DataTableBody>
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

      <SectionCard title="اجزای حقوق" description="اجزای قانونی (پایه، اضافه‌کاری، بیمه، مالیات، مساعده) قفل‌اند؛ مشمول بیمه و مالیات بودنِ بقیه را اینجا تعیین کنید." flush>
        <DataTable caption="اجزای حقوق" frame={false}>
          <DataTableHead>
            <DataTableRow>
              <Th>کد</Th>
              <Th>عنوان</Th>
              <Th>نوع</Th>
              <Th>مشمول مالیات</Th>
              <Th>مشمول بیمه</Th>
              <Th>حساب‌ها</Th>
              <Th>وضعیت</Th>
            </DataTableRow>
          </DataTableHead>
          <DataTableBody>
            {(components.data?.components ?? []).map((c) => (
              <DataTableRow key={c.id}>
                <Td nowrap>{c.code}</Td>
                <Td>{c.name}</Td>
                <Td nowrap>{KIND_LABEL[c.kind]}</Td>
                {(["taxable", "insurable"] as const).map((k) => (
                  <Td key={k}>
                    <input
                      type="checkbox"
                      aria-label={`${k === "taxable" ? "مشمول مالیات" : "مشمول بیمه"} ${c.name}`}
                      checked={c[k]}
                      disabled={!canManage || !!c.systemKey || c.kind !== "earning"}
                      onChange={(e) => void toggle(c, { [k]: e.target.checked })}
                    />
                  </Td>
                ))}
                <Td nowrap muted>
                  {toPersianDigits(`${c.debitAccountCode ?? "—"} / ${c.creditAccountCode ?? "—"}`)}
                </Td>
                <Td>
                  <StatusBadge tone={c.isActive ? "active" : "neutral"}>{c.isActive ? "فعال" : "غیرفعال"}</StatusBadge>
                </Td>
              </DataTableRow>
            ))}
          </DataTableBody>
        </DataTable>
      </SectionCard>
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
