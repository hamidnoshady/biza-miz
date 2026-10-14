"use client";

/**
 * #865 employee payroll files: canonical team identity, contract/personnel
 * fields, statutory insurance and tax inputs, payment destination, recurring
 * items and their audit trail, plus dimensioned cost allocation.
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
import { payrollError } from "./payroll-error";
import {
  shamsi,
  useEngineData,
  type PayrollComponent,
  type PayrollPaymentAccount,
  type PayrollProfile,
  type PayrollRecurringItem,
} from "./payroll-engine-shared";

interface Option {
  id: string;
  name: string;
}

interface ShareDraft {
  percent: string;
  locationId: string;
  projectId: string;
  label: string;
}

interface ProfileDetail {
  profile: PayrollProfile;
  items: PayrollRecurringItem[];
  changes: ProfileChange[];
}

interface ProfileChange {
  before: unknown;
  after: unknown;
  changedByName: string | null;
  changedAt: string;
}

interface ItemChange {
  before: PayrollRecurringItem | null;
  after: PayrollRecurringItem;
  changedBy: string | null;
  changedByName: string | null;
  changedAt: string;
}

const EMPLOYMENT_LABEL: Record<PayrollProfile["employmentType"], string> = {
  full_time: "تمام‌وقت",
  part_time: "پاره‌وقت",
  contract: "قراردادی",
  hourly: "ساعتی",
  intern: "کارآموز",
};

const ITEM_KIND_LABEL: Record<PayrollComponent["kind"], string> = {
  earning: "مزایا",
  deduction: "کسور",
  employer_contribution: "سهم کارفرما",
};

function canEnterAsItem(component: PayrollComponent): boolean {
  return component.kind !== "employer_contribution" && (!component.systemKey || ["bonus", "loan_installment"].includes(component.systemKey));
}

export function PayrollEngineProfiles({ canManage }: { canManage: boolean }) {
  const money = useMoney();
  const [reload, setReload] = useState(0);
  const profiles = useEngineData<{ profiles: PayrollProfile[] }>("/api/ledger/payroll/engine/profiles", reload);
  const [editing, setEditing] = useState<string | null>(null);
  const [itemsFor, setItemsFor] = useState<string | null>(null);
  const list = profiles.data?.profiles ?? [];

  if (profiles.loading && !profiles.data) return <SectionCardSkeleton rows={5} label="در حال بارگذاری پرونده‌ها" />;
  return (
    <div className="space-y-4">
      <ErrorBox>{profiles.error}</ErrorBox>
      {list.length === 0 ? (
        <SectionCard title="پرونده حقوقی کارکنان">
          <EmptyState title="هنوز کارمندی ثبت نشده است">کارکنان را از بخش تیم اضافه کنید.</EmptyState>
        </SectionCard>
      ) : (
        <SectionCard title="پرونده حقوقی کارکنان" flush>
          <DataTable caption="پرونده حقوقی کارکنان" frame={false}>
            <DataTableHead>
              <Th>کارمند / کد پرسنلی</Th>
              <Th>نوع همکاری</Th>
              <Th numeric>حقوق پایه ماهانه</Th>
              <Th>استخدام</Th>
              <Th>بیمه / مالیات</Th>
              <Th>تسهیم هزینه</Th>
              <Th>
                <span className="sr-only">عملیات</span>
              </Th>
            </DataTableHead>
            <DataTableBody>
              {list.map((p) => (
                <DataTableRow key={p.userId}>
                  <Td>
                    <div className="font-medium">{p.fullName}</div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      کد پرسنلی {p.employeeCode ?? "—"} · کد حقوق {p.payrollCode ?? "—"}
                      {!p.configured ? " · بدون پروندهٔ تنظیم‌شده" : ""}
                    </div>
                  </Td>
                  <Td nowrap>{EMPLOYMENT_LABEL[p.employmentType]}</Td>
                  <Td numeric>{money.formatText(p.baseSalary)}</Td>
                  <Td nowrap>
                    {shamsi(p.hireDate)}
                    {p.terminationDate ? ` تا ${shamsi(p.terminationDate)}` : ""}
                  </Td>
                  <Td>
                    <span className="flex flex-wrap gap-1">
                      <StatusBadge tone={p.insuranceProfile.insured ? "active" : "neutral"}>{p.insuranceProfile.insured ? "بیمه‌شده" : "بدون بیمه"}</StatusBadge>
                      {p.taxProfile.exempt ? <StatusBadge tone="neutral">معاف از مالیات</StatusBadge> : null}
                    </span>
                  </Td>
                  <Td>{p.costAllocation.length === 0 ? "—" : toPersianDigits(`${p.costAllocation.length} سهم`)}</Td>
                  <Td>
                    <div className="flex flex-wrap gap-1">
                      <SecondaryButton onClick={() => setItemsFor(itemsFor === p.userId ? null : p.userId)}>
                        {itemsFor === p.userId ? "بستن اقلام" : "مزایا و کسور"}
                      </SecondaryButton>
                      {canManage ? (
                        <SecondaryButton onClick={() => setEditing(editing === p.userId ? null : p.userId)}>
                          {editing === p.userId ? "بستن ویرایش" : "ویرایش پرونده"}
                        </SecondaryButton>
                      ) : null}
                    </div>
                  </Td>
                </DataTableRow>
              ))}
            </DataTableBody>
          </DataTable>
        </SectionCard>
      )}
      {editing ? (
        <ProfileEditor
          key={editing}
          profile={list.find((p) => p.userId === editing)!}
          onSaved={() => {
            setEditing(null);
            setReload((n) => n + 1);
          }}
        />
      ) : null}
      {itemsFor ? (
        <RecurringItemsPanel
          key={itemsFor}
          userId={itemsFor}
          profile={list.find((p) => p.userId === itemsFor)!}
          canManage={canManage}
        />
      ) : null}
    </div>
  );
}

function ProfileEditor({ profile, onSaved }: { profile: PayrollProfile; onSaved: () => void }) {
  const money = useMoney();
  const locations = useEngineData<{ locations: Option[] }>("/api/locations/active");
  const projects = useEngineData<{ projects: Option[] }>("/api/ai/projects");
  const payout = useEngineData<{ paymentAccounts: PayrollPaymentAccount[] }>("/api/ledger/payroll/preview?includeCommission=false");
  const [base, setBase] = useState(money.toInputText(profile.baseSalary));
  const [employeeCode, setEmployeeCode] = useState(profile.employeeCode ?? "");
  const [payrollCode, setPayrollCode] = useState(profile.payrollCode ?? "");
  const [employmentType, setEmploymentType] = useState(profile.employmentType);
  const [hireDate, setHireDate] = useState(profile.hireDate ?? "");
  const [terminationDate, setTerminationDate] = useState(profile.terminationDate ?? "");
  const [insured, setInsured] = useState(profile.insuranceProfile.insured);
  const [insuranceNumber, setInsuranceNumber] = useState(profile.insuranceProfile.insuranceNumber ?? "");
  const [exempt, setExempt] = useState(profile.taxProfile.exempt);
  const [nationalId, setNationalId] = useState(profile.taxProfile.nationalId ?? "");
  const [destinationMethod, setDestinationMethod] = useState(profile.paymentDestination.method);
  const [paymentAccountId, setPaymentAccountId] = useState(profile.paymentDestination.paymentAccountId ?? "");
  const [iban, setIban] = useState(profile.paymentDestination.iban ?? "");
  const [cardNumber, setCardNumber] = useState(profile.paymentDestination.cardNumber ?? "");
  const [isActive, setIsActive] = useState(profile.isActive);
  const [shares, setShares] = useState<ShareDraft[]>(
    profile.costAllocation.map((s) => ({ percent: String(s.percent), locationId: s.locationId ?? "", projectId: s.projectId ?? "", label: s.label ?? "" })),
  );
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const total = shares.reduce((s, x) => s + (Number(x.percent) || 0), 0);
  const eligibleAccounts = (payout.data?.paymentAccounts ?? []).filter((account) => destinationMethod === "bank" ? account.role === "bank" : account.role !== "bank");
  const accountOptions = [
    { value: "", label: "حساب پیش‌فرض کسب‌وکار" },
    ...eligibleAccounts.map((account) => ({ value: account.id, label: `${account.code} — ${account.name}` })),
  ];

  async function save() {
    setPending(true);
    setError("");
    let baseSalary: string;
    try {
      baseSalary = money.parseText(base || "0");
    } catch {
      setPending(false);
      setError(payrollError("invalid_amount"));
      return;
    }
    const res = await api<{ error?: string }>(`/api/ledger/payroll/engine/profiles/${profile.userId}`, {
      method: "PUT",
      body: JSON.stringify({
        employeeCode: employeeCode.trim() || null,
        payrollCode: payrollCode.trim() || null,
        employmentType,
        baseSalary,
        hireDate: hireDate || null,
        terminationDate: terminationDate || null,
        insuranceProfile: { insured, insuranceNumber: insuranceNumber.trim() || null },
        taxProfile: { exempt, nationalId: nationalId.trim() || null },
        paymentDestination: {
          method: destinationMethod,
          paymentAccountId: paymentAccountId || null,
          iban: iban.trim() || null,
          cardNumber: cardNumber.trim() || null,
        },
        isActive,
        costAllocation: shares.map((s) => ({
          percent: Number(s.percent),
          locationId: s.locationId || null,
          projectId: s.projectId || null,
          label: s.label || null,
        })),
      }),
    });
    setPending(false);
    if (!res.ok) return setError(payrollError(res.data.error));
    onSaved();
  }

  const update = (i: number, patch: Partial<ShareDraft>) => setShares((current) => current.map((s, j) => (j === i ? { ...s, ...patch } : s)));

  return (
    <SectionCard title={`پرونده حقوقی ${profile.fullName}`} description="کد پرسنلی روی پروندهٔ مشترک کارکنان ذخیره می‌شود؛ کد حقوق، نوع همکاری و اطلاعات قانونی هم در همین پرونده تنظیم می‌شوند.">
      <ErrorBox>{error || locations.error || projects.error || payout.error}</ErrorBox>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="کد پرسنلی">
          <input className={inputClass} maxLength={40} value={employeeCode} onChange={(e) => setEmployeeCode(e.target.value)} />
        </Field>
        <Field label="کد حقوق">
          <input className={inputClass} maxLength={40} value={payrollCode} onChange={(e) => setPayrollCode(e.target.value)} />
        </Field>
        <Field label="نوع همکاری">
          <select className={inputClass} value={employmentType} onChange={(e) => setEmploymentType(e.target.value as PayrollProfile["employmentType"])}>
            {Object.entries(EMPLOYMENT_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </Field>
        <Field label={`حقوق پایه ماهانه (${money.unitLabel})`}>
          <PersianNumberInput className={inputClass} dir="ltr" inputMode="numeric" allowDecimal={false} allowNegative={false} value={base} onChange={(e) => setBase(e.target.value)} />
        </Field>
        <Field label="تاریخ استخدام" as="div">
          <JalaliDatePicker value={hireDate} onChange={setHireDate} ariaLabel="تاریخ استخدام" clearable />
        </Field>
        <Field label="تاریخ پایان همکاری" as="div">
          <JalaliDatePicker value={terminationDate} onChange={setTerminationDate} ariaLabel="تاریخ پایان همکاری" clearable />
        </Field>
        <div className="flex flex-col justify-end gap-2 text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} /> فعال در محاسبهٔ حقوق
          </label>
        </div>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div className="space-y-2 rounded-xl border border-border p-3">
          <label className="flex items-center gap-2 text-sm font-medium">
            <input type="checkbox" checked={insured} onChange={(e) => setInsured(e.target.checked)} /> مشمول بیمه
          </label>
          <Field label="شمارهٔ بیمه" hint={insured ? "برای فرد بیمه‌شده الزامی است." : "برای فرد بدون بیمه اختیاری است."}>
            <input className={inputClass} dir="ltr" inputMode="numeric" maxLength={24} value={insuranceNumber} onChange={(e) => setInsuranceNumber(e.target.value)} />
          </Field>
        </div>
        <div className="space-y-2 rounded-xl border border-border p-3">
          <label className="flex items-center gap-2 text-sm font-medium">
            <input type="checkbox" checked={exempt} onChange={(e) => setExempt(e.target.checked)} /> معاف از مالیات حقوق
          </label>
          <Field label="کد ملی مالیاتی" hint={exempt ? "در صورت معافیت اختیاری است." : "کد ملی معتبر برای محاسبهٔ مالیات لازم است."}>
            <input className={inputClass} dir="ltr" inputMode="numeric" maxLength={10} value={nationalId} onChange={(e) => setNationalId(e.target.value)} />
          </Field>
        </div>
        <div className="space-y-2 rounded-xl border border-border p-3">
          <Field label="مقصد دریافتی کارمند">
            <select className={inputClass} value={destinationMethod} onChange={(e) => setDestinationMethod(e.target.value as "bank" | "cash")}>
              <option value="bank">واریز بانکی</option>
              <option value="cash">دریافت نقدی</option>
            </select>
          </Field>
          <Field label="حساب پرداخت کسب‌وکار" hint="این فهرست فقط حساب‌های فعال و قابل پرداختِ همین کسب‌وکار را نشان می‌دهد." as="div">
            <SearchableSelect
              value={paymentAccountId}
              onChange={setPaymentAccountId}
              options={accountOptions}
              loading={payout.loading}
              disabled={payout.loading}
              ariaLabel="حساب پرداخت کسب‌وکار"
              placeholder="حساب را انتخاب کنید"
            />
          </Field>
          {destinationMethod === "bank" ? (
            <>
              <Field label="شمارهٔ شبا" hint="برای مقصد بانکی الزامی است.">
                <input className={inputClass} dir="ltr" inputMode="text" maxLength={34} value={iban} onChange={(e) => setIban(e.target.value)} placeholder="IR…" />
              </Field>
              <Field label="شمارهٔ کارت (اختیاری)">
                <input className={inputClass} dir="ltr" inputMode="numeric" maxLength={24} value={cardNumber} onChange={(e) => setCardNumber(e.target.value)} />
              </Field>
            </>
          ) : null}
        </div>
      </div>

      <div className="mt-4 space-y-2">
        <h3 className="text-sm font-semibold">تسهیم هزینه حقوق</h3>
        <InfoBox>هر سهم، سند جداگانه‌ای با شعبه و پروژهٔ خودش در دفتر می‌گیرد. بدون سهم، کل هزینه بدون بُعد ثبت می‌شود.</InfoBox>
        {shares.map((s, i) => (
          <div key={i} className="grid gap-2 sm:grid-cols-[6rem_1fr_1fr_1fr_auto] sm:items-end">
            <Field label="درصد">
              <PersianNumberInput className={inputClass} dir="ltr" inputMode="decimal" allowDecimal allowNegative={false} value={s.percent} onChange={(e) => update(i, { percent: e.target.value })} />
            </Field>
            <Field label="شعبه">
              <select className={inputClass} value={s.locationId} onChange={(e) => update(i, { locationId: e.target.value })}>
                <option value="">—</option>
                {(locations.data?.locations ?? []).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </Field>
            <Field label="پروژه">
              <select className={inputClass} value={s.projectId} onChange={(e) => update(i, { projectId: e.target.value })}>
                <option value="">—</option>
                {(projects.data?.projects ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </Field>
            <Field label="توضیح">
              <input className={inputClass} value={s.label} onChange={(e) => update(i, { label: e.target.value })} />
            </Field>
            <SecondaryButton onClick={() => setShares((current) => current.filter((_, j) => j !== i))}>حذف</SecondaryButton>
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-3">
          <SecondaryButton onClick={() => setShares((current) => [...current, { percent: current.length === 0 ? "100" : "", locationId: "", projectId: "", label: "" }])}>
            افزودن سهم
          </SecondaryButton>
          {shares.length > 0 ? (
            <span className={total === 100 ? "text-sm text-muted-foreground" : "text-sm text-destructive"}>
              جمع: {toPersianDigits(Math.round(total * 100) / 100)}٪
            </span>
          ) : null}
        </div>
      </div>
      <div className="mt-4">
        <Button type="button" onClick={() => void save()} disabled={pending || (shares.length > 0 && Math.abs(total - 100) > 1e-9)}>
          ذخیره پرونده
        </Button>
      </div>
    </SectionCard>
  );
}

function RecurringItemsPanel({ userId, profile, canManage }: { userId: string; profile: PayrollProfile; canManage: boolean }) {
  const money = useMoney();
  const [reload, setReload] = useState(0);
  const detail = useEngineData<ProfileDetail>(`/api/ledger/payroll/engine/profiles/${userId}`, reload);
  const components = useEngineData<{ components: PayrollComponent[] }>(canManage ? "/api/ledger/payroll/engine/components" : null);
  const [componentId, setComponentId] = useState("");
  const [amount, setAmount] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState("");
  const [effectiveTo, setEffectiveTo] = useState("");
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [endingItem, setEndingItem] = useState<string | null>(null);
  const [endDate, setEndDate] = useState("");
  const [historyItem, setHistoryItem] = useState<string | null>(null);
  const items = detail.data?.items ?? [];
  const choices = (components.data?.components ?? []).filter((component) => component.isActive && canEnterAsItem(component));
  const selectedComponentId = componentId || choices[0]?.id || "";

  async function add() {
    setPending(true);
    setError("");
    let rial: string;
    try {
      rial = money.parseText(amount);
    } catch {
      setPending(false);
      setError(payrollError("invalid_amount"));
      return;
    }
    const res = await api<{ error?: string }>("/api/ledger/payroll/engine/items", {
      method: "POST",
      body: JSON.stringify({
        userId,
        componentId: selectedComponentId,
        amount: rial,
        effectiveFrom,
        effectiveTo: effectiveTo || null,
        note: note.trim() || null,
      }),
    });
    setPending(false);
    if (!res.ok) return setError(payrollError(res.data.error));
    setAmount("");
    setEffectiveFrom("");
    setEffectiveTo("");
    setNote("");
    setReload((n) => n + 1);
  }

  async function end(itemId: string) {
    if (!endDate) return setError(payrollError("invalid_effective_date"));
    setPending(true);
    setError("");
    const res = await api<{ error?: string }>(`/api/ledger/payroll/engine/items/${itemId}`, {
      method: "PATCH",
      body: JSON.stringify({ effectiveTo: endDate }),
    });
    setPending(false);
    if (!res.ok) return setError(payrollError(res.data.error));
    setEndingItem(null);
    setEndDate("");
    setReload((n) => n + 1);
  }

  if (detail.loading && !detail.data) return <SectionCardSkeleton rows={4} label="در حال بارگذاری مزایا و کسور" />;
  return (
    <SectionCard title={`مزایا، کسور و سوابق ${profile.fullName}`} description="اقلام تکرارشونده با تاریخ اعتبار ثبت می‌شوند و پس از پایان، حذف نخواهند شد." flush>
      <ErrorBox>{error || detail.error || components.error}</ErrorBox>
      {items.length === 0 ? (
        <EmptyState title="قلم تکرارشونده‌ای ثبت نشده است">برای کمک‌هزینه، قسط وام یا مزایای ثابت، قلم تازه اضافه کنید.</EmptyState>
      ) : (
        <DataTable caption="اقلام تکرارشوندهٔ حقوق">
          <DataTableHead>
            <Th>قلم</Th>
            <Th>نوع</Th>
            <Th numeric>مبلغ ماهانه</Th>
            <Th>اعتبار</Th>
            <Th>توضیح</Th>
            <Th>
              <span className="sr-only">عملیات</span>
            </Th>
          </DataTableHead>
          <DataTableBody>
            {items.map((item) => (
              <DataTableRow key={item.id}>
                <Td>{item.componentName}<div className="text-xs text-muted-foreground">{item.componentCode}</div></Td>
                <Td nowrap>{ITEM_KIND_LABEL[item.kind]}</Td>
                <Td numeric>{money.formatText(item.amount)}</Td>
                <Td nowrap>{shamsi(item.effectiveFrom)}{item.effectiveTo ? ` تا ${shamsi(item.effectiveTo)}` : " به بعد"}</Td>
                <Td>{item.note || "—"}</Td>
                <Td>
                  <div className="flex flex-wrap gap-1">
                    {canManage && !item.endedAt ? (
                      <SecondaryButton onClick={() => { setEndingItem(endingItem === item.id ? null : item.id); setEndDate(""); }}>
                        {endingItem === item.id ? "بستن" : "پایان قلم"}
                      </SecondaryButton>
                    ) : null}
                    <SecondaryButton onClick={() => setHistoryItem(historyItem === item.id ? null : item.id)}>
                      {historyItem === item.id ? "بستن سابقه" : "سابقه"}
                    </SecondaryButton>
                  </div>
                  {endingItem === item.id ? (
                    <div className="mt-2 min-w-48 space-y-2">
                      <JalaliDatePicker value={endDate} onChange={setEndDate} ariaLabel={`تاریخ پایان ${item.componentName}`} />
                      <Button type="button" onClick={() => void end(item.id)} disabled={pending || !endDate}>ثبت پایان</Button>
                    </div>
                  ) : null}
                </Td>
              </DataTableRow>
            ))}
          </DataTableBody>
        </DataTable>
      )}
      {historyItem ? <ItemHistory key={historyItem} itemId={historyItem} /> : null}
      {canManage ? (
        <div className="mt-4 space-y-3 border-t border-border pt-4">
          <h3 className="text-sm font-semibold">افزودن قلم تکرارشونده</h3>
          <InfoBox>اقلام قانونیِ محاسبه‌شده مثل بیمه، مالیات و اضافه‌کاری از این مسیر قابل ثبت نیستند؛ فقط مزایا، کسور و اقلام ورودپذیر انتخاب می‌شوند.</InfoBox>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="نوع قلم" as="div">
              <SearchableSelect
                value={selectedComponentId}
                onChange={setComponentId}
                options={choices.map((component) => ({ value: component.id, label: `${component.code} — ${component.name}` }))}
                loading={components.loading}
                disabled={components.loading || choices.length === 0}
                ariaLabel="نوع قلم تکرارشونده"
              />
            </Field>
            <Field label={`مبلغ ماهانه (${money.unitLabel})`}>
              <PersianNumberInput className={inputClass} dir="ltr" inputMode="numeric" allowDecimal={false} allowNegative={false} value={amount} onChange={(e) => setAmount(e.target.value)} />
            </Field>
            <Field label="از تاریخ" as="div">
              <JalaliDatePicker value={effectiveFrom} onChange={setEffectiveFrom} ariaLabel="شروع اعتبار قلم" />
            </Field>
            <Field label="تا تاریخ" as="div">
              <JalaliDatePicker value={effectiveTo} onChange={setEffectiveTo} ariaLabel="پایان اعتبار قلم" clearable />
            </Field>
            <Field label="یادداشت">
              <input className={inputClass} maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} />
            </Field>
          </div>
          <Button type="button" onClick={() => void add()} disabled={pending || !selectedComponentId || !amount.trim() || !effectiveFrom}>
            افزودن قلم
          </Button>
        </div>
      ) : null}
      {detail.data?.changes.length ? <ProfileHistory changes={detail.data.changes} /> : null}
    </SectionCard>
  );
}

function ItemHistory({ itemId }: { itemId: string }) {
  const money = useMoney();
  const history = useEngineData<{ changes: ItemChange[] }>(`/api/ledger/payroll/engine/items/${itemId}`);
  if (history.loading && !history.data) return <SectionCardSkeleton rows={2} label="در حال بارگذاری سابقهٔ قلم" />;
  const changes = history.data?.changes ?? [];
  return (
    <div className="mt-3 rounded-xl border border-border p-3">
      <ErrorBox>{history.error}</ErrorBox>
      {changes.length === 0 ? <p className="text-sm text-muted-foreground">سابقه‌ای برای این قلم ثبت نشده است.</p> : (
        <DataTable caption="تاریخچهٔ تغییرات قلم">
          <DataTableHead>
            <Th>تغییر</Th>
            <Th>عامل</Th>
            <Th>زمان</Th>
          </DataTableHead>
          <DataTableBody>
            {changes.map((change, index) => (
              <DataTableRow key={`${change.changedAt}-${index}`}>
                <Td>
                  {change.before ? "ویرایش / پایان" : "ایجاد"} · {money.formatText(change.after.amount)} · {shamsi(change.after.effectiveFrom)}{change.after.effectiveTo ? ` تا ${shamsi(change.after.effectiveTo)}` : " به بعد"}
                </Td>
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

function ProfileHistory({ changes }: { changes: ProfileChange[] }) {
  const money = useMoney();
  return (
    <div className="mt-4 border-t border-border pt-4">
      <h3 className="mb-2 text-sm font-semibold">تاریخچهٔ تغییر پرونده</h3>
      <DataTable caption="تاریخچهٔ تغییرات پرونده">
        <DataTableHead>
          <Th>عنوان</Th>
          <Th>عامل</Th>
          <Th>زمان</Th>
        </DataTableHead>
        <DataTableBody>
          {changes.map((change, index) => {
            const after = typeof change.after === "object" && change.after !== null ? change.after as Record<string, unknown> : {};
            return (
              <DataTableRow key={`${change.changedAt}-${index}`}>
                <Td>
                  {typeof after.payrollCode === "string" && after.payrollCode ? `کد حقوق ${after.payrollCode} · ` : ""}
                  {typeof after.baseSalary === "string" ? money.formatText(after.baseSalary) : "پرونده به‌روزرسانی شد"}
                </Td>
                <Td>{change.changedByName ?? "کاربر حذف‌شده"}</Td>
                <Td nowrap>{shamsi(change.changedAt)}</Td>
              </DataTableRow>
            );
          })}
        </DataTableBody>
      </DataTable>
    </div>
  );
}
