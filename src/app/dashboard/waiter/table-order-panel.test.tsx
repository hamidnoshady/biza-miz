// @vitest-environment jsdom
/**
 * Waiter TableOrderPanel & POS TablePickerDialog tests:
 *  - Issue #916: explicit 'new order' vs 'select existing order' (never
 *    auto-appends a new order to the latest open order on a table).
 *  - Issue #910: one order, one add-on quantity, on both sides of the waiter's
 *    screen (cart line and saved open order).
 */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MenuTreePayload } from "@/lib/restaurant-menu";
import { printKitchenTicket } from "@/lib/printing/client";
import { TableOrderPanel } from "./table-order-panel";
import { TablePickerDialog } from "../pos/table-picker-dialog";

vi.mock("../use-realtime", () => ({ useRealtime: () => undefined }));
vi.mock("@/lib/printing/client", () => ({ printKitchenTicket: vi.fn(async () => ({ ok: true })) }));

const apiMock = vi.hoisted(() => vi.fn());
const apiOrQueueMock = vi.hoisted(() => vi.fn());

vi.mock("../ui", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, api: apiMock };
});

vi.mock("../offline-queue", () => ({ apiOrQueue: apiOrQueueMock }));

const ITEM_ID = "11111111-1111-4111-8111-111111111111";
const GROUP_ID = "22222222-2222-4222-8222-222222222222";
const OPTION_ID = "33333333-3333-4333-8333-333333333333";
const TABLE_ID = "44444444-4444-4444-8444-444444444444";
const ORDER_ID = "55555555-5555-4555-8555-555555555555";

/** The `/api/menu` payload is the raw (snake_case) tree, as the server sends it. */
const MENU: MenuTreePayload = {
  categories: [
    { id: "66666666-6666-4666-8666-666666666666", name: "نوشیدنی", tax_rate: 0, sort_order: 0, is_active: true },
  ],
  items: [
    {
      id: ITEM_ID,
      category_id: "66666666-6666-4666-8666-666666666666",
      name: "لاته",
      description: null,
      sku: null,
      price: 100_000,
      image_url: null,
      image_media_id: null,
      sort_order: 0,
      is_active: true,
      target_margin_percent: null,
    },
  ],
  modifierGroups: [
    { id: GROUP_ID, name: "افزودنی‌ها", min_select: 0, max_select: 3, sort_order: 0, is_active: true },
  ],
  modifiers: [
    {
      id: OPTION_ID,
      group_id: GROUP_ID,
      name: "شات اضافه",
      price_delta: 20_000,
      sort_order: 0,
      is_active: true,
    },
  ],
  itemModifierGroups: [
    {
      menu_item_id: ITEM_ID,
      modifier_group_id: GROUP_ID,
      min_select_override: null,
      max_select_override: null,
      sort_order: 0,
      is_active: true,
    },
  ],
};

const TABLE = {
  id: TABLE_ID,
  name: "میز ۱",
  section_id: null,
  capacity: 4,
  status: "occupied" as const,
  session_id: "77777777-7777-4777-8777-777777777777",
  party_size: 2,
  guest_name: null,
  order_id: null as string | null,
  order_number: null,
  item_status_counts: {},
};

function ok<T>(data: T) {
  return { ok: true as const, data };
}

function mockMenu() {
  apiMock.mockImplementation(async (path: string) => {
    if (path === "/api/menu") return ok(MENU);
    if (path === `/api/orders/${ORDER_ID}`) return ok({ items: [], modifiers: [] });
    return ok({});
  });
}

beforeEach(() => {
  apiMock.mockReset();
  apiOrQueueMock.mockReset();
  apiOrQueueMock.mockResolvedValue({ ok: true, queued: false, data: { order: { id: ORDER_ID } } });
  mockMenu();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function addThreeShots(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: /لاته/ }));
  const plus = await screen.findByLabelText("افزودن یک شات اضافه");
  await user.click(plus);
  await user.click(plus);
  await user.click(plus);
  await user.click(screen.getByRole("button", { name: /^افزودن —/ }));
}

describe("TableOrderPanel — add-on quantities (Issue #910)", () => {
  it("sends the add-on quantity it built, not one unit", async () => {
    const user = userEvent.setup();
    render(<TableOrderPanel table={TABLE} onBack={vi.fn()} onChanged={vi.fn()} />);

    await addThreeShots(user);

    const cart = screen
      .getAllByRole("list")
      .find((list) => list.textContent?.includes("شات اضافه"));
    expect(cart).toBeTruthy();
    expect(cart!.textContent).toContain("×۳");
    expect(cart!.textContent).toContain("۶٬۰۰۰ تومان");
    expect(cart!.textContent).toContain("هر عدد +۲٬۰۰۰");

    await user.click(screen.getByRole("button", { name: "ارسال به آشپزخانه" }));

    await waitFor(() => expect(apiOrQueueMock).toHaveBeenCalledTimes(1));
    const [path, init] = apiOrQueueMock.mock.calls[0];
    expect(path).toBe("/api/orders");
    const body = init.body as {
      items: { menuItemId: string; quantity: number; modifiers: { id: string; quantity: number }[] }[];
    };
    expect(body.items).toHaveLength(1);
    expect(body.items[0].menuItemId).toBe(ITEM_ID);
    expect(body.items[0].quantity).toBe(1);
    expect(body.items[0].modifiers).toEqual([{ id: OPTION_ID, quantity: 3 }]);
    // Order mutations enqueue durable kitchen dispatch in their transaction;
    // the panel must not print a second, non-idempotent copy itself.
    expect(printKitchenTicket).not.toHaveBeenCalled();
  });

  it("sends only this new round through the order-items mutation", async () => {
    const user = userEvent.setup();
    const seatedTable = { ...TABLE, order_id: ORDER_ID };
    render(<TableOrderPanel table={seatedTable} onBack={vi.fn()} onChanged={vi.fn()} />);

    await addThreeShots(user);
    await user.click(screen.getByRole("button", { name: "ارسال به آشپزخانه" }));

    await waitFor(() => expect(apiOrQueueMock).toHaveBeenCalledTimes(1));
    const [path, init] = apiOrQueueMock.mock.calls[0];
    expect(path).toBe(`/api/orders/${ORDER_ID}/items`);
    expect(init.method).toBe("POST");
    expect(init.body.items).toHaveLength(1);
    expect(init.body.items[0]).toMatchObject({ menuItemId: ITEM_ID, quantity: 1 });
    expect(printKitchenTicket).not.toHaveBeenCalled();
  });

  it("shows the open order's saved add-on quantity the same way", async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path === "/api/menu") return ok(MENU);
      if (path === `/api/orders/${ORDER_ID}`) {
        return ok({
          items: [
            {
              id: "88888888-8888-4888-8888-888888888888",
              name_snapshot: "لاته",
              quantity: 2,
              status: "pending" as const,
              note: null,
            },
          ],
          modifiers: [
            {
              order_item_id: "88888888-8888-4888-8888-888888888888",
              name_snapshot: "شات اضافه",
              price_delta: "20000",
              quantity: 3,
            },
          ],
        });
      }
      return ok({});
    });

    render(
      <TableOrderPanel
        table={{ ...TABLE, order_id: ORDER_ID }}
        onBack={vi.fn()}
        onChanged={vi.fn()}
      />,
    );

    await screen.findByText("۲× لاته");
    expect(screen.getByText("×۳")).toBeTruthy();
    expect(screen.getByText("+۶٬۰۰۰ تومان")).toBeTruthy();
    expect(screen.getByText(/روی هر واحد/).textContent).toContain("+۶٬۰۰۰ تومان");
    expect(screen.getByText("(هر عدد +۲٬۰۰۰)")).toBeTruthy();
    expect(screen.queryByText("۱× لاته")).toBeNull();
  });
});

describe("Waiter TableOrderPanel & POS TablePickerDialog — explicit 'new order' vs 'select existing order' (Issue #916)", () => {
  it("never appends a new order to the latest open order in TableOrderPanel unless an existing order is explicitly selected", async () => {
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

    await act(async () => {
      newIndependentOrderBtn.click();
    });
    expect(onConfirm).toHaveBeenCalledWith("table-5", "2", { mode: "new" });
    expect(onSelectExistingOrder).not.toHaveBeenCalled();

    await act(async () => {
      selectExisting102Btn.click();
    });
    expect(onSelectExistingOrder).toHaveBeenCalledWith("order-B-latest", "table-5");
  });
});
