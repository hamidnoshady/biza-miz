"use client";

/**
 * The payroll workspace: the #835 journal-level monthly payroll (pay terms,
 * accruals, advances — unchanged) beside the #865 engine's runs, employee
 * files, rules and reports. A month is booked by one path or the other; the
 * server refuses the second (`period_held_by_engine` / `…_journal_payroll`).
 */
import { useState } from "react";
import { TabBar, TabPanel } from "@/app/dashboard/tab-bar";
import type { Runner } from "./accounting-manager";
import { PayrollEngineProfiles } from "./payroll-engine-profiles";
import { PayrollEngineReports } from "./payroll-engine-reports";
import { PayrollEngineRules } from "./payroll-engine-rules";
import { PayrollEngineRuns } from "./payroll-engine-runs";
import { PayrollSection } from "./payroll-section";

type PayrollTab = "monthly" | "runs" | "employees" | "rules" | "reports";

const TABS: ReadonlyArray<{ key: PayrollTab; label: string }> = [
  { key: "monthly", label: "حقوق ماهانه ساده" },
  { key: "runs", label: "اجرای حقوق" },
  { key: "employees", label: "پرونده کارکنان" },
  { key: "rules", label: "قوانین و اجزا" },
  { key: "reports", label: "گزارش‌ها" },
];

export function PayrollWorkspace({
  busy,
  run,
  refreshKey,
  canManage,
  ownerKey,
}: {
  busy: boolean;
  run: Runner;
  refreshKey: number;
  canManage?: boolean;
  ownerKey?: string;
}) {
  const [tab, setTab] = useState<PayrollTab>("monthly");
  // Unknown permission draws the controls and lets the API decide, as the #835 screen does.
  const manage = canManage !== false;
  return (
    <div className="space-y-4">
      <TabBar idPrefix="payroll" label="بخش‌های حقوق و دستمزد" tabs={TABS} active={tab} onChange={setTab} />
      <TabPanel idPrefix="payroll" active={tab}>
        {tab === "monthly" ? <PayrollSection busy={busy} run={run} refreshKey={refreshKey} canManage={canManage} ownerKey={ownerKey} /> : null}
        {tab === "runs" ? <PayrollEngineRuns canManage={manage} /> : null}
        {tab === "employees" ? <PayrollEngineProfiles canManage={manage} /> : null}
        {tab === "rules" ? <PayrollEngineRules canManage={manage} /> : null}
        {tab === "reports" ? <PayrollEngineReports /> : null}
      </TabPanel>
    </div>
  );
}
