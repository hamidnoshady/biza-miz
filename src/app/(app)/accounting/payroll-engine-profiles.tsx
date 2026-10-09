"use client";

/**
 * #865 employee payroll files: contract rate, employment dates (Shamsi), the
 * insurance / tax flags, and the cost allocation across branches and projects
 * that the accrual's journal entries are dimensioned by. The server refuses a
 * branch or project that is not this business's own and active.
 */
import { useState } from "react";
import { DataTable, DataTableBody, DataTableHead, DataTableRow, Td, Th } from "@/app/dashboard/data-table";
import { JalaliDatePicker } from "@/app/dashboard/jalali-date-picker";
import { EmptyState, SectionCard, SectionCardSkeleton, StatusBadge } from "@/app/dashboard/page-chrome";
import { api, ErrorBox, Field, InfoBox, inputClass, SecondaryButton } from "@/app/dashboard/ui";
import { Button } from "@/components/ui/button";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useMoney } from "@/components/money/money-context";
import { toPersianDigits } from "@/lib/digits";
import { payrollError } from "./payroll-error";
import { shamsi, useEngineData, type PayrollProfile } from "./payroll-engine-shared";

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

export function PayrollEngineProfiles({ canManage }: { canManage: boolean }) {
  const money = useMoney();
  const [reload, setReload] = useState(0);
  const profiles = useEngineData<{ profiles: PayrollProfile[] }>("/api/ledger/payroll/engine/profiles", reload);
  const [editing, setEditing] = useState<string | null>(null);
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
              <DataTableRow>
                <Th>کارمند</Th>
                <Th numeric>حقوق پایه ماهانه</Th>
                <Th>استخدام</Th>
                <Th>بیمه / مالیات</Th>
                <Th>تسهیم هزینه</Th>
                <Th>
                  <span className="sr-only">ویرایش</span>
                </Th>
              </DataTableRow>
            </DataTableHead>
            <DataTableBody>
              {list.map((p) => (
                <DataTableRow key={p.userId}>
                  <Td>
                    {p.fullName}
                    {!p.configured ? <span className="ms-2 text-xs text-muted-foreground">(بدون پرونده)</span> : null}
                  </Td>
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
                    {canManage ? (
                      <SecondaryButton onClick={() => setEditing(editing === p.userId ? null : p.userId)}>
                        {editing === p.userId ? "بستن" : "ویرایش"}
                      </SecondaryButton>
                    ) : null}
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
    </div>
  );
}

function ProfileEditor({ profile, onSaved }: { profile: PayrollProfile; onSaved: () => void }) {
  const money = useMoney();
  const locations = useEngineData<{ locations: Option[] }>("/api/locations/active");
  const projects = useEngineData<{ projects: Option[] }>("/api/ai/projects");
  const [base, setBase] = useState(money.toInputText(profile.baseSalary));
  const [hireDate, setHireDate] = useState(profile.hireDate ?? "");
  const [terminationDate, setTerminationDate] = useState(profile.terminationDate ?? "");
  const [insured, setInsured] = useState(profile.insuranceProfile.insured);
  const [exempt, setExempt] = useState(profile.taxProfile.exempt);
  const [shares, setShares] = useState<ShareDraft[]>(
    profile.costAllocation.map((s) => ({ percent: String(s.percent), locationId: s.locationId ?? "", projectId: s.projectId ?? "", label: s.label ?? "" })),
  );
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const total = shares.reduce((s, x) => s + (Number(x.percent) || 0), 0);

  async function save() {
    setPending(true);
    setError("");
    const res = await api<{ error?: string }>(`/api/ledger/payroll/engine/profiles/${profile.userId}`, {
      method: "PUT",
      body: JSON.stringify({
        baseSalary: money.parseText(base || "0"),
        hireDate: hireDate || null,
        terminationDate: terminationDate || null,
        insuranceProfile: { ...profile.insuranceProfile, insured },
        taxProfile: { ...profile.taxProfile, exempt },
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

  const update = (i: number, patch: Partial<ShareDraft>) => setShares(shares.map((s, j) => (j === i ? { ...s, ...patch } : s)));

  return (
    <SectionCard title={`پرونده حقوقی ${profile.fullName}`}>
      <ErrorBox>{error}</ErrorBox>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
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
            <input type="checkbox" checked={insured} onChange={(e) => setInsured(e.target.checked)} /> مشمول بیمه
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={exempt} onChange={(e) => setExempt(e.target.checked)} /> معاف از مالیات حقوق
          </label>
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
                {(locations.data?.locations ?? []).map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="پروژه">
              <select className={inputClass} value={s.projectId} onChange={(e) => update(i, { projectId: e.target.value })}>
                <option value="">—</option>
                {(projects.data?.projects ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="توضیح">
              <input className={inputClass} value={s.label} onChange={(e) => update(i, { label: e.target.value })} />
            </Field>
            <SecondaryButton onClick={() => setShares(shares.filter((_, j) => j !== i))}>حذف</SecondaryButton>
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-3">
          <SecondaryButton onClick={() => setShares([...shares, { percent: shares.length === 0 ? "100" : "", locationId: "", projectId: "", label: "" }])}>
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
