import { describe, expect, it } from "vitest";
import {
  costOfSalesCodeForIndustry,
  inventoryCodeForIndustry,
  postingRulesFor,
} from "./accounting-posting-rules";
import {
  coaTemplateForIndustry,
  costOfSalesCodesForIndustry,
  WELL_KNOWN_CODES,
} from "./coa-template";
import { INDUSTRIES, type Industry } from "./industries";

/**
 * «تنظیمات حسابداری» reports the automatic posting rules, and a settings
 * screen that reports the wrong account is worse than one that reports
 * nothing: an accountant reconciles against what it says.
 *
 * So these assertions tie the summary to the two things it claims to
 * summarise — the industry's own chart template, and the posting code's own
 * account mapping. A trade whose chart changes, or an inventory account that
 * is remapped in `retail-stock-posting-rules.ts`, fails here rather than
 * quietly mis-labelling the settings page.
 */

/**
 * The mapping `retail-stock-posting-rules.ts` posts against. Restated here
 * rather than imported because that module registers posting rules and pulls
 * in `pg` at import time; this test is the guard that the copy stays honest.
 */
const POSTING_ENGINE_INVENTORY_CODES: Record<Industry, string> = {
  service_saas: WELL_KNOWN_CODES.inventory,
  food_service: WELL_KNOWN_CODES.inventory,
  architecture_construction: WELL_KNOWN_CODES.inventory,
  jewelry: WELL_KNOWN_CODES.goldInventory,
  watch: WELL_KNOWN_CODES.watchInventory,
  accessories: WELL_KNOWN_CODES.accessoryInventory,
  cosmetics: WELL_KNOWN_CODES.cosmeticInventory,
  wholesale: WELL_KNOWN_CODES.wholesaleInventory,
  tools_fittings: WELL_KNOWN_CODES.toolsInventory,
  haberdashery: WELL_KNOWN_CODES.haberdasheryInventory,
};

/** Every bare 4-digit code a rule names, with the `a / b / c` alternatives split out. */
function codesIn(rule: { lines: { code: string }[] }): string[] {
  return rule.lines
    .flatMap((line) => line.code.split("/").map((part) => part.trim()))
    .filter((code) => /^\d{4}$/.test(code));
}

describe("the inventory account the settings page names", () => {
  it.each(INDUSTRIES)("matches the posting engine's own mapping for %s", (industry) => {
    expect(inventoryCodeForIndustry(industry)).toBe(POSTING_ENGINE_INVENTORY_CODES[industry]);
  });

  it.each(INDUSTRIES)("exists in %s's chart of accounts", (industry) => {
    const codes = new Set(coaTemplateForIndustry(industry).map((account) => account.code));
    expect(codes.has(inventoryCodeForIndustry(industry))).toBe(true);
  });
});

describe("the cost-of-sales account the settings page names", () => {
  it.each(INDUSTRIES)("is %s's own primary cost-of-sales account", (industry) => {
    // The first entry is the trade's COGS account; the rest of the list is the
    // shrinkage/write-down accounts that share the gross-profit line.
    expect(costOfSalesCodeForIndustry(industry)).toBe(costOfSalesCodesForIndustry(industry)[0]);
    const codes = new Set(coaTemplateForIndustry(industry).map((account) => account.code));
    expect(codes.has(costOfSalesCodeForIndustry(industry))).toBe(true);
  });

  it("never offers a café's 5100 to a trade whose chart has no such account", () => {
    // The regression this prevents: hard-coding WELL_KNOWN_CODES.cogs, which
    // the seven retail templates deliberately do not seed.
    for (const industry of INDUSTRIES) {
      if (industry === "food_service" || industry === "service_saas") continue;
      expect(costOfSalesCodeForIndustry(industry)).not.toBe(WELL_KNOWN_CODES.cogs);
    }
  });
});

describe("postingRulesFor", () => {
  it.each(INDUSTRIES)("names only accounts that exist in %s's chart", (industry) => {
    const codes = new Set(coaTemplateForIndustry(industry).map((account) => account.code));
    for (const system of ["perpetual", "periodic"] as const) {
      for (const rule of postingRulesFor({ industry, inventorySystem: system })) {
        for (const code of codesIn(rule)) {
          expect(
            codes.has(code),
            `${industry}/${system}: rule «${rule.label}» names ${code}, which is not in the chart`,
          ).toBe(true);
        }
      }
    }
  });

  it("gives every rule a balanced pair of sides", () => {
    for (const industry of INDUSTRIES) {
      for (const rule of postingRulesFor({ industry })) {
        expect(rule.lines.some((line) => line.side === "debit")).toBe(true);
        expect(rule.lines.some((line) => line.side === "credit")).toBe(true);
      }
    }
  });

  it("gives every rule and line non-empty words, never a bare code", () => {
    for (const rule of postingRulesFor({ industry: "food_service" })) {
      expect(rule.label.trim().length).toBeGreaterThan(0);
      expect(rule.description.trim().length).toBeGreaterThan(0);
      for (const line of rule.lines) expect(line.label.trim().length).toBeGreaterThan(0);
    }
  });

  it("keys every rule uniquely, so React can list them", () => {
    const keys = postingRulesFor({ industry: "jewelry" }).map((rule) => rule.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  describe("the periodic inventory system", () => {
    it("debits «خرید طی دوره» on a purchase instead of the inventory asset", () => {
      const purchase = postingRulesFor({ industry: "food_service", inventorySystem: "periodic" })
        .find((rule) => rule.key === "purchase")!;
      const debit = purchase.lines.find((line) => line.side === "debit")!;
      expect(debit.code).toBe(WELL_KNOWN_CODES.periodicPurchases);
    });

    it("debits the inventory asset under the perpetual system", () => {
      const purchase = postingRulesFor({ industry: "food_service", inventorySystem: "perpetual" })
        .find((rule) => rule.key === "purchase")!;
      const debit = purchase.lines.find((line) => line.side === "debit")!;
      expect(debit.code).toBe(WELL_KNOWN_CODES.inventory);
    });

    it("says cost of sales is recognised at the period close, not at the sale", () => {
      const cogs = postingRulesFor({ industry: "wholesale", inventorySystem: "periodic" })
        .find((rule) => rule.key === "cogs")!;
      expect(cogs.description).toContain("بستن دوره");
    });
  });

  describe("the sale rule", () => {
    it("splits F&B revenue by order channel, the way the order posting does", () => {
      const sale = postingRulesFor({ industry: "food_service" }).find((rule) => rule.key === "sale")!;
      const revenue = sale.lines.find((line) => line.code.includes(WELL_KNOWN_CODES.dineInRevenue))!;
      expect(revenue.code).toContain(WELL_KNOWN_CODES.takeawayRevenue);
      expect(revenue.code).toContain(WELL_KNOWN_CODES.deliveryRevenue);
      expect(revenue.side).toBe("credit");
    });

    it("gives a retail trade its single sales account, not the channel split", () => {
      const sale = postingRulesFor({ industry: "cosmetics" }).find((rule) => rule.key === "sale")!;
      const revenue = sale.lines.find((line) => line.side === "credit" && line.code !== WELL_KNOWN_CODES.vatPayable)!;
      expect(revenue.code).toBe(WELL_KNOWN_CODES.cosmeticSalesRevenue);
    });

    it("always credits output VAT", () => {
      for (const industry of INDUSTRIES) {
        const sale = postingRulesFor({ industry }).find((rule) => rule.key === "sale")!;
        expect(sale.lines.some((line) => line.code === WELL_KNOWN_CODES.vatPayable && line.side === "credit")).toBe(true);
      }
    });

    it("calls the sale a فاکتور in a shop and a سفارش in a café", () => {
      expect(postingRulesFor({ industry: "food_service" })[0].label).toContain("سفارش");
      expect(postingRulesFor({ industry: "jewelry" })[0].label).toContain("فاکتور");
    });
  });

  describe("the payroll rule", () => {
    it("accrues to wages payable and settles from it, as accruePayroll does", () => {
      const payroll = postingRulesFor({ industry: "food_service" }).find((rule) => rule.key === "payroll")!;
      expect(payroll.lines).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ side: "debit", code: WELL_KNOWN_CODES.salariesExpense }),
          expect.objectContaining({ side: "credit", code: WELL_KNOWN_CODES.salariesPayable }),
          expect.objectContaining({ side: "debit", code: WELL_KNOWN_CODES.salariesPayable }),
        ]),
      );
    });
  });
});
