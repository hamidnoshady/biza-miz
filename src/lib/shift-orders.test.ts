import { describe, expect, it } from "vitest";
import {
  groupShiftOrders,
  type ShiftOrderItemInput,
  type ShiftOrderPaymentInput,
} from "./shift-orders";

function row(over: Partial<ShiftOrderItemInput> = {}): ShiftOrderItemInput {
  return {
    orderId: "o1",
    orderNumber: 102,
    type: "dine_in",
    status: "completed",
    tableName: "میز ۴",
    guestCount: 2,
    customerName: null,
    openedAt: "2026-08-11T11:42:00.000Z",
    closedAt: "2026-08-11T12:10:00.000Z",
    openedByName: "سارا",
    closedByName: "سارا",
    orderNote: null,
    voidedReason: null,
    amendedAt: null,
    subtotal: 2_000_000,
    discount: 0,
    discountType: null,
    discountValue: null,
    serviceCharge: 0,
    tax: 150_000,
    tipAmount: 0,
    orderTotal: 2_150_000,
    itemId: "i1",
    itemName: "اسپرسو",
    quantity: 1,
    unitPrice: 600_000,
    modifiers: [],
    itemStatus: "served",
    note: null,
    voidReason: null,
    ...over,
  };
}

function payment(over: Partial<ShiftOrderPaymentInput> = {}): ShiftOrderPaymentInput {
  return {
    orderId: "o1",
    method: "cash",
    methodName: "نقدی",
    amount: 2_150_000,
    reference: null,
    receivedAt: "2026-08-11T12:10:00.000Z",
    receivedByName: "سارا",
    ...over,
  };
}

describe("groupShiftOrders", () => {
  it("keeps every slice of a split payment, in the order it was taken", () => {
    const orders = groupShiftOrders(
      [row({ itemId: "i1" })],
      [
        payment({ amount: 1_000_000, methodName: "نقدی" }),
        payment({ method: "card", methodName: "پوز ملت", amount: 1_150_000 }),
      ],
    );
    expect(orders[0].payments.map((p) => [p.methodName, p.amount])).toEqual([
      ["نقدی", 1_000_000],
      ["پوز ملت", 1_150_000],
    ]);
  });

  it("collapses the join into one entry per order, preserving row order", () => {
    const orders = groupShiftOrders([
      row({ itemId: "i1" }),
      row({ itemId: "i2", itemName: "کیک شکلاتی" }),
      row({ orderId: "o2", orderNumber: 103, type: "takeaway", tableName: null, itemId: "i3", itemName: "لاته" }),
    ]);
    expect(orders.map((o) => o.id)).toEqual(["o1", "o2"]);
    expect(orders[0]!.lines.map((l) => l.name)).toEqual(["اسپرسو", "کیک شکلاتی"]);
    expect(orders[1]!.lines).toHaveLength(1);
  });

  it("prices a line as (unit price + modifier deltas) × quantity", () => {
    const [order] = groupShiftOrders([
      row({
        quantity: 2,
        unitPrice: 600_000,
        modifiers: [
          { name: "شات اضافه", priceDelta: 50_000 },
          { name: "بدون شکر", priceDelta: -20_000 },
        ],
      }),
    ]);
    expect(order!.lines[0]!.amount).toBe(1_260_000);
  });

  it("prices the issue's repro: 100,000 + shot 20,000 ×3, two units = 320,000", () => {
    // The one arithmetic every surface must agree on (issue #910). The shift
    // report reads the same snapshots the till wrote, so it must reach the
    // same number the cart, the order dialog and the receipt show.
    const [order] = groupShiftOrders([
      row({
        quantity: 2,
        unitPrice: 100_000,
        modifiers: [{ name: "شات اضافه", priceDelta: 20_000, quantity: 3 }],
      }),
    ]);
    const line = order!.lines[0]!;
    expect(line.amount).toBe(320_000);
    expect(line.addOnsPerUnit).toBe(60_000);
    // The order-level add-on total is per unit × line quantity.
    expect(order!.addOnTotal).toBe(120_000);
    expect(order!.itemCount).toBe(2);
  });

  it("counts an add-on that has no quantity field as one unit", () => {
    // Rows written before migration 0169 have no quantity; they were one each.
    const [order] = groupShiftOrders([
      row({ quantity: 1, unitPrice: 100_000, modifiers: [{ name: "شات", priceDelta: 20_000 }] }),
    ]);
    expect(order!.lines[0]!.amount).toBe(120_000);
    expect(order!.lines[0]!.addOnsPerUnit).toBe(20_000);
  });

  it("subtracts a negative add-on by its own quantity", () => {
    const [order] = groupShiftOrders([
      row({
        quantity: 2,
        unitPrice: 100_000,
        modifiers: [{ name: "تخفیف شیر", priceDelta: -10_000, quantity: 2 }],
      }),
    ]);
    expect(order!.lines[0]!.amount).toBe(160_000);
    expect(order!.lines[0]!.addOnsPerUnit).toBe(-20_000);
  });

  it("keeps a line's add-ons by name, with its base unit price and per-unit add-on total", () => {
    const [order] = groupShiftOrders([
      row({
        quantity: 3,
        unitPrice: 600_000,
        modifiers: [
          { name: "شات اضافه", priceDelta: 50_000 },
          { name: "شیر بادام", priceDelta: 30_000 },
        ],
      }),
    ]);
    const line = order!.lines[0]!;
    expect(line.modifiers.map((m) => m.name)).toEqual(["شات اضافه", "شیر بادام"]);
    expect(line.unitPrice).toBe(600_000);
    expect(line.addOnsPerUnit).toBe(80_000);
  });

  it("totals the order's add-ons across live lines only", () => {
    const [order] = groupShiftOrders([
      row({ itemId: "i1", quantity: 2, modifiers: [{ name: "شات اضافه", priceDelta: 50_000 }] }),
      row({
        itemId: "i2",
        quantity: 5,
        itemStatus: "voided",
        modifiers: [{ name: "شات اضافه", priceDelta: 50_000 }],
      }),
    ]);
    expect(order!.addOnTotal).toBe(100_000);
  });

  it("keeps voided lines flagged but out of the item count, with their reason", () => {
    const [order] = groupShiftOrders([
      row({ itemId: "i1", quantity: 2 }),
      row({ itemId: "i2", quantity: 3, itemStatus: "voided", voidReason: "اشتباه صندوق‌دار" }),
    ]);
    expect(order!.itemCount).toBe(2);
    expect(order!.lines.map((l) => l.voided)).toEqual([false, true]);
    expect(order!.lines[1]!.voidReason).toBe("اشتباه صندوق‌دار");
  });

  it("keeps an order that has no lines yet", () => {
    const [order] = groupShiftOrders([row({ status: "open", itemId: null, itemName: null, itemStatus: null })]);
    expect(order!.lines).toEqual([]);
    expect(order!.itemCount).toBe(0);
    expect(order!.addOnTotal).toBe(0);
  });

  it("reports the order's own total, not the sum of its lines", () => {
    const [order] = groupShiftOrders([row({ orderTotal: 2_150_000, unitPrice: 600_000, quantity: 1 })]);
    expect(order!.total).toBe(2_150_000);
  });

  it("carries the order's own money breakdown and its facts", () => {
    const [order] = groupShiftOrders([
      row({
        subtotal: 2_000_000,
        discount: 200_000,
        discountType: "percent",
        discountValue: 10,
        serviceCharge: 100_000,
        tax: 90_000,
        tipAmount: 50_000,
        customerName: "رضا",
        orderNote: "بدون نمک",
      }),
    ]);
    expect(order).toMatchObject({
      subtotal: 2_000_000,
      discount: 200_000,
      discountType: "percent",
      discountValue: 10,
      serviceCharge: 100_000,
      tax: 90_000,
      tipAmount: 50_000,
      customerName: "رضا",
      note: "بدون نمک",
      guestCount: 2,
      openedByName: "سارا",
    });
  });

  it("attaches payments to their own order without fanning out the lines", () => {
    const orders = groupShiftOrders(
      [
        row({ itemId: "i1" }),
        row({ itemId: "i2", itemName: "کیک شکلاتی" }),
        row({ orderId: "o2", orderNumber: 103, itemId: "i3", itemName: "لاته" }),
      ],
      [
        payment({ method: "cash", amount: 1_000_000 }),
        payment({ method: "card", amount: 1_150_000 }),
        payment({ orderId: "o2", method: "card", amount: 900_000 }),
      ],
    );
    expect(orders[0]!.lines).toHaveLength(2);
    expect(orders[0]!.payments.map((p) => p.method)).toEqual(["cash", "card"]);
    expect(orders[1]!.payments).toHaveLength(1);
  });

  it("ignores a payment whose order is outside the reported window", () => {
    const [order] = groupShiftOrders([row()], [payment({ orderId: "gone" })]);
    expect(order!.payments).toEqual([]);
  });
});
