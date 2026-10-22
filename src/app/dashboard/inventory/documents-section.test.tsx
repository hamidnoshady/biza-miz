// @vitest-environment jsdom

/**
 * Issue #909 §13 — switching the kind filter («همه»/«رسید»/«حواله») used to
 * leave the *previous* filter's documents fully visible, selectable, with
 * nothing marking them stale, for as long as the newly-selected filter's
 * request was in flight: only the very first load ever set `documents` from
 * `null`. Fixed the same way `stock-section.tsx`'s warehouse switch was:
 * clear on a genuine filter change, never on a same-scope `reloadKey` bump.
 * The adjacent "item 4" gap (a same-scope refresh that itself fails must
 * not erase an already-loaded, perfectly good list) is fixed the same way
 * `stock-section.tsx`/`waste-section.tsx` already do it.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocumentsSection } from "./documents-section";

afterEach(cleanup);

function document_(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "doc-1",
    kind: "receipt",
    location_id: "wh-1",
    location_name: "انبار مرکزی",
    supplier_name: "تامین‌کننده الف",
    recipient: null,
    document_number: null,
    internal_voucher_number: "V-1",
    reversed_of: null,
    is_reversal: false,
    note: null,
    total_value_rial: "1000000",
    created_at: "2026-01-01T00:00:00Z",
    created_by_name: null,
    line_count: 1,
    ...overrides,
  };
}

function stubRoutes(onDocuments: (url: string) => unknown) {
  return vi.fn(async (url: string) => {
    if (url.startsWith("/api/inventory/warehouses")) {
      return { ok: true, status: 200, json: async () => ({ warehouses: [] }) };
    }
    if (url.startsWith("/api/inventory/warehouse-documents")) {
      return onDocuments(url);
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}

describe("DocumentsSection — a changed scope (switching the kind filter) must not keep showing the old filter's documents", () => {
  it("clears the previous filter's documents immediately on switch, never rendering them under the newly-selected filter", async () => {
    let resolveIssue: ((value: unknown) => void) | null = null;
    let call = 0;
    vi.stubGlobal(
      "fetch",
      stubRoutes((url) => {
        call += 1;
        if (call === 1) {
          expect(url).not.toContain("kind=");
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({ documents: [document_({ id: "doc-receipt", supplier_name: "تامین‌کننده الف" })] }),
          });
        }
        // The «حواله» request deliberately never resolves during the
        // assertions below — this is exactly the window the old defect
        // kept the receipt row on screen through.
        expect(url).toContain("kind=issue");
        return new Promise((resolve) => {
          resolveIssue = resolve;
        });
      }),
    );
    render(<DocumentsSection />);
    await screen.findByText("تامین‌کننده الف");

    fireEvent.click(screen.getByRole("button", { name: "حواله" }));

    // The «حواله» request is still in flight (never resolved above) — the
    // list must already have dropped the receipt row rather than showing
    // it as if it matched the newly-selected «حواله» filter.
    await waitFor(() => expect(screen.queryByText("تامین‌کننده الف")).toBeNull());
    expect(await screen.findByRole("status", { name: "در حال بارگذاری سندهای انبار" })).toBeTruthy();

    await act(async () => {
      resolveIssue?.({
        ok: true,
        status: 200,
        json: async () => ({ documents: [document_({ id: "doc-issue", kind: "issue", recipient: "انباردار شمال" })] }),
      });
    });
    expect(await screen.findByText("انباردار شمال")).toBeTruthy();
  });

  it("reselecting the filter already active is not a scope change and must not disturb what is on screen", async () => {
    let call = 0;
    vi.stubGlobal(
      "fetch",
      stubRoutes(() => {
        call += 1;
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ documents: [document_()] }) });
      }),
    );
    render(<DocumentsSection />);
    await screen.findByText("تامین‌کننده الف");

    fireEvent.click(screen.getByRole("button", { name: "همه" }));
    expect(screen.getByText("تامین‌کننده الف")).toBeTruthy();
    await waitFor(() => expect(call).toBe(1));
  });

  it("a same-scope refresh (reloadKey bump after reversing a document) that itself fails must not wipe an already-loaded, perfectly good list", async () => {
    // The list GET always has a trailing `?` (even with no filters set);
    // the detail GET and the reverse POST both have a path segment after
    // `warehouse-documents/` instead — distinct enough to route by URL alone.
    const isListUrl = (url: string) => url.startsWith("/api/inventory/warehouse-documents?");
    let listCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.startsWith("/api/inventory/warehouses")) {
          return { ok: true, status: 200, json: async () => ({ warehouses: [] }) };
        }
        if (url.endsWith("/reverse")) {
          return { ok: true, status: 200, json: async () => ({ reversalId: "rev-1" }) };
        }
        if (/warehouse-documents\/doc-1$/.test(url)) {
          return { ok: true, status: 200, json: async () => ({ document: document_(), lines: [] }) };
        }
        if (isListUrl(url)) {
          listCalls += 1;
          // First list load succeeds; the reload a successful reversal
          // triggers (same filters, same scope) fails — the row must still
          // be on screen afterwards.
          if (listCalls === 1) return { ok: true, status: 200, json: async () => ({ documents: [document_()] }) };
          return { ok: false, status: 500, json: async () => ({ error: "server_error" }) };
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );
    render(<DocumentsSection />);
    await screen.findByText("تامین‌کننده الف");

    fireEvent.click(screen.getByRole("button", { name: "جزئیات سند رسید انبار مرکزی" }));
    await screen.findByText(/شماره داخلی/);
    fireEvent.click(screen.getByRole("button", { name: "برگشت سند (سند معکوس)" }));
    fireEvent.click(screen.getByRole("button", { name: "تأیید برگشت" }));

    await waitFor(() => expect(listCalls).toBe(2));
    // The reload after a successful reversal failed — the row that was
    // already correctly on screen for these filters must still be there.
    expect(screen.getByText("تامین‌کننده الف")).toBeTruthy();
  });
});
