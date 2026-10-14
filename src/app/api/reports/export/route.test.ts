/**
 * The trial-balance export branch of the shared report exporter (issue #820).
 *
 * Two things this pins that a screen test cannot:
 *
 *  - **The permission model is the existing one.** Exporting needs
 *    `reports.export` — the platform-wide report-download grant — *and*
 *    `ledger.view`, because the trial balance is an accounting report rather
 *    than a business-insight one. No trial-balance-specific export key.
 *  - **The file carries the report's identity, not just its numbers.** Business
 *    name, title, the selected period, the generation date in Shamsi, the
 *    account code/name/type and the totals — and the balance and ledger-health
 *    states, kept as two separate lines because they are two separate facts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import * as auth from "@/lib/auth";
import * as settings from "@/lib/settings";
import * as ledgerReports from "@/lib/ledger-reports-service";
import * as pdfRender from "@/lib/pdf-render";
import * as reportsService from "@/lib/reports-service";
import * as setupState from "@/lib/setup-state";
import * as shiftOrdersService from "@/lib/shift-orders-service";
import { PERMISSIONS } from "@/lib/permissions";
import { POST } from "./route";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requirePermission: vi.fn(),
    withTenantScope: (handler: (...args: unknown[]) => Promise<NextResponse>) => handler,
  };
});

vi.mock("@/lib/industry-guard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/industry-guard")>();
  return { ...actual, getBusinessIndustry: vi.fn(async () => "food_service") };
});

vi.mock("@/lib/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/settings")>();
  return { ...actual, getSetting: vi.fn() };
});

vi.mock("@/lib/ledger-reports-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ledger-reports-service")>();
  return { ...actual, getTrialBalance: vi.fn() };
});

// The PDF branch renders through a real browser engine; a unit test must not
// launch one. It also reads the business's letterhead, which is a DB read.
vi.mock("@/lib/pdf-render", () => ({ renderHtmlToPdf: vi.fn(async () => Buffer.from("%PDF-1.7")) }));

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return {
    ...actual,
    query: vi.fn(async () => ({ rows: [{ name: "کافه نمونه" }] })),
  };
});

vi.mock("@/lib/setup-state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/setup-state")>();
  return {
    ...actual,
    getPrimaryLocation: vi.fn(async () => ({ address: "تهران", phone: "021" })),
    // The file's branch scope, read the same way the query route reads it.
    resolveActiveLocation: vi.fn(),
  };
});

vi.mock("@/lib/shift-orders-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/shift-orders-service")>();
  return { ...actual, getShiftOrdersReport: vi.fn() };
});

vi.mock("@/lib/reports-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/reports-service")>();
  return {
    ...actual,
    runCustomReportQuery: vi.fn(),
    getBusinessOverview: vi.fn(async () => ({ branches: [], consolidated: { subtotal: 0, discount: 0, tax: 0, total: 0, cogs: 0, wasteCost: 0, orderCount: 0 } })),
    getProfitAndLoss: vi.fn(),
    getBalanceSheet: vi.fn(),
    getCashFlow: vi.fn(),
  };
});

const SESSION = { businessId: "biz-1", sub: "user-1", role: "manager" };

function account(overrides: Record<string, unknown> = {}) {
  return {
    id: "acc-1",
    code: "1100",
    name: "صندوق",
    type: "asset",
    isActive: true,
    parentId: null,
    parentCode: null,
    level: "moein",
    hasChildren: false,
    isContra: false,
    normalBalance: "debit",
    isAbnormalBalance: false,
    openingDebit: "0",
    openingCredit: "0",
    periodDebit: "1000000",
    periodCredit: "400000",
    closingDebit: "600000",
    closingCredit: "0",
    ...overrides,
  };
}

const REPORT = {
  businessName: "کافه نمونه",
  mode: "detailed" as const,
  periodFrom: "2026-03-01",
  periodTo: "2026-03-31",
  asOf: null,
  accounts: [
    account(),
    account({ id: "acc-2", code: "4100", name: "درآمد فروش", type: "revenue", normalBalance: "credit", periodDebit: "0", periodCredit: "1000000", closingDebit: "0", closingCredit: "1000000" }),
    account({ id: "acc-3", code: "5300", name: "اجاره", type: "expense", periodDebit: "400000", periodCredit: "0", closingDebit: "400000", closingCredit: "0" }),
  ],
  totals: {
    openingDebit: "0", openingCredit: "0", periodDebit: "1400000",
    periodCredit: "1400000", closingDebit: "1000000", closingCredit: "1000000",
    closingDifference: "0",
  },
  trialBalanceBalanced: true,
  activity: { entryCount: 2, lineCount: 4 },
  integrity: {
    ledgerHealthy: true, entryCount: 2, lineCount: 4,
    unbalancedEntryCount: 0, invalidEntryCount: 0, balanceDifference: "0",
  },
};

function postRequest(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

function csvOf(response: NextResponse): Promise<string> {
  return response.text();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
  vi.mocked(settings.getSetting).mockResolvedValue({ currencyDisplay: "rial" } as never);
  vi.mocked(ledgerReports.getTrialBalance).mockResolvedValue(REPORT as never);
  vi.mocked(setupState.resolveActiveLocation).mockResolvedValue({ id: "loc-b" } as never);
  vi.mocked(reportsService.runCustomReportQuery).mockResolvedValue([
    { dim: "2026-01-01", value: 1_250_000 },
  ] as never);
});

const MONEY_CONFIG = {
  view: "v_sales_by_day",
  metric: "total",
  aggregation: "sum" as const,
  dimension: "day",
};

describe("POST /api/reports/export request validation", () => {
  it("rejects non-object JSON bodies instead of throwing while reading fields", async () => {
    for (const body of [null, [], "csv"]) {
      const response = await POST(postRequest(body));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "bad_request" });
    }
    expect(ledgerReports.getTrialBalance).not.toHaveBeenCalled();
    expect(reportsService.runCustomReportQuery).not.toHaveBeenCalled();
  });

  it("rejects malformed title, date, query and option shapes before execution", async () => {
    for (const body of [
      { format: "csv", title: 7 },
      { format: "csv", kind: "pnl", dateFrom: "2026-02-30" },
      { format: "csv", kind: "pnl", dateFrom: "2026-03-31", dateTo: "2026-03-01" },
      { format: "csv", kind: "shift_orders", query: { page: 1 } },
      { format: "csv", kind: "trial_balance", trialBalanceOptions: [] },
    ]) {
      expect((await POST(postRequest(body))).status).toBe(400);
    }
    expect(ledgerReports.getTrialBalance).not.toHaveBeenCalled();
    expect(reportsService.runCustomReportQuery).not.toHaveBeenCalled();
  });

  it("rejects a null chart config without reaching the report engine", async () => {
    const response = await POST(postRequest({ format: "csv", kind: "chart", config: null }));
    expect(response.status).toBe(400);
    expect(reportsService.runCustomReportQuery).not.toHaveBeenCalled();
  });
});

/** The insight branches below speak the business's display unit, not Rial. */
function useTomanDisplayUnit() {
  vi.mocked(settings.getSetting).mockResolvedValue({ currencyDisplay: "toman" } as never);
}

describe("POST /api/reports/export (kind=trial_balance)", () => {
  it("requires reports.export first", async () => {
    const denied = NextResponse.json({ error: "forbidden" }, { status: 403 });
    vi.mocked(auth.requirePermission).mockResolvedValue({ session: null, error: denied } as never);

    const response = await POST(postRequest({
      format: "csv", kind: "trial_balance", dateFrom: "2026-03-01", dateTo: "2026-03-31",
    }));

    expect(response).toBe(denied);
    expect(auth.requirePermission).toHaveBeenCalledWith(PERMISSIONS.reportsExport);
    expect(ledgerReports.getTrialBalance).not.toHaveBeenCalled();
  });

  it("also requires ledger.view, the trial balance's own page gate", async () => {
    const denied = NextResponse.json({ error: "forbidden" }, { status: 403 });
    vi.mocked(auth.requirePermission).mockImplementation(async (permission) =>
      permission === PERMISSIONS.reportsExport
        ? ({ session: SESSION, error: null } as never)
        : ({ session: null, error: denied } as never),
    );

    const response = await POST(postRequest({
      format: "csv", kind: "trial_balance", dateFrom: "2026-03-01", dateTo: "2026-03-31",
    }));

    expect(response).toBe(denied);
    expect(auth.requirePermission).toHaveBeenCalledWith(PERMISSIONS.ledgerView);
    expect(ledgerReports.getTrialBalance).not.toHaveBeenCalled();
  });

  it("does not invent a trial-balance-specific export permission", async () => {
    await POST(postRequest({
      format: "csv", kind: "trial_balance", dateFrom: "2026-03-01", dateTo: "2026-03-31",
    }));
    const asked = vi.mocked(auth.requirePermission).mock.calls.map(([permission]) => permission);
    expect(asked).toEqual([PERMISSIONS.reportsExport, PERMISSIONS.ledgerView]);
  });

  it("exports a CSV carrying the report's identity and every amount", async () => {
    const response = await POST(postRequest({
      format: "csv", kind: "trial_balance", dateFrom: "2026-03-01", dateTo: "2026-03-31",
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/csv");
    expect(response.headers.get("content-disposition")).toContain("filename*=UTF-8''");

    const csv = await csvOf(response);
    // Business, title, selected range, generation date and both states.
    expect(csv).toContain("کافه نمونه");
    expect(csv).toContain("تراز آزمایشی");
    expect(csv).toContain("۱۴۰۵");
    expect(csv).toContain("دفتر تجمیعی همهٔ شعب");
    expect(csv).toContain("مانده‌های پایان دوره برابر است");
    expect(csv).toContain("دفتر سالم است");
    // Account identity and the six period columns, as exact Rial strings.
    expect(csv).toContain("کد حساب");
    expect(csv).toContain("1100");
    expect(csv).toContain("صندوق");
    expect(csv).toContain("دارایی");
    expect(csv).toContain("1000000");
    expect(csv).toContain("600000");
    expect(csv).toContain("جمع حساب‌های نمایش‌داده‌شده");
  });

  it("keeps the two report states apart in the exported file", async () => {
    vi.mocked(ledgerReports.getTrialBalance).mockResolvedValue({
      ...REPORT,
      trialBalanceBalanced: true,
      integrity: { ...REPORT.integrity, ledgerHealthy: false, unbalancedEntryCount: 2, invalidEntryCount: 1 },
    } as never);

    const csv = await csvOf(await POST(postRequest({
      format: "csv", kind: "trial_balance", asOf: "2026-03-31",
    })));
    expect(csv).toContain("مانده‌های پایان دوره برابر است");
    expect(csv).toContain("۲ سند نامتوازن");
    expect(csv).toContain("۱ سند ناقص");
  });

  it("sends the as-of shortcut through as a closing-only scope", async () => {
    await POST(postRequest({ format: "csv", kind: "trial_balance", asOf: "2026-03-31" }));
    expect(ledgerReports.getTrialBalance).toHaveBeenCalledWith(SESSION.businessId, { asOf: "2026-03-31" });
  });

  it("applies the on-screen filters to the exported rows", async () => {
    const csv = await csvOf(await POST(postRequest({
      format: "csv",
      kind: "trial_balance",
      dateFrom: "2026-03-01",
      dateTo: "2026-03-31",
      trialBalanceOptions: { presentation: "detailed", accountType: "revenue" },
    })));

    expect(csv).toContain("4100");
    expect(csv).not.toContain("1100");
    expect(csv).not.toContain("5300");
    expect(ledgerReports.getTrialBalance).toHaveBeenCalledWith(SESSION.businessId, {
      dateFrom: "2026-03-01",
      dateTo: "2026-03-31",
    });
  });

  it("drops the movement columns from a closing-only export", async () => {
    vi.mocked(ledgerReports.getTrialBalance).mockResolvedValue({ ...REPORT, mode: "closing" } as never);
    const csv = await csvOf(await POST(postRequest({
      format: "csv", kind: "trial_balance", asOf: "2026-03-31",
    })));
    expect(csv).not.toContain("گردش بدهکار دوره");
    expect(csv).toContain("مانده پایان بدهکار");
  });

  it.each([
    [{ format: "csv", kind: "trial_balance" }, "invalid_report_scope"],
    [{ format: "csv", kind: "trial_balance", asOf: "2026-02-31" }, "invalid_report_scope"],
    [{ format: "csv", kind: "trial_balance", dateFrom: "2026-03-31", dateTo: "2026-03-01" }, "invalid_report_scope"],
    [
      { format: "csv", kind: "trial_balance", asOf: "2026-03-31", dateFrom: "2026-03-01", dateTo: "2026-03-31" },
      "invalid_report_scope",
    ],
    [
      { format: "csv", kind: "trial_balance", asOf: "2026-03-31", trialBalanceOptions: { accountType: "banana" } },
      "invalid_trial_balance_filter",
    ],
    [
      { format: "csv", kind: "trial_balance", asOf: "2026-03-31", trialBalanceOptions: { presentation: "sideways" } },
      "invalid_trial_balance_filter",
    ],
  ])("400s on an unusable request: %j", async (body, error) => {
    const response = await POST(postRequest(body));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error });
    expect(ledgerReports.getTrialBalance).not.toHaveBeenCalled();
  });

  it("renders a PDF from the same rows, in the business's own display unit", async () => {
    const response = await POST(postRequest({
      format: "pdf", kind: "trial_balance", dateFrom: "2026-03-01", dateTo: "2026-03-31",
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");

    const html = String(vi.mocked(pdfRender.renderHtmlToPdf).mock.calls[0][0]);
    // Letterhead, title, the period and both states — the same identity the
    // CSV carries.
    expect(html).toContain("کافه نمونه");
    expect(html).toContain("تراز آزمایشی");
    expect(html).toContain("دفتر تجمیعی همهٔ شعب");
    expect(html).toContain("مانده‌های پایان دوره برابر است");
    expect(html).toContain("دفتر سالم است");
    // Rial was the business's chosen unit, so 600,000 stays 600,000.
    expect(html).toContain("۶۰۰٬۰۰۰ ریال");
    expect(html).toContain("مانده پایان بدهکار (ریال)");
  });

  it("renders the PDF in Toman when that is the business's display unit", async () => {
    vi.mocked(settings.getSetting).mockResolvedValue({ currencyDisplay: "toman" } as never);
    await POST(postRequest({
      format: "pdf", kind: "trial_balance", dateFrom: "2026-03-01", dateTo: "2026-03-31",
    }));
    const html = String(vi.mocked(pdfRender.renderHtmlToPdf).mock.calls[0][0]);
    expect(html).toContain("۶۰٬۰۰۰ تومان");
    expect(html).toContain("مانده پایان بدهکار (تومان)");
  });
});

describe("POST /api/reports/export — chart files", () => {
  beforeEach(useTomanDisplayUnit);

  it("scopes the file to the same active branch the screen read", async () => {
    await POST(postRequest({ format: "csv", kind: "chart", config: MONEY_CONFIG }));
    expect(setupState.resolveActiveLocation).toHaveBeenCalled();
    expect(reportsService.runCustomReportQuery).toHaveBeenCalledWith(
      "biz-1",
      MONEY_CONFIG,
      expect.objectContaining({ mode: "branch", locationId: "loc-b" }),
    );
  });

  it("refuses rather than exporting every branch when no branch is accessible", async () => {
    vi.mocked(setupState.resolveActiveLocation).mockResolvedValue(null as never);
    const response = await POST(postRequest({ format: "csv", kind: "chart", config: MONEY_CONFIG }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(expect.objectContaining({ error: "no_accessible_branch" }));
    expect(reportsService.runCustomReportQuery).not.toHaveBeenCalled();
  });

  it("writes money in the business's display unit and names it on the column", async () => {
    // 1,250,000 Rial is 125,000 Toman for a Toman business; the file used to
    // carry raw Rial whichever unit the business had chosen (issue #819).
    const response = await POST(
      postRequest({ format: "csv", kind: "chart", config: MONEY_CONFIG, title: "فروش" }),
    );
    const body = await response.text();
    expect(response.headers.get("content-type")).toContain("text/csv");
    expect(body).toContain("تومان");
    expect(body).toContain("125000");
    expect(body).not.toContain("1250000");
  });

  it("keeps a non-money measure unconverted and unlabelled", async () => {
    vi.mocked(reportsService.runCustomReportQuery).mockResolvedValue([
      { dim: "2026-01-01", value: 42 },
    ] as never);
    const response = await POST(
      postRequest({
        format: "csv",
        kind: "chart",
        config: { ...MONEY_CONFIG, metric: "order_count" },
        title: "تعداد",
      }),
    );
    const body = await response.text();
    expect(body).toContain("42");
    expect(body).not.toContain("تومان");
  });
});

describe("POST /api/reports/export — detailed shift file", () => {
  beforeEach(useTomanDisplayUnit);

  function shiftReport(page: number, pageCount: number) {
    return {
      shift: null,
      scope: "all_shifts" as const,
      shifts: [],
      orders: [
        {
          id: `o-${page}`,
          orderNumber: page,
          type: "dine_in" as const,
          status: "completed",
          tableName: null,
          guestCount: null,
          customerName: null,
          openedAt: "2026-01-01T08:00:00.000Z",
          closedAt: "2026-01-01T08:30:00.000Z",
          openedByName: null,
          closedByName: null,
          note: null,
          voidedReason: null,
          amendedAt: null,
          subtotal: 1_000_000,
          discount: 0,
          discountType: null,
          discountValue: null,
          serviceCharge: 0,
          tax: 0,
          tipAmount: 0,
          total: 1_000_000,
          addOnTotal: 0,
          lines: [],
          itemCount: 1,
          payments: [],
        },
      ],
      summary: {
        matchingCount: pageCount,
        completedCount: pageCount,
        completedAmount: 0,
        openCount: 0,
        openAmount: 0,
        heldCount: 0,
        heldAmount: 0,
        voidedCount: 0,
        voidedAmount: 0,
      },
      totalCount: pageCount,
      totalAmount: 0,
      page,
      pageSize: 100,
      pageCount,
    };
  }

  it("walks every page instead of exporting only the visible one", async () => {
    vi.mocked(shiftOrdersService.getShiftOrdersReport).mockImplementation(
      (async (_location: string, filters: { page?: number }) =>
        shiftReport(filters.page ?? 1, 3)) as never,
    );
    const response = await POST(
      postRequest({ format: "csv", kind: "shift_orders", query: "allShifts=1&page=2" }),
    );
    const body = await response.text();
    const calls = vi.mocked(shiftOrdersService.getShiftOrdersReport).mock.calls;
    expect(calls.map((call) => (call[1] as { page: number }).page)).toEqual([1, 2, 3]);
    // The requested page (2) is ignored on purpose: the file is the whole
    // filtered set, so it starts at page one.
    expect(body).toContain("شمارهٔ سفارش");
    expect((body.match(/o-\d/g) ?? []).length).toBe(0);
  });

  it("exports in the caller's display unit and refuses an invalid filter string", async () => {
    vi.mocked(shiftOrdersService.getShiftOrdersReport).mockResolvedValue(shiftReport(1, 1) as never);
    const ok = await POST(postRequest({ format: "csv", kind: "shift_orders", query: "allShifts=1" }));
    expect(await ok.text()).toContain("تومان");

    const bad = await POST(
      postRequest({ format: "csv", kind: "shift_orders", query: "status=whatever" }),
    );
    expect(bad.status).toBe(400);
  });

  it("is gated by the export capability, like every other file", async () => {
    vi.mocked(shiftOrdersService.getShiftOrdersReport).mockResolvedValue(shiftReport(1, 1) as never);
    await POST(postRequest({ format: "csv", kind: "shift_orders" }));
    const permissions = vi.mocked(auth.requirePermission).mock.calls.map((call) => call[0]);
    expect(permissions).toContain("reports.export");
  });
});

describe("POST /api/reports/export — ledger statements are branch-scoped", () => {
  /*
   * The audit's finding #2 on the export surface: `kind: "pnl"`,
   * `"balance_sheet"` and `"cash_flow"` called the reporting services with no
   * location at all, so a manager holding `reports.export` — every manager does
   * — downloaded the whole business's statements while the same manager's
   * screen showed one branch's. The consolidated form still exists; it has to
   * be asked for and it needs `reports.business_wide`.
   */
  beforeEach(() => {
    vi.mocked(reportsService.getProfitAndLoss).mockResolvedValue({
      revenue: [], expenses: [], totalRevenue: 0, totalExpenses: 0, netIncome: 0,
      costOfSales: 0, grossProfit: 0, laborCost: 0, primeCost: 0, operatingExpenses: 0,
    } as never);
    vi.mocked(reportsService.getCashFlow).mockResolvedValue({
      openingCash: 0, closingCash: 0, netChange: 0, lines: [], activities: { operating: 0, investing: 0, financing: 0 },
      clearingChange: 0, cashDefinition: "نقد",
    } as never);
    vi.mocked(reportsService.getBalanceSheet).mockResolvedValue({
      assets: [], liabilities: [], equity: [], retainedEarnings: 0,
      totalAssets: 0, totalLiabilities: 0, totalEquity: 0, balanced: true,
      currentAssets: 0, nonCurrentAssets: 0, currentLiabilities: 0, nonCurrentLiabilities: 0,
    } as never);
  });

  it.each([
    ["pnl", "getProfitAndLoss"],
    ["balance_sheet", "getBalanceSheet"],
    ["cash_flow", "getCashFlow"],
  ] as const)("reads %s from the caller's own branch by default", async (kind, service) => {
    await POST(postRequest({ format: "csv", kind, dateFrom: "2026-01-01", dateTo: "2026-01-31" }));
    expect(setupState.resolveActiveLocation).toHaveBeenCalled();
    // The resolved branch — "loc-b" — reaches the statement service, whatever
    // position the service's own signature puts it in.
    expect(vi.mocked(reportsService[service]).mock.calls[0]).toContainEqual(
      expect.objectContaining({ mode: "branch", locationId: "loc-b" }),
    );
  });

  it("refuses a business-wide statement without the capability", async () => {
    vi.mocked(auth.requirePermission).mockImplementation((async (permission: string) => {
      if (permission === "reports.business_wide") {
        return { session: null, error: new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }) };
      }
      return { session: SESSION, error: null };
    }) as never);
    const response = await POST(postRequest({ format: "csv", kind: "pnl", scope: "business-wide" }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(expect.objectContaining({ error: "business_wide_forbidden" }));
    expect(reportsService.getProfitAndLoss).not.toHaveBeenCalled();
  });

  it("reads the whole business for a statement when the capability is held and the scope asked for", async () => {
    // The default mock accepts every permission key, so this is the owner case.
    const response = await POST(postRequest({ format: "csv", kind: "pnl", scope: "business-wide" }));
    expect(response.status).toBe(200);
    const permissions = vi.mocked(auth.requirePermission).mock.calls.map((call) => call[0]);
    expect(permissions).toContain("reports.business_wide");
    // No branch reaches the service: the consolidated read is the explicit one.
    expect(vi.mocked(reportsService.getProfitAndLoss).mock.calls[0]).not.toContain("loc-b");
  });

  it("refuses a business-wide scope on a kind that has no consolidated form", async () => {
    // A business-wide *row dump* — every branch's orders in one file — is the
    // leak, not a report the product has.
    const chart = await POST(postRequest({ format: "csv", kind: "chart", config: MONEY_CONFIG, scope: "business-wide" }));
    expect(chart.status).toBe(400);
    expect(await chart.json()).toEqual(expect.objectContaining({ error: "scope_not_supported" }));

    const shift = await POST(postRequest({ format: "csv", kind: "shift_orders", query: "allShifts=1", scope: "business-wide" }));
    expect(shift.status).toBe(400);
    expect(await shift.json()).toEqual(expect.objectContaining({ error: "scope_not_supported" }));
  });

  it("refuses a scope value it does not serve rather than defaulting", async () => {
    const response = await POST(postRequest({ format: "csv", kind: "pnl", scope: "everything" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(expect.objectContaining({ error: "invalid_scope" }));
    expect(reportsService.getProfitAndLoss).not.toHaveBeenCalled();
  });

  it("refuses the statement file when no branch is accessible and none was asked for", async () => {
    vi.mocked(setupState.resolveActiveLocation).mockResolvedValue(null as never);
    const response = await POST(postRequest({ format: "csv", kind: "cash_flow" }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(expect.objectContaining({ error: "no_accessible_branch" }));
    expect(reportsService.getCashFlow).not.toHaveBeenCalled();
  });
});

describe("POST /api/reports/export — consolidated branch file", () => {
  beforeEach(useTomanDisplayUnit);

  it("requires the business-wide capability on top of the export capability", async () => {
    await POST(postRequest({ format: "csv", kind: "business_overview" }));
    const permissions = vi.mocked(auth.requirePermission).mock.calls.map((call) => call[0]);
    expect(permissions).toContain("reports.export");
    expect(permissions).toContain("reports.business_wide");
  });

  it("refuses the consolidated file when the second capability is missing", async () => {
    vi.mocked(auth.requirePermission).mockImplementation((async (permission: string) => {
      if (permission === "reports.business_wide") {
        return { session: null, error: new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }) };
      }
      return { session: SESSION, error: null };
    }) as never);
    const response = await POST(postRequest({ format: "csv", kind: "business_overview" }));
    expect(response.status).toBe(403);
    expect(reportsService.getBusinessOverview).not.toHaveBeenCalled();
  });

  it("converts consolidated money for CSV, not only for PDF", async () => {
    vi.mocked(reportsService.getBusinessOverview).mockResolvedValue({
      from: null,
      to: null,
      branches: [
        {
          locationId: "loc-1",
          locationName: "شعبهٔ یک",
          isActive: true,
          orderCount: 2,
          subtotal: 10_000_000,
          discount: 0,
          tax: 0,
          total: 10_000_000,
          cogs: 4_000_000,
          wasteCost: 0,
        },
      ],
      consolidated: { orderCount: 2, subtotal: 10_000_000, discount: 0, tax: 0, total: 10_000_000, cogs: 4_000_000, wasteCost: 0 },
    } as never);
    const response = await POST(postRequest({ format: "csv", kind: "business_overview" }));
    const body = await response.text();
    expect(body).toContain("1000000"); // 10,000,000 Rial → 1,000,000 Toman
    expect(body).toContain("تومان");
  });
});
