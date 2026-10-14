import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as auth from "@/lib/auth";
import * as setup from "@/lib/payroll-engine-setup";
import * as runs from "@/lib/payroll-engine-runs";
import { PayrollError } from "@/lib/payroll-errors";
import { PERMISSIONS } from "@/lib/permissions";
import { GET as listComponents, POST as createComponent } from "./components/route";
import { GET as componentHistory, PATCH as updateComponent } from "./components/[id]/route";
import { GET as listItems, POST as createItem } from "./items/route";
import { GET as itemHistory, PATCH as endItem } from "./items/[id]/route";
import { GET as listProfiles } from "./profiles/route";
import { GET as getProfile, PUT as updateProfile } from "./profiles/[userId]/route";
import { GET as listRules, POST as createRules } from "./rule-sets/route";
import { GET as listRuns, POST as createRun } from "./runs/route";
import { GET as getRun, PATCH as patchRun } from "./runs/[id]/route";
import { POST as runAction } from "./runs/[id]/[action]/route";
import { GET as getPayslip } from "./payslips/[id]/route";
import { GET as report } from "./reports/[report]/route";

vi.mock("@/lib/auth", () => ({
  withTenantScope: (handler: unknown) => handler,
  requirePermission: vi.fn(),
}));
vi.mock("@/lib/payroll-engine-setup", () => ({
  listComponents: vi.fn(),
  listPayrollPostingAccounts: vi.fn(),
  saveComponent: vi.fn(),
  listComponentChanges: vi.fn(),
  listItems: vi.fn(),
  addItem: vi.fn(),
  endItem: vi.fn(),
  listItemChanges: vi.fn(),
  listProfiles: vi.fn(),
  getProfile: vi.fn(),
  saveProfile: vi.fn(),
  listProfileChanges: vi.fn(),
  listRuleSets: vi.fn(),
  createRuleSet: vi.fn(),
}));
vi.mock("@/lib/payroll-engine-runs", () => ({
  listEngineRuns: vi.fn(),
  createEngineRun: vi.fn(),
  getEngineRun: vi.fn(),
  listPayslips: vi.fn(),
  updateEngineRunInputs: vi.fn(),
  calculateEngineRun: vi.fn(),
  reviewEngineRun: vi.fn(),
  approveEngineRun: vi.fn(),
  postEngineRun: vi.fn(),
  payEngineRun: vi.fn(),
  closeEngineRun: vi.fn(),
  cancelEngineRun: vi.fn(),
  getPayslip: vi.fn(),
  payrollRegister: vi.fn(),
  employeePayrollCard: vi.fn(),
  insuranceSummary: vi.fn(),
  payrollTaxSummary: vi.fn(),
  employerCostReport: vi.fn(),
  payrollLiabilityReconciliation: vi.fn(),
  periodComparison: vi.fn(),
  payrollPeriodSummaries: vi.fn(),
}));
vi.mock("@/lib/payroll-engine-calc", () => ({ IRAN_RULE_TEMPLATE: { monthDays: 30, taxBrackets: [] } }));

const BUSINESS_ID = "business-a";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const RUN_ID = "11111111-1111-4111-8111-111111111111";
const ITEM_ID = "33333333-3333-4333-8333-333333333333";
const COMPONENT_ID = "44444444-4444-4444-8444-444444444444";
const session = { businessId: BUSINESS_ID, sub: USER_ID, role: "accountant" };
const ctx = { params: Promise.resolve({ id: RUN_ID }) };
const profileCtx = { params: Promise.resolve({ userId: USER_ID }) };
const componentCtx = { params: Promise.resolve({ id: COMPONENT_ID }) };
const itemCtx = { params: Promise.resolve({ id: ITEM_ID }) };
const reportCtx = (name: string) => ({ params: Promise.resolve({ report: name }) });

function request(path: string, options: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  return new NextRequest(`http://localhost/api/ledger/payroll/engine/${path}`, {
    method: options.method ?? "GET",
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

const denied = () => ({
  session: null,
  error: NextResponse.json({ error: "forbidden", code: "MISSING_PERMISSION" }, { status: 403 }),
}) as never;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session, error: null } as never);
  vi.mocked(setup.listComponents).mockResolvedValue([] as never);
  vi.mocked(setup.listPayrollPostingAccounts).mockResolvedValue([] as never);
  vi.mocked(setup.saveComponent).mockResolvedValue({ id: COMPONENT_ID } as never);
  vi.mocked(setup.listComponentChanges).mockResolvedValue([] as never);
  vi.mocked(setup.listItems).mockResolvedValue([] as never);
  vi.mocked(setup.addItem).mockResolvedValue({ id: ITEM_ID } as never);
  vi.mocked(setup.endItem).mockResolvedValue({ id: ITEM_ID } as never);
  vi.mocked(setup.listItemChanges).mockResolvedValue([] as never);
  vi.mocked(setup.listProfiles).mockResolvedValue([] as never);
  vi.mocked(setup.getProfile).mockResolvedValue({ userId: USER_ID } as never);
  vi.mocked(setup.saveProfile).mockResolvedValue({ userId: USER_ID } as never);
  vi.mocked(setup.listProfileChanges).mockResolvedValue([] as never);
  vi.mocked(setup.listRuleSets).mockResolvedValue([] as never);
  vi.mocked(setup.createRuleSet).mockResolvedValue({ id: "rule-set-1" } as never);
  vi.mocked(runs.listEngineRuns).mockResolvedValue([] as never);
  vi.mocked(runs.createEngineRun).mockResolvedValue({ id: RUN_ID, idempotentReplay: false } as never);
  vi.mocked(runs.getEngineRun).mockResolvedValue({ id: RUN_ID } as never);
  vi.mocked(runs.listPayslips).mockResolvedValue([] as never);
  vi.mocked(runs.updateEngineRunInputs).mockResolvedValue({ id: RUN_ID } as never);
  vi.mocked(runs.calculateEngineRun).mockResolvedValue({ id: RUN_ID } as never);
  vi.mocked(runs.reviewEngineRun).mockResolvedValue({ id: RUN_ID } as never);
  vi.mocked(runs.approveEngineRun).mockResolvedValue({ id: RUN_ID } as never);
  vi.mocked(runs.postEngineRun).mockResolvedValue({ id: RUN_ID } as never);
  vi.mocked(runs.payEngineRun).mockResolvedValue({ id: RUN_ID } as never);
  vi.mocked(runs.closeEngineRun).mockResolvedValue({ id: RUN_ID } as never);
  vi.mocked(runs.cancelEngineRun).mockResolvedValue({ id: RUN_ID } as never);
  vi.mocked(runs.getPayslip).mockResolvedValue({ id: "payslip-1" } as never);
  vi.mocked(runs.payrollRegister).mockResolvedValue({ payslips: [] } as never);
  vi.mocked(runs.employeePayrollCard).mockResolvedValue({ payslips: [] } as never);
  vi.mocked(runs.insuranceSummary).mockResolvedValue({ totals: null } as never);
  vi.mocked(runs.payrollTaxSummary).mockResolvedValue({ totals: null } as never);
  vi.mocked(runs.employerCostReport).mockResolvedValue({ totals: null } as never);
  vi.mocked(runs.payrollLiabilityReconciliation).mockResolvedValue({ reconciled: true } as never);
  vi.mocked(runs.periodComparison).mockResolvedValue({ periods: [] } as never);
  vi.mocked(runs.payrollPeriodSummaries).mockResolvedValue([] as never);
});

describe("payroll engine routes — capability boundary", () => {
  const reads: Array<[string, () => Promise<Response>, () => unknown]> = [
    ["list components", () => listComponents(), () => setup.listComponents],
    ["component audit", () => componentHistory(request(`components/${COMPONENT_ID}`), componentCtx), () => setup.listComponentChanges],
    ["list items", () => listItems(request("items?userId=" + USER_ID)), () => setup.listItems],
    ["item audit", () => itemHistory(request(`items/${ITEM_ID}`), itemCtx), () => setup.listItemChanges],
    ["list profiles", () => listProfiles(), () => setup.listProfiles],
    ["profile detail", () => getProfile(request(`profiles/${USER_ID}`), profileCtx), () => setup.getProfile],
    ["list rule sets", () => listRules(), () => setup.listRuleSets],
    ["list runs", () => listRuns(request("runs?period=1404-05")), () => runs.listEngineRuns],
    ["run detail", () => getRun(request(`runs/${RUN_ID}`), ctx), () => runs.getEngineRun],
    ["payslip", () => getPayslip(request("payslips/payslip-1"), { params: Promise.resolve({ id: "payslip-1" }) }), () => runs.getPayslip],
    ["register report", () => report(request("reports/register?period=1404-05"), reportCtx("register")), () => runs.payrollRegister],
    ["employee card", () => report(request(`reports/employee-card?userId=${USER_ID}&year=1404`), reportCtx("employee-card")), () => runs.employeePayrollCard],
    ["insurance report", () => report(request("reports/insurance?period=1404-05"), reportCtx("insurance")), () => runs.insuranceSummary],
    ["tax report", () => report(request("reports/tax?period=1404-05"), reportCtx("tax")), () => runs.payrollTaxSummary],
    ["employer cost report", () => report(request("reports/employer-cost?period=1404-05"), reportCtx("employer-cost")), () => runs.employerCostReport],
    ["reconciliation report", () => report(request("reports/reconciliation"), reportCtx("reconciliation")), () => runs.payrollLiabilityReconciliation],
    ["period comparison", () => report(request("reports/comparison?a=1404-05&b=1404-06"), reportCtx("comparison")), () => runs.periodComparison],
    ["period summaries", () => report(request("reports/periods"), reportCtx("periods")), () => runs.payrollPeriodSummaries],
  ];
  const writes: Array<[string, () => Promise<Response>, () => unknown]> = [
    ["create component", () => createComponent(request("components", { method: "POST", body: { code: "MEAL", name: "Meal", kind: "earning" } })), () => setup.saveComponent],
    ["edit component", () => updateComponent(request(`components/${COMPONENT_ID}`, { method: "PATCH", body: { name: "New label" } }), componentCtx), () => setup.saveComponent],
    ["add item", () => createItem(request("items", { method: "POST", body: { userId: USER_ID, componentId: COMPONENT_ID } })), () => setup.addItem],
    ["end item", () => endItem(request(`items/${ITEM_ID}`, { method: "PATCH", body: { effectiveTo: "2025-08-31" } }), itemCtx), () => setup.endItem],
    ["save profile", () => updateProfile(request(`profiles/${USER_ID}`, { method: "PUT", body: { payrollCode: "P-1" } }), profileCtx), () => setup.saveProfile],
    ["create rule version", () => createRules(request("rule-sets", { method: "POST", body: { title: "Rules", effectiveFrom: "2025-03-21", rules: {} } })), () => setup.createRuleSet],
    ["create run", () => createRun(request("runs", { method: "POST", headers: { "Idempotency-Key": "engine-key-001" }, body: { periodKey: "1404-05", runType: "supplemental", accrualDate: "2025-08-20", includeCommission: true, inputs: { [USER_ID]: { overtimeHours: -1 } } } })), () => runs.createEngineRun],
    ["patch run inputs", () => patchRun(request(`runs/${RUN_ID}`, { method: "PATCH", body: { inputMode: "merge", inputs: { [USER_ID]: { overtimeHours: 1 } }, removeEmployeeIds: [] } }), ctx), () => runs.updateEngineRunInputs],
    ["calculate run", () => runAction(request(`runs/${RUN_ID}/calculate`, { method: "POST", body: {} }), { params: Promise.resolve({ id: RUN_ID, action: "calculate" }) }), () => runs.calculateEngineRun],
    ["review run", () => runAction(request(`runs/${RUN_ID}/review`, { method: "POST", body: {} }), { params: Promise.resolve({ id: RUN_ID, action: "review" }) }), () => runs.reviewEngineRun],
    ["approve run", () => runAction(request(`runs/${RUN_ID}/approve`, { method: "POST", body: {} }), { params: Promise.resolve({ id: RUN_ID, action: "approve" }) }), () => runs.approveEngineRun],
    ["post run", () => runAction(request(`runs/${RUN_ID}/post`, { method: "POST", body: {} }), { params: Promise.resolve({ id: RUN_ID, action: "post" }) }), () => runs.postEngineRun],
    ["pay run", () => runAction(request(`runs/${RUN_ID}/pay`, { method: "POST", body: { method: "bank", paidDate: "2025-08-31", paymentAccountId: "55555555-5555-4555-8555-555555555555" } }), { params: Promise.resolve({ id: RUN_ID, action: "pay" }) }), () => runs.payEngineRun],
    ["close run", () => runAction(request(`runs/${RUN_ID}/close`, { method: "POST", body: {} }), { params: Promise.resolve({ id: RUN_ID, action: "close" }) }), () => runs.closeEngineRun],
    ["cancel run", () => runAction(request(`runs/${RUN_ID}/cancel`, { method: "POST", body: {} }), { params: Promise.resolve({ id: RUN_ID, action: "cancel" }) }), () => runs.cancelEngineRun],
  ];

  it.each(reads)("%s requires only payroll.view", async (_name, call) => {
    expect((await call()).status).toBe(200);
    expect(auth.requirePermission).toHaveBeenCalledTimes(1);
    expect(auth.requirePermission).toHaveBeenCalledWith(PERMISSIONS.payrollView);
  });

  it.each(writes)("%s requires payroll.manage", async (_name, call) => {
    const response = await call();
    expect([200, 201]).toContain(response.status);
    expect(auth.requirePermission).toHaveBeenCalledTimes(1);
    expect(auth.requirePermission).toHaveBeenCalledWith(PERMISSIONS.payrollManage);
  });

  it.each([...reads, ...writes])("%s refuses a missing capability before touching its service", async (_name, call, service) => {
    vi.mocked(auth.requirePermission).mockResolvedValue(denied());
    const response = await call();
    expect(response.status).toBe(403);
    expect(service()).not.toHaveBeenCalled();
  });

  it("binds run creation to all normalized request inputs and the header idempotency key", async () => {
    await createRun(request("runs", {
      method: "POST",
      headers: { "Idempotency-Key": "engine-key-001" },
      body: { periodKey: "1404-05", runType: "supplemental", accrualDate: "2025-08-20", includeCommission: true, inputs: { [USER_ID]: { overtimeHours: -1 } } },
    }));
    expect(runs.createEngineRun).toHaveBeenCalledWith({
      businessId: BUSINESS_ID,
      actorId: USER_ID,
      periodKey: "1404-05",
      runType: "supplemental",
      accrualDate: "2025-08-20",
      includeCommission: true,
      inputs: { [USER_ID]: { overtimeHours: -1 } },
      note: undefined,
      idempotencyKey: "engine-key-001",
    });
  });

  it("passes the selected payout account and date to the locked posting service", async () => {
    await runAction(request(`runs/${RUN_ID}/pay`, { method: "POST", body: { method: "bank", paidDate: "2025-08-31", paymentAccountId: "55555555-5555-4555-8555-555555555555" } }), { params: Promise.resolve({ id: RUN_ID, action: "pay" }) });
    expect(runs.payEngineRun).toHaveBeenCalledWith({
      businessId: BUSINESS_ID,
      runId: RUN_ID,
      actorId: USER_ID,
      method: "bank",
      paidDate: "2025-08-31",
      paymentAccountId: "55555555-5555-4555-8555-555555555555",
    });
  });

  it("returns a typed service conflict instead of swallowing it", async () => {
    vi.mocked(runs.updateEngineRunInputs).mockRejectedValue(new PayrollError("run_immutable", 409));
    const response = await patchRun(request(`runs/${RUN_ID}`, { method: "PATCH", body: { inputMode: "merge", inputs: {} } }), ctx);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "run_immutable" });
  });
});
