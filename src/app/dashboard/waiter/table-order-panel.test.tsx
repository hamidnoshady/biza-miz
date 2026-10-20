// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TableOrderPanel } from "./table-order-panel";
import { TablePickerDialog } from "../pos/table-picker-dialog";

const apiMock = vi.fn();
const apiOrQueueMock = vi.fn();

vi.mock("../ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ui")>();
  return {
    ...actual,
    api: (...args: unknown[]) => apiMock(...args),
  };
});

vi.mock("../offline-queue", () => ({
  apiOrQueue: (...args: unknown[]) => apiOrQueueMock(...args),
}));

vi.mock("../use-realtime", () => ({
  useRealtime: () => {},
}));

vi.mock("@/components/money/money-context", () => ({
  useMoney: () => ({
    format: (n: number) => `${n} ریال`,
    short: (n: number) => `${n}`,
  }),
}));

vi.mock("@/lib/printing/client", () => ({
  printKitchenTicket: vi.fn().mockResolvedValue({ ok: true }),
}));

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.mockImplementation(async (url: string) => {
    if (url === "/api/menu") {
      return {
        ok: true,
        data: {
          categories: [{ id: "cat-1", name: "نوشیدنی", is_active: true, sort_order: 1 }],
          items: [
            {
              id: "item-1",
              category_id: "cat-1",
              name: "اسپرسو",
              price: "90000",
              is_active: true,
              sort_order: 1,
            },
          ],
          modifierGroups: [],
          modifiers: [],
          itemModifierGroups: [],
        },
      };
    }
    if (url.startsWith("/api/orders/")) {
      return {
        ok: true,
        data: {
          items: [
            {
              id: "oi-existing",
              name_snapshot: "چای سیاه",
              quantity: 1,
              status: "sent",
              note: null,
            },
          ],
          modifiers: [],
        },
      };
    }
    return { ok: true, data: {} };
  });

  apiOrQueueMock.mockResolvedValue({
    ok: true,
    queued: false,
    data: { order: { id: "order-C-new" } },
  });
});

describe("Waiter TableOrderPanel & POS TablePickerDialog — explicit 'new order' vs 'select existing order'", () => {
  it("never appends a new order to the latest open order in TableOrderPanel unless an existing order is explicitly selected", async () => {
    const tableWithTwoOpenOrders = {
      id: "table-5",
      name: "میز ۵",
      status: "seated",
      session_id: "sess-5",
      guest_name: "سارا",
      order_id: "order-B-latest",
      active_order_count: 2,
      orders: [
        {
          id: "order-B-latest",
          order_number: 102,
          status: "open" as const,
          total: "250000",
          customer_id: null,
          customer_name: "مریم",
          opened_at: "2026-10-20T12:10:00Z",
          item_status_counts: {},
        },
        {
          id: "order-A-older",
          order_number: 101,
          status: "open" as const,
          total: "180000",
          customer_id: null,
          customer_name: "علی",
          opened_at: "2026-10-20T12:00:00Z",
          item_status_counts: {},
        },
      ],
    };

    // Open TableOrderPanel without passing initialOrderId — must default to "+ سفارش جدید مستقل", NOT order-B-latest!
    await act(async () => {
      render(
        <TableOrderPanel
          table={tableWithTwoOpenOrders}
          onBack={() => {}}
          onChanged={() => {}}
        />,
      );
    });

    const newOrderBtn = screen.getByRole("button", { name: "+ سفارش جدید مستقل" });
    const selectOrder102Btn = screen.getByRole("button", { name: /انتخاب سفارش #۱۰۲/ });
    const selectOrder101Btn = screen.getByRole("button", { name: /انتخاب سفارش #۱۰۱/ });

    expect(newOrderBtn.getAttribute("aria-pressed")).toBe("true");
    expect(selectOrder102Btn.getAttribute("aria-pressed")).toBe("false");
    expect(selectOrder101Btn.getAttribute("aria-pressed")).toBe("false");

    // Pick a menu item and send to kitchen -> must call POST /api/orders (new order), NEVER /api/orders/order-B-latest/items!
    await act(async () => {
      screen.getByText("اسپرسو").click();
    });
    await act(async () => {
      screen.getByRole("button", { name: "ارسال به آشپزخانه" }).click();
    });

    expect(apiOrQueueMock).toHaveBeenCalledTimes(1);
    expect(apiOrQueueMock.mock.calls[0][0]).toBe("/api/orders");
    expect(apiOrQueueMock.mock.calls[0][1]).toMatchObject({
      method: "POST",
      body: expect.objectContaining({
        type: "dine_in",
        tableId: "table-5",
      }),
    });
    expect(
      apiOrQueueMock.mock.calls.some(([url]) =>
        String(url).includes("/api/orders/order-B-latest/items"),
      ),
    ).toBe(false);

    // Now explicitly click "انتخاب سفارش #۱۰۱ · علی" and send an item -> appends ONLY to the explicitly selected order-A-older
    apiOrQueueMock.mockClear();
    await act(async () => {
      selectOrder101Btn.click();
    });
    expect(selectOrder101Btn.getAttribute("aria-pressed")).toBe("true");

    await act(async () => {
      screen.getByText("اسپرسو").click();
    });
    await act(async () => {
      screen.getByRole("button", { name: "ارسال به آشپزخانه" }).click();
    });

    expect(apiOrQueueMock).toHaveBeenCalledTimes(1);
    expect(apiOrQueueMock.mock.calls[0][0]).toBe("/api/orders/order-A-older/items");
  });

  it("exposes explicit 'new order' vs 'select existing order' actions in POS TablePickerDialog", async () => {
    const onConfirm = vi.fn();
    const onSelectExistingOrder = vi.fn();

    await act(async () => {
      render(
        <TablePickerDialog
          open
          intent="order"
          selectedTableId="table-5"
          guestCount="2"
          onCancel={() => {}}
          onConfirm={onConfirm}
          onSelectExistingOrder={onSelectExistingOrder}
          tables={[
            {
              id: "table-5",
              name: "میز ۵",
              capacity: 4,
              status: "seated",
              active_order_count: 2,
              open_orders: [
                {
                  id: "order-B-latest",
                  order_number: 102,
                  status: "open",
                  total: "250000",
                  customer_name: "مریم",
                },
                {
                  id: "order-A-older",
                  order_number: 101,
                  status: "open",
                  total: "180000",
                  customer_name: "علی",
                },
              ],
            },
          ]}
        />,
      );
    });

    const newIndependentOrderBtn = screen.getByRole("button", {
      name: "+ ثبت سفارش جدید مستقل",
    });
    const selectExisting102Btn = screen.getByRole("button", {
      name: /انتخاب سفارش موجود #۱۰۲/,
    });
    const selectExisting101Btn = screen.getByRole("button", {
      name: /انتخاب سفارش موجود #۱۰۱/,
    });

    expect(newIndependentOrderBtn).toBeTruthy();
    expect(selectExisting102Btn).toBeTruthy();
    expect(selectExisting101Btn).toBeTruthy();

    // Clicking "+ ثبت سفارش جدید مستقل" confirms a brand-new order and never selects an existing order
    await act(async () => {
      newIndependentOrderBtn.click();
    });
    expect(onConfirm).toHaveBeenCalledWith("table-5", "2", { mode: "new" });
    expect(onSelectExistingOrder).not.toHaveBeenCalled();

    // Clicking "انتخاب سفارش موجود #۱۰۲" explicitly invokes onSelectExistingOrder
    await act(async () => {
      selectExisting102Btn.click();
    });
    expect(onSelectExistingOrder).toHaveBeenCalledWith("order-B-latest", "table-5");
  });
});
