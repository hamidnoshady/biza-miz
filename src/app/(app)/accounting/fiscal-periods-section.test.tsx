// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toPersianDigits } from "@/lib/digits";
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
  failFirstReadiness?: boolean;
  closeError?: string;
} = {}) {
  const yearAttempts = { count: 0 };
  const readinessAttempts = { count: 0 };
  const calls: string[] = [];
  const mock = vi.fn(async (url: string) => {
    calls.push(url);
    if (url === "/api/ledger/fiscal-readiness") {
      readinessAttempts.count += 1;
      if (options.failFirstReadiness && readinessAttempts.count === 1) {
        return { ok: false, status: 503, json: async () => ({ error: "request_failed" }) };
      }
      return { ok: true, status: 200, json: async () => ({ readiness: options.readiness ?? readiness() }) };
    }
    if (url === `/api/ledger/fiscal-years/${fiscalYear.id}/close` && options.closeError) {
      return { ok: false, status: 409, json: async () => ({ error: options.closeError }) };
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
  return { calls, mock, yearAttempts, readinessAttempts };
}

async function renderSection(canManage: boolean, options: Parameters<typeof stubFetch>[0] = {}) {
  const network = stubFetch(options);
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<FiscalPeriodsSection canManage={canManage} />);
  });
  await waitFor(() => {
    expect(
      screen.queryByText("سال انتخاب‌شده") ||
        screen.queryByText(/هنوز سال مالی‌ای تعریف نشده است/) ||
        screen.queryByText(/بارگذاری سال‌های مالی ناموفق بود/),
    ).toBeTruthy();
  });
  return { ...network, view };
}

describe("FiscalPeriodsSection capability-aware controls", () => {
  it("explains first-year adoption, back-dated coverage, and where to define missing years", async () => {
    await renderSection(true, { years: { fiscalYears: [] } });

    expect(await screen.findByText("کنترل دوره‌های مالی با تعریف نخستین سال فعال می‌شود.")).toBeTruthy();
    expect(screen.getByText(/حتی اگر تاریخش به گذشته برگردد/)).toBeTruthy();
    expect(screen.getByText(/ثبت با تاریخِ بدون پوشش پذیرفته نمی‌شود/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "رفتن به فرم تعریف سال مالی" }).getAttribute("href")).toBe(
      "#fiscal-year-definition",
    );
    expect(document.getElementById("fiscal-year-definition")).toBeTruthy();
  });

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

  it("offers a readiness retry and lets the server check final close when readiness is unavailable", async () => {
    const allClosed = Array.from({ length: 12 }, (_, i) => period("soft_closed", i + 1));
    const network = await renderSection(true, {
      periods: { periods: allClosed },
      failFirstReadiness: true,
    });

    expect(await screen.findByText("بررسی پوشش اسناد در دسترس نیست")).toBeTruthy();
    const closeYear = screen.getByRole("button", { name: "بستن نهایی سال" });
    expect(closeYear.hasAttribute("disabled")).toBe(false);
    expect(screen.getByText(/بستن نهایی فقط پس از بررسی سرور انجام می‌شود/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "تلاش دوباره برای بررسی پوشش" }));
    await waitFor(() => expect(network.readinessAttempts.count).toBe(2));
    await waitFor(() => {
      expect(screen.queryByText("بررسی پوشش اسناد در دسترس نیست")).toBeNull();
      expect(screen.getByRole("button", { name: "بستن نهایی سال" }).hasAttribute("disabled")).toBe(false);
    });
  });

  it("surfaces the server's coverage rejection after an unavailable readiness read", async () => {
    const allClosed = Array.from({ length: 12 }, (_, i) => period("soft_closed", i + 1));
    const network = await renderSection(true, {
      periods: { periods: allClosed },
      failFirstReadiness: true,
      closeError: "uncovered_entries_before_close",
    });

    await screen.findByText("بررسی پوشش اسناد در دسترس نیست");
    fireEvent.click(screen.getByRole("button", { name: "بستن نهایی سال" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "بستن نهایی سال مالی" }));

    expect(
      await screen.findByText(/بستن نهایی این سال ممکن نیست: اسنادی با تاریخ پیش از پایان سال/),
    ).toBeTruthy();
    expect(network.calls).toContain(`/api/ledger/fiscal-years/${fiscalYear.id}/close`);
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
    // The year label renders before its effect requests the periods. Assert
    // the request after that effect, not in the render/effect timing gap.
    await waitFor(() => expect(network.calls.some((url) => url === `/api/ledger/fiscal-years/${fiscalYear.id}/periods`)).toBe(true));
  });

  it("keeps the twelve period rows visible, with a Retry, when the refresh after a soft-close fails (issue #909 §6)", async () => {
    let periodsAttempt = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/ledger/fiscal-readiness") {
          return { ok: true, status: 200, json: async () => ({ readiness: readiness() }) };
        }
        if (url === "/api/ledger/fiscal-years") {
          return { ok: true, status: 200, json: async () => ({ fiscalYears: [fiscalYear] }) };
        }
        if (url === `/api/ledger/fiscal-years/${fiscalYear.id}/periods`) {
          periodsAttempt += 1;
          // Attempt 1: the initial load (ok). Attempt 2: the refresh the
          // soft-close triggers (fails). Attempt 3: the reader's own retry (ok).
          if (periodsAttempt === 2) {
            return { ok: false, status: 500, json: async () => ({ error: "request_failed" }) };
          }
          return { ok: true, status: 200, json: async () => ({ periods: [period("open")] }) };
        }
        if (url === `/api/ledger/fiscal-periods/${period("open").id}` && init?.method === "PATCH") {
          return { ok: true, status: 200, json: async () => ({ period: period("soft_closed") }) };
        }
        return { ok: true, status: 200, json: async () => ({}) };
      }),
    );

    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(<FiscalPeriodsSection canManage />);
    });
    await screen.findAllByText(toPersianDigits("فروردین 1404"));

    fireEvent.click(screen.getAllByRole("button", { name: "بستن موقت" })[0]);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "بستن موقت دوره" }));

    // The soft-close succeeded; its own refresh (attempt 2) failed. The row
    // from attempt 1 must stay on screen with its own retry, not vanish
    // behind the skeleton or the no-data empty state.
    await waitFor(() => expect(screen.getByText("به‌روزرسانی دوره‌های این سال ناموفق بود؛ فهرست زیر هنوز معتبر است.")).toBeTruthy());
    expect(screen.getAllByText(toPersianDigits("فروردین 1404")).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "تلاش دوباره" }));
    await waitFor(() =>
      expect(screen.queryByText("به‌روزرسانی دوره‌های این سال ناموفق بود؛ فهرست زیر هنوز معتبر است.")).toBeNull(),
    );
    expect(screen.getAllByText(toPersianDigits("فروردین 1404")).length).toBeGreaterThan(0);
    view.unmount();
  });
});
