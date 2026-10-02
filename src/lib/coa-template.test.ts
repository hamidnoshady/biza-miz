import { describe, expect, it } from "vitest";
import { INDUSTRIES, type Industry } from "./industries";
import {
  ACCESSORIES_COA_TEMPLATE,
  ACCOUNT_LEVELS,
  coaTemplateForIndustry,
  COSMETICS_COA_TEMPLATE,
  costOfSalesCodesForIndustry,
  FNB_COA_TEMPLATE,
  HABERDASHERY_COA_TEMPLATE,
  JEWELRY_COA_TEMPLATE,
  isNonCurrentCode,
  isValidAccountCode,
  nextAccountLevel,
  TOOLS_FITTINGS_COA_TEMPLATE,
  WATCH_COA_TEMPLATE,
  WHOLESALE_COA_TEMPLATE,
  normalBalanceForType,
  validateAccounts,
  WELL_KNOWN_CODES,
  type AccountType,
} from "./coa-template";

/**
 * The accounts every template must carry, whatever the business sells.
 *
 * This list is the guard that was missing. `WELL_KNOWN_CODES` spans five
 * industries, so "every template contains every well-known code" was never the
 * rule — but the per-template assertions that replaced it named only each
 * trade's own three accounts, and nothing checked the accounts a *shared*
 * feature needs. The four retail templates therefore drifted: payroll
 * (`salariesExpense`), depreciation (`accumulatedDepreciation`/
 * `depreciationExpense`), a markdown (`inventoryWriteDownExpense`) and a
 * supplier return (`supplierReceivable`) all post from pages every industry
 * has, against accounts only F&B's chart contained, and failed with
 * `ledger_account_missing` in a real jewellery or cosmetics shop.
 */
const CORE_REQUIRED_CODES: readonly string[] = [
  WELL_KNOWN_CODES.cash,
  WELL_KNOWN_CODES.bankClearing,
  WELL_KNOWN_CODES.accountsReceivable,
  WELL_KNOWN_CODES.supplierReceivable,
  WELL_KNOWN_CODES.vatReceivable,
  WELL_KNOWN_CODES.accountsPayable,
  WELL_KNOWN_CODES.vatPayable,
  WELL_KNOWN_CODES.salariesPayable,
  WELL_KNOWN_CODES.salariesExpense,
  WELL_KNOWN_CODES.commissionExpense,
  WELL_KNOWN_CODES.accumulatedDepreciation,
  WELL_KNOWN_CODES.depreciationExpense,
  WELL_KNOWN_CODES.inventoryWriteDownExpense,
  // A physical count can find *more* than the system thought in any trade, so
  // the gain side is core. The shortage side is not: F&B books it to 5160 and
  // the retail trades to 5190, because cosmetics already spends 5160 on
  // expiry/testers. See WELL_KNOWN_CODES.retailCountShortageExpense.
  WELL_KNOWN_CODES.inventoryCountGain,
  WELL_KNOWN_CODES.salesReturns,
  WELL_KNOWN_CODES.storeCreditPayable,
  WELL_KNOWN_CODES.giftCardPayable,
  WELL_KNOWN_CODES.openingEquity,
  WELL_KNOWN_CODES.retainedEarnings,
  // Phase 30 — the cheque registers, on every chart because taking or writing
  // a cheque is not something one trade does and the others don't.
  WELL_KNOWN_CODES.chequesReceivable,
  WELL_KNOWN_CODES.chequesOnHand,
  WELL_KNOWN_CODES.chequesInCollection,
  WELL_KNOWN_CODES.chequesReturned,
  WELL_KNOWN_CODES.chequesPayable,
  WELL_KNOWN_CODES.chequesIssued,
  WELL_KNOWN_CODES.chequesIssuedReturned,
  WELL_KNOWN_CODES.bouncedChequeExpense,
  // Phase 37 Wave 4 — a marketing campaign is cross-industry, so both sides of
  // its cost document (debit marketing expense / credit platform-message
  // payable) must exist on every chart or four of the trades would fail with
  // ledger_account_missing.
  WELL_KNOWN_CODES.marketingExpense,
  WELL_KNOWN_CODES.platformMessageCreditPayable,
];

/** Each trade's own accounts, on top of the core every chart shares. */
const TRADE_REQUIRED_CODES: Record<Industry, readonly string[]> = {
  service_saas: ["1200", "2100", "4500", "4510", "4520", "5660", "5670"],
  food_service: [
    WELL_KNOWN_CODES.inventory,
    WELL_KNOWN_CODES.cogs,
    WELL_KNOWN_CODES.wasteExpense,
    WELL_KNOWN_CODES.inventoryCountExpense,
    WELL_KNOWN_CODES.workInProgress,
    WELL_KNOWN_CODES.appliedConversionCost,
    WELL_KNOWN_CODES.inventoryInTransit,
    WELL_KNOWN_CODES.nrvAllowance,
    WELL_KNOWN_CODES.tipsPayable,
    WELL_KNOWN_CODES.platformReceivable,
    WELL_KNOWN_CODES.platformCommissionExpense,
    WELL_KNOWN_CODES.dineInRevenue,
    WELL_KNOWN_CODES.takeawayRevenue,
    WELL_KNOWN_CODES.deliveryRevenue,
  ],
  jewelry: [
    WELL_KNOWN_CODES.goldInventory,
    WELL_KNOWN_CODES.goldSalesRevenue,
    WELL_KNOWN_CODES.makingChargeRevenue,
    WELL_KNOWN_CODES.goldCogs,
    WELL_KNOWN_CODES.consignmentPayable,
    WELL_KNOWN_CODES.consignmentCommissionRevenue,
    WELL_KNOWN_CODES.layawayDeposit,
    WELL_KNOWN_CODES.goldCustomerAccount,
    WELL_KNOWN_CODES.repairServiceRevenue,
    WELL_KNOWN_CODES.repairPartsExpense,
    WELL_KNOWN_CODES.retailInventoryInTransit,
    WELL_KNOWN_CODES.retailCountShortageExpense,
  ],
  watch: [
    WELL_KNOWN_CODES.watchInventory,
    WELL_KNOWN_CODES.watchSalesRevenue,
    WELL_KNOWN_CODES.watchCogs,
    WELL_KNOWN_CODES.repairServiceRevenue,
    WELL_KNOWN_CODES.repairPartsExpense,
    WELL_KNOWN_CODES.retailInventoryInTransit,
    WELL_KNOWN_CODES.retailCountShortageExpense,
  ],
  accessories: [
    WELL_KNOWN_CODES.accessoryInventory,
    WELL_KNOWN_CODES.accessorySalesRevenue,
    WELL_KNOWN_CODES.accessoryCogs,
    WELL_KNOWN_CODES.retailInventoryInTransit,
    WELL_KNOWN_CODES.retailCountShortageExpense,
  ],
  cosmetics: [
    WELL_KNOWN_CODES.cosmeticInventory,
    WELL_KNOWN_CODES.cosmeticSalesRevenue,
    WELL_KNOWN_CODES.cosmeticCogs,
    WELL_KNOWN_CODES.cosmeticExpiredAndTester,
    WELL_KNOWN_CODES.retailInventoryInTransit,
    WELL_KNOWN_CODES.retailCountShortageExpense,
  ],
  wholesale: [
    WELL_KNOWN_CODES.wholesaleInventory,
    WELL_KNOWN_CODES.wholesaleSalesRevenue,
    WELL_KNOWN_CODES.wholesaleCogs,
    WELL_KNOWN_CODES.retailInventoryInTransit,
    WELL_KNOWN_CODES.retailCountShortageExpense,
  ],
  tools_fittings: [
    WELL_KNOWN_CODES.toolsInventory,
    WELL_KNOWN_CODES.toolsSalesRevenue,
    WELL_KNOWN_CODES.toolsCogs,
    WELL_KNOWN_CODES.retailInventoryInTransit,
    WELL_KNOWN_CODES.retailCountShortageExpense,
  ],
  haberdashery: [
    WELL_KNOWN_CODES.haberdasheryInventory,
    WELL_KNOWN_CODES.haberdasherySalesRevenue,
    WELL_KNOWN_CODES.haberdasheryCogs,
    WELL_KNOWN_CODES.retailInventoryInTransit,
    WELL_KNOWN_CODES.retailCountShortageExpense,
  ],
};

describe.each(INDUSTRIES)("%s chart of accounts", (industry) => {
  const template = coaTemplateForIndustry(industry);
  const codes = new Set(template.map((a) => a.code));

  it("is itself valid", () => {
    expect(validateAccounts([...template])).toEqual([]);
  });

  it("carries every account a cross-industry feature posts to", () => {
    expect([...CORE_REQUIRED_CODES].filter((code) => !codes.has(code))).toEqual([]);
  });

  it("carries its own trade's accounts", () => {
    expect([...TRADE_REQUIRED_CODES[industry]].filter((code) => !codes.has(code))).toEqual([]);
  });

  it("carries every account its own cost-of-sales list names", () => {
    expect([...costOfSalesCodesForIndustry(industry)].filter((code) => !codes.has(code))).toEqual([]);
  });

  it("gives every cheque معین the right parent", () => {
    const parentOf = (code: string) => template.find((a) => a.code === code)?.parentCode;
    for (const code of [
      WELL_KNOWN_CODES.chequesOnHand,
      WELL_KNOWN_CODES.chequesInCollection,
      WELL_KNOWN_CODES.chequesReturned,
    ]) {
      expect(parentOf(code)).toBe(WELL_KNOWN_CODES.chequesReceivable);
    }
    for (const code of [WELL_KNOWN_CODES.chequesIssued, WELL_KNOWN_CODES.chequesIssuedReturned]) {
      expect(parentOf(code)).toBe(WELL_KNOWN_CODES.chequesPayable);
    }
  });
});

describe("the retail templates carry no F&B recipe-shaped accounts", () => {
  it.each(["jewelry", "watch", "accessories", "cosmetics", "wholesale", "tools_fittings", "haberdashery"] as const)(
    "%s",
    (industry) => {
      const codes = new Set(coaTemplateForIndustry(industry).map((a) => a.code));
      expect(codes.has(WELL_KNOWN_CODES.inventory)).toBe(false);
      expect(codes.has(WELL_KNOWN_CODES.cogs)).toBe(false);
    },
  );
});

describe("coaTemplateForIndustry", () => {
  it("gives each industry its own template", () => {
    expect(coaTemplateForIndustry("food_service")).toBe(FNB_COA_TEMPLATE);
    expect(coaTemplateForIndustry("jewelry")).toBe(JEWELRY_COA_TEMPLATE);
    expect(coaTemplateForIndustry("watch")).toBe(WATCH_COA_TEMPLATE);
    expect(coaTemplateForIndustry("accessories")).toBe(ACCESSORIES_COA_TEMPLATE);
    expect(coaTemplateForIndustry("cosmetics")).toBe(COSMETICS_COA_TEMPLATE);
    expect(coaTemplateForIndustry("wholesale")).toBe(WHOLESALE_COA_TEMPLATE);
    expect(coaTemplateForIndustry("tools_fittings")).toBe(TOOLS_FITTINGS_COA_TEMPLATE);
    expect(coaTemplateForIndustry("haberdashery")).toBe(HABERDASHERY_COA_TEMPLATE);
  });
});

describe("nextAccountLevel", () => {
  it("is group for no parent", () => {
    expect(nextAccountLevel(null)).toBe("group");
  });

  it("walks group -> kol -> moein -> tafsili", () => {
    expect(nextAccountLevel("group")).toBe("kol");
    expect(nextAccountLevel("kol")).toBe("moein");
    expect(nextAccountLevel("moein")).toBe("tafsili");
  });

  it("returns null past the deepest tier — تفصیلی can't have children", () => {
    expect(nextAccountLevel("tafsili")).toBeNull();
  });

  it("covers every declared level exactly once", () => {
    expect(ACCOUNT_LEVELS).toEqual(["group", "kol", "moein", "tafsili"]);
  });
});

describe("normalBalanceForType", () => {
  it("asset and expense are debit-normal", () => {
    expect(normalBalanceForType("asset")).toBe("debit");
    expect(normalBalanceForType("expense")).toBe("debit");
  });

  it("liability, equity, and revenue are credit-normal", () => {
    expect(normalBalanceForType("liability")).toBe("credit");
    expect(normalBalanceForType("equity")).toBe("credit");
    expect(normalBalanceForType("revenue")).toBe("credit");
  });

  it("every account type maps to exactly one normal balance", () => {
    const types: AccountType[] = ["asset", "liability", "equity", "revenue", "expense"];
    for (const t of types) {
      expect(["debit", "credit"]).toContain(normalBalanceForType(t));
    }
  });
});

describe("contra accounts in the F&B template", () => {
  it("marks every reducing account as contra, and nothing else", () => {
    const contraCodes = FNB_COA_TEMPLATE.filter((a) => a.isContra).map((a) => a.code);
    expect(contraCodes.sort()).toEqual([
      "1390", // ذخیره کاهش ارزش موجودی
      "1510", // استهلاک انباشته
      "3200", // برداشت مالک
      "4350", // تخفیفات فروش
      "4400", // برگشت از فروش
      "5180", // هزینهٔ تبدیل جذب‌شده در تولید
    ]);
  });

  it("keeps applied conversion cost out of cost of sales", () => {
    // 5180 offsets the wages/utilities a production run capitalised, both of
    // which sit outside gross profit. Counting it as cost of sales would
    // overstate margin in the period a batch was made and understate it in the
    // period it sold — the exact distortion capitalising the cost avoids.
    for (const industry of INDUSTRIES) {
      expect(costOfSalesCodesForIndustry(industry)).not.toContain(WELL_KNOWN_CODES.appliedConversionCost);
    }
  });
});

describe("validateAccounts", () => {
  it("rejects duplicate codes", () => {
    const errors = validateAccounts([
      { code: "1000", name: "الف", type: "asset" },
      { code: "1000", name: "ب", type: "asset" },
    ]);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("rejects a missing parent", () => {
    const errors = validateAccounts([{ code: "1100", name: "صندوق", type: "asset", parentCode: "1000" }]);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("rejects an empty list", () => {
    expect(validateAccounts([]).length).toBeGreaterThan(0);
  });
});

describe("isNonCurrentCode", () => {
  it("treats the fixed-asset range as non-current", () => {
    expect(isNonCurrentCode("asset", "1500")).toBe(true);
    expect(isNonCurrentCode("asset", "1510")).toBe(true);
    expect(isNonCurrentCode("asset", "1599")).toBe(true);
  });

  it("treats everything else on the asset side as current", () => {
    for (const code of ["1100", "1240", "1300", "1400", "1600"]) {
      expect(isNonCurrentCode("asset", code)).toBe(false);
    }
  });

  it("treats borrowings as non-current and the rest of the liabilities as current", () => {
    expect(isNonCurrentCode("liability", "2500")).toBe(true);
    expect(isNonCurrentCode("liability", "2600")).toBe(true);
    for (const code of ["2100", "2120", "2300", "2480"]) {
      expect(isNonCurrentCode("liability", code)).toBe(false);
    }
  });

  it("says no for equity, revenue and expense — the split is a balance-sheet question", () => {
    expect(isNonCurrentCode("equity", "3100")).toBe(false);
    expect(isNonCurrentCode("revenue", "4300")).toBe(false);
    expect(isNonCurrentCode("expense", "5900")).toBe(false);
  });

  it("says no for a code that isn't a number", () => {
    expect(isNonCurrentCode("asset", "")).toBe(false);
    expect(isNonCurrentCode("asset", "abc")).toBe(false);
  });

  it("partitions each template's assets and liabilities without dropping a line", () => {
    for (const industry of INDUSTRIES) {
      const template = coaTemplateForIndustry(industry);
      for (const type of ["asset", "liability"] as const) {
        const lines = template.filter((a) => a.type === type);
        const current = lines.filter((a) => !isNonCurrentCode(type, a.code));
        const nonCurrent = lines.filter((a) => isNonCurrentCode(type, a.code));
        expect(current.length + nonCurrent.length).toBe(lines.length);
      }
    }
  });
});

describe("costOfSalesCodesForIndustry", () => {
  it("names each trade's own cost of goods sold", () => {
    expect(costOfSalesCodesForIndustry("food_service")).toContain(WELL_KNOWN_CODES.cogs);
    expect(costOfSalesCodesForIndustry("jewelry")).toContain(WELL_KNOWN_CODES.goldCogs);
    expect(costOfSalesCodesForIndustry("watch")).toContain(WELL_KNOWN_CODES.watchCogs);
    expect(costOfSalesCodesForIndustry("accessories")).toContain(WELL_KNOWN_CODES.accessoryCogs);
    expect(costOfSalesCodesForIndustry("cosmetics")).toContain(WELL_KNOWN_CODES.cosmeticCogs);
    expect(costOfSalesCodesForIndustry("wholesale")).toContain(WELL_KNOWN_CODES.wholesaleCogs);
    expect(costOfSalesCodesForIndustry("tools_fittings")).toContain(WELL_KNOWN_CODES.toolsCogs);
    expect(costOfSalesCodesForIndustry("haberdashery")).toContain(WELL_KNOWN_CODES.haberdasheryCogs);
  });

  it("never lands a trade's cost of sales in another trade's list", () => {
    // 5150 is F&B's waste account and cosmetics' COGS; 5160 is F&B's count
    // shortage and cosmetics' expired/tester. The lists are per-industry
    // precisely so those two codes can mean different things.
    expect(costOfSalesCodesForIndustry("jewelry")).not.toContain(WELL_KNOWN_CODES.cogs);
    expect(costOfSalesCodesForIndustry("watch")).not.toContain(WELL_KNOWN_CODES.goldCogs);
    expect(costOfSalesCodesForIndustry("accessories")).not.toContain(WELL_KNOWN_CODES.wasteExpense);
  });

  it("counts خرید طی دوره (5105) as cost of sales in every industry", () => {
    // Under سیستم ادواری the balance of 5105 between closes IS the period's
    // yet-unclosed cost of goods, and each close credits it back to zero — so
    // the gross-profit line stays honest mid-period in any trade. Perpetual
    // businesses never post to it, so counting it costs them nothing.
    for (const industry of INDUSTRIES) {
      expect(costOfSalesCodesForIndustry(industry)).toContain(WELL_KNOWN_CODES.periodicPurchases);
    }
  });

  it("answers for every industry", () => {
    for (const industry of INDUSTRIES) {
      expect(costOfSalesCodesForIndustry(industry).length).toBeGreaterThan(0);
    }
  });
});

describe("auto-posting targets vs. the leaf rule", () => {
  it("documents that some well-known posting targets are parents, so the leaf rule stays manual-only", () => {
    // manual-journal-service.assertAccountsPostable refuses to post a
    // hand-typed document to an account that has children. That rule must NOT
    // be promoted into postJournalEntry: the shipped charts deliberately post
    // to these three while each carries children, so a blanket check would
    // break payroll, commissions and every cheque operation in every trade.
    const expectedParentTargets = [
      WELL_KNOWN_CODES.salariesPayable,
      WELL_KNOWN_CODES.chequesReceivable,
      WELL_KNOWN_CODES.chequesPayable,
    ];

    for (const industry of INDUSTRIES) {
      const template = coaTemplateForIndustry(industry);
      const parents = new Set(
        template.map((a) => a.parentCode).filter((c): c is string => Boolean(c)),
      );
      for (const code of expectedParentTargets) {
        expect(
          parents.has(code),
          `${code} should still be a parent in ${industry}; if this changed, re-check the leaf rule's scope`,
        ).toBe(true);
      }
    }
  });
});

describe("isValidAccountCode", () => {
  /* codes are persisted as Latin digits only (digits.ts convention); the
     create route canonicalises Persian/Arabic digits with toLatinDigits and
     this predicate is the gate for whatever remains — see
     accounts-service.ts's createAccount. */
  it("accepts plain numerals, the shape every well-known code follows", () => {
    expect(isValidAccountCode("6100")).toBe(true);
    expect(isValidAccountCode("1")).toBe(true);
    for (const code of Object.values(WELL_KNOWN_CODES)) {
      expect(isValidAccountCode(code)).toBe(true);
    }
  });

  it("rejects Persian and Arabic digits — they must be canonicalised before storing", () => {
    expect(isValidAccountCode("۶۱۰۰")).toBe(false);
    expect(isValidAccountCode("٦١٠٠")).toBe(false);
    expect(isValidAccountCode("61۰0")).toBe(false);
  });

  it("rejects letters, separators, signs and whitespace", () => {
    expect(isValidAccountCode("")).toBe(false);
    expect(isValidAccountCode("abc")).toBe(false);
    expect(isValidAccountCode("61-00")).toBe(false);
    expect(isValidAccountCode("61.00")).toBe(false);
    expect(isValidAccountCode("61 00")).toBe(false);
    expect(isValidAccountCode("+6100")).toBe(false);
  });
});
