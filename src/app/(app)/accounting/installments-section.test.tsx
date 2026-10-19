// @vitest-environment jsdom

/**
 * Issue #909 — a failed read must never be indistinguishable from "nothing to
 * show". The installment list used to set `plans=[]` on a failed request, so
 * the empty-state copy («هنوز برنامه قسطی ثبت نشده است.») rendered right next
 * to the error box — telling the reader in the same breath that nothing was
 * saved and that something went wrong reading it. The create dialog's party
 * picker had the same shape: a failed `/api/parties` read quietly finished as
 * an empty, selectable list.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MoneyProvider } from "@/components/money/money-context";
import { InstallmentsSection } from "./installments-section";

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

function renderSection() {
  return render(
    <MoneyProvider unit="toman">
      <InstallmentsSection />
    </MoneyProvider>,
  );
}

describe("InstallmentsSection — a failed read is never shown as an empty register", () => {
  it("offers a retry instead of 'no plans' when the initial list read fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "server_error" }, { status: 500 })),
    );

    renderSection();

    await waitFor(() => expect(screen.getByRole("button", { name: "تلاش دوباره" })).toBeTruthy());
    // The misleading empty-register copy must not appear alongside a failure.
    expect(screen.queryByText("هنوز برنامه قسطی ثبت نشده است.")).toBeNull();
  });

  it("shows the empty state only when the read actually succeeds with zero plans", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ plans: [] })));

    renderSection();

    await waitFor(() => expect(screen.getByText("هنوز برنامه قسطی ثبت نشده است.")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "تلاش دوباره" })).toBeNull();
  });

  it("re-fetches the list when the retry button after a failure is pressed", async () => {
    let shouldFail = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => (shouldFail ? jsonResponse({ error: "server_error" }, { status: 500 }) : jsonResponse({ plans: [] }))),
    );

    renderSection();
    await waitFor(() => expect(screen.getByRole("button", { name: "تلاش دوباره" })).toBeTruthy());

    shouldFail = false;
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "تلاش دوباره" }));
    });

    await waitFor(() => expect(screen.getByText("هنوز برنامه قسطی ثبت نشده است.")).toBeTruthy());
  });
});

describe("InstallmentsSection — the create dialog's party picker", () => {
  it("shows a failure with retry rather than an empty-looking selector when the party read fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith("/api/ledger/installments")) return jsonResponse({ plans: [] });
        if (url.startsWith("/api/parties")) return jsonResponse({ error: "server_error" }, { status: 500 });
        if (url.startsWith("/api/sales/invoices")) return jsonResponse({ invoices: [] });
        return jsonResponse({});
      }),
    );

    renderSection();
    await waitFor(() => expect(screen.getByText("هنوز برنامه قسطی ثبت نشده است.")).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "اقساط جدید" }));
    });

    await waitFor(() =>
      expect(
        screen.getByText("بارگذاری فهرست اشخاص ناموفق بود؛ این فهرست نمی‌تواند خالی فرض شود."),
      ).toBeTruthy(),
    );
    // No selector drawn as if the business genuinely has zero customers.
    expect(screen.queryByRole("combobox", { name: "انتخاب شخص" })).toBeNull();
  });
});
