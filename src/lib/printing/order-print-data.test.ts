/**
 * A sale's printed receipt and kitchen ticket, built from the sale's own rows
 * (issue #815: server-side loading and authorization of persisted operational
 * documents).
 *
 * These are pure functions, so the money and the wording can be pinned exactly:
 *
 *  - the lines are the persisted ones — a voided line never prints, an add-on
 *    is charged by its own quantity, and the line total is the arithmetic the
 *    till screen uses (`linePriceBreakdown`);
 *  - the issue moment is the sale's own (`closed_at`, else `opened_at`): a
 *    reprint months later shows the day the sale happened, never today;
 *  - the labels come from the order's type and table, and the payments from the
 *    tender rows, with the business's method names honoured.
 */
import { describe, expect, it } from "vitest";
import type { OrderDetail, OrderDetailItem, OrderDetailModifier, OrderDetailPayment, OrderDetailOrder } from "../order-read-service";
import { buildOrderKitchenTicket, buildOrderReceipt } from "./order-print-data";

const business = {
  name: "کافه نمونه",
  address: "تهران، خیابان نمونه",
  phone: "02100000000",
  footerMessage: "با تشکر از خرید شما",
};

function order(overrides: Partial<OrderDetailOrder> = {}): OrderDetailOrder {
  return {
    id: "order-1",
    location_id: "loc-1",
    order_number: "12",
    type: "dine_in",
    status: "completed",
    table_id: "table-1",
    table_name: "میز ۳",
    customer_id: null,
    customer_name: null,
    customer_phone: null,
    guest_count: 2,
    subtotal: "500000",
    discount: "50000",
    discount_type: null,
    discount_value: null,
    service_charge: "0",
    tax: "45000",
    total: "495000",
    tip_amount: "20000",
    note: null,
    opened_by: null,
    closed_by: null,
    opened_at: new Date("2026-02-01T18:30:00.000Z"),
    closed_at: new Date("2026-02-01T20:15:00.000Z"),
    voided_reason: null,
    ...overrides,
  };
}

function item(overrides: Partial<OrderDetailItem> = {}): OrderDetailItem {
  return {
    id: "item-1",
    menu_item_id: "menu-1",
    name_snapshot: "چای",
    unit_price: "100000",
    quantity: 2,
    status: "served",
    note: null,
    void_reason: null,
    created_at: new Date("2026-02-01T18:31:00.000Z"),
    ...overrides,
  };
}

function modifier(overrides: Partial<OrderDetailModifier> = {}): OrderDetailModifier {
  return {
    id: "mod-1",
    order_item_id: "item-1",
    modifier_id: "m-1",
    name_snapshot: "شکر اضافه",
    price_delta: "10000",
    quantity: 2,
    ...overrides,
  };
}

function payment(overrides: Partial<OrderDetailPayment> = {}): OrderDetailPayment {
  return {
    id: "pay-1",
    method: "cash",
    amount: "300000",
    reference: null,
    received_at: new Date("2026-02-01T20:15:00.000Z"),
    payment_method_name: null,
    ...overrides,
  };
}

function detail(overrides: Partial<OrderDetail> = {}): OrderDetail {
  return { order: order(), items: [item()], modifiers: [], payments: [], ...overrides };
}

describe("buildOrderReceipt", () => {
  it("prints the sale's own issue moment, never the moment of the reprint", () => {
    expect(buildOrderReceipt(detail(), business, "toman").issuedAt).toEqual(new Date("2026-02-01T20:15:00.000Z"));
    // An order that never closed (a bill printed before payment) falls back to
    // the moment it opened.
    const open = detail({ order: order({ status: "open", closed_at: null }) });
    expect(buildOrderReceipt(open, business, "toman").issuedAt).toEqual(new Date("2026-02-01T18:30:00.000Z"));
  });

  it("takes every amount from the order row, not from arithmetic on the lines", () => {
    const receipt = buildOrderReceipt(detail(), business, "toman");
    expect(receipt.subtotal).toBe(500_000);
    expect(receipt.discount).toBe(50_000);
    expect(receipt.tax).toBe(45_000);
    expect(receipt.total).toBe(495_000);
    expect(receipt.tip).toBe(20_000);
    expect(receipt.unit).toBe("toman");
    expect(receipt.business).toEqual(business);
  });

  it("keeps the sale's own line detail: quantity, add-ons and their money", () => {
    const receipt = buildOrderReceipt(
      detail({ items: [item(), item({ id: "item-2", name_snapshot: "کیک", unit_price: "150000", quantity: 1 })], modifiers: [modifier()] }),
      business,
      "toman",
    );
    expect(receipt.lines).toEqual([
      // 2 × (100000 + 2 × 10000)
      { name: "چای", quantity: 2, lineTotal: 240_000, modifiersLabel: "شکر اضافه ×۲" },
      { name: "کیک", quantity: 1, lineTotal: 150_000, modifiersLabel: null },
    ]);
  });

  it("never prints a voided line", () => {
    const receipt = buildOrderReceipt(
      detail({ items: [item(), item({ id: "item-2", name_snapshot: "حذف‌شده", status: "voided" })] }),
      business,
      "toman",
    );
    expect(receipt.lines.map((line) => line.name)).toEqual(["چای"]);
  });

  it("carries the queue label, the order type, the table and the customer", () => {
    const dineIn = buildOrderReceipt(detail({ order: order({ customer_name: "مریم" }) }), business, "toman");
    expect(dineIn.orderLabel).toBe("#12");
    expect(dineIn.orderTypeLabel).toBe("حضوری — میز ۳");
    expect(dineIn.customerName).toBe("مریم");

    const takeaway = buildOrderReceipt(detail({ order: order({ type: "takeaway", table_name: null }) }), business, "toman");
    expect(takeaway.orderLabel).toBe("T-12");
    expect(takeaway.orderTypeLabel).toBe("بیرون‌بر");
  });

  it("names each tender slice the way the business named it", () => {
    const receipt = buildOrderReceipt(
      detail({
        payments: [
          payment({ method: "cash", amount: "195000", payment_method_name: "نقدی صندوق" }),
          payment({ id: "pay-2", method: "card", amount: "300000" }),
        ],
      }),
      business,
      "toman",
    );
    expect(receipt.payments).toEqual([
      { label: "نقدی صندوق", amount: 195_000 },
      { label: "کارت‌خوان", amount: 300_000 },
    ]);
    expect(receipt.paymentMethod).toBe("cash");
  });

  it("sends no payments when the sale has none", () => {
    const receipt = buildOrderReceipt(detail(), business, "rial");
    expect(receipt.payments).toBeNull();
    expect(receipt.paymentMethod).toBeNull();
    expect(receipt.unit).toBe("rial");
  });

  it("carries the retail invoice's label for a retail sale", () => {
    const retail = buildOrderReceipt(detail({ order: order({ type: "retail", order_number: "77", table_name: null }) }), business, "toman");
    expect(retail.orderLabel).toBe("فاکتور 77");
    expect(retail.orderTypeLabel).toBe("فروشگاهی");
  });
});

describe("buildOrderKitchenTicket", () => {
  it("puts the table on the big line — that is what the runner carries the tray to", () => {
    const ticket = buildOrderKitchenTicket(detail());
    expect(ticket.label).toBe("میز ۳");
    expect(ticket.orderTypeLabel).toBe("حضوری");
  });

  it("falls back to the order type when a dine-in order has no table, and to the queue label otherwise", () => {
    expect(buildOrderKitchenTicket(detail({ order: order({ table_name: null }) })).label).toBe("حضوری");
    expect(buildOrderKitchenTicket(detail({ order: order({ type: "takeaway", table_name: null }) })).label).toBe("بیرون‌بر");
  });

  it("lists what to make, with add-ons and the guest's note, and never a voided line", () => {
    const ticket = buildOrderKitchenTicket(
      detail({
        order: order({ note: "بدون نمک برای کل سفارش" }),
        items: [
          item({ note: "بدون شکر" }),
          item({ id: "item-2", name_snapshot: "حذف‌شده", status: "voided" }),
        ],
        modifiers: [modifier({ quantity: 1, name_snapshot: "شیر پرچرب" })],
      }),
    );
    expect(ticket.lines).toEqual([
      { name: "چای", quantity: 2, modifiersLabel: "شیر پرچرب", note: "بدون شکر" },
    ]);
    expect(ticket.orderNote).toBe("بدون نمک برای کل سفارش");
    // A ticket is an instruction, not a record: it is stamped now.
    expect(ticket.sentAt).toBeInstanceOf(Date);
  });

  it("prints no prices — a kitchen ticket is about what to make", () => {
    const ticket = buildOrderKitchenTicket(detail({ items: [item()] }));
    expect(JSON.stringify(ticket)).not.toContain("100000");
    expect(Object.keys(ticket.lines[0])).toEqual(["name", "quantity", "modifiersLabel", "note"]);
  });
});
