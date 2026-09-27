import { describe, expect, it } from "vitest";
import { buildRetailInvoiceReceipt } from "./print-data";
import type { RetailInvoiceDetail } from "./types";

/**
 * `buildRetailInvoiceReceipt` is the one function both a fresh sale's first
 * print and a months-later reprint call — these tests exercise it exactly as
 * both call sites would, with no DB involved (per repo convention, only the
 * DB-touching wrapper `getRetailInvoicePrintData` is left to the integration
 * suite).
 */
const business = { name: "طلافروشی نمونه", address: "تهران، بازار", phone: "02100000000", footerMessage: "با تشکر" };

const baseDetail: RetailInvoiceDetail = {
  orderId: "order-1",
  orderNumber: 42,
  status: "completed",
  // A fixed historical date — this must survive into the receipt unchanged.
  // Reprinting an old invoice must never show today's date (the bug this
  // guards against: the old code called `new Date()` at reprint time).
  issuedAt: "2024-01-05T10:15:00.000Z",
  voidedReason: null,
  businessId: "biz-1",
  locationId: "loc-1",
  locationName: "شعبه مرکزی",
  cashierId: "user-1",
  cashierName: "زهرا احمدی",
  customer: { id: "cust-1", name: "مریم کریمی", phone: "09120000000" },
  note: null,
  lines: [],
  subtotal: 0,
  discount: 0,
  tax: 0,
  total: 0,
  payments: [],
  paidTotal: 0,
  balanceDue: 0,
  overpaid: 0,
  creditTotal: 0,
  currencyUnit: "toman",
  integration: { holooQueued: false, holooSynced: false },
};

describe("buildRetailInvoiceReceipt", () => {
  it("carries the invoice's real issue date, not the current time", () => {
    const receipt = buildRetailInvoiceReceipt(baseDetail, business);
    expect(receipt.issuedAt).toBe("2024-01-05T10:15:00.000Z");
  });

  it("prints the invoice's actual discount, never a hardcoded zero", () => {
    const receipt = buildRetailInvoiceReceipt({ ...baseDetail, discount: 25_000 }, business);
    expect(receipt.discount).toBe(25_000);
  });

  it("labels a voided invoice distinctly while keeping the base label stable", () => {
    const normal = buildRetailInvoiceReceipt(baseDetail, business);
    const voided = buildRetailInvoiceReceipt({ ...baseDetail, status: "voided" }, business);
    expect(normal.orderTypeLabel).toBe("فاکتور فروش");
    expect(voided.orderTypeLabel).toBe("فاکتور فروش (باطل‌شده)");
  });

  it("prints a gold line's real weight, purity and price breakdown", () => {
    const receipt = buildRetailInvoiceReceipt(
      {
        ...baseDetail,
        lines: [
          {
            kind: "gold",
            orderItemId: "oi-1",
            itemId: "item-1",
            nameSnapshot: "انگشتر طلا",
            quantity: "1",
            gross: "10000000",
            manualDiscount: "0",
            promotionDiscount: "0",
            discount: "0",
            vat: "300000",
            net: "10000000",
            total: "10300000",
            netWeight: "3.500",
            purity: "18",
            pricePerGram: 2_500_000,
            priceDate: "2024-01-05",
            makingChargeType: "percent",
            makingChargeValue: 7,
            profitPercent: 7,
            metalValue: "8750000",
            makingCharge: "612500",
            profit: "637500",
            consigned: false,
          },
        ],
      },
      business,
    );
    const line = receipt.lines[0];
    expect(line.quantity).toBe(1);
    expect(line.lineTotal).toBe(10_300_000);
    expect(line.goldBreakdown).toEqual({
      metalValue: 8_750_000,
      makingCharge: 612_500,
      profit: 637_500,
      netWeight: "3.500",
      purity: "18",
    });
  });

  it("preserves a watch line's serial number, warranty and provenance", () => {
    const receipt = buildRetailInvoiceReceipt(
      {
        ...baseDetail,
        lines: [
          {
            kind: "watch",
            orderItemId: "oi-2",
            itemId: "item-2",
            nameSnapshot: "ساعت رولکس",
            quantity: "1",
            gross: "500000000",
            manualDiscount: "0",
            promotionDiscount: "0",
            discount: "0",
            vat: "0",
            net: "500000000",
            total: "500000000",
            serialId: "serial-1",
            serialNumber: "RLX-000123",
            warrantyMonths: 18,
            warrantyStartDate: "2024-01-05",
            warrantyEndDate: "2025-07-05",
            provenance: { conditionGrade: "like_new", boxAndPapers: true },
          },
        ],
      },
      business,
    );
    const line = receipt.lines[0];
    expect(line.serial).toEqual({
      serialNumber: "RLX-000123",
      warrantyMonths: 18,
      warrantyEndDate: "2025-07-05",
    });
    expect(line.serialProvenance).toEqual({ conditionGrade: "like_new", boxAndPapers: true });
  });

  it("preserves a cosmetic line's batch numbers and expiry date", () => {
    const receipt = buildRetailInvoiceReceipt(
      {
        ...baseDetail,
        lines: [
          {
            kind: "cosmetic",
            orderItemId: "oi-3",
            itemId: "item-3",
            nameSnapshot: "کرم ضدآفتاب",
            quantity: "3",
            unitPrice: "400000",
            gross: "1200000",
            manualDiscount: "0",
            promotionDiscount: "0",
            discount: "0",
            vat: "0",
            net: "1200000",
            total: "1200000",
            batchNumbers: ["B100", "B101"],
            expiryDate: "2025-03-01",
          },
        ],
      },
      business,
    );
    const line = receipt.lines[0];
    expect(line.quantity).toBe(3);
    expect(line.batch).toEqual({ batchNumber: "B100، B101", expiryDate: "2025-03-01" });
  });

  it("shows a legacy (pre-snapshot) line's stored breakdown without fabricating weight/purity", () => {
    const receipt = buildRetailInvoiceReceipt(
      {
        ...baseDetail,
        lines: [
          {
            kind: "legacy",
            orderItemId: "oi-4",
            itemId: "item-4",
            nameSnapshot: "دستبند طلا",
            quantity: "1",
            unitPrice: "9000000",
            total: "9000000",
            metalValue: "7000000",
            makingCharge: "1000000",
            profit: "1000000",
          },
        ],
      },
      business,
    );
    const line = receipt.lines[0];
    expect(line.goldBreakdown).toEqual({
      metalValue: 7_000_000,
      makingCharge: 1_000_000,
      profit: 1_000_000,
      netWeight: null,
      purity: null,
    });
  });

  it("renders one payment row per tender using the resolved method label", () => {
    const receipt = buildRetailInvoiceReceipt(
      {
        ...baseDetail,
        payments: [
          { id: "p1", method: "cash", methodLabel: "نقدی", amount: 5_000_000, reference: null, paymentMethodId: null, receivedAt: "2024-01-05T10:15:00.000Z" },
          { id: "p2", method: "card", methodLabel: "کارت‌خوان", amount: 5_300_000, reference: "1234", paymentMethodId: "pm-1", receivedAt: "2024-01-05T10:16:00.000Z" },
        ],
      },
      business,
    );
    expect(receipt.payments).toEqual([
      { label: "نقدی", amount: 5_000_000 },
      { label: "کارت‌خوان", amount: 5_300_000 },
    ]);
  });

  it("falls back to null payments when the invoice somehow has none recorded", () => {
    const receipt = buildRetailInvoiceReceipt(baseDetail, business);
    expect(receipt.payments).toBeNull();
    expect(receipt.paymentMethod).toBeNull();
  });

  it("names the invoice's customer and cashier", () => {
    const receipt = buildRetailInvoiceReceipt(baseDetail, business);
    expect(receipt.customerName).toBe("مریم کریمی");
    expect(receipt.cashierName).toBe("زهرا احمدی");
  });

  it("carries the business's actual display unit", () => {
    const receipt = buildRetailInvoiceReceipt({ ...baseDetail, currencyUnit: "rial" }, business);
    expect(receipt.unit).toBe("rial");
  });
});
