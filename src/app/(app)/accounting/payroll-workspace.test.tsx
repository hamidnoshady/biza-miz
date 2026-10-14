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
import { jalaliToIsoDate, todayJalali } from "@/lib/jalali";
import type { Runner } from "./accounting-manager";
import { PayrollWorkspace } from "./payroll-workspace";
import type { PayrollComponent } from "./payroll-engine-shared";

const router = { push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn(), refresh: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: () => "/accounting/payroll" }));

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const ALI = "22222222-2222-4222-8222-222222222222";
const HIDDEN = "33333333-3333-4333-8333-333333333333";
const COMPONENT_ID = "44444444-4444-4444-8444-444444444444";
const CASH_ID = "55555555-5555-4555-8555-555555555555";
const BANK_ID = "66666666-6666-4666-8666-666666666666";
const HOUSING_COMPONENT: PayrollComponent = {
  id: COMPONENT_ID, code: "HOUSING", name: "حق مسکن", kind: "earning", systemKey: null,
  taxable: true, insurable: false, debitAccountCode: "5200", creditAccountCode: "2300",
  effectiveFrom: "2000-01-01", effectiveTo: null, isActive: true,
};
const COMPONENT_ACCOUNTS = [
  { id: "account-expense", code: "5200", name: "هزینه حقوق", type: "expense" },
  { id: "account-payable", code: "2300", name: "حقوق پرداختنی", type: "liability" },
  { id: CASH_ID, code: "1100", name: "صندوق", type: "asset" },
  { id: BANK_ID, code: "1110", name: "بانک", type: "asset" },
];
const PAYMENT_ACCOUNTS = [
  { id: CASH_ID, code: "1100", name: "صندوق", role: "cash" },
  { id: BANK_ID, code: "1110", name: "بانک", role: "bank" },
];

let runInputs: Record<string, unknown> = {};
let componentCatalog: { components: PayrollComponent[]; accounts: typeof COMPONENT_ACCOUNTS } = { components: [HOUSING_COMPONENT], accounts: COMPONENT_ACCOUNTS };
let createFailures = 0;

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
  inputs: JSON.parse(JSON.stringify(runInputs)) as Record<string, unknown>,
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
  idempotencyKey: string | null;
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
  const headers = new Headers(init?.headers);
  requests.push({ method, url, body, idempotencyKey: headers.get("Idempotency-Key") });
  if (url === "/api/ledger/payroll/engine/runs" && method === "POST") {
    if (createFailures > 0) {
      createFailures--;
      return respond(503, { error: "server_error" });
    }
    return respond(201, { run: supplementalRun("draft") });
  }
  if (url === "/api/ledger/payroll/engine/runs" && method === "GET") {
    if (holdRuns) await holdRuns;
    return respond(200, { runs: [supplementalRun(runStatus)] });
  }
  if (url === "/api/ledger/payroll/engine/profiles") return respond(200, { profiles: [profile] });
  if (url === `/api/ledger/payroll/engine/profiles/${ALI}` && method === "GET") return respond(200, { profile, items: [], changes: [] });
  if (url === `/api/ledger/payroll/engine/profiles/${ALI}` && method === "PUT") return respond(200, { profile });
  if (url === "/api/ledger/payroll/engine/components" && method === "GET") return respond(200, componentCatalog);
  if (url === "/api/ledger/payroll/engine/components" && method === "POST") return respond(201, { component: { ...HOUSING_COMPONENT, ...body } });
  if (url === `/api/ledger/payroll/engine/components/${COMPONENT_ID}` && method === "PATCH") return respond(200, { component: { ...HOUSING_COMPONENT, ...body } });
  if (url === `/api/ledger/payroll/engine/components/${COMPONENT_ID}` && method === "GET") return respond(200, { changes: [] });
  if (url === "/api/ledger/payroll/engine/items" && method === "POST") return respond(201, { item: { id: "item-1" } });
  if (url === "/api/ledger/payroll/engine/items/item-1" && method === "PATCH") return respond(200, { item: { id: "item-1" } });
  if (url === "/api/ledger/payroll/engine/items/item-1" && method === "GET") return respond(200, { changes: [] });
  if (url === "/api/locations/active") return respond(200, { locations: [{ id: "location-1", name: "شعبه مرکزی" }] });
  if (url === "/api/ai/projects") return respond(200, { projects: [{ id: "project-1", name: "پروژه الف" }] });
  if (url === "/api/ledger/payroll/preview?includeCommission=false") return respond(200, { paymentAccounts: PAYMENT_ACCOUNTS });
  if (url === `/api/ledger/payroll/engine/runs/${RUN_ID}` && method === "GET") {
    return respond(200, { run: supplementalRun(runStatus), payslips: runStatus === "draft" ? [] : [debtSlip] });
  }
  if (url === `/api/ledger/payroll/engine/runs/${RUN_ID}` && method === "PATCH") return respond(200, { run: supplementalRun(runStatus) });
  if (url === `/api/ledger/payroll/engine/runs/${RUN_ID}/calculate`) {
    runStatus = "calculated";
    return respond(200, { run: supplementalRun(runStatus) });
  }
  if (url === `/api/ledger/payroll/engine/runs/${RUN_ID}/pay` && method === "POST") {
    runStatus = "paid";
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
  if (url.startsWith("/api/ledger/payroll/engine/reports/employee-card?")) {
    const query = new URL(url, "http://localhost").searchParams;
    return respond(200, { year: query.get("year"), payslips: [], totals: {} });
  }
  if (url.startsWith("/api/ledger/payroll/engine/reports/comparison?")) {
    return respond(200, { a: null, b: null, difference: {} });
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
  runInputs = {};
  componentCatalog = { components: [HOUSING_COMPONENT], accounts: COMPONENT_ACCOUNTS };
  createFailures = 0;
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

  it("exposes the complete employee setup and submits the selected payment account and statutory fields", async () => {
    renderWorkspace();
    fireEvent.click(screen.getByRole("tab", { name: "پرونده کارکنان" }));
    await screen.findByText("علی");
    fireEvent.click(screen.getByRole("button", { name: "ویرایش پرونده" }));

    fireEvent.change(screen.getByLabelText("کد پرسنلی"), { target: { value: "۰۰۷" } });
    fireEvent.change(screen.getByLabelText("نوع همکاری"), { target: { value: "part_time" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "مشمول بیمه" }));
    fireEvent.change(await screen.findByLabelText(/شمارهٔ بیمه/), { target: { value: "12345678901" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "معاف از مالیات حقوق" }));
    fireEvent.change(screen.getByLabelText(/کد ملی مالیاتی/), { target: { value: "0084575980" } });

    const accountSelect = screen.getByRole("button", { name: "حساب پرداخت کسب‌وکار" });
    await waitFor(() => expect((accountSelect as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(accountSelect);
    fireEvent.click(await screen.findByRole("option", { name: /1110/ }));
    fireEvent.click(screen.getByRole("button", { name: "ذخیره پرونده" }));

    await waitFor(() => expect(requests.some((request) => request.method === "PUT" && request.url.endsWith(`/profiles/${ALI}`))).toBe(true));
    const save = requests.find((request) => request.method === "PUT" && request.url.endsWith(`/profiles/${ALI}`))!;
    expect(save.body).toMatchObject({
      employeeCode: "۰۰۷",
      employmentType: "part_time",
      insuranceProfile: { insured: true, insuranceNumber: "12345678901" },
      taxProfile: { exempt: false, nationalId: "0084575980" },
      paymentDestination: { method: "bank", paymentAccountId: BANK_ID },
    });
  });

  it("creates a component from the payroll UI with a Jalali effective date and canonical ledger mapping", async () => {
    renderWorkspace();
    fireEvent.click(screen.getByRole("tab", { name: "قوانین و اجزا" }));
    fireEvent.click(await screen.findByRole("button", { name: "جزء تازه" }));
    fireEvent.change(screen.getByLabelText("کد جزء حقوق"), { target: { value: "MEAL" } });
    fireEvent.change(screen.getByLabelText("عنوان"), { target: { value: "کمک‌هزینه غذا" } });
    fireEvent.click(screen.getByRole("button", { name: "شروع اعتبار جزء حقوق" }));
    fireEvent.click(await screen.findByRole("button", { name: "امروز" }));
    fireEvent.click(screen.getByRole("button", { name: "ذخیره جزء" }));

    await waitFor(() => expect(requests.some((request) => request.method === "POST" && request.url.endsWith("/components"))).toBe(true));
    const save = requests.find((request) => request.method === "POST" && request.url.endsWith("/components"))!;
    expect(save.body).toMatchObject({ code: "MEAL", name: "کمک‌هزینه غذا", kind: "earning", debitAccountCode: "5200", creditAccountCode: "2300" });
    expect((save.body as { effectiveFrom: string }).effectiveFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("keeps system component codes editable but locks statutory flags and effective dates", async () => {
    componentCatalog = {
      components: [{ ...HOUSING_COMPONENT, code: "BASE", name: "حقوق پایه", systemKey: "base_wage" }],
      accounts: COMPONENT_ACCOUNTS,
    };
    renderWorkspace();
    fireEvent.click(screen.getByRole("tab", { name: "قوانین و اجزا" }));
    await screen.findByText("BASE");
    fireEvent.click(screen.getByRole("button", { name: "ویرایش" }));
    expect((screen.getByLabelText("کد جزء حقوق") as HTMLInputElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "شروع اعتبار جزء حقوق" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "پایان اعتبار جزء حقوق" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("checkbox", { name: "مشمول مالیات" }) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("checkbox", { name: "مشمول بیمه" }) as HTMLInputElement).disabled).toBe(true);
  });

  it("adds a recurring payroll item from the employee file with an explicit effective date", async () => {
    renderWorkspace();
    fireEvent.click(screen.getByRole("tab", { name: "پرونده کارکنان" }));
    await screen.findByText("علی");
    fireEvent.click(screen.getByRole("button", { name: "مزایا و کسور" }));
    await screen.findByText("افزودن قلم تکرارشونده");
    fireEvent.change(screen.getByLabelText(/مبلغ ماهانه/), { target: { value: "750000" } });
    fireEvent.click(screen.getByRole("button", { name: "شروع اعتبار قلم" }));
    fireEvent.click(await screen.findByRole("button", { name: "امروز" }));
    fireEvent.click(screen.getByRole("button", { name: "افزودن قلم" }));

    await waitFor(() => expect(requests.some((request) => request.method === "POST" && request.url.endsWith("/items"))).toBe(true));
    const save = requests.find((request) => request.method === "POST" && request.url.endsWith("/items"))!;
    expect(save.body).toMatchObject({ userId: ALI, componentId: COMPONENT_ID, amount: "750000", note: null });
    expect((save.body as { effectiveFrom: string }).effectiveFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);
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
    expect(patch.body).toEqual({
      inputMode: "merge",
      inputs: { [ALI]: { overtimeHours: -10, unpaidLeaveDays: null, items: [] } },
      removeEmployeeIds: [],
      includeCommission: false,
    });
    // The PATCH lands before the calculate, never after.
    expect(requests.findIndex((r) => r.method === "PATCH")).toBeLessThan(requests.findIndex((r) => r.url.endsWith("/calculate")));
    // Anchored to the amount: the runs table's «بدهی کارکنان» header can still
    // be mounted while the details render, and would make a bare /^بدهی/ ambiguous.
    expect(await screen.findByText(/^بدهی\s*[۰-۹0-9]/)).toBeTruthy();
  });

  it("merges a typed edit without dropping an existing manual item or a hidden employee input", async () => {
    runInputs = {
      [ALI]: { overtimeHours: 0, unpaidLeaveDays: 0, items: [{ code: "BONUS", amount: "250000" }] },
      [HIDDEN]: { overtimeHours: 2, unpaidLeaveDays: 1, items: [{ code: "MEAL", amount: "100000" }] },
    };
    renderWorkspace();
    fireEvent.click(screen.getByRole("tab", { name: "اجرای حقوق" }));
    fireEvent.click(await screen.findByRole("button", { name: "جزئیات" }));
    expect(await screen.findByText(/ورودی‌های ۱ کارمندِ غیرفعال یا پنهان/)).toBeTruthy();
    fireEvent.change(await screen.findByLabelText("اضافه‌کاری علی"), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "ذخیرهٔ ورودی‌ها" }));
    await waitFor(() => expect(requests.some((request) => request.method === "PATCH")).toBe(true));
    const patch = requests.find((request) => request.method === "PATCH")!;
    expect(patch.body).toEqual({
      inputMode: "merge",
      inputs: { [ALI]: { overtimeHours: 3, unpaidLeaveDays: 0, items: [{ code: "BONUS", amount: "250000" }] } },
      removeEmployeeIds: [],
      includeCommission: false,
    });
    expect((patch.body as { inputs: Record<string, unknown> }).inputs).not.toHaveProperty(HIDDEN);
  });

  it("only removes hidden employee inputs after the manager explicitly requests it", async () => {
    runInputs = {
      [ALI]: { overtimeHours: 1, unpaidLeaveDays: 0, items: [] },
      [HIDDEN]: { overtimeHours: 2, unpaidLeaveDays: 1, items: [{ code: "MEAL", amount: "100000" }] },
    };
    renderWorkspace();
    fireEvent.click(screen.getByRole("tab", { name: "اجرای حقوق" }));
    fireEvent.click(await screen.findByRole("button", { name: "جزئیات" }));
    expect(await screen.findByRole("button", { name: "حذف صریح ورودی‌های پنهان" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "ذخیرهٔ ورودی‌ها" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "حذف صریح ورودی‌های پنهان" }));
    fireEvent.click(screen.getByRole("button", { name: "ذخیرهٔ ورودی‌ها" }));
    await waitFor(() => expect(requests.some((request) => request.method === "PATCH")).toBe(true));
    const patch = requests.find((request) => request.method === "PATCH")!;
    expect((patch.body as { removeEmployeeIds: string[] }).removeEmployeeIds).toEqual([HIDDEN]);
  });

  it("reuses the idempotency key when the same create request is retried", async () => {
    createFailures = 1;
    renderWorkspace();
    fireEvent.click(screen.getByRole("tab", { name: "اجرای حقوق" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "تسویهٔ پورسانت‌های پرداخت‌نشده در این اجرا" }));
    const createButton = screen.getByRole("button", { name: "ایجاد اجرا" });
    fireEvent.click(createButton);
    await waitFor(() => expect(requests.filter((request) => request.method === "POST" && request.url.endsWith("/runs")).length).toBe(1));
    fireEvent.click(createButton);
    await waitFor(() => expect(requests.filter((request) => request.method === "POST" && request.url.endsWith("/runs")).length).toBe(2));
    const creates = requests.filter((request) => request.method === "POST" && request.url.endsWith("/runs"));
    expect(creates[0].body).toEqual(creates[1].body);
    expect(creates[0].idempotencyKey).toBeTruthy();
    expect(creates[0].idempotencyKey).toBe(creates[1].idempotencyKey);
    expect((creates[0].body as { includeCommission: boolean }).includeCommission).toBe(true);
  });

  it("pays an engine run from the selected Financial Account on the selected Jalali date", async () => {
    runStatus = "posted";
    renderWorkspace();
    fireEvent.click(screen.getByRole("tab", { name: "اجرای حقوق" }));
    fireEvent.click(await screen.findByRole("button", { name: "جزئیات" }));

    const accountPicker = await screen.findByRole("button", { name: "حساب پرداخت اجرای حقوق" });
    await waitFor(() => expect((accountPicker as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(accountPicker);
    fireEvent.click(await screen.findByRole("option", { name: /1110 — بانک/ }));

    const today = todayJalali();
    const day = 20;
    const expectedDate = jalaliToIsoDate(today.jy, today.jm, day);
    fireEvent.click(screen.getByRole("button", { name: "تاریخ پرداخت اجرای حقوق" }));
    const calendar = await screen.findByRole("dialog", { name: "انتخاب تاریخ شمسی" });
    const persianDay = String(day).replace(/\d/g, (digit) => "۰۱۲۳۴۵۶۷۸۹"[Number(digit)]);
    fireEvent.click(within(calendar).getByRole("button", { name: new RegExp(`^${persianDay} `) }));
    fireEvent.click(screen.getByRole("button", { name: "پرداخت" }));

    await waitFor(() => expect(requests.some((request) => request.method === "POST" && request.url.endsWith("/pay"))).toBe(true));
    const pay = requests.find((request) => request.method === "POST" && request.url.endsWith("/pay"))!;
    expect(pay.body).toEqual({ method: "bank", paidDate: expectedDate, paymentAccountId: BANK_ID });
  });

  it("requests the employee card with an explicit Jalali year and compares two explicit periods", async () => {
    renderWorkspace();
    fireEvent.click(screen.getByRole("tab", { name: "گزارش‌ها" }));
    const reportSelect = await screen.findByLabelText("گزارش");
    fireEvent.change(reportSelect, { target: { value: "employee-card" } });
    const employeePicker = await screen.findByRole("button", { name: "کارمند برای کارت حقوق" });
    fireEvent.click(employeePicker);
    fireEvent.click(await screen.findByRole("option", { name: /علی/ }));
    const yearSelect = screen.getByLabelText("سال شمسی") as HTMLSelectElement;
    const selectedYear = yearSelect.options[1].value;
    fireEvent.change(yearSelect, { target: { value: selectedYear } });
    await waitFor(() => expect(requests.some((request) => request.url.startsWith("/api/ledger/payroll/engine/reports/employee-card?"))).toBe(true));
    const cardRequests = requests.filter((request) => request.url.startsWith("/api/ledger/payroll/engine/reports/employee-card?"));
    const cardQuery = new URL(cardRequests.at(-1)!.url, "http://localhost").searchParams;
    expect(cardQuery.get("userId")).toBe(ALI);
    expect(cardQuery.get("year")).toBe(selectedYear);

    fireEvent.change(reportSelect, { target: { value: "comparison" } });
    await waitFor(() => expect(requests.some((request) => request.url.startsWith("/api/ledger/payroll/engine/reports/comparison?"))).toBe(true));
    const compareRequest = requests.filter((request) => request.url.startsWith("/api/ledger/payroll/engine/reports/comparison?")).at(-1)!;
    const comparison = new URL(compareRequest.url, "http://localhost").searchParams;
    expect(comparison.get("a")).toMatch(/^\d{4}-\d{2}$/);
    expect(comparison.get("b")).toMatch(/^\d{4}-\d{2}$/);
    expect(comparison.get("a")).not.toBe(comparison.get("b"));
  });

  it("reports a reconciliation difference", async () => {
    renderWorkspace();
    fireEvent.click(screen.getByRole("tab", { name: "گزارش‌ها" }));
    fireEvent.change(screen.getByLabelText("گزارش"), { target: { value: "reconciliation" } });
    expect(await screen.findByText("مغایرت", { selector: "span *, span" })).toBeTruthy();
    expect(requests.some((r) => r.url === "/api/ledger/payroll/engine/reports/reconciliation")).toBe(true);
  });
});
