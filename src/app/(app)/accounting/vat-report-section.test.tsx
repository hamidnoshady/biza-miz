// @vitest-environment jsdom

/**
 * Issue #909 — VAT must never show a previous period's figures as if they
 * described a newly selected date range, and a failed read must offer a
 * visible retry rather than leaving the skeleton on screen forever.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MoneyProvider } from "@/components/money/money-context";
import { formatTomanText } from "@/lib/money";
import { VatReportSection } from "./vat-report-section";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function report(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    report: {
      periodFrom: null,
      periodTo: null,
      outputVat: 1000,
      inputVat: 400,
      netPayable: 600,
      vatPayableBalance: 600,
      vatReceivableBalance: 0,
      ...overrides,
    },
  };
}

function jsonResponse(body: unknown, init: { status?: number } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json" },
  });
}

function renderSection(refreshKey = 0) {
  return render(
    <MoneyProvider unit="toman">
      <VatReportSection refreshKey={refreshKey} />
    </MoneyProvider>,
  );
}

describe("VatReportSection — scope and retry (issue #909)", () => {
  it("shows a retry action when the initial read fails, rather than an endless skeleton", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "server_error" }, { status: 500 })));

    renderSection();

    await waitFor(() =>
      expect(screen.getByText("بارگذاری گزارش مالیات بر ارزش افزوده ناموفق بود.")).toBeTruthy(),
    );
    expect(screen.getByRole("button", { name: "تلاش دوباره" })).toBeTruthy();
  });

  it("clears the previous figures and shows a loading shape the moment a date changes", async () => {
    let resolveSecond: ((value: Response) => void) | null = null;
    let callCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        callCount += 1;
        if (callCount === 1) return jsonResponse(report({ outputVat: 1111 }));
        return new Promise<Response>((resolve) => {
          resolveSecond = resolve;
        });
      }),
    );

    renderSection();
    await waitFor(() => expect(screen.getByText(formatTomanText("1111"))).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "از تاریخ" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "امروز" }));
    });

    // The previous figure must disappear immediately — never shown as if it
    // described the newly chosen range.
    await waitFor(() => expect(screen.queryByText(formatTomanText("1111"))).toBeNull());

    await act(async () => {
      resolveSecond?.(jsonResponse(report({ outputVat: 2222 })));
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByText(formatTomanText("2222"))).toBeTruthy());
  });

  it("keeps the existing figures and a refreshing label for a same-scope refresh", async () => {
    let resolveSecond: ((value: Response) => void) | null = null;
    let callCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        callCount += 1;
        if (callCount === 1) return jsonResponse(report({ outputVat: 500 }));
        return new Promise<Response>((resolve) => {
          resolveSecond = resolve;
        });
      }),
    );

    const view = renderSection(0);
    await waitFor(() => expect(screen.getByText(formatTomanText("500"))).toBeTruthy());

    view.rerender(
      <MoneyProvider unit="toman">
        <VatReportSection refreshKey={1} />
      </MoneyProvider>,
    );

    // Same scope (no date change) — the old figure stays, labelled as pending.
    expect(screen.getByText(formatTomanText("500"))).toBeTruthy();
    expect(await screen.findByText("در حال به‌روزرسانی گزارش مالیات بر ارزش افزوده برای همین بازه…")).toBeTruthy();

    await act(async () => {
      resolveSecond?.(jsonResponse(report({ outputVat: 500 })));
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(screen.queryByText("در حال به‌روزرسانی گزارش مالیات بر ارزش افزوده برای همین بازه…")).toBeNull(),
    );
  });
});
