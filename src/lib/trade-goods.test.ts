import { describe, expect, it } from "vitest";
import {
  TRADE_GOODS_ACCOUNTS,
  TRADE_GOODS_INDUSTRIES,
  computeTradeGoodsSalePrice,
  isTradeGoodsIndustry,
  nextTradeGoodsAverageUnitCost,
  tradeGoodsCogs,
  validateTradeGoodsReceipt,
  type TradeGoodsIndustry,
} from "./trade-goods";
import { WELL_KNOWN_CODES } from "./coa-template";

describe("TRADE_GOODS_INDUSTRIES", () => {
  it("covers exactly the trade-goods trades and nothing else", () => {
    // Phase 38 opened the set with three trades; issue #1567 adds
    // `fashion_apparel` for the same reason — a garment/shoe/bag is a
    // countable finished good sold as a variant child.
    expect(TRADE_GOODS_INDUSTRIES).toEqual([
      "wholesale",
      "tools_fittings",
      "haberdashery",
      "fashion_apparel",
    ]);
  });

  it("isTradeGoodsIndustry recognises them and rejects the rest", () => {
    for (const trade of TRADE_GOODS_INDUSTRIES) {
      expect(isTradeGoodsIndustry(trade)).toBe(true);
    }
    expect(isTradeGoodsIndustry("accessories")).toBe(false);
    expect(isTradeGoodsIndustry("food_service")).toBe(false);
    expect(isTradeGoodsIndustry(null)).toBe(false);
  });

  it("maps each trade to its own well-known accounts", () => {
    expect(TRADE_GOODS_ACCOUNTS.wholesale).toEqual({
      inventory: WELL_KNOWN_CODES.wholesaleInventory,
      sales: WELL_KNOWN_CODES.wholesaleSalesRevenue,
      cogs: WELL_KNOWN_CODES.wholesaleCogs,
    });
    expect(TRADE_GOODS_ACCOUNTS.tools_fittings.inventory).toBe(WELL_KNOWN_CODES.toolsInventory);
    expect(TRADE_GOODS_ACCOUNTS.haberdashery.cogs).toBe(WELL_KNOWN_CODES.haberdasheryCogs);
  });
});

describe("trade-goods arithmetic", () => {
  it("computes a sale breakdown the same way the item_stock model always has", () => {
    const breakdown = computeTradeGoodsSalePrice({ unitPrice: 100, quantity: "3", discount: 100, vatPercent: 9 });
    expect(breakdown.gross).toBe("300");
    expect(breakdown.net).toBe("200");
    expect(breakdown.vat).toBe("18");
    expect(breakdown.total).toBe("218");
  });

  it("rolls the weighted average forward and computes COGS", () => {
    const average = nextTradeGoodsAverageUnitCost("10", 50_000, "10", 70_000);
    expect(average).toBe("60000");
    expect(tradeGoodsCogs("2.5", 60_000)).toBe("150000");
  });

  it("validates receipts", () => {
    expect(validateTradeGoodsReceipt({ quantity: "1", unitCost: 1000 })).toEqual([]);
    expect(validateTradeGoodsReceipt({ quantity: "0", unitCost: 1000 }).length).toBeGreaterThan(0);
  });
});
