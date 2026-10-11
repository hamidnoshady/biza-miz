"use client";

/**
 * #865 statutory payroll reports. Every value comes from immutable payslip
 * snapshots; filters are explicit Jalali period/year selections and the
 * two-period comparison uses the service's strict comparison endpoint.
 */
import { useState } from "react";
import { DataTable, DataTableBody, DataTableFoot, DataTableHead, DataTableRow, Td, Th } from "@/app/dashboard/data-table";
import { EmptyState, KpiCard, KpiRow, SectionCard, SectionCardSkeleton, StatusBadge } from "@/app/dashboard/page-chrome";
import { ErrorBox, Field, InfoBox, inputClass } from "@/app/dashboard/ui";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { useMoney } from "@/components/money/money-context";
import { toPersianDigits } from "@/lib/digits";
import { currentPeriodKey, periodText, recentPeriodKeys, useEngineData, type Payslip, type PayrollProfile } from "./payroll-engine-shared";

type Report = "register" | "employee-card" | "insurance" | "tax" | "employer-cost" | "periods" | "comparison" | "reconciliation";

const REPORTS: ReadonlyArray<{ key: Report; label: string; periodic: boolean }> = [
  { key: "register", label: "لیست حقوق", periodic: true },
  { key: "employee-card", label: "کارت حقوق کارمند", periodic: false },
  { key: "insurance", label: "خلاصه بیمه", periodic: true },
  { key: "tax", label: "خلاصه مالیات حقوق", periodic: true },
  { key: "employer-cost", label: "بهای تمام‌شده کارفرما", periodic: true },
  { key: "periods", label: "خلاصهٔ دوره‌ها", periodic: false },
  { key: "comparison", label: "مقایسهٔ دو دوره", periodic: false },
  { key: "reconciliation", label: "تطبیق با دفتر", periodic: false },
];

type EmployeeRow = { userId: string | null; employeeName: string } & Record<string, string | null>;

type PeriodTotals = Record<string, string | number> & { periodKey: string; employees: number };

const EMPLOYEE_COLUMNS: Record<"insurance" | "tax" | "employer-cost", Array<[string, string]>> = {
  insurance: [
    ["insuranceBase", "حقوق مشمول بیمه"],
    ["employeeInsurance", "سهم کارمند"],
    ["employerInsurance", "سهم کارفرما"],
    ["unemploymentInsurance", "بیمه بیکاری"],
  ],
  tax: [["gross", "ناخالص"], ["taxableBase", "مشمول مالیات"], ["incomeTax", "مالیات"]],
  "employer-cost": [["gross", "ناخالص"], ["employerInsurance", "بیمه کارفرما"], ["unemploymentInsurance", "بیمه بیکاری"], ["employerCost", "بهای تمام‌شده"]],
};

const COMPARISON_FIELDS = [
  ["gross", "ناخالص"],
  ["totalInsurance", "کل بیمه"],
  ["incomeTax", "مالیات حقوق"],
  ["netPay", "خالص پرداختی"],
  ["employerCost", "بهای تمام‌شده کارفرما"],
] as const;

export function PayrollEngineReports() {
  const [report, setReport] = useState<Report>("register");
  const [period, setPeriod] = useState(currentPeriodKey());
  const periods = recentPeriodKeys();
  const [periodA, setPeriodA] = useState(periods[0] ?? currentPeriodKey());
  const [periodB, setPeriodB] = useState(periods[1] ?? currentPeriodKey());
  const [userId, setUserId] = useState("");
  const [year, setYear] = useState(currentPeriodKey().slice(0, 4));
  const employees = useEngineData<{ profiles: PayrollProfile[] }>("/api/ledger/payroll/engine/profiles");
  const meta = REPORTS.find((entry) => entry.key === report)!;
  let url: string | null = `/api/ledger/payroll/engine/reports/${report}`;
  if (meta.periodic) url += `?period=${encodeURIComponent(period)}`;
  else if (report === "employee-card") {
    url = userId ? `/api/ledger/payroll/engine/reports/employee-card?userId=${encodeURIComponent(userId)}&year=${encodeURIComponent(year)}` : null;
  } else if (report === "comparison") {
    url = `/api/ledger/payroll/engine/reports/comparison?a=${encodeURIComponent(periodA)}&b=${encodeURIComponent(periodB)}`;
  }
  const data = useEngineData<Record<string, unknown>>(url);
  const profiles = employees.data?.profiles ?? [];
  const employeeOptions = [
    { value: "", label: "انتخاب کارمند" },
    ...profiles.map((profile) => ({ value: profile.userId, label: `${profile.fullName} — ${profile.employeeCode ?? profile.payrollCode ?? "بدون کد"}` })),
  ];
  const years = Array.from({ length: 20 }, (_, index) => String(Number(currentPeriodKey().slice(0, 4)) - index));
  const needsEmployee = report === "employee-card";
  const needsComparison = report === "comparison";

  return (
    <div className="space-y-4">
      <SectionCard title="گزارش‌های حقوق">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="گزارش">
            <select className={inputClass} value={report} onChange={(e) => setReport(e.target.value as Report)}>
              {REPORTS.map((entry) => <option key={entry.key} value={entry.key}>{entry.label}</option>)}
            </select>
          </Field>
          {meta.periodic ? (
            <Field label="دوره">
              <select className={inputClass} value={period} onChange={(e) => setPeriod(e.target.value)}>
                {periods.map((key) => <option key={key} value={key}>{periodText(key)}</option>)}
              </select>
            </Field>
          ) : null}
          {needsEmployee ? (
            <>
              <Field label="کارمند" as="div">
                <SearchableSelect
                  value={userId}
                  onChange={setUserId}
                  options={employeeOptions}
                  loading={employees.loading}
                  disabled={employees.loading || profiles.length === 0}
                  ariaLabel="کارمند برای کارت حقوق"
                  placeholder="انتخاب کارمند"
                />
              </Field>
              <Field label="سال شمسی">
                <select className={inputClass} value={year} onChange={(e) => setYear(e.target.value)}>
                  {years.map((value) => <option key={value} value={value}>{toPersianDigits(value)}</option>)}
                </select>
              </Field>
            </>
          ) : null}
          {needsComparison ? (
            <>
              <Field label="دورهٔ نخست">
                <select className={inputClass} value={periodA} onChange={(e) => setPeriodA(e.target.value)}>
                  {periods.map((key) => <option key={key} value={key}>{periodText(key)}</option>)}
                </select>
              </Field>
              <Field label="دورهٔ دوم">
                <select className={inputClass} value={periodB} onChange={(e) => setPeriodB(e.target.value)}>
                  {periods.map((key) => <option key={key} value={key}>{periodText(key)}</option>)}
                </select>
              </Field>
            </>
          ) : null}
        </div>
        {needsEmployee && employees.error ? <ErrorBox>{employees.error}</ErrorBox> : null}
        {needsEmployee && profiles.length === 0 && !employees.loading ? <InfoBox>برای نمایش کارت حقوق، ابتدا کارمند را در تیم ثبت کنید.</InfoBox> : null}
        {needsComparison && periodA === periodB ? <InfoBox>برای مقایسه، دو دورهٔ متفاوت انتخاب کنید.</InfoBox> : null}
      </SectionCard>
      <ErrorBox>{data.error}</ErrorBox>
      {data.loading ? (
        <SectionCardSkeleton rows={5} label="در حال بارگذاری گزارش" />
      ) : needsEmployee && !userId ? (
        <SectionCard><EmptyState title="کارمندی انتخاب نشده است">کارمند و سال شمسی را برای دیدن کارت حقوق انتخاب کنید.</EmptyState></SectionCard>
      ) : needsComparison && periodA === periodB ? null : data.data ? (
        <ReportBody report={report} data={data.data} periodA={periodA} periodB={periodB} employee={profiles.find((profile) => profile.userId === userId)} />
      ) : null}
    </div>
  );
}

function ReportBody({
  report,
  data,
  periodA,
  periodB,
  employee,
}: {
  report: Report;
  data: Record<string, unknown>;
  periodA: string;
  periodB: string;
  employee?: PayrollProfile;
}) {
  const money = useMoney();
  if (report === "register") {
    const payslips = (data.payslips as Payslip[]) ?? [];
    const totals = data.totals as Record<string, string> | undefined;
    if (payslips.length === 0) return <Empty />;
    return (
      <SectionCard title="لیست حقوق" flush>
        <DataTable caption="لیست حقوق" frame={false}>
          <DataTableHead>
            <Th>کارمند</Th><Th>اجرا</Th><Th numeric>ناخالص</Th><Th numeric>بیمه</Th><Th numeric>مالیات</Th><Th numeric>کسورات</Th><Th numeric>خالص</Th><Th numeric>بدهی</Th>
          </DataTableHead>
          <DataTableBody>
            {payslips.map((slip) => (
              <DataTableRow key={slip.id}>
                <Td>{slip.employeeName}</Td>
                <Td nowrap>{slip.runType === "regular" ? "عادی" : `اصلاحی ${toPersianDigits(slip.sequence - 1)}`}</Td>
                <Td numeric>{money.formatText(slip.gross)}</Td>
                <Td numeric>{money.formatText(slip.employeeInsurance)}</Td>
                <Td numeric>{money.formatText(slip.incomeTax)}</Td>
                <Td numeric>{money.formatText(slip.totalDeductions)}</Td>
                <Td numeric>{money.formatText(slip.netPay)}</Td>
                <Td numeric>{slip.employeeDebt === "0" ? "—" : money.formatText(slip.employeeDebt)}</Td>
              </DataTableRow>
            ))}
          </DataTableBody>
          {totals ? (
            <DataTableFoot>
              <DataTableRow>
                <Td>جمع</Td><Td />
                {(["gross", "employeeInsurance", "incomeTax", "totalDeductions", "netPay", "employeeDebt"] as const).map((key) => (
                  <Td key={key} numeric>{money.formatText(totals[key] ?? "0")}</Td>
                ))}
              </DataTableRow>
            </DataTableFoot>
          ) : null}
        </DataTable>
      </SectionCard>
    );
  }
  if (report === "employee-card") {
    const slips = (data.payslips as Payslip[]) ?? [];
    const totals = data.totals as Record<string, string> | undefined;
    if (slips.length === 0) return <Empty />;
    return (
      <SectionCard title={`کارت حقوق ${employee?.fullName ?? slips[0]?.employeeName ?? "کارمند"}`} description={`سال شمسی ${toPersianDigits(String(data.year ?? ""))}`} flush>
        {totals ? (
          <KpiRow>
            <KpiCard label="ناخالص سال" value={money.formatText(totals.gross ?? "0")} />
            <KpiCard label="بیمه سهم کارمند" value={money.formatText(totals.employeeInsurance ?? "0")} />
            <KpiCard label="مالیات سال" value={money.formatText(totals.incomeTax ?? "0")} />
            <KpiCard label="خالص پرداختی" value={money.formatText(totals.netPay ?? "0")} />
          </KpiRow>
        ) : null}
        <DataTable caption="کارت حقوق سالانهٔ کارمند">
          <DataTableHead>
            <Th>دوره</Th><Th>اجرا</Th><Th numeric>ناخالص</Th><Th numeric>بیمه</Th><Th numeric>مالیات</Th><Th numeric>کسورات</Th><Th numeric>خالص</Th><Th numeric>بدهی</Th><Th>پرداخت</Th>
          </DataTableHead>
          <DataTableBody>
            {slips.map((slip) => (
              <DataTableRow key={slip.id}>
                <Td nowrap>{periodText(slip.periodKey)}</Td>
                <Td nowrap>{slip.runType === "regular" ? "عادی" : `اصلاحی ${toPersianDigits(slip.sequence - 1)}`}</Td>
                <Td numeric>{money.formatText(slip.gross)}</Td>
                <Td numeric>{money.formatText(slip.employeeInsurance)}</Td>
                <Td numeric>{money.formatText(slip.incomeTax)}</Td>
                <Td numeric>{money.formatText(slip.totalDeductions)}</Td>
                <Td numeric>{money.formatText(slip.netPay)}</Td>
                <Td numeric>{slip.employeeDebt === "0" ? "—" : money.formatText(slip.employeeDebt)}</Td>
                <Td><StatusBadge tone={slip.paymentStatus === "paid" ? "positive" : "neutral"}>{slip.paymentStatus === "paid" ? "پرداخت‌شده" : "پرداخت‌نشده"}</StatusBadge></Td>
              </DataTableRow>
            ))}
          </DataTableBody>
        </DataTable>
      </SectionCard>
    );
  }
  if (report === "insurance" || report === "tax" || report === "employer-cost") {
    const rows = (data.employees as EmployeeRow[]) ?? [];
    if (rows.length === 0) return <Empty />;
    const columns = EMPLOYEE_COLUMNS[report];
    const allocation = (data.allocation as Array<{ label: string | null; locationId: string | null; projectId: string | null; amount: string }>) ?? [];
    return (
      <>
        <SectionCard title={REPORTS.find((entry) => entry.key === report)!.label} flush>
          <DataTable caption={REPORTS.find((entry) => entry.key === report)!.label} frame={false}>
            <DataTableHead>
              <Th>کارمند</Th>
              {columns.map(([, label]) => <Th key={label} numeric>{label}</Th>)}
            </DataTableHead>
            <DataTableBody>
              {rows.map((row) => (
                <DataTableRow key={row.userId ?? row.employeeName}>
                  <Td>{row.employeeName}</Td>
                  {columns.map(([key]) => <Td key={key} numeric>{money.formatText(row[key] ?? "0")}</Td>)}
                </DataTableRow>
              ))}
            </DataTableBody>
          </DataTable>
        </SectionCard>
        {report === "employer-cost" ? (
          <SectionCard title="تسهیم به شعبه و پروژه" flush>
            <DataTable caption="تسهیم به شعبه و پروژه" frame={false}>
              <DataTableHead><Th>سهم</Th><Th numeric>مبلغ</Th></DataTableHead>
              <DataTableBody>
                {allocation.map((share, index) => (
                  <DataTableRow key={index}>
                    <Td>{share.label ?? (share.locationId || share.projectId ? "شعبه / پروژه" : "—")}</Td>
                    <Td numeric>{money.formatText(share.amount)}</Td>
                  </DataTableRow>
                ))}
                <DataTableRow><Td>بدون تسهیم</Td><Td numeric>{money.formatText(String(data.unallocated ?? "0"))}</Td></DataTableRow>
              </DataTableBody>
            </DataTable>
          </SectionCard>
        ) : null}
      </>
    );
  }
  if (report === "periods") {
    const summaries = (data.periods as PeriodTotals[]) ?? [];
    if (summaries.length === 0) return <Empty />;
    return (
      <SectionCard title="خلاصهٔ دوره‌ها" flush>
        <DataTable caption="خلاصهٔ دوره‌های حقوق" frame={false}>
          <DataTableHead><Th>دوره</Th><Th numeric>نفرات</Th><Th numeric>ناخالص</Th><Th numeric>کل بیمه</Th><Th numeric>مالیات</Th><Th numeric>خالص</Th><Th numeric>بهای تمام‌شده</Th></DataTableHead>
          <DataTableBody>
            {summaries.map((summary) => (
              <DataTableRow key={summary.periodKey}>
                <Td nowrap>{periodText(summary.periodKey)}</Td>
                <Td numeric>{toPersianDigits(String(summary.employees))}</Td>
                {(["gross", "totalInsurance", "incomeTax", "netPay", "employerCost"] as const).map((key) => <Td key={key} numeric>{money.formatText(String(summary[key] ?? "0"))}</Td>)}
              </DataTableRow>
            ))}
          </DataTableBody>
        </DataTable>
      </SectionCard>
    );
  }
  if (report === "comparison") {
    const a = data.a as PeriodTotals | null;
    const b = data.b as PeriodTotals | null;
    const difference = data.difference as Record<string, string>;
    return (
      <SectionCard title="مقایسهٔ دو دوره" description="اختلاف برابر است با دورهٔ دوم منهای دورهٔ نخست؛ نبود فیش در یک ماه، صفر در نظر گرفته می‌شود." flush>
        <DataTable caption="مقایسهٔ دو دورهٔ حقوق">
          <DataTableHead><Th>شاخص</Th><Th numeric>{periodText(periodA)}</Th><Th numeric>{periodText(periodB)}</Th><Th numeric>اختلاف</Th></DataTableHead>
          <DataTableBody>
            {COMPARISON_FIELDS.map(([key, label]) => (
              <DataTableRow key={key}>
                <Td>{label}</Td>
                <Td numeric>{money.formatText(String(a?.[key] ?? "0"))}</Td>
                <Td numeric>{money.formatText(String(b?.[key] ?? "0"))}</Td>
                <Td numeric>{money.formatText(difference[key] ?? "0")}</Td>
              </DataTableRow>
            ))}
          </DataTableBody>
          <DataTableFoot>
            <DataTableRow><Td>تعداد کارکنان</Td><Td numeric>{toPersianDigits(String(a?.employees ?? 0))}</Td><Td numeric>{toPersianDigits(String(b?.employees ?? 0))}</Td><Td>—</Td></DataTableRow>
          </DataTableFoot>
        </DataTable>
      </SectionCard>
    );
  }
  const accounts = (data.accounts as Array<{ code: string; expected: string; glFromEngine: string; difference: string; glTotal: string }>) ?? [];
  return (
    <SectionCard
      title="تطبیق بدهی‌های حقوق با دفتر"
      description="مانده‌ای که فیش‌های ثبت‌شده باید در هر حساب بسازند، در برابر آنچه اسناد حقوق واقعاً ثبت کرده‌اند — همه از یک لحظهٔ ثابت پایگاه داده."
      actions={<StatusBadge tone={data.reconciled ? "positive" : "danger"} dot>{data.reconciled ? "متوازن" : "مغایرت"}</StatusBadge>}
      flush
    >
      <DataTable caption="تطبیق بدهی‌های حقوق با دفتر" frame={false}>
        <DataTableHead><Th>حساب</Th><Th numeric>مورد انتظار</Th><Th numeric>ثبت‌شده توسط حقوق</Th><Th numeric>مغایرت</Th><Th numeric>ماندهٔ کل حساب</Th></DataTableHead>
        <DataTableBody>
          {accounts.map((account) => (
            <DataTableRow key={account.code}>
              <Td nowrap>{toPersianDigits(account.code)}</Td>
              <Td numeric>{money.formatText(account.expected)}</Td>
              <Td numeric>{money.formatText(account.glFromEngine)}</Td>
              <Td numeric>{account.difference === "0" ? "—" : money.formatText(account.difference)}</Td>
              <Td numeric muted>{money.formatText(account.glTotal)}</Td>
            </DataTableRow>
          ))}
        </DataTableBody>
      </DataTable>
    </SectionCard>
  );
}

function Empty() {
  return <SectionCard><EmptyState title="داده‌ای برای این گزارش نیست">فقط اجراهای تأییدشده و پس از آن در گزارش‌ها می‌آیند.</EmptyState></SectionCard>;
}
