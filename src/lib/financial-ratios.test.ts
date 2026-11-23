import { describe, expect, it } from "vitest";
import {
  FINANCIAL_RATIO_CATALOGUE_VERSION,
  FINANCIAL_RATIO_DEFINITIONS,
  FINANCIAL_RATIO_TREND_KEYS,
  RATIO_INPUT_LABELS,
  RATIO_REASON_LABELS,
  compareFinancialRatios,
  computeFinancialRatios,
  financialRatioCatalogue,
  formatRatioValue,
  groupFinancialRatios,
  periodDayCount,
  type FinancialRatioInputSet,
  type RatioInputKey,
} from "./financial-ratios";

/**
 * Independently calculated fixtures. Every amount is integer Rial and every
 * expected figure below is worked out by hand from the fixture, not by calling
 * the implementation — so a formula that drifts fails here.
 *
 * Period: 2025-01-01 → 2025-12-31 (365 days).
 */
const FULL: FinancialRatioInputSet = {
  values: {
    cashAndEquivalents: 200_000,
    tradeReceivables: 300_000,
    tradePayables: 200_000,
    inventory: 400_000,
    currentAssets: 1_000_000,
    currentLiabilities: 500_000,
    totalAssets: 2_000_000,
    totalLiabilities: 800_000,
    totalEquity: 1_200_000,
    netRevenue: 1_500_000,
    costOfSales: 900_000,
    grossProfit: 600_000,
    operatingExpenses: 350_000,
    operatingProfit: 250_000,
    interestExpense: 50_000,
    netIncome: 200_000,
    periodDays: 365,
    openingTotalAssets: 1_800_000,
    openingTotalEquity: 1_000_000,
    openingInventory: 350_000,
    openingTradeReceivables: 250_000,
    openingTradePayables: 150_000,
  },
};

function ratio(result: ReturnType<typeof computeFinancialRatios>, key: string) {
  const found = result.find((item) => item.key === key);
  if (!found) throw new Error(`missing ratio ${key}`);
  return found;
}

describe("financial ratio catalogue", () => {
  it("is versioned and lists each key once", () => {
    expect(FINANCIAL_RATIO_CATALOGUE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    const keys = FINANCIAL_RATIO_DEFINITIONS.map((definition) => definition.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.length).toBe(18);
  });

  it("documents every required input with a label and its source report", () => {
    for (const definition of FINANCIAL_RATIO_DEFINITIONS) {
      expect(definition.formula.length).toBeGreaterThan(0);
      expect(definition.explanation.length).toBeGreaterThan(0);
      expect(definition.requires.length).toBeGreaterThan(0);
      for (const key of definition.requires) {
        expect(RATIO_INPUT_LABELS[key], `${definition.key} → ${key}`).toBeTruthy();
      }
    }
    expect(financialRatioCatalogue()).toEqual(FINANCIAL_RATIO_DEFINITIONS);
  });

  it("groups the ratios in liquidity → leverage → profitability → efficiency order", () => {
    const groups = groupFinancialRatios(computeFinancialRatios(FULL));
    expect(groups.map((group) => group.key)).toEqual([
      "liquidity",
      "leverage",
      "profitability",
      "efficiency",
    ]);
    expect(groups.map((group) => group.ratios.length)).toEqual([3, 3, 5, 7]);
  });

  it("plots only catalogue keys", () => {
    const keys = FINANCIAL_RATIO_DEFINITIONS.map((definition) => definition.key);
    for (const key of FINANCIAL_RATIO_TREND_KEYS) expect(keys).toContain(key);
  });
});

describe("formulas — hand-calculated fixtures", () => {
  const ratios = computeFinancialRatios(FULL);

  it("computes the three liquidity ratios from the closing balances", () => {
    expect(ratio(ratios, "current_ratio").value).toBe(2);
    expect(ratio(ratios, "quick_ratio").value).toBe(1);
    expect(ratio(ratios, "cash_ratio").value).toBe(0.4);
    expect(ratio(ratios, "current_ratio").display).toBe("۲٫۰۰");
    expect(ratio(ratios, "cash_ratio").display).toBe("۰٫۴۰");
  });

  it("computes the leverage ratios", () => {
    expect(ratio(ratios, "debt_to_assets").value).toBeCloseTo(0.4, 6);
    expect(ratio(ratios, "debt_to_equity").value).toBeCloseTo(0.666667, 6);
    // EBIT = net income 200,000 + interest 50,000 = 250,000; ÷ 50,000 = 5.
    expect(ratio(ratios, "interest_coverage").value).toBe(5);
    expect(ratio(ratios, "interest_coverage").display).toBe("۵٫۰۰");
  });

  it("computes margins on net revenue and shows percent with one decimal", () => {
    expect(ratio(ratios, "gross_margin").value).toBeCloseTo(40, 6);
    expect(ratio(ratios, "operating_margin").value).toBeCloseTo(16.666667, 6);
    expect(ratio(ratios, "net_margin").value).toBeCloseTo(13.333333, 6);
    expect(ratio(ratios, "gross_margin").display).toBe("۴۰٫۰٪");
    expect(ratio(ratios, "net_margin").display).toBe("۱۳٫۳٪");
  });

  it("uses the opening/closing average for ROA, ROE and asset turnover", () => {
    // Average assets = (1,800,000 + 2,000,000) / 2 = 1,900,000.
    expect(ratio(ratios, "return_on_assets").value).toBeCloseTo(10.526316, 5);
    // Average equity = (1,000,000 + 1,200,000) / 2 = 1,100,000.
    expect(ratio(ratios, "return_on_equity").value).toBeCloseTo(18.181818, 5);
    expect(ratio(ratios, "asset_turnover").value).toBeCloseTo(1500 / 1900, 6);
    expect(ratio(ratios, "return_on_equity").display).toBe("۱۸٫۲٪");
  });

  it("computes turnover and day counts from the same averages", () => {
    // Inventory average = (350,000 + 400,000) / 2 = 375,000.
    expect(ratio(ratios, "inventory_turnover").value).toBeCloseTo(2.4, 6);
    expect(ratio(ratios, "days_inventory_outstanding").value).toBeCloseTo(365 / 2.4, 5);
    expect(ratio(ratios, "days_inventory_outstanding").display).toBe("۱۵۲٫۱ روز");
    // Receivables average = (250,000 + 300,000) / 2 = 275,000.
    expect(ratio(ratios, "receivables_turnover").value).toBeCloseTo(1500 / 275, 6);
    expect(ratio(ratios, "days_sales_outstanding").value).toBeCloseTo(365 / (1500 / 275), 5);
    // Payables average = (150,000 + 200,000) / 2 = 175,000.
    expect(ratio(ratios, "payables_turnover").value).toBeCloseTo(900 / 175, 6);
    expect(ratio(ratios, "days_payable_outstanding").value).toBeCloseTo(365 / (900 / 175), 5);
  });

  it("lists the inputs each ratio used", () => {
    const gross = ratio(ratios, "gross_margin");
    expect(gross.inputs.map((line) => line.key)).toEqual(["grossProfit", "netRevenue"]);
    expect(gross.missingInputs).toEqual([]);
    expect(gross.reason).toBeNull();
  });
});

describe("missing data and unmeaningful denominators", () => {
  it("returns unavailable with the missing input named, never zero", () => {
    const ratios = computeFinancialRatios({
      values: { ...FULL.values, netIncome: null },
    });
    const net = ratio(ratios, "net_margin");
    expect(net.status).toBe("unavailable");
    expect(net.value).toBeNull();
    expect(net.display).toBeNull();
    expect(net.reason).toBe("missing_input");
    expect(net.missingInputs).toContain("netIncome");
  });

  it("treats an absent interest account as a classification gap with its own reason", () => {
    const ratios = computeFinancialRatios({
      values: { ...FULL.values, interestExpense: null },
      reasons: { interestExpense: "interest_expense_not_classified" },
    });
    const coverage = ratio(ratios, "interest_coverage");
    expect(coverage.reason).toBe("interest_expense_not_classified");
    expect(coverage.reasonText).toBe(RATIO_REASON_LABELS.interest_expense_not_classified);
    expect(coverage.value).toBeNull();
    // Operating profit was supplied independently of the mapping, so the margins still compute.
    expect(ratio(ratios, "operating_margin").status).toBe("available");
  });

  it("refuses zero current liabilities instead of returning infinity", () => {
    const ratios = computeFinancialRatios({
      values: { ...FULL.values, currentLiabilities: 0 },
    });
    for (const key of ["current_ratio", "quick_ratio", "cash_ratio"]) {
      expect(ratio(ratios, key).status).toBe("unavailable");
      expect(ratio(ratios, key).reason).toBe("zero_denominator");
      expect(ratio(ratios, key).value).toBeNull();
    }
  });

  it("refuses a negative denominator where the ratio is not meaningful", () => {
    const ratios = computeFinancialRatios({
      values: { ...FULL.values, currentLiabilities: -1_000 },
    });
    expect(ratio(ratios, "current_ratio").reason).toBe("negative_denominator");
  });

  it("marks debt-to-equity and ROE undefined on zero or negative equity", () => {
    for (const equity of [0, -50_000]) {
      const ratios = computeFinancialRatios({
        values: { ...FULL.values, totalEquity: equity, openingTotalEquity: equity },
      });
      expect(ratio(ratios, "debt_to_equity").reason).toBe("non_positive_equity");
      expect(ratio(ratios, "return_on_equity").reason).toBe("non_positive_equity");
    }
  });

  it("refuses zero interest expense", () => {
    const ratios = computeFinancialRatios({
      values: { ...FULL.values, interestExpense: 0 },
    });
    expect(ratio(ratios, "interest_coverage").reason).toBe("zero_denominator");
  });

  it("marks margins unavailable when net revenue is zero or negative", () => {
    for (const revenue of [0, -1]) {
      const ratios = computeFinancialRatios({
        values: { ...FULL.values, netRevenue: revenue },
      });
      for (const key of ["gross_margin", "operating_margin", "net_margin"]) {
        expect(ratio(ratios, key).reason).toBe("no_revenue");
      }
      expect(ratio(ratios, "receivables_turnover").reason).toBe("no_revenue");
      expect(ratio(ratios, "asset_turnover").reason).toBe("no_revenue");
      // The day counts derive from an unavailable turnover, not from a fabricated one.
      expect(ratio(ratios, "days_sales_outstanding").reason).toBe("derived_unavailable");
    }
  });

  it("requires opening balances for every average-balance ratio", () => {
    const ratios = computeFinancialRatios({
      values: {
        ...FULL.values,
        openingTotalAssets: null,
        openingTotalEquity: null,
        openingInventory: null,
        openingTradeReceivables: null,
        openingTradePayables: null,
      },
    });
    for (const key of [
      "return_on_assets",
      "return_on_equity",
      "inventory_turnover",
      "receivables_turnover",
      "payables_turnover",
      "asset_turnover",
    ]) {
      expect(ratio(ratios, key).reason).toBe("no_opening_comparative");
      expect(ratio(ratios, key).value).toBeNull();
    }
    for (const key of [
      "days_inventory_outstanding",
      "days_sales_outstanding",
      "days_payable_outstanding",
    ]) {
      expect(ratio(ratios, key).reason).toBe("derived_unavailable");
    }
    // Point-in-time liquidity did not need opening data and still computed.
    expect(ratio(ratios, "current_ratio").value).toBe(2);
  });

  it("refuses a non-positive numerator where a turnover would be meaningless", () => {
    const ratios = computeFinancialRatios({
      values: { ...FULL.values, costOfSales: 0 },
    });
    expect(ratio(ratios, "inventory_turnover").reason).toBe("non_positive_numerator");
    expect(ratio(ratios, "payables_turnover").reason).toBe("non_positive_numerator");
  });

  it("refuses an invalid period length for day-based ratios", () => {
    const ratios = computeFinancialRatios({
      values: { ...FULL.values, periodDays: 0 },
    });
    expect(ratio(ratios, "days_inventory_outstanding").reason).toBe("no_period_days");
  });

  it("keeps negative margins as facts rather than errors", () => {
    const ratios = computeFinancialRatios({
      values: { ...FULL.values, netIncome: -200_000 },
    });
    const net = ratio(ratios, "net_margin");
    expect(net.status).toBe("available");
    expect(net.value).toBeCloseTo(-13.333333, 5);
    expect(net.display).toBe("-۱۳٫۳٪");
  });

  it("reports negative interest coverage when EBIT is negative", () => {
    const ratios = computeFinancialRatios({
      values: { ...FULL.values, netIncome: -250_000 },
    });
    expect(ratio(ratios, "interest_coverage").value).toBe(-4);
  });
});

describe("presentation and comparison", () => {
  it("formats Persian digits and units without changing the stored value", () => {
    expect(formatRatioValue(1.23456, "ratio")).toBe("۱٫۲۳");
    expect(formatRatioValue(12.345, "percent")).toBe("۱۲٫۳٪");
    expect(formatRatioValue(7.25, "days")).toBe("۷٫۳ روز");
    expect(formatRatioValue(-0.004, "ratio")).toBe("۰٫۰۰");
    expect(formatRatioValue(Number.NaN, "ratio")).toBe("—");
  });

  it("computes previous-period change only when both periods have a figure", () => {
    const current = computeFinancialRatios(FULL);
    const previous = computeFinancialRatios({
      values: {
        ...FULL.values,
        netRevenue: 1_000_000,
        grossProfit: 300_000,
        totalLiabilities: 600_000,
        totalAssets: 1_800_000,
        totalEquity: 1_200_000,
      },
    });
    const compared = compareFinancialRatios(current, previous);
    const debt = compared.find((item) => item.key === "debt_to_assets")!;
    expect(debt.change).toBeCloseTo(0.4 - 600_000 / 1_800_000, 6);
    expect(debt.direction).toBe("up");
    expect(debt.changePct).toBeCloseTo(
      ((0.4 - 600_000 / 1_800_000) / (600_000 / 1_800_000)) * 100,
      2,
    );

    const gross = compared.find((item) => item.key === "gross_margin")!;
    expect(gross.change).toBeCloseTo(40 - 30, 6);
    expect(gross.direction).toBe("up");
  });

  it("has no change when the previous period is unavailable", () => {
    const current = computeFinancialRatios(FULL);
    const previous = computeFinancialRatios({
      values: { ...FULL.values, netRevenue: 0 },
    });
    const compared = compareFinancialRatios(current, previous);
    const margin = compared.find((item) => item.key === "net_margin")!;
    expect(margin.previous?.status).toBe("unavailable");
    expect(margin.change).toBeNull();
    expect(margin.changePct).toBeNull();
    expect(margin.direction).toBeNull();
  });

  it("does not divide by a zero previous figure", () => {
    const current = computeFinancialRatios(FULL);
    const previous = computeFinancialRatios({
      values: { ...FULL.values, totalLiabilities: 0 },
    });
    const debt = compareFinancialRatios(current, previous).find((item) => item.key === "debt_to_assets")!;
    expect(debt.previous?.value).toBe(0);
    expect(debt.change).toBeCloseTo(0.4, 6);
    expect(debt.changePct).toBeNull();
  });
});

describe("period boundaries", () => {
  it("counts both ends of an inclusive period", () => {
    expect(periodDayCount("2025-01-01", "2025-01-01")).toBe(1);
    expect(periodDayCount("2025-01-01", "2025-01-31")).toBe(31);
    expect(periodDayCount("2024-01-01", "2024-12-31")).toBe(366);
    expect(periodDayCount("2025-12-31", "2025-01-01")).toBeNull();
    expect(periodDayCount("not-a-date", "2025-01-01")).toBeNull();
  });

  it("carries the period day count into the day-based ratios", () => {
    const month = computeFinancialRatios({
      values: { ...FULL.values, periodDays: periodDayCount("2025-01-01", "2025-01-31") },
    });
    expect(ratio(month, "days_inventory_outstanding").value).toBeCloseTo(31 / 2.4, 5);
  });
});
