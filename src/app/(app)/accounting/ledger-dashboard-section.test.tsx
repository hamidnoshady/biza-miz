// @vitest-environment jsdom

/**
 * Issue #909 — the accounting home must offer an explicit retry when its
 * initial read fails, instead of leaving the error box sitting forever above
 * a spinner-shaped placeholder that will never resolve on its own.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MoneyProvider } from "@/components/money/money-context";
import { LedgerDashboardSection } from "./ledger-dashboard-section";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, init: { status?: number } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json" },
  });
}

function overviewBody() {
  return {
    overview: {
      balanced: true,
      totalDebit: 0,
      totalCredit: 0,
      journalEntryCount: 0,
      journalLineCount: 0,
      unbalancedEntryCount: 0,
      invalidEntryCount: 0,
      balanceDifference: 0,
      cashAndBank: 0,
      liquidity: { cash: 0, bank: 0, pettyCash: 0 },
      paymentClearing: 0,
      receivables: 0,
      otherReceivables: 0,
      vatReceivable: 0,
      payables: 0,
      revenue: 0,
      expenses: 0,
      netIncome: 0,
      openReceivableCheques: 0,
      openPayableCheques: 0,
      costCoverage: { uncostedLines: 0, uncostedOrders: 0, uncostedNetRial: 0, provisional: false },
      scope: { period: "lifetime", branches: "all", asOf: "2024-01-01T00:00:00.000Z" },
      recentEntries: [],
    },
  };
}

function renderSection(refreshKey = 0) {
  return render(
    <MoneyProvider unit="toman">
      <LedgerDashboardSection onGoToTab={() => {}} refreshKey={refreshKey} />
    </MoneyProvider>,
  );
}

function routedFetch(overviewStatus: number) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/ledger/overview")) {
      return overviewStatus === 200
        ? jsonResponse(overviewBody())
        : jsonResponse({ error: "server_error" }, { status: overviewStatus });
    }
    if (url.includes("/api/ledger/fiscal-readiness")) {
      return jsonResponse({ readiness: null });
    }
    if (url.includes("/api/ledger/shift-sales")) {
      return jsonResponse({ shiftSales: null });
    }
    return jsonResponse({}, { status: 404 });
  });
}

describe("LedgerDashboardSection — initial-failure retry (issue #909)", () => {
  it("shows a retry action (not an endless skeleton) when the overview read fails", async () => {
    vi.stubGlobal("fetch", routedFetch(500));

    renderSection();

    await waitFor(() =>
      expect(screen.getByText("بارگذاری داشبورد حسابداری ناموفق بود.")).toBeTruthy(),
    );
    expect(screen.getByRole("button", { name: "تلاش دوباره" })).toBeTruthy();
    // The permanent "loading" skeleton must not sit underneath the error.
    expect(screen.queryByRole("status", { name: "در حال بارگذاری داشبورد حسابداری" })).toBeNull();
  });

  it("re-fetches and renders the dashboard once Retry succeeds", async () => {
    const fetchMock = routedFetch(500);
    vi.stubGlobal("fetch", fetchMock);

    renderSection();
    await waitFor(() => expect(screen.getByRole("button", { name: "تلاش دوباره" })).toBeTruthy());

    vi.stubGlobal("fetch", routedFetch(200));
    screen.getByRole("button", { name: "تلاش دوباره" }).click();

    await waitFor(() => expect(screen.getByText("دفتر شما هنوز خالی است")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "تلاش دوباره" })).toBeNull();
  });
});
