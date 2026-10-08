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
  return { ...actual, getPrimaryLocation: vi.fn(async () => ({ address: "تهران", phone: "021" })) };
});

const SESSION = { businessId: "business-1" };

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
});

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
