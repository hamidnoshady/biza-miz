// @vitest-environment jsdom

/**
 * The #865 payroll workspace, end to end against a fake server behind `fetch`:
 * the tab strip keeps the #835 monthly screen and adds the engine; a
 * correction run takes signed overtime and sends it as a negative number; a
 * debt shows as a debt, not a negative net; the reconciliation reports its
 * state; and the engine screens show a skeleton while their first fetch is in
 * flight.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MoneyProvider } from "@/components/money/money-context";
import type { Runner } from "./accounting-manager";
import { PayrollWorkspace } from "./payroll-workspace";

const router = { push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn(), refresh: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: () => "/accounting/payroll" }));

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const ALI = "22222222-2222-4222-8222-222222222222";

const supplementalRun = (status = "draft") => ({
  id: RUN_ID,
  periodKey: "1404-05",
  periodLabel: "مرداد ۱۴۰۴",
  runType: "supplemental",
  sequence: 2,
  status,
  accrualDate: "2025-08-22",
  includeCommission: false,
  note: null,
  inputs: {},
  ruleSetId: null,
  ruleSetVersion: 1,
  totals:
    status === "draft"
      ? null
      : {
          employees: 1,
          gross: "-6562500",
          employeeInsurance: "0",
          employerInsurance: "0",
          unemploymentInsurance: "0",
          incomeTax: "0",
          totalDeductions: "0",
          netPay: "0",
          employeeDebt: "6562500",
          employerCost: "-6562500",
          commission: "0",
        },
  accrualEntryIds: [],
  paymentEntryId: null,
  paidDate: null,
  createdAt: "2025-08-22T10:00:00Z",
  approvedAt: null,
  postedAt: null,
  closedAt: null,
});

const profile = {
  userId: ALI,
  fullName: "علی",
  employeeCode: null,
  payrollCode: null,
  employmentType: "full_time",
  hireDate: "2025-03-21",
  terminationDate: null,
  baseSalary: "90000000",
  insuranceProfile: { insured: false },
  taxProfile: { exempt: true },
  paymentDestination: { method: "bank" },
  costAllocation: [],
  isActive: true,
  configured: true,
};

const debtSlip = {
  id: "slip-1",
  runId: RUN_ID,
  periodKey: "1404-05",
  runType: "supplemental",
  sequence: 2,
  runStatus: "calculated",
  userId: ALI,
  employeeName: "علی",
  employeeCode: null,
  earnings: [{ code: "OVERTIME", name: "اضافه‌کاری", amount: "-6562500" }],
  deductions: [],
  employerContributions: [],
  gross: "-6562500",
  taxableBase: "0",
  insuranceBase: "0",
  employeeInsurance: "0",
  employerInsurance: "0",
  unemploymentInsurance: "0",
  incomeTax: "0",
  totalDeductions: "0",
  netPay: "0",
  employeeDebt: "6562500",
  employerCost: "-6562500",
  baseSalary: "90000000",
  workedDays: 30,
  overtimeHours: -10,
  unpaidLeaveDays: 0,
  costAllocation: [],
  paymentStatus: "unpaid",
  paidAt: null,
};

interface Recorded {
  method: string;
  url: string;
  body: unknown;
}

let requests: Recorded[] = [];
let runStatus = "draft";
let holdRuns: Promise<void> | null = null;

function respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input);
  const method = init?.method ?? "GET";
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
  requests.push({ method, url, body });
  if (url === "/api/ledger/payroll/engine/runs" && method === "GET") {
    if (holdRuns) await holdRuns;
    return respond(200, { runs: [supplementalRun(runStatus)] });
  }
  if (url === "/api/ledger/payroll/engine/profiles") return respond(200, { profiles: [profile] });
  if (url === `/api/ledger/payroll/engine/runs/${RUN_ID}` && method === "GET") {
    return respond(200, { run: supplementalRun(runStatus), payslips: runStatus === "draft" ? [] : [debtSlip] });
  }
  if (url === `/api/ledger/payroll/engine/runs/${RUN_ID}` && method === "PATCH") return respond(200, { run: supplementalRun(runStatus) });
  if (url === `/api/ledger/payroll/engine/runs/${RUN_ID}/calculate`) {
    runStatus = "calculated";
    return respond(200, { run: supplementalRun(runStatus) });
  }
  if (url === "/api/ledger/payroll/engine/reports/reconciliation") {
    return respond(200, {
      runs: 1,
      payslips: 1,
      reconciled: false,
      accounts: [{ code: "2300", expected: "100", glFromEngine: "90", difference: "-10", glTotal: "90" }],
    });
  }
  // The #835 monthly screen's requests are not under test here.
  return respond(404, { error: "not_found" });
}

const run: Runner = async (fn) => (await fn()).ok;

function renderWorkspace() {
  return render(
    <MoneyProvider unit="rial">
      <PayrollWorkspace busy={false} run={run} refreshKey={0} canManage ownerKey="owner" />
    </MoneyProvider>,
  );
}

beforeEach(() => {
  requests = [];
  runStatus = "draft";
  holdRuns = null;
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  vi.stubGlobal("fetch", vi.fn(fakeFetch));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("payroll workspace", () => {
  it("keeps the #835 monthly screen as the first tab and adds the engine's tabs", () => {
    renderWorkspace();
    const tabs = within(screen.getByRole("tablist", { name: "بخش‌های حقوق و دستمزد" })).getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["حقوق ماهانه ساده", "اجرای حقوق", "پرونده کارکنان", "قوانین و اجزا", "گزارش‌ها"]);
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
  });

  it("shows a skeleton while the runs load, then the runs", async () => {
    let release!: () => void;
    holdRuns = new Promise((r) => (release = r));
    renderWorkspace();
    fireEvent.click(screen.getByRole("tab", { name: "اجرای حقوق" }));
    expect(screen.getByRole("status", { name: "در حال بارگذاری اجراها" })).toBeTruthy();
    release();
    expect(await screen.findByText("مرداد ۱۴۰۴")).toBeTruthy();
    expect(screen.getByText("اصلاحی ۱")).toBeTruthy();
  });

  it("sends a correction's overtime as a negative number and shows the result as a debt", async () => {
    renderWorkspace();
    fireEvent.click(screen.getByRole("tab", { name: "اجرای حقوق" }));
    fireEvent.click(await screen.findByRole("button", { name: "جزئیات" }));
    const overtime = await screen.findByLabelText("اضافه‌کاری علی");
    fireEvent.change(overtime, { target: { value: "-10" } });
    fireEvent.click(screen.getByRole("button", { name: "محاسبه" }));
    await waitFor(() => expect(requests.some((r) => r.url.endsWith("/calculate"))).toBe(true));
    const patch = requests.find((r) => r.method === "PATCH")!;
    expect(patch.body).toEqual({ inputs: { [ALI]: { overtimeHours: -10 } } });
    // The PATCH lands before the calculate, never after.
    expect(requests.findIndex((r) => r.method === "PATCH")).toBeLessThan(requests.findIndex((r) => r.url.endsWith("/calculate")));
    expect(await screen.findByText(/^بدهی/)).toBeTruthy();
  });

  it("reports a reconciliation difference", async () => {
    renderWorkspace();
    fireEvent.click(screen.getByRole("tab", { name: "گزارش‌ها" }));
    fireEvent.change(screen.getByLabelText("گزارش"), { target: { value: "reconciliation" } });
    expect(await screen.findByText("مغایرت", { selector: "span *, span" })).toBeTruthy();
    expect(requests.some((r) => r.url === "/api/ledger/payroll/engine/reports/reconciliation")).toBe(true);
  });
});
