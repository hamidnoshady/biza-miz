import { describe, expect, it } from "vitest";
import { shiftOrdersExportTable } from "./shift-orders-export";
import type { ShiftOrder } from "./shift-orders";

function order(over: Partial<ShiftOrder> = {}): ShiftOrder {
  return {
    id: "o1",
    orderNumber: 102,
    type: "dine_in",
    status: "completed",
    tableName: "میز ۴",
    guestCount: 2,
    customerName: "سارا",
    openedAt: "2026-01-01T08:30:00.000Z",
    closedAt: "2026-01-01T09:10:00.000Z",
    openedByName: "مینا",
    closedByName: "مینا",
    note: null,
    voidedReason: null,
    amendedAt: null,
    subtotal: 2_000_000,
    discount: 100_000,
    discountType: "amount",
    discountValue: 100_000,
    serviceCharge: 0,
    tax: 150_000,
    tipAmount: 0,
    total: 2_050_000,
    addOnTotal: 0,
    lines: [],
    itemCount: 3,
    channel: "in_store",
    payments: [
      { method: "cash", methodName: "نقدی", amount: 1_000_000, reference: null, receivedAt: "2026-01-01T09:10:00.000Z", receivedByName: "مینا" },
      { method: "card", methodName: "پوز ملت", amount: 1_050_000, reference: null, receivedAt: "2026-01-01T09:10:00.000Z", receivedByName: "مینا" },
    ],
    ...over,
  };
}

describe("shiftOrdersExportTable", () => {
  it("writes money in the business's display unit and names the unit on the column", () => {
    // 2,050,000 Rial is 205,000 Toman; the file must say so on the column.
    const table = shiftOrdersExportTable([order()], "toman");
    expect(table.columns.find((c) => c.key === "total")?.label).toContain("تومان");
    expect(table.rows[0].total).toBe(205_000);
    expect(table.rows[0].subtotal).toBe(200_000);
  });

  it("keeps Rial amounts unconverted for a Rial business", () => {
    const table = shiftOrdersExportTable([order()], "rial");
    expect(table.columns.find((c) => c.key === "total")?.label).toContain("ریال");
    expect(table.rows[0].total).toBe(2_050_000);
  });

  it("labels dates in Shamsi, matching the screen", () => {
    const table = shiftOrdersExportTable([order()], "toman");
    // 2026-01-01 is 1404/10/11 Jalali.
    expect(String(table.rows[0].openedAt)).toContain("۱۴۰۴/۱۰/۱۱");
  });

  it("lists every tender of a split bill in the order it was taken", () => {
    const table = shiftOrdersExportTable([order()], "toman");
    expect(table.rows[0].payments).toBe("نقدی: 100000؛ پوز ملت: 105000");
  });

  it("carries the void reason so a cancelled bill is legible in the file", () => {
    const table = shiftOrdersExportTable(
      [order({ status: "voided", voidedReason: "مشتری رفت" })],
      "toman",
    );
    expect(table.rows[0].status).toBe("باطل‌شده");
    expect(table.rows[0].voidedReason).toBe("مشتری رفت");
  });
});
