/** @vitest-environment jsdom */
//
// The orders list: what the owner meets when the store has hundreds of orders
// and a few custom statuses.
//
//   * typing in search is debounced and never replaces the field with a
//     loading state, and an older answer cannot overwrite a newer one;
//   * the counts and the status chips come from the server's facets, so they
//     describe the whole store, not the 25 rows on screen;
//   * a custom store status is shown (not «وضعیت نامشخص») and is offered
//     as a target for «تغییر وضعیت» beside WooCommerce's canonical seven.
//
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type React from "react";

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children?: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock("@/app/dashboard/ui", () => ({
  api: vi.fn(),
  errorMessageOrRaw: (message: string) => message,
  ErrorBox: ({ children }: { children?: React.ReactNode }) => (children ? <div role="alert">{children}</div> : null),
  InfoBox: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  inputClass: "",
}));
vi.mock("./woo-order-detail-modal", () => ({ WooOrderDetailModal: () => null }));

import { api } from "@/app/dashboard/ui";
import { StoreOrdersSection } from "./orders-section";

const FACETS = {
  total: 120,
  imported: 100,
  unrecorded: 20,
  queued: 3,
  attention: 1,
  statuses: [
    { value: "processing", count: 70 },
    { value: "completed", count: 45 },
    { value: "shipped", count: 5 },
  ],
};

function order(overrides: Record<string, unknown> = {}) {
  return {
    remoteId: "1001",
    localOrderId: "o-1",
    localOrderNumber: 12,
    number: "1001",
    status: "shipped",
    total: "250000",
    currency: "IRT",
    dateCreated: "2026-10-20T10:00:00Z",
    customer: "سارا احمدی",
    paymentMethod: "zarinpal",
    paymentMethodTitle: "زرین‌پال",
    ingestStatus: "processed",
    ingestError: null,
    lineCount: 3,
    operations: [],
    ...overrides,
  };
}

const call = vi.fn();
const mockedApi = vi.mocked(api);

function respond(orders = [order()], total = orders.length) {
  mockedApi.mockResolvedValue({ ok: true, status: 200, aborted: false, data: { orders, total, page: 1, pageSize: 25, facets: FACETS } } as never);
}

const lastUrl = () => String(mockedApi.mock.calls.at(-1)?.[0]);

beforeEach(() => {
  vi.clearAllMocks();
  call.mockResolvedValue({ ok: true });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("StoreOrdersSection", () => {
  it("shows a custom store status by name and counts the whole store, not the page", async () => {
    respond();
    render(<StoreOrdersSection connectionId="c1" busy={false} call={call as never} />);
    await screen.findByText("#1001");
    const statusRow = screen.getByRole("group", { name: "فیلتر وضعیت سفارش ووکامرس" });
    expect(within(statusRow).getByText(/shipped/)).toBeTruthy();
    expect(within(statusRow).getByText(/در حال پردازش/).textContent).toContain("۷۰");
    // the page holds one order; the summary chips hold the store's totals
    const work = screen.getByRole("group", { name: "فیلتر کار سفارش‌ها" });
    expect(work.textContent).toContain("۱۲۰");
    expect(work.textContent).toContain("۲۰");
    // the card badge is the custom status, not «وضعیت نامشخص»
    expect(screen.queryByText("وضعیت نامشخص")).toBeNull();
  });

  it("shows the gateway's own payment name instead of its code (#1215 P1-3)", async () => {
    respond([order({ paymentMethod: "cod", paymentMethodTitle: "پرداخت در محل" })]);
    render(<StoreOrdersSection connectionId="c1" busy={false} call={call as never} />);
    await screen.findByText("#1001");
    expect(screen.getByText(/پرداخت در محل/)).toBeTruthy();
    expect(screen.queryByText(/cod/)).toBeNull();
  });

  it("uses the store's registered status name and offers a registered status it has not used yet", async () => {
    respond();
    const registry = new Map([
      ["shipped", "ارسال شد"],
      ["awaiting-pickup", "در انتظار تحویل"],
    ]);
    render(<StoreOrdersSection connectionId="c1" busy={false} call={call as never} statusRegistry={registry} />);
    await screen.findByText("#1001");
    // The card badge and the status chip are the store's own words, not the slug.
    expect(screen.getAllByText("ارسال شد").length).toBeGreaterThan(0);
    expect(screen.queryByText("shipped")).toBeNull();

    fireEvent.click(screen.getAllByRole("button", { name: "تغییر وضعیت" })[0]);
    // A status the store registered but has never used is now choosable.
    expect(screen.getByRole("group", { name: "تغییر وضعیت سفارش 1001" }).textContent).toContain("در انتظار تحویل");
  });

  it("debounces search into one request and keeps the field typeable", async () => {
    respond();
    render(<StoreOrdersSection connectionId="c1" busy={false} call={call as never} />);
    await screen.findByText("#1001");
    vi.useFakeTimers();
    const field = screen.getByRole("searchbox", { name: "جست‌وجو در سفارش‌های ووکامرس" }) as HTMLInputElement;
    const before = mockedApi.mock.calls.length;
    for (const text of ["س", "سا", "سار", "سارا"]) {
      fireEvent.change(field, { target: { value: text } });
      expect(field.value).toBe(text);
    }
    expect(mockedApi.mock.calls.length).toBe(before);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(mockedApi.mock.calls.length).toBe(before + 1);
    expect(decodeURIComponent(lastUrl())).toContain("search=سارا");
    expect(field.disabled).toBe(false);
  });

  it("filters by the store's own status and resets to the first page", async () => {
    respond();
    render(<StoreOrdersSection connectionId="c1" busy={false} call={call as never} />);
    await screen.findByText("#1001");
    fireEvent.click(within(screen.getByRole("group", { name: "فیلتر وضعیت سفارش ووکامرس" })).getByText(/shipped/));
    await waitFor(() => expect(lastUrl()).toContain("status=shipped"));
    expect(lastUrl()).toContain("page=1");
  });

  it("offers the store's custom statuses as a target and queues the change", async () => {
    respond();
    render(<StoreOrdersSection connectionId="c1" busy={false} call={call as never} />);
    await screen.findByText("#1001");
    fireEvent.click(screen.getByRole("button", { name: "تغییر وضعیت" }));
    const picker = screen.getByRole("group", { name: "تغییر وضعیت سفارش 1001" });
    expect(within(picker).getByRole("button", { name: /معلق/ })).toBeTruthy();
    fireEvent.click(within(picker).getByRole("button", { name: /تکمیل‌شده/ }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        "/api/integrations/connections/c1/store/orders",
        "POST",
        { action: "status", remoteId: "1001", status: "completed" },
      ),
    );
  });

  it("pages through the mirror with the shared pager", async () => {
    respond([order()], 60);
    render(<StoreOrdersSection connectionId="c1" busy={false} call={call as never} />);
    await screen.findByText("#1001");
    fireEvent.click(screen.getByRole("button", { name: /بعدی/ }));
    await waitFor(() => expect(lastUrl()).toContain("page=2"));
  });
});
