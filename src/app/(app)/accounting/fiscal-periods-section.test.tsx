// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FiscalPeriodsSection } from "./fiscal-periods-section";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const fiscalYear = {
  id: "year-1404",
  label: "1404",
  startsOn: "2025-03-21",
  endsOn: "2026-03-20",
  closedAt: null,
};

function period(status: "open" | "soft_closed" | "locked" = "open", month = 1) {
  return {
    id: `period-${month}`,
    fiscalYearId: fiscalYear.id,
    label: `1404-${String(month).padStart(2, "0")}`,
    name: `${month === 1 ? "فروردین" : "اردیبهشت"} 1404`,
    startsOn: month === 1 ? "2025-03-21" : "2025-04-21",
    endsOn: month === 1 ? "2025-04-20" : "2025-05-21",
    status,
  };
}

function readiness(overrides: Record<string, unknown> = {}) {
  return {
    ready: true,
    issues: [],
    hasFiscalYear: true,
    fiscalYearCount: 1,
    today: "2025-04-10",
    todayCovered: true,
    uncovered: { count: 0, earliest: null, latest: null },
    closableYearLabels: ["1404"],
    canClose: true,
    ...overrides,
  };
}

function stubFetch(options: {
  years?: unknown;
  periods?: unknown;
  readiness?: unknown;
  failFirstYears?: boolean;
} = {}) {
  const yearAttempts = { count: 0 };
  const calls: string[] = [];
  const mock = vi.fn(async (url: string) => {
    calls.push(url);
    if (url === "/api/ledger/fiscal-readiness") {
      return { ok: true, status: 200, json: async () => ({ readiness: options.readiness ?? readiness() }) };
    }
    if (url === "/api/ledger/fiscal-years") {
      yearAttempts.count += 1;
      if (options.failFirstYears && yearAttempts.count === 1) {
        return { ok: false, status: 500, json: async () => ({ error: "request_failed" }) };
      }
      return { ok: true, status: 200, json: async () => options.years ?? { fiscalYears: [fiscalYear] } };
    }
    if (url === `/api/ledger/fiscal-years/${fiscalYear.id}/periods`) {
      return { ok: true, status: 200, json: async () => options.periods ?? { periods: [period("open")] } };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });
  vi.stubGlobal("fetch", mock);
  return { calls, mock, yearAttempts };
}

async function renderSection(canManage: boolean, options: Parameters<typeof stubFetch>[0] = {}) {
  const network = stubFetch(options);
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<FiscalPeriodsSection canManage={canManage} />);
  });
  await waitFor(() => {
    expect(screen.queryByText("سال انتخاب‌شده") || screen.queryByText(/بارگذاری سال‌های مالی ناموفق بود/)).toBeTruthy();
  });
  return { ...network, view };
}

describe("FiscalPeriodsSection capability-aware controls", () => {
  it("shows status read-only and hides every mutation for a ledger viewer", async () => {
    await renderSection(false, { periods: { periods: [period("soft_closed"), period("locked", 2)] } });

    expect(screen.getByText("نمایش فقط‌خواندنی")).toBeTruthy();
    expect(screen.getAllByText("بستهٔ موقت").length).toBeGreaterThan(0);
    expect(screen.getAllByText("قفل‌شده").length).toBeGreaterThan(0);
    for (const label of ["تعریف سال مالی", "بستن موقت", "قفل کردن", "بازگشایی", "بستن نهایی سال"]) {
      expect(screen.queryByRole("button", { name: label })).toBeNull();
    }
  });

  it("shows mutations to a manager and explains a soft-close before confirming it", async () => {
    await renderSection(true);

    expect(screen.getAllByRole("button", { name: "تعریف سال مالی" }).length).toBe(1);
    const closeButtons = screen.getAllByRole("button", { name: "بستن موقت" });
    expect(closeButtons.length).toBeGreaterThan(0);
    fireEvent.click(closeButtons[0]);

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/ledger\.close_period/)).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "بستن موقت دوره" })).toBeTruthy();
  });

  it("states the full, irreversible year-end consequences in the accessible confirmation", async () => {
    const allClosed = Array.from({ length: 12 }, (_, i) => period("soft_closed", i + 1));
    await renderSection(true, { periods: { periods: allClosed } });

    const closeYear = screen.getByRole("button", { name: "بستن نهایی سال" });
    expect(closeYear.hasAttribute("disabled")).toBe(false);
    fireEvent.click(closeYear);

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/درآمد و هزینه بسته می‌شوند/)).toBeTruthy();
    expect(within(dialog).getByText(/هر دوازده دوره قفل می‌شوند/)).toBeTruthy();
    expect(within(dialog).getByText(/بازگشایی هیچ دوره‌ای ممکن نیست/)).toBeTruthy();
  });

  it("keeps final close disabled until coverage prerequisites are satisfied", async () => {
    const allClosed = Array.from({ length: 12 }, (_, i) => period("soft_closed", i + 1));
    await renderSection(true, {
      periods: { periods: allClosed },
      readiness: readiness({
        uncovered: { count: 1, earliest: "2024-12-01", latest: "2024-12-01" },
        closableYearLabels: [],
        canClose: false,
      }),
    });

    expect(screen.getByRole("button", { name: "بستن نهایی سال" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/اسنادِ بیرون از دوره تا پایان سال/)).toBeTruthy();
  });

  it("keeps the year list usable after a failed load and retries successfully", async () => {
    const network = await renderSection(false, { failFirstYears: true });
    expect(screen.getByText("بارگذاری سال‌های مالی ناموفق بود. می‌توانید دوباره تلاش کنید.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "تلاش دوباره" }));

    await waitFor(() => expect(screen.getByText("سال انتخاب‌شده")).toBeTruthy());
    expect(network.yearAttempts.count).toBe(2);
    expect(network.calls.some((url) => url === `/api/ledger/fiscal-years/${fiscalYear.id}/periods`)).toBe(true);
  });
});
