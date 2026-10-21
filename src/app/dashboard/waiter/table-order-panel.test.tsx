// @vitest-environment jsdom

/**
 * Issue #910 — one order, one add-on quantity, on both sides of the waiter's
 * screen.
 *
 * The waiter sees the same order twice: the cart it is about to send, and the
 * order the kitchen already has. Both are rendered from the same shape —
 * `DisplayModifier[]` with `quantity` — and after the audit both must state
 * the sold count, not just the option name:
 *
 *   - new cart line: holding/pressing «+» three times on «شات اضافه» puts
 *     `{id, quantity: 3}` on the payload, and the badge reads «×۳» with the
 *     per-unit extended money;
 *   - open order loaded from the server: `order_item_modifiers.quantity = 3`
 *     reaches the badge the same way, so the waiter's figures match the order
 *     dialog and the receipt instead of silently showing one shot.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MenuTreePayload } from "@/lib/restaurant-menu";
import { TableOrderPanel } from "./table-order-panel";

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

describe("TableOrderPanel — add-on quantities", () => {
  it("sends the add-on quantity it built, not one unit", async () => {
    const user = userEvent.setup();
    render(<TableOrderPanel table={TABLE} onBack={vi.fn()} onChanged={vi.fn()} />);

    await addThreeShots(user);

    // The cart line states «×۳» and the per-unit extended price. Deltas are
    // stored in Rial (۲۰٬۰۰۰) and shown in Toman (۲٬۰۰۰), so three shots are
    // ۶٬۰۰۰ تومان on every unit — not the ۲٬۰۰۰ of a single shot.
    const cart = screen
      .getAllByRole("list")
      .find((list) => list.textContent?.includes("شات اضافه"));
    expect(cart).toBeTruthy();
    expect(cart!.textContent).toContain("×۳");
    expect(cart!.textContent).toContain("۶٬۰۰۰ تومان");
    // The unit price is named beside the extended one, never merged with it.
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
    // One latte, three shots — the two counts are separate numbers.
    expect(body.items[0].quantity).toBe(1);
    expect(body.items[0].modifiers).toEqual([{ id: OPTION_ID, quantity: 3 }]);
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
    // The badge carries the sold count and the per-unit total: 3 × 20,000 Rial.
    expect(screen.getByText("×۳")).toBeTruthy();
    // The chip's own money is the extended one…
    expect(screen.getByText("+۶٬۰۰۰ تومان")).toBeTruthy();
    // …and the caption says what that is: per unit, not for the whole line.
    expect(screen.getByText(/روی هر واحد/).textContent).toContain("+۶٬۰۰۰ تومان");
    // …and the single-shot amount is still visible beside it.
    expect(screen.getByText("(هر عدد +۲٬۰۰۰)")).toBeTruthy();
    // And no second line was invented for the same order.
    expect(screen.queryByText("۱× لاته")).toBeNull();
  });
});
