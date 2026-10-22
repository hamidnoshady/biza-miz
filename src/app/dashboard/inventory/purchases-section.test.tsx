// @vitest-environment jsdom

/**
 * Issue #909 §13 — switching a list filter («وضعیت», «تأمین‌کننده», a date
 * range) used to leave the *previous* filters' purchases fully visible —
 * rows a person could still open or act on — for as long as the newly
 * selected filters' request was in flight, because only the very first load
 * ever set `purchases` from `null`. Fixed the same way `stock-section.tsx`'s
 * warehouse switch and `documents-section.tsx`'s kind filter were.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PurchasesSection } from "./purchases-section";

afterEach(cleanup);

function purchase(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "pur-1",
    status: "draft",
    total: "1000000",
    note: null,
    supplier_id: null,
    supplier_name: "تامین‌کننده الف",
    purchase_date: "2026-01-01",
    ordered_at: null,
    received_at: null,
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function stubRoutes(onPurchases: (url: string) => unknown) {
  return vi.fn(async (url: string) => {
    if (url.startsWith("/api/inventory/purchases")) return onPurchases(url);
    if (url.startsWith("/api/inventory/suppliers")) return { ok: true, status: 200, json: async () => ({ suppliers: [] }) };
    throw new Error(`unexpected fetch ${url}`);
  });
}

describe("PurchasesSection — a changed scope (switching a list filter) must not keep showing the old filters' purchases", () => {
  it("clears the previous filters' purchases immediately on switch, never rendering them under the newly-selected status", async () => {
    let resolveReceived: ((value: unknown) => void) | null = null;
    let call = 0;
    vi.stubGlobal(
      "fetch",
      stubRoutes((url) => {
        call += 1;
        if (call === 1) {
          expect(url).not.toContain("status=");
          return Promise.resolve({ ok: true, status: 200, json: async () => ({ purchases: [purchase()] }) });
        }
        expect(url).toContain("status=received");
        // Deliberately never resolves during the assertions below — this is
        // exactly the window the old defect kept the draft row on screen
        // through, under the newly-selected «received» status.
        return new Promise((resolve) => {
          resolveReceived = resolve;
        });
      }),
    );
    render(<PurchasesSection items={[]} suppliers={[]} busy={false} run={async () => true} />);
    await screen.findByText(/تامین‌کننده الف/);

    fireEvent.click(screen.getByRole("button", { name: "وضعیت" }));
    fireEvent.click(screen.getByRole("option", { name: "دریافت‌شده" }));

    await waitFor(() => expect(screen.queryByText(/تامین‌کننده الف/)).toBeNull());
    expect(await screen.findByRole("status", { name: "در حال بارگذاری فهرست خریدها" })).toBeTruthy();

    await act(async () => {
      resolveReceived?.({
        ok: true,
        status: 200,
        json: async () => ({ purchases: [purchase({ id: "pur-2", status: "received", supplier_name: "تامین‌کننده ب" })] }),
      });
    });
    expect(await screen.findByText(/تامین‌کننده ب/)).toBeTruthy();
  });

  it("a same-scope refresh (after receiving a purchase) keeps the rows on screen, not a changed scope", async () => {
    let call = 0;
    vi.stubGlobal(
      "fetch",
      stubRoutes(() => {
        call += 1;
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ purchases: [purchase()] }) });
      }),
    );
    render(<PurchasesSection items={[]} suppliers={[]} busy={false} run={async () => true} />);
    await screen.findByText(/تامین‌کننده الف/);

    // Reselecting the already-active "همه وضعیت‌ها" is not a scope change.
    fireEvent.click(screen.getByRole("button", { name: "وضعیت" }));
    fireEvent.click(screen.getByRole("option", { name: "همه وضعیت‌ها" }));
    expect(screen.getByText(/تامین‌کننده الف/)).toBeTruthy();
    await waitFor(() => expect(call).toBe(1));
  });
});
