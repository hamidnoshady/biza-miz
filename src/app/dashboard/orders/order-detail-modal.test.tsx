// @vitest-environment jsdom

/**
 * Issue #910, P0 — the order dialog's line money, rendered from a real API
 * payload.
 *
 * `renderLine` used to pass `addOns.map(addOn => addOn.priceDelta)` to the
 * breakdown, so an add-on sold three times priced as one. This drives the
 * dialog the way the orders queue does — open it on an order id, let it fetch
 * `/api/orders/:id`, read the row — and asserts the arithmetic the customer
 * and the cashier both compare against the persisted total:
 *
 *   100,000 base + 20,000 × 3 shots = 160,000 Rial per unit, × 2 units =
 *   320,000 Rial — shown as ۱۶٬۰۰۰ / ۳۲٬۰۰۰ Toman, with «×۳» on the chip.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrderDetailModal } from "./order-detail-modal";

const apiMock = vi.hoisted(() => vi.fn());

vi.mock("../ui", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, api: apiMock };
});

vi.mock("../use-realtime", () => ({ useRealtime: () => undefined }));

// One frozen object, not a fresh literal per call: the dialog holds it in
// effect dependencies, and a new identity every render is an infinite loop.
const BUSINESS = Object.freeze({
  name: "کافه آزمون",
  address: null,
  phone: null,
  taxRate: 0,
  currency: "toman",
});
vi.mock("../use-business-info", () => ({ useBusinessInfo: () => BUSINESS }));

const PAYMENT_METHODS = Object.freeze({
  methods: Object.freeze([]) as never[],
  loaded: true,
  error: "",
  reload: async () => undefined,
});

vi.mock("../payment-ways", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    // Stable identities: the dialog holds `methods` in an effect dependency
    // that settles the draft, so a fresh array each call re-renders forever.
    usePaymentMethods: () => PAYMENT_METHODS,
  };
});

vi.mock("@/lib/printing/client", () => ({
  kickDrawer: vi.fn(async () => ({ ok: true })),
  printSaleReceipt: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../offline-queue", () => ({
  apiOrQueue: vi.fn(async () => ({ ok: true, queued: false, data: {} })),
}));

const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const ITEM_ID = "22222222-2222-4222-8222-222222222222";

const ORDER = {
  id: ORDER_ID,
  order_number: 102,
  type: "dine_in",
  status: "open",
  table_id: null,
  table_name: null,
  queue_number: null,
  customer_id: null,
  customer_name: null,
  customer_phone: null,
  guest_count: 2,
  note: null,
  subtotal: "320000",
  discount: "0",
  discount_type: null,
  discount_value: null,
  service_charge: "0",
  tax: "0",
  total: "320000",
  tip_amount: "0",
  paid_amount: "0",
  opened_at: new Date("2026-10-20T09:00:00.000Z").toISOString(),
  created_at: new Date("2026-10-20T09:00:00.000Z").toISOString(),
};

const ITEM = {
  id: ITEM_ID,
  menu_item_id: "33333333-3333-4333-8333-333333333333",
  name_snapshot: "لاته",
  unit_price: "100000",
  quantity: 2,
  status: "served",
  note: null,
  void_reason: null,
};

const MODIFIER = {
  id: "44444444-4444-4444-8444-444444444444",
  order_item_id: ITEM_ID,
  modifier_id: "55555555-5555-4555-8555-555555555555",
  name_snapshot: "شات اضافه",
  price_delta: "20000",
  quantity: 3,
};

beforeEach(() => {
  apiMock.mockReset();
  apiMock.mockImplementation(async (path: string) => {
    if (path === `/api/orders/${ORDER_ID}`) {
      return {
        ok: true,
        data: { order: ORDER, items: [ITEM], modifiers: [MODIFIER], payments: [] },
      };
    }
    if (path === "/api/menu") {
      return {
        ok: true,
        data: { categories: [], items: [], modifierGroups: [], modifiers: [], itemModifierGroups: [] },
      };
    }
    return { ok: true, data: {} };
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("OrderDetailModal — line pricing", () => {
  it("prices the repro line with each add-on's own quantity", async () => {
    render(
      <OrderDetailModal
        orderId={ORDER_ID}
        open
        onOpenChange={vi.fn()}
        canEdit={false}
        canTakePayment={false}
      />,
    );

    const name = await screen.findByText("لاته");
    const line = name.closest("li");
    expect(line).toBeTruthy();

    // Unit price is announced once, with the add-on share beside it.
    expect(line!.textContent).toContain("۱۶٬۰۰۰ تومان هر واحد");
    expect(line!.textContent).toContain("۶٬۰۰۰");
    // …and the chip names the sold count and the extended amount.
    const lineScope = within(line as HTMLElement);
    expect(lineScope.getByText("×۳")).toBeTruthy();
    expect(lineScope.getByText("+۶٬۰۰۰ تومان")).toBeTruthy();
    // The dialog's footer total is the order's own persisted figure; the line
    // row may state the same amount, so both occurrences are the same money.
    expect(screen.getAllByText("۳۲٬۰۰۰ تومان").length).toBeGreaterThan(0);
  });

  it("does not invent add-on money on a plain line", async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path === `/api/orders/${ORDER_ID}`) {
        return {
          ok: true,
          data: {
            order: { ...ORDER, subtotal: "200000", total: "200000" },
            items: [ITEM],
            modifiers: [],
            payments: [],
          },
        };
      }
      return { ok: true, data: {} };
    });

    render(
      <OrderDetailModal
        orderId={ORDER_ID}
        open
        onOpenChange={vi.fn()}
        canEdit={false}
        canTakePayment={false}
      />,
    );

    const name = await screen.findByText("لاته");
    const line = name.closest("li");
    expect(line!.textContent).toContain("۱۰٬۰۰۰ تومان هر واحد");
    expect(line!.textContent).not.toContain("افزودنی");
  });
});
