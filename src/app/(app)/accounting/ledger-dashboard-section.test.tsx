// @vitest-environment jsdom

/**
 * The Accounting home's browser contract (#912 items 5, 7): failures are
 * visible and distinct (error vs no-location vs stale), an aborted or
 * superseded request never writes state, long exact-Rial amounts render in
 * full, and the provisional-profit warning lists its source lines with a
 * drill-down link.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MoneyProvider } from "@/components/money/money-context";
import { formatMoneyText } from "@/lib/money";
import { LedgerDashboardSection, ShiftSalesQuickReport } from "./ledger-dashboard-section";

type ApiResult = { ok: boolean; status: number; data: unknown; aborted: boolean };
const apiMock = vi.fn<(url: string, init?: RequestInit) => Promise<ApiResult>>();

vi.mock("@/app/dashboard/ui", () => ({
  api: (url: string, init?: RequestInit) => apiMock(url, init),
  ErrorBox: ({ children }: { children: React.ReactNode }) =>
    children ? <div role="alert">{children}</div> : null,
  InfoBox: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const READINESS = {
  ready: true,
  issues: [],
  hasFiscalYear: true,
  fiscalYearCount: 1,
  today: "2026-01-15",
  todayCovered: true,
  uncovered: { count: 0, earliest: null, latest: null },
  closableYearLabels: [],
  canClose: false,
};

function overviewFixture(overrides: Record<string, unknown> = {}) {
  return {
    balanced: true,
    totalDebit: "1000",
    totalCredit: "1000",
    journalEntryCount: 3,
    journalLineCount: 6,
    unbalancedEntryCount: 0,
    invalidEntryCount: 0,
    balanceDifference: "0",
    cashAndBank: "100",
    liquidity: { cash: "100", bank: "0", pettyCash: "0" },
    paymentClearing: "0",
    receivables: "0",
    otherReceivables: "0",
    vatReceivable: "0",
    payables: "0",
    revenue: "500",
    expenses: "200",
    netIncome: "300",
    openReceivableCheques: 0,
    openPayableCheques: 0,
    costCoverage: { uncostedLines: 0, uncostedOrders: 0, uncostedNetRial: "0", provisional: false, affected: [] },
    scope: {
      period: "fiscal_year",
      periodFrom: "2025-01-01",
      periodTo: "2025-12-31",
      fiscalYearLabel: "1404",
      branches: "all",
      asOf: "2026-01-15T00:00:00.000Z",
      asOfDate: "2026-01-15",
    },
    recentEntries: [],
    ...overrides,
  };
}

const ok = (data: unknown): ApiResult => ({ ok: true, status: 200, data, aborted: false });
const fail = (): ApiResult => ({ ok: false, status: 500, data: {}, aborted: false });

function route(handlers: Record<string, () => ApiResult | Promise<ApiResult>>) {
  apiMock.mockImplementation((url) => {
    if (typeof url !== "string") return Promise.resolve(fail());
    for (const [key, handler] of Object.entries(handlers)) {
      if (url.includes(key)) return Promise.resolve(handler());
    }
    return Promise.resolve(fail());
  });
}

function renderDashboard(props: Partial<{ canPropose: boolean }> = {}) {
  return render(
    <MoneyProvider unit="rial">
      <div dir="rtl">
        <LedgerDashboardSection
          onGoToTab={() => undefined}
          refreshKey={0}
          allowedSections={["dashboard", "entries", "manual", "chart-of-accounts", "fiscal-periods"]}
          canPropose={props.canPropose ?? false}
        />
      </div>
    </MoneyProvider>,
  );
}

beforeEach(() => apiMock.mockReset());
afterEach(cleanup);

describe("LedgerDashboardSection (#912)", () => {
  it("shows a retryable error instead of a skeleton that never resolves", async () => {
    route({ "/api/ledger/overview": fail, "/api/ledger/fiscal-readiness": () => ok({ readiness: READINESS }), "/api/ledger/shift-sales": () => ok({ shiftSales: null, reason: "no_location" }) });
    renderDashboard();
    expect(await screen.findByText("بارگذاری داشبورد حسابداری ناموفق بود.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "تلاش دوباره" })).toBeTruthy();
    expect(screen.queryByText("نقدینگی قابل استفاده")).toBeNull();
  });

  it("empty ledger onboards without offering a forbidden manual entry", async () => {
    route({
      "/api/ledger/overview": () => ok({ overview: overviewFixture({ journalEntryCount: 0, journalLineCount: 0 }) }),
      "/api/ledger/fiscal-readiness": () => ok({ readiness: READINESS }),
      "/api/ledger/shift-sales": () => ok({ shiftSales: null, reason: "no_location" }),
    });
    renderDashboard({ canPropose: false });
    expect(await screen.findByText("دفتر شما هنوز خالی است")).toBeTruthy();
    expect(screen.queryByText(/اولین سند دستی/)).toBeNull();
  });

  it("keeps stale amounts visible with a warning when a refresh fails", async () => {
    let failing = false;
    route({
      "/api/ledger/overview": () => (failing ? fail() : ok({ overview: overviewFixture() })),
      "/api/ledger/fiscal-readiness": () => ok({ readiness: READINESS }),
      "/api/ledger/shift-sales": () => ok({ shiftSales: null, reason: "no_location" }),
    });
    renderDashboard();
    expect(await screen.findByText("نقدینگی قابل استفاده")).toBeTruthy();
    failing = true;
    fireEvent.click(screen.getByRole("button", { name: "به‌روزرسانی" }));
    expect(await screen.findByText(/مبالغ زیر ممکن است قدیمی باشند/)).toBeTruthy();
    // The last good figure is still there — marked stale, not replaced by zero.
    expect(screen.getByText("نقدینگی قابل استفاده")).toBeTruthy();
  });

  it("a superseded response cannot clobber a newer one", async () => {
    let resolveFirst!: (r: ApiResult) => void;
    const first = new Promise<ApiResult>((r) => { resolveFirst = r; });
    let calls = 0;
    route({
      "/api/ledger/overview": () => {
        calls += 1;
        return calls === 1 ? first : ok({ overview: overviewFixture({ cashAndBank: "777", liquidity: { cash: "777", bank: "0", pettyCash: "0" } }) });
      },
      "/api/ledger/fiscal-readiness": () => ok({ readiness: READINESS }),
      "/api/ledger/shift-sales": () => ok({ shiftSales: null, reason: "no_location" }),
    });
    const { rerender } = renderDashboard();
    rerender(
      <MoneyProvider unit="rial">
        <LedgerDashboardSection onGoToTab={() => undefined} refreshKey={1} canPropose={false} />
      </MoneyProvider>,
    );
    await waitFor(() => expect(screen.getAllByText(formatMoneyText("777", "rial")).length).toBeGreaterThan(0));
    resolveFirst(ok({ overview: overviewFixture({ cashAndBank: "999" }) }));
    await waitFor(() => expect(screen.queryByText(formatMoneyText("999", "rial"))).toBeNull());
    expect(screen.getAllByText(formatMoneyText("777", "rial")).length).toBeGreaterThan(0);
  });

  it("renders long exact amounts in full and lists affected cost lines with drill-down", async () => {
    const big = "9007199254740993";
    route({
      "/api/ledger/overview": () => ok({
        overview: overviewFixture({
          cashAndBank: big,
          costCoverage: {
            uncostedLines: 1, uncostedOrders: 1, uncostedNetRial: "5000", provisional: true,
            affected: [{ orderId: "o-1", orderNumber: "42", orderItemId: "i-1", sourceType: "woocommerce_order", costStatus: "missing", outstandingNetRial: "5000" }],
          },
          recentEntries: [{ id: "entry-9", date: "2026-01-10", memo: "فروش", sourceType: "manual", total: "500" }],
        }),
      }),
      "/api/ledger/fiscal-readiness": () => ok({ readiness: READINESS }),
      "/api/ledger/shift-sales": () => ok({ shiftSales: null, reason: "no_location" }),
    });
    renderDashboard();
    expect(await screen.findByText(formatMoneyText(big, "rial"))).toBeTruthy();
    const drill = await screen.findByRole("link", { name: "دیدن سفارش" });
    expect(drill.getAttribute("href")).toContain("order=42");
    const entryLink = screen.getByRole("link", { name: /بازکردن سند/ });
    expect(entryLink.getAttribute("href")).toBe("/accounting/entries?entry=entry-9");
  });
});

describe("ShiftSalesQuickReport (#912)", () => {
  it("distinguishes a failed read from zero sales and retries", async () => {
    let failing = true;
    apiMock.mockImplementation(() =>
      Promise.resolve(failing
        ? fail()
        : ok({ shiftSales: { since: "2026-01-15T00:00:00.000Z", lastShiftEndedAt: null, hasOpenShift: true, summary: { orderCount: 2, grossTotal: 700, cashTotal: 700, cardTotal: 0, onlineTotal: 0, creditTotal: 0 } } })),
    );
    render(<MoneyProvider unit="rial"><ShiftSalesQuickReport refreshKey={0} /></MoneyProvider>);
    expect(await screen.findByText("گزارش فروش شیفت خوانده نشد")).toBeTruthy();
    failing = false;
    fireEvent.click(screen.getByRole("button", { name: "تلاش دوباره" }));
    expect(await screen.findByText("فروش شیفت جاری")).toBeTruthy();
  });

  it("renders nothing for a business with no accessible branch", async () => {
    apiMock.mockImplementation(() => Promise.resolve(ok({ shiftSales: null, reason: "no_location" })));
    const { container } = render(<MoneyProvider unit="rial"><ShiftSalesQuickReport refreshKey={0} /></MoneyProvider>);
    await waitFor(() => expect(container.textContent).toBe(""));
  });
});
