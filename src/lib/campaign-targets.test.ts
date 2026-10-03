import { describe, expect, it } from "vitest";
import {
  campaignTargetAxes,
  describeCampaignScope,
  isWholeCatalogue,
  normaliseCampaignScope,
} from "./campaign-targets";

const catalogue = {
  items: [
    { id: "i1", name: "لاته" },
    { id: "i2", name: "موکا" },
    { id: "i3", name: "اسپرسو" },
    { id: "i4", name: "آمریکانو" },
    { id: "i5", name: "کاپوچینو" },
  ],
  categories: [{ id: "c1", name: "نوشیدنی گرم" }],
  brands: [{ id: "b1", name: "Dell" }],
};

describe("campaignTargetAxes", () => {
  it("offers only the axes the trade's cart actually passes to the engine", () => {
    // F&B carts carry the menu category; retail carts carry the brand.
    expect(campaignTargetAxes("order_ticket")).toEqual(["items", "categories"]);
    expect(campaignTargetAxes("retail_invoice")).toEqual(["items", "brands"]);
  });
});

describe("normaliseCampaignScope", () => {
  it("drops ids on an axis the trade cannot match, and de-duplicates the rest", () => {
    expect(
      normaliseCampaignScope({ itemIds: ["i1", "i1", ""], categoryIds: ["c1"], brandIds: ["b1"] }, ["items", "brands"]),
    ).toEqual({ itemIds: ["i1"], categoryIds: [], brandIds: ["b1"] });
  });
});

describe("describeCampaignScope", () => {
  it("says so plainly when the campaign covers everything", () => {
    const empty = { itemIds: [], categoryIds: [], brandIds: [] };
    expect(isWholeCatalogue(empty)).toBe(true);
    expect(describeCampaignScope(empty, catalogue)).toBe("روی همهٔ کالاها");
  });

  it("names the chosen items, folding a long list", () => {
    expect(describeCampaignScope({ itemIds: ["i1", "i2"], categoryIds: [], brandIds: [] }, catalogue)).toBe("روی لاته، موکا");
    expect(
      describeCampaignScope({ itemIds: ["i1", "i2", "i3", "i4", "i5"], categoryIds: [], brandIds: [] }, catalogue),
    ).toBe("روی لاته، موکا، اسپرسو و ۲ مورد دیگر");
  });

  it("describes a category or brand on its own, and the AND of two axes", () => {
    expect(describeCampaignScope({ itemIds: [], categoryIds: ["c1"], brandIds: [] }, catalogue)).toBe("روی کالاهای دستهٔ نوشیدنی گرم");
    expect(describeCampaignScope({ itemIds: [], categoryIds: [], brandIds: ["b1"] }, catalogue)).toBe("روی کالاهای برند Dell");
    expect(describeCampaignScope({ itemIds: ["i1"], categoryIds: [], brandIds: ["b1"] }, catalogue)).toBe(
      "روی لاته و فقط اگر برند Dell باشند",
    );
  });

  it("never prints an id for a row that disappeared", () => {
    expect(describeCampaignScope({ itemIds: ["gone"], categoryIds: [], brandIds: [] }, catalogue)).toBe("روی مورد حذف‌شده");
  });
});
