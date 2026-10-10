// @vitest-environment jsdom

/**
 * Issue #824 §7 / review item 4 — the chart-of-accounts section must mount
 * independently of the shared active-account picker.
 *
 * Two things are asserted, and both were untrue before the refactor:
 *
 *   1. `/accounting/chart-of-accounts` performs exactly one request — its own
 *      `?all=1`. It must not also fire (or wait on) the `?all=0` picker fetch.
 *   2. A failed picker fetch cannot blank the chart. The old code gated the
 *      whole section on `accounts`, so one failed GET rendered «بارگذاری فهرست
 *      حساب‌های فعال ناموفق بود» for a screen that never needed the list.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountingManager } from "./accounting-manager";

afterEach(cleanup);

const CHART_ROWS = [
  {
    id: "g-1", code: "6100", name: "هزینه‌ها", type: "expense", parentId: null, parentCode: null,
    isActive: true, hasPostings: false, hasDraftPostings: false, hasChildren: false,
    level: "group", normalBalance: "debit", isContra: false,
  },
];

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

function renderChart() {
  return render(
    <AccountingManager
      role="owner"
      section="chart-of-accounts"
      permissions={["ledger.view", "accounts.edit"]}
      currentUserId="user-owner"
    />,
  );
}

function okJson(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("issue #824 §7: chart mounting is independent", () => {
  it("issues only the chart's own ?all=1 request", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(String(url)).toContain("/api/ledger/accounts?all=1");
      return okJson({ accounts: CHART_ROWS });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderChart();
    await waitFor(() => expect(screen.getAllByText("هزینه‌ها").length).toBeGreaterThan(0));

    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls).toEqual(["/api/ledger/accounts?all=1"]);
    // The picker list is what the manual/expense sections need; this screen
    // must not pay for it.
    expect(urls.some((u) => u === "/api/ledger/accounts")).toBe(false);
  });

  it("still renders the chart when the picker endpoint is broken", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url) === "/api/ledger/accounts?all=1") return okJson({ accounts: CHART_ROWS });
      throw new Error("picker endpoint down");
    });
    vi.stubGlobal("fetch", fetchMock);

    renderChart();
    await waitFor(() => expect(screen.getAllByText("هزینه‌ها").length).toBeGreaterThan(0));

    // No picker-failure banner, and no retry prompt for a request never made.
    // Matches the picker-failure copy on either side of the reconciliation.
    expect(screen.queryByText(/ناموفق بود/)).toBeNull();
    expect(screen.queryByRole("button", { name: /تلاش دوباره/ })).toBeNull();
  });
});

describe("issue #824 review §1: the blocked-restore reason reaches the user", () => {
  it("renders the app's Persian copy for ancestor_archived, never the raw code", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        return new Response(JSON.stringify({ error: "ancestor_archived" }), {
          status: 409,
          headers: { "Content-Type": "application/json" },
        });
      }
      return okJson({ accounts: CHART_ROWS });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderChart();
    await waitFor(() => expect(screen.getAllByText("هزینه‌ها").length).toBeGreaterThan(0));

    const row = screen
      .getAllByText("هزینه‌ها")
      .map((n) => n.closest("tr"))
      .find((r): r is HTMLTableRowElement => r !== null)!;
    fireEvent.click(within(row).getByRole("button", { name: /بایگانی|فعال کردن/ }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("حساب‌های والد در زنجیره هنوز بایگانی است");
    expect(alert.textContent).not.toContain("ancestor_archived");
  });
});
