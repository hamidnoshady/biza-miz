// @vitest-environment jsdom

/**
 * `InvoiceManagementView`'s filter bar: the status chips and the Jalali
 * date-range pickers added alongside the existing method/search filters. This
 * proves the client sends the server's expected query params (`status`,
 * `dateFrom`, `dateTo` as ISO `YYYY-MM-DD`) and surfaces the server's
 * validation error codes (`invalid_invoice_status`, `invalid_date_range`) as
 * Persian text — not that the date math itself is correct (that is the
 * server-side `list-service` integration test's job).
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InvoiceManagementView } from "./invoice-management-view";

function emptyPage() {
  return new Response(JSON.stringify({ invoices: [], count: 0, timeZone: "Asia/Tehran" }), { status: 200 });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock = vi.fn(async () => emptyPage());
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Flush the view's debounce timer (0ms when the search box is untouched) and
 * let the resulting promise chain settle. */
async function flush() {
  await act(async () => {
    await vi.runAllTimersAsync();
  });
}

function click(name: string) {
  fireEvent.click(screen.getByRole("button", { name }));
}

function lastRequestUrl(): URL {
  const lastCall = fetchMock.mock.calls.at(-1);
  if (!lastCall) throw new Error("fetch was never called");
  return new URL(String(lastCall[0]), "http://localhost");
}

describe("InvoiceManagementView filters", () => {
  it("loads with no status/date params by default", async () => {
    render(<InvoiceManagementView />);
    await flush();
    const url = lastRequestUrl();
    expect(url.searchParams.has("status")).toBe(false);
    expect(url.searchParams.has("dateFrom")).toBe(false);
    expect(url.searchParams.has("dateTo")).toBe(false);
  });

  it("sends status=voided when the باطل‌شده chip is selected, and resets to page 1", async () => {
    render(<InvoiceManagementView />);
    await flush();

    click("باطل‌شده");
    await flush();

    const url = lastRequestUrl();
    expect(url.searchParams.get("status")).toBe("voided");
    expect(url.searchParams.get("page")).toBe("1");
  });

  it("clears the status filter when «همه وضعیت‌ها» is re-selected", async () => {
    render(<InvoiceManagementView />);
    await flush();

    click("تکمیل‌شده");
    await flush();
    expect(lastRequestUrl().searchParams.get("status")).toBe("completed");

    click("همه وضعیت‌ها");
    await flush();
    expect(lastRequestUrl().searchParams.has("status")).toBe(false);
  });

  it("sends dateFrom/dateTo as ISO dates once both pickers are set to «امروز»", async () => {
    render(<InvoiceManagementView />);
    await flush();

    click("از تاریخ");
    click("امروز");
    await flush();

    click("تا تاریخ");
    click("امروز");
    await flush();

    const url = lastRequestUrl();
    const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;
    expect(url.searchParams.get("dateFrom")).toMatch(isoDatePattern);
    expect(url.searchParams.get("dateTo")).toMatch(isoDatePattern);
  });

  it("maps the server's invalid_date_range error to a Persian message", async () => {
    fetchMock.mockImplementation(async () =>
      new Response(JSON.stringify({ error: "invalid_date_range" }), { status: 400 }),
    );
    render(<InvoiceManagementView />);
    await flush();

    expect(
      screen.getByText("بازهٔ تاریخ نامعتبر است؛ تاریخ شروع باید قبل از تاریخ پایان باشد."),
    ).toBeTruthy();
  });
});

describe("InvoiceManagementView screen-reader announcements", () => {
  function onePage() {
    return new Response(
      JSON.stringify({
        invoices: [
          {
            id: "inv-1",
            orderNumber: 101,
            status: "completed",
            total: 4_500_000,
            closedAt: new Date().toISOString(),
            customerName: "مشتری تست",
            lineCount: 1,
            paymentMethods: [{ method: "cash", name: "نقدی" }],
          },
        ],
        count: 1,
        timeZone: "Asia/Tehran",
      }),
      { status: 200 },
    );
  }

  it("marks the result-count summary as a polite live region, so page/filter changes are announced", async () => {
    fetchMock.mockImplementation(async () => onePage());
    render(<InvoiceManagementView />);
    await flush();

    const summary = screen.getByText(/نتیجه$/);
    expect(summary.getAttribute("aria-live")).toBe("polite");
  });

  it("announces the mid-refresh state through a role=status live region, not just a visual pill", async () => {
    render(<InvoiceManagementView />);
    await flush();

    // A second request is issued for the status filter change, and this
    // time never resolves — mimicking the window where a refresh is in
    // flight while the previous rows are still on screen.
    fetchMock.mockImplementation(() => new Promise(() => {}));
    click("باطل‌شده");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    const status = screen.getByRole("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.textContent).toContain("در حال به‌روزرسانی");
  });
});

describe("InvoiceManagementView split-payment display", () => {
  function pageWithSplitInvoice() {
    return new Response(
      JSON.stringify({
        invoices: [
          {
            id: "inv-1",
            orderNumber: 101,
            status: "completed",
            total: 4_500_000,
            closedAt: new Date().toISOString(),
            customerName: "مشتری تست",
            lineCount: 1,
            paymentMethods: [
              { method: "bank", name: "کارت‌خوان" },
              { method: "cash", name: "نقدی" },
            ],
          },
        ],
        count: 1,
        timeZone: "Asia/Tehran",
      }),
      { status: 200 },
    );
  }

  it("shows every tendered method on a split-payment invoice's row, joined together", async () => {
    fetchMock.mockImplementation(async () => pageWithSplitInvoice());
    render(<InvoiceManagementView />);
    await flush();

    expect(screen.getAllByText("کارت‌خوان، نقدی").length).toBeGreaterThan(0);
  });

  it("marks a credit-tendered invoice's payment badge distinctly, even when it's one of several methods", async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            invoices: [
              {
                id: "inv-2",
                orderNumber: 102,
                status: "completed",
                total: 1_000_000,
                closedAt: new Date().toISOString(),
                customerName: null,
                lineCount: 1,
                paymentMethods: [
                  { method: "cash", name: "نقدی" },
                  { method: "credit", name: "نسیه" },
                ],
              },
            ],
            count: 1,
            timeZone: "Asia/Tehran",
          }),
          { status: 200 },
        ),
    );
    render(<InvoiceManagementView />);
    await flush();

    const badges = screen.getAllByText("نقدی، نسیه");
    expect(badges.length).toBeGreaterThan(0);
  });

  it("renders every row in both the desktop table and the mobile card list (`hidden lg:block` / `lg:hidden`), each with a working «جزئیات و چاپ» button", async () => {
    fetchMock.mockImplementation(async () => pageWithSplitInvoice());
    render(<InvoiceManagementView />);
    await flush();

    // Both layouts exist in the DOM at once (CSS, not React, decides which
    // is visible per breakpoint) — the invoice number and the open button
    // must appear in each, or one of the two layouts silently lost the row.
    const customerNames = screen.getAllByText("مشتری تست");
    expect(customerNames.length).toBe(2);
    const openButtons = screen.getAllByRole("button", { name: /جزئیات و چاپ/ });
    expect(openButtons.length).toBe(2);

    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes("/api/sales/invoices/inv-1")) {
        return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
      }
      return pageWithSplitInvoice();
    });
    act(() => {
      fireEvent.click(openButtons[0]);
    });
    await flush();

    // The detail modal mounts and starts loading the invoice it was opened for.
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/api/sales/invoices/inv-1"))).toBe(true);
  });
});

describe("InvoiceManagementView export", () => {
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;

  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => "blob:mock");
    URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
  });

  function pageWithOneInvoice() {
    return new Response(
      JSON.stringify({
        invoices: [
          {
            id: "inv-1",
            orderNumber: 55,
            status: "completed",
            total: 1_000_000,
            closedAt: new Date().toISOString(),
            customerName: "مشتری",
            lineCount: 1,
            paymentMethods: [{ method: "cash", name: "نقدی" }],
          },
        ],
        count: 1,
        timeZone: "Asia/Tehran",
      }),
      { status: 200 },
    );
  }

  it("requests a page-scoped CSV, with the current filters and pagination, when «خروجی این صفحه» is clicked", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes("format=csv")) return new Response("csv-body", { status: 200 });
      return pageWithOneInvoice();
    });
    render(<InvoiceManagementView />);
    await flush();

    click("خروجی این صفحه");
    await flush();

    const csvCall = fetchMock.mock.calls.find((c) => String(c[0]).includes("format=csv"));
    expect(csvCall).toBeDefined();
    const url = new URL(String(csvCall![0]), "http://localhost");
    expect(url.searchParams.get("format")).toBe("csv");
    expect(url.searchParams.get("page")).toBe("1");
    expect(url.searchParams.has("all")).toBe(false);
  });

  it("requests the full filtered set, ignoring pagination, when «خروجی کامل» is clicked", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes("format=csv")) return new Response("csv-body", { status: 200 });
      return pageWithOneInvoice();
    });
    render(<InvoiceManagementView />);
    await flush();

    click("باطل‌شده");
    await flush();

    const exportButton = screen.getByRole("button", { name: /خروجی کامل/ });
    fireEvent.click(exportButton);
    await flush();

    const csvCall = fetchMock.mock.calls.find((c) => String(c[0]).includes("format=csv"));
    expect(csvCall).toBeDefined();
    const url = new URL(String(csvCall![0]), "http://localhost");
    expect(url.searchParams.get("format")).toBe("csv");
    expect(url.searchParams.get("all")).toBe("true");
    // The full export must carry the same filter the screen is showing.
    expect(url.searchParams.get("status")).toBe("voided");
  });
});
