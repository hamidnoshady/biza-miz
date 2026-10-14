import { describe, expect, it } from "vitest";
import { normalizePosSearchText } from "@/lib/pos-selection";
import { formatQuantity, toPersianDigits } from "@/lib/digits";
import { classifyStockLevel } from "@/lib/retail-stock";

describe("موجودی انبار (Stock Levels UI Logic)", () => {
  describe("stockStatus classification for Food Service inventory items", () => {
    function stockStatus(item: { quantity: string; reorder_level: string | null }): "out" | "low" | "ok" {
      const qty = Number(item.quantity);
      if (qty <= 0) return "out";
      const reorder = item.reorder_level === null ? null : Number(item.reorder_level);
      if (reorder !== null && qty <= reorder) return "low";
      return "ok";
    }

    it("identifies out of stock when quantity is 0 or negative", () => {
      expect(stockStatus({ quantity: "0", reorder_level: "5" })).toBe("out");
      expect(stockStatus({ quantity: "-2", reorder_level: "5" })).toBe("out");
      expect(stockStatus({ quantity: "0", reorder_level: null })).toBe("out");
    });

    it("identifies low stock when positive quantity is at or below reorder level", () => {
      expect(stockStatus({ quantity: "5", reorder_level: "5" })).toBe("low");
      expect(stockStatus({ quantity: "2.5", reorder_level: "5" })).toBe("low");
      expect(stockStatus({ quantity: "0.1", reorder_level: "1" })).toBe("low");
    });

    it("identifies sufficient stock (ok) when quantity exceeds reorder level or reorder level is null", () => {
      expect(stockStatus({ quantity: "10", reorder_level: "5" })).toBe("ok");
      expect(stockStatus({ quantity: "5.01", reorder_level: "5" })).toBe("ok");
      expect(stockStatus({ quantity: "10", reorder_level: null })).toBe("ok");
    });
  });

  describe("search normalization with Persian/Arabic characters and case insensitivity", () => {
    const items = [
      { id: "1", item_name: "شیر کم‌چرب کاله", sku: "MLK-KALEH-01", unit: "لیتر" },
      { id: "2", item_name: "شکر سفید", sku: "SGR-WHT-02", unit: "کیلوگرم" },
      { id: "3", item_name: "قهوه عربیکا ۱۰۰٪", sku: "COF-ARB-100", unit: "کیلوگرم" },
    ];

    it("finds items using Persian or Arabic kaf (ک / ك)", () => {
      // Search with Arabic kaf 'ك'
      const queryArabicKaf = normalizePosSearchText("كاله");
      const matched = items.filter((item) =>
        normalizePosSearchText(`${item.item_name} ${item.sku} ${item.unit}`).includes(queryArabicKaf),
      );
      expect(matched).toHaveLength(1);
      expect(matched[0].id).toBe("1");
    });

    it("finds items using Persian or Arabic yeh (ی / ي)", () => {
      // Search with Arabic yeh 'ي'
      const queryArabicYeh = normalizePosSearchText("عربيكا");
      const matched = items.filter((item) =>
        normalizePosSearchText(`${item.item_name} ${item.sku} ${item.unit}`).includes(queryArabicYeh),
      );
      expect(matched).toHaveLength(1);
      expect(matched[0].id).toBe("3");
    });

    it("matches SKU with case-insensitivity and partial query", () => {
      const queryLowerSku = normalizePosSearchText("mlk-kaleh");
      const matched = items.filter((item) =>
        normalizePosSearchText(`${item.item_name} ${item.sku} ${item.unit}`).includes(queryLowerSku),
      );
      expect(matched).toHaveLength(1);
      expect(matched[0].id).toBe("1");
    });

    it("matches unit names in search", () => {
      const queryUnit = normalizePosSearchText("کیلوگرم");
      const matched = items.filter((item) =>
        normalizePosSearchText(`${item.item_name} ${item.sku} ${item.unit}`).includes(queryUnit),
      );
      expect(matched).toHaveLength(2);
    });
  });

  describe("Retail classifyStockLevel helper", () => {
    it("correctly identifies stock levels for retail items", () => {
      expect(classifyStockLevel("15", "10")).toBe("ok");
      expect(classifyStockLevel("10", "10")).toBe("low");
      expect(classifyStockLevel("3", "10")).toBe("low");
      expect(classifyStockLevel("0", "10")).toBe("out");
      expect(classifyStockLevel("-1", "10")).toBe("out");
      expect(classifyStockLevel("0", null)).toBe("out");
    });
  });

  describe("Formatting Persian digits and quantities", () => {
    it("formats quantity and converts to Persian digits cleanly", () => {
      expect(formatQuantity("12.5")).toBe("۱۲٫۵");
      expect(formatQuantity("100")).toBe("۱۰۰");
      expect(toPersianDigits("1540")).toBe("۱۵۴۰");
    });
  });
});
