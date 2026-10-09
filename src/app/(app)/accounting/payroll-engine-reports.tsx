"use client";

/**
 * #865 payroll reports: register, insurance and tax summaries (the basis of the
 * monthly list and return), employer cost by branch / project, a per-period
 * overview, and the liabilities-vs-ledger reconciliation. Every figure comes
 * from the standing payslip snapshots; nothing is recomputed here.
 */
import { useState } from "react";
import { DataTable, DataTableBody, DataTableFoot, DataTableHead, DataTableRow, Td, Th } from "@/app/dashboard/data-table";
import { EmptyState, SectionCard, SectionCardSkeleton, StatusBadge } from "@/app/dashboard/page-chrome";
import { ErrorBox, Field, inputClass } from "@/app/dashboard/ui";
import { useMoney } from "@/components/money/money-context";
import { toPersianDigits } from "@/lib/digits";
import { currentPeriodKey, periodText, recentPeriodKeys, useEngineData, type Payslip } from "./payroll-engine-shared";

type Report = "register" | "insurance" | "tax" | "employer-cost" | "periods" | "reconciliation";

const REPORTS: ReadonlyArray<{ key: Report; label: string; periodic: boolean }> = [
  { key: "register", label: "لیست حقوق", periodic: true },
  { key: "insurance", label: "خلاصه بیمه", periodic: true },
  { key: "tax", label: "خلاصه مالیات حقوق", periodic: true },
  { key: "employer-cost", label: "بهای تمام‌شده کارفرما", periodic: true },
  { key: "periods", label: "مقایسه دوره‌ها", periodic: false },
  { key: "reconciliation", label: "تطبیق با دفتر", periodic: false },
];

type EmployeeRow = { userId: string | null; employeeName: string } & Record<string, string | null>;

const EMPLOYEE_COLUMNS: Record<"insurance" | "tax" | "employer-cost", Array<[string, string]>> = {
  insurance: [
    ["insuranceBase", "حقوق مشمول بیمه"],
    ["employeeInsurance", "سهم کارمند"],
    ["employerInsurance", "سهم کارفرما"],
    ["unemploymentInsurance", "بیمه بیکاری"],
  ],
  tax: [
    ["gross", "ناخالص"],
    ["taxableBase", "مشمول مالیات"],
    ["incomeTax", "مالیات"],
  ],
  "employer-cost": [
    ["gross", "ناخالص"],
    ["employerInsurance", "بیمه کارفرما"],
    ["unemploymentInsurance", "بیمه بیکاری"],
    ["employerCost", "بهای تمام‌شده"],
  ],
};

export function PayrollEngineReports() {
  const [report, setReport] = useState<Report>("register");
  const [period, setPeriod] = useState(currentPeriodKey());
  const meta = REPORTS.find((r) => r.key === report)!;
  const url = `/api/ledger/payroll/engine/reports/${report}${meta.periodic ? `?period=${encodeURIComponent(period)}` : ""}`;
  const data = useEngineData<Record<string, unknown>>(url);

  return (
    <div className="space-y-4">
      <SectionCard title="گزارش‌های حقوق">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="گزارش">
            <select className={inputClass} value={report} onChange={(e) => setReport(e.target.value as Report)}>
              {REPORTS.map((r) => (
                <option key={r.key} value={r.key}>
                  {r.label}
                </option>
              ))}
            </select>
          </Field>
          {meta.periodic ? (
            <Field label="دوره">
              <select className={inputClass} value={period} onChange={(e) => setPeriod(e.target.value)}>
                {recentPeriodKeys().map((k) => (
                  <option key={k} value={k}>
                    {periodText(k)}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}
        </div>
      </SectionCard>
      <ErrorBox>{data.error}</ErrorBox>
      {data.loading ? <SectionCardSkeleton rows={5} label="در حال بارگذاری گزارش" /> : data.data ? <ReportBody report={report} data={data.data} /> : null}
    </div>
  );
}

function ReportBody({ report, data }: { report: Report; data: Record<string, unknown> }) {
  const money = useMoney();
  if (report === "register") {
    const payslips = (data.payslips as Payslip[]) ?? [];
    const totals = data.totals as Record<string, string>;
    if (payslips.length === 0) return <Empty />;
    return (
      <SectionCard title="لیست حقوق" flush>
        <DataTable caption="لیست حقوق" frame={false}>
          <DataTableHead>
            <DataTableRow>
              <Th>کارمند</Th>
              <Th>اجرا</Th>
              <Th numeric>ناخالص</Th>
              <Th numeric>بیمه</Th>
              <Th numeric>مالیات</Th>
              <Th numeric>کسورات</Th>
              <Th numeric>خالص</Th>
              <Th numeric>بدهی</Th>
            </DataTableRow>
          </DataTableHead>
          <DataTableBody>
            {payslips.map((s) => (
              <DataTableRow key={s.id}>
                <Td>{s.employeeName}</Td>
                <Td nowrap>{s.runType === "regular" ? "عادی" : `اصلاحی ${toPersianDigits(s.sequence - 1)}`}</Td>
                <Td numeric>{money.formatText(s.gross)}</Td>
                <Td numeric>{money.formatText(s.employeeInsurance)}</Td>
                <Td numeric>{money.formatText(s.incomeTax)}</Td>
                <Td numeric>{money.formatText(s.totalDeductions)}</Td>
                <Td numeric>{money.formatText(s.netPay)}</Td>
                <Td numeric>{s.employeeDebt === "0" ? "—" : money.formatText(s.employeeDebt)}</Td>
              </DataTableRow>
            ))}
          </DataTableBody>
          <DataTableFoot>
            <DataTableRow>
              <Td>جمع</Td>
              <Td />
              {(["gross", "employeeInsurance", "incomeTax", "totalDeductions", "netPay", "employeeDebt"] as const).map((k) => (
                <Td key={k} numeric>
                  {money.formatText(totals[k] ?? "0")}
                </Td>
              ))}
            </DataTableRow>
          </DataTableFoot>
        </DataTable>
      </SectionCard>
    );
  }
  if (report === "insurance" || report === "tax" || report === "employer-cost") {
    const rows = (data.employees as EmployeeRow[]) ?? [];
    if (rows.length === 0) return <Empty />;
    const cols = EMPLOYEE_COLUMNS[report];
    const allocation = (data.allocation as Array<{ label: string | null; locationId: string | null; projectId: string | null; amount: string }>) ?? [];
    return (
      <>
        <SectionCard title={REPORTS.find((r) => r.key === report)!.label} flush>
          <DataTable caption={REPORTS.find((r) => r.key === report)!.label} frame={false}>
            <DataTableHead>
              <DataTableRow>
                <Th>کارمند</Th>
                {cols.map(([, label]) => (
                  <Th key={label} numeric>
                    {label}
                  </Th>
                ))}
              </DataTableRow>
            </DataTableHead>
            <DataTableBody>
              {rows.map((r) => (
                <DataTableRow key={r.userId ?? r.employeeName}>
                  <Td>{r.employeeName}</Td>
                  {cols.map(([k]) => (
                    <Td key={k} numeric>
                      {money.formatText(r[k] ?? "0")}
                    </Td>
                  ))}
                </DataTableRow>
              ))}
            </DataTableBody>
          </DataTable>
        </SectionCard>
        {report === "employer-cost" ? (
          <SectionCard title="تسهیم به شعبه و پروژه" flush>
            <DataTable caption="تسهیم به شعبه و پروژه" frame={false}>
              <DataTableHead>
                <DataTableRow>
                  <Th>سهم</Th>
                  <Th numeric>مبلغ</Th>
                </DataTableRow>
              </DataTableHead>
              <DataTableBody>
                {allocation.map((a, i) => (
                  <DataTableRow key={i}>
                    <Td>{a.label ?? (a.locationId || a.projectId ? "شعبه / پروژه" : "—")}</Td>
                    <Td numeric>{money.formatText(a.amount)}</Td>
                  </DataTableRow>
                ))}
                <DataTableRow>
                  <Td>بدون تسهیم</Td>
                  <Td numeric>{money.formatText(String(data.unallocated ?? "0"))}</Td>
                </DataTableRow>
              </DataTableBody>
            </DataTable>
          </SectionCard>
        ) : null}
      </>
    );
  }
  if (report === "periods") {
    const periods = (data.periods as Array<Record<string, string | number>>) ?? [];
    if (periods.length === 0) return <Empty />;
    return (
      <SectionCard title="مقایسه دوره‌ها" flush>
        <DataTable caption="مقایسه دوره‌ها" frame={false}>
          <DataTableHead>
            <DataTableRow>
              <Th>دوره</Th>
              <Th numeric>نفرات</Th>
              <Th numeric>ناخالص</Th>
              <Th numeric>کل بیمه</Th>
              <Th numeric>مالیات</Th>
              <Th numeric>خالص</Th>
              <Th numeric>بهای تمام‌شده</Th>
            </DataTableRow>
          </DataTableHead>
          <DataTableBody>
            {periods.map((p) => (
              <DataTableRow key={String(p.periodKey)}>
                <Td nowrap>{periodText(String(p.periodKey))}</Td>
                <Td numeric>{toPersianDigits(String(p.employees))}</Td>
                {(["gross", "totalInsurance", "incomeTax", "netPay", "employerCost"] as const).map((k) => (
                  <Td key={k} numeric>
                    {money.formatText(String(p[k] ?? "0"))}
                  </Td>
                ))}
              </DataTableRow>
            ))}
          </DataTableBody>
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
        <DataTableHead>
          <DataTableRow>
            <Th>حساب</Th>
            <Th numeric>مورد انتظار</Th>
            <Th numeric>ثبت‌شده توسط حقوق</Th>
            <Th numeric>مغایرت</Th>
            <Th numeric>ماندهٔ کل حساب</Th>
          </DataTableRow>
        </DataTableHead>
        <DataTableBody>
          {accounts.map((a) => (
            <DataTableRow key={a.code}>
              <Td nowrap>{toPersianDigits(a.code)}</Td>
              <Td numeric>{money.formatText(a.expected)}</Td>
              <Td numeric>{money.formatText(a.glFromEngine)}</Td>
              <Td numeric>{a.difference === "0" ? "—" : money.formatText(a.difference)}</Td>
              <Td numeric muted>
                {money.formatText(a.glTotal)}
              </Td>
            </DataTableRow>
          ))}
        </DataTableBody>
      </DataTable>
    </SectionCard>
  );
}

function Empty() {
  return (
    <SectionCard>
      <EmptyState title="داده‌ای برای این گزارش نیست">فقط اجراهای تأییدشده و پس از آن در گزارش‌ها می‌آیند.</EmptyState>
    </SectionCard>
  );
}
