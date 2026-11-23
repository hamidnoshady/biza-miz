/**
 * Issue #1324 — the financial-ratios report against a real ledger.
 *
 * The pure formulas are covered by `src/lib/financial-ratios.test.ts`. What can
 * only be proved here is that the calculation service reads the SAME books the
 * existing statements read: every input it hands the engine is compared with
 * `getProfitAndLoss` / `getBalanceSheet` over the same range and scope, and the
 * branch, dimension, opening-balance and re-posting cases are exercised against
 * posted entries. Issue #1324 also asks the subledger questions to agree with
 * the reports that already own them, so the trade receivable, trade payable and
 * inventory inputs are reconciled against A/R aging, A/P aging and the
 * inventory-valuation report as of the same date.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { BUSINESS_WIDE_SCOPE, branchScope } from "../src/lib/report-scope";
import { formatRatioValue } from "../src/lib/financial-ratios";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

const FROM = "2025-01-01";
const TO = "2025-03-31";

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let reportsService: typeof import("../src/lib/reports-service");
let ratioService: typeof import("../src/lib/financial-ratios-service");
let arService: typeof import("../src/lib/ar-service");
let apService: typeof import("../src/lib/ap-service");

const biz = { id: "", loc1: "", loc2: "", costCenter: "" };
const acct = {
  cash: "",
  receivable: "",
  inventory: "",
  payable: "",
  capital: "",
  revenue: "",
  cogs: "",
  salaries: "",
  interest: "",
};

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

function maintenanceUrl(): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = "/postgres";
  return url.toString();
}

beforeAll(async () => {
  databaseName = `pos_ratios_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }
  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });
  process.env.DATABASE_URL = urlFor(databaseName);
  dbLib = await import("../src/lib/db");
  reportsService = await import("../src/lib/reports-service");
  ratioService = await import("../src/lib/financial-ratios-service");
  arService = await import("../src/lib/ar-service");
  apService = await import("../src/lib/ap-service");
  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
}, 120_000);

afterAll(async () => {
  await db?.end();
  await dbLib?.getPool().end().catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

beforeEach(async () => {
  await db.query("DELETE FROM settings");
  await db.query("DELETE FROM journal_lines");
  await db.query("DELETE FROM journal_entries");
  await db.query("DELETE FROM stock_movements");
  await db.query("DELETE FROM inventory_lots");
  await db.query("DELETE FROM inventory_events");
  await db.query("DELETE FROM accounting_dimension_values");
  await db.query("DELETE FROM businesses");

  const business = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ('Ratios Co', $1) RETURNING id",
    [`ratios-${randomUUID().slice(0, 8)}`],
  );
  biz.id = business.rows[0].id;

  const locations = await db.query<{ id: string }>(
    `INSERT INTO locations (business_id, name, timezone, is_active)
     VALUES ($1, 'Main', 'Asia/Tehran', true), ($1, 'Second', 'Asia/Tehran', true)
     RETURNING id`,
    [biz.id],
  );
  biz.loc1 = locations.rows[0].id;
  biz.loc2 = locations.rows[1].id;

  const accounts = await db.query<{ id: string; code: string }>(
    `INSERT INTO accounts (business_id, code, name, type)
     VALUES ($1, '1100', 'Cash', 'asset'),
            ($1, '1200', 'Accounts receivable', 'asset'),
            ($1, '1300', 'Inventory', 'asset'),
            ($1, '2100', 'Accounts payable', 'liability'),
            ($1, '3100', 'Capital', 'equity'),
            ($1, '4300', 'Sales', 'revenue'),
            ($1, '5100', 'Cost of goods sold', 'expense'),
            ($1, '5200', 'Salaries', 'expense'),
            ($1, '5800', 'Interest expense', 'expense')
     RETURNING id, code`,
    [biz.id],
  );
  const byCode: Record<string, keyof typeof acct> = {
    "1100": "cash",
    "1200": "receivable",
    "1300": "inventory",
    "2100": "payable",
    "3100": "capital",
    "4300": "revenue",
    "5100": "cogs",
    "5200": "salaries",
    "5800": "interest",
  };
  for (const row of accounts.rows) acct[byCode[row.code]] = row.id;

  biz.costCenter = (
    await db.query<{ id: string }>(
      `INSERT INTO accounting_dimension_values (business_id, kind, code, name)
       VALUES ($1, 'cost_center', 'CC-A', 'Center A') RETURNING id`,
      [biz.id],
    )
  ).rows[0].id;

  // Opening: capital in cash, and stock bought on credit.
  await post("2024-12-31", [
    { account: acct.cash, debit: 5_000_000 },
    { account: acct.capital, credit: 5_000_000 },
  ]);
  await post("2024-12-31", [
    { account: acct.inventory, debit: 1_000_000 },
    { account: acct.payable, credit: 1_000_000 },
  ]);

  // The period.
  await post("2025-01-05", [
    { account: acct.cash, debit: 3_000_000 },
    { account: acct.revenue, credit: 3_000_000 },
  ]);
  await post("2025-01-20", [
    { account: acct.receivable, debit: 2_000_000, costCenter: biz.costCenter },
    { account: acct.revenue, credit: 2_000_000, costCenter: biz.costCenter },
  ]);
  await post("2025-02-10", [
    { account: acct.cogs, debit: 600_000 },
    { account: acct.inventory, credit: 600_000 },
  ]);
  await post("2025-02-28", [
    { account: acct.salaries, debit: 400_000 },
    { account: acct.cash, credit: 400_000 },
  ]);
  await post("2025-03-10", [
    { account: acct.interest, debit: 100_000 },
    { account: acct.cash, credit: 100_000 },
  ]);
  await post("2025-03-15", [
    { account: acct.cash, debit: 500_000 },
    { account: acct.receivable, credit: 500_000 },
  ]);
  await post("2025-03-20", [
    { account: acct.payable, debit: 300_000 },
    { account: acct.cash, credit: 300_000 },
  ]);
  // A second branch's sale, which a branch-scoped report must never see.
  await post(
    "2025-03-25",
    [
      { account: acct.cash, debit: 1_000_000 },
      { account: acct.revenue, credit: 1_000_000 },
    ],
    biz.loc2,
  );

  // The stock ledger behind the journal's inventory movement: 10 units received
  // at 100,000 (the opening 1,000,000) and 6 consumed at cost (the February COGS
  // of 600,000), leaving one open lot worth the 400,000 the 1300 account
  // carries. The valuation report reads these rows and the ratios read the
  // journal, so a comparable fixture has to agree on both sides — as a real
  // posting does, because it writes both.
  const stockItem = await db.query<{ id: string }>(
    `INSERT INTO inventory_items (location_id, name, unit, avg_cost, carrying_value_rial)
     VALUES ($1, 'Flour', 'kg', 100000, 400000) RETURNING id`,
    [biz.loc1],
  );
  const stockEvent = await db.query<{ id: string }>(
    `INSERT INTO inventory_events (business_id, location_id, event_type, source_type, costing_version, posting_status)
     VALUES ($1, $2, 'purchase_receipt', 'fixture', 2, 'posted') RETURNING id`,
    [biz.id, biz.loc1],
  );
  const stockItemId = stockItem.rows[0].id;
  const stockEventId = stockEvent.rows[0].id;
  await db.query(
    `INSERT INTO stock_movements (location_id, inventory_item_id, type, quantity, unit_cost, cost_value_rial, source_type, inventory_event_id)
     VALUES ($1, $2, 'purchase', 10, 100000, 1000000, 'fixture', $3),
            ($1, $2, 'sale', -6, 100000, 600000, 'fixture', $3)`,
    [biz.loc1, stockItemId, stockEventId],
  );
  await db.query(
    `INSERT INTO inventory_lots (location_id, inventory_item_id, remaining_qty, unit_cost, source_type, inventory_event_id,
       original_quantity, original_value_rial, remaining_value_rial)
     VALUES ($1, $2, 4, 100000, 'fixture', $3, 10, 1000000, 400000)`,
    [biz.loc1, stockItemId, stockEventId],
  );
});

async function post(
  entryDate: string,
  lines: { account: string; debit?: number; credit?: number; costCenter?: string }[],
  locationId: string = biz.loc1,
) {
  const entry = await db.query<{ id: string }>(
    `INSERT INTO journal_entries (business_id, location_id, entry_date, memo, source_type)
     VALUES ($1, $2, $3, 'ratio fixture', 'manual') RETURNING id`,
    [biz.id, locationId, entryDate],
  );
  const entryId = entry.rows[0].id;
  for (const line of lines) {
    await db.query(
      `INSERT INTO journal_lines (entry_id, account_id, debit, credit, cost_center_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [entryId, line.account, line.debit ?? 0, line.credit ?? 0, line.costCenter ?? null],
    );
  }
}

function input(report: Awaited<ReturnType<typeof ratioService.getFinancialRatios>>, key: string) {
  const found = report.inputs.find((item) => item.key === key);
  if (!found) throw new Error(`missing input ${key}`);
  return found.value;
}

function ratio(report: Awaited<ReturnType<typeof ratioService.getFinancialRatios>>, key: string) {
  const found = report.groups.flatMap((group) => group.ratios).find((item) => item.key === key);
  if (!found) throw new Error(`missing ratio ${key}`);
  return found;
}

async function report(overrides: Partial<Parameters<typeof ratioService.getFinancialRatios>[1]> = {}) {
  return ratioService.getFinancialRatios(biz.id, {
    dateFrom: FROM,
    dateTo: TO,
    scope: BUSINESS_WIDE_SCOPE,
    trendPeriods: 0,
    ...overrides,
  });
}

/** The inventory-valuation standard report, summed the way its screen and chart read it. */
async function inventoryValuation(scope: Parameters<typeof reportsService.runStandardReportRows>[2]) {
  const rows = await reportsService.runStandardReportRows("inventory_valuation", biz.id, scope);
  return {
    items: rows.length,
    value: rows.reduce((sum, row) => sum + Number(row.valuation ?? 0), 0),
  };
}

describe("subledger and inventory reports reconcile to the same books", () => {
  it("agrees with A/R aging and A/P aging as of the period end", async () => {
    const result = await report();
    const ar = await arService.getArAging(biz.id, TO);
    const ap = await apService.getApAging(biz.id, TO);

    expect(ar.asOfDate).toBe(TO);
    expect(ap.asOfDate).toBe(TO);
    expect(input(result, "tradeReceivables")).toBe(ar.totals.total);
    expect(input(result, "tradePayables")).toBe(ap.totals.total);
    expect(ar.totals.total).toBe(1_500_000);
    expect(ap.totals.total).toBe(700_000);

    // The same comparison at an earlier period boundary: the March receipt and
    // the March payment are not in the aging yet, and the ratios must not see
    // them either.
    const earlier = await report({ dateTo: "2025-02-28" });
    const arEarlier = await arService.getArAging(biz.id, "2025-02-28");
    const apEarlier = await apService.getApAging(biz.id, "2025-02-28");
    expect(input(earlier, "tradeReceivables")).toBe(arEarlier.totals.total);
    expect(input(earlier, "tradePayables")).toBe(apEarlier.totals.total);
    expect(input(earlier, "tradeReceivables")).toBe(2_000_000);
    expect(input(earlier, "tradePayables")).toBe(1_000_000);

    // The aging reports are business-wide by construction (no branch argument),
    // so the reconciliation is at that scope. Every A/R and A/P line here is on
    // branch one; branch two genuinely has none.
    const secondBranch = await report({ scope: branchScope(biz.loc2) });
    expect(input(secondBranch, "tradeReceivables")).toBe(0);
    expect(input(secondBranch, "tradePayables")).toBe(0);
  });

  it("agrees with the inventory-valuation report at the period end", async () => {
    const result = await report();
    const valuation = await inventoryValuation(BUSINESS_WIDE_SCOPE);
    expect(input(result, "inventory")).toBe(400_000);
    expect(valuation.items).toBe(1);
    expect(valuation.value).toBe(input(result, "inventory"));

    // The valuation view carries `location_id`, so unlike the aging reports it
    // reconciles in branch scope too — on the branch that holds the stock, and
    // as an honest zero on the branch that holds none.
    const firstBranch = await report({ scope: branchScope(biz.loc1) });
    expect(input(firstBranch, "inventory")).toBe(
      (await inventoryValuation(branchScope(biz.loc1))).value,
    );
    const secondBranch = await report({ scope: branchScope(biz.loc2) });
    expect(input(secondBranch, "inventory")).toBe(
      (await inventoryValuation(branchScope(biz.loc2))).value,
    );
  });
});

describe("inputs reconcile to the existing statements", () => {
  beforeEach(async () => {
    await ratioService.setFinancialRatioMapping(biz.id, {
      interestExpenseAccountCodes: ["5800"],
    });
  });

  it("matches the P&L movement for the period and the balance sheet at its end", async () => {
    const result = await report();
    const pnl = await reportsService.getProfitAndLoss(biz.id, { dateFrom: FROM, dateTo: TO }, BUSINESS_WIDE_SCOPE);
    const balance = await reportsService.getBalanceSheet(biz.id, TO, BUSINESS_WIDE_SCOPE);

    expect(input(result, "netRevenue")).toBe(pnl.totalRevenue);
    expect(input(result, "costOfSales")).toBe(pnl.costOfSales);
    expect(input(result, "grossProfit")).toBe(pnl.grossProfit);
    expect(input(result, "netIncome")).toBe(pnl.netIncome);
    // Operating profit excludes the classified interest expense from overhead.
    expect(input(result, "interestExpense")).toBe(100_000);
    expect(input(result, "operatingExpenses")).toBe(pnl.totalExpenses - pnl.costOfSales - 100_000);
    expect(input(result, "operatingProfit")).toBe(
      pnl.totalRevenue - pnl.costOfSales - (pnl.totalExpenses - pnl.costOfSales - 100_000),
    );

    expect(input(result, "totalAssets")).toBe(balance.totalAssets);
    expect(input(result, "totalLiabilities")).toBe(balance.totalLiabilities);
    expect(input(result, "totalEquity")).toBe(balance.totalEquity);
    expect(input(result, "currentAssets")).toBe(balance.currentAssets);
    expect(input(result, "currentLiabilities")).toBe(balance.currentLiabilities);
    expect(result.checks.balanceSheetBalanced).toBe(true);
    expect(balance.balanced).toBe(true);
    // Opening balances are the balance at `dateFrom - 1`.
    const opening = await reportsService.getBalanceSheet(biz.id, "2024-12-31", BUSINESS_WIDE_SCOPE);
    expect(input(result, "openingTotalAssets")).toBe(opening.totalAssets);
    expect(input(result, "openingTotalEquity")).toBe(opening.totalEquity);
  });

  it("computes the documented formulas from those reconciled inputs", async () => {
    const result = await report();
    // Consolidated: revenue 6,000,000; COGS 600,000; expenses 500,000 → net 4,900,000.
    expect(ratio(result, "current_ratio").value).toBeCloseTo(10_600_000 / 700_000, 6);
    expect(ratio(result, "quick_ratio").value).toBeCloseTo((8_700_000 + 1_500_000) / 700_000, 6);
    expect(ratio(result, "cash_ratio").value).toBeCloseTo(8_700_000 / 700_000, 6);
    expect(ratio(result, "debt_to_assets").value).toBeCloseTo(700_000 / 10_600_000, 6);
    expect(ratio(result, "debt_to_equity").value).toBeCloseTo(700_000 / 9_900_000, 6);
    // EBIT = 4,900,000 + 100,000 = 5,000,000; ÷ 100,000.
    expect(ratio(result, "interest_coverage").value).toBe(50);
    expect(ratio(result, "gross_margin").value).toBeCloseTo((6_000_000 - 600_000) / 6_000_000 * 100, 6);
    expect(ratio(result, "operating_margin").value).toBeCloseTo((5_400_000 - 400_000) / 6_000_000 * 100, 6);
    expect(ratio(result, "net_margin").value).toBeCloseTo(4_900_000 / 6_000_000 * 100, 6);
    // Average assets = (6,000,000 + 10,600,000) / 2 = 8,300,000.
    expect(ratio(result, "return_on_assets").value).toBeCloseTo(4_900_000 / 8_300_000 * 100, 6);
    // Average equity = (5,000,000 + 9,900,000) / 2 = 7,450,000.
    expect(ratio(result, "return_on_equity").value).toBeCloseTo(4_900_000 / 7_450_000 * 100, 6);
    // Inventory average = (1,000,000 + 400,000) / 2 = 700,000.
    expect(ratio(result, "inventory_turnover").value).toBeCloseTo(600_000 / 700_000, 6);
    expect(ratio(result, "days_inventory_outstanding").value).toBeCloseTo(90 / (600_000 / 700_000), 6);
    // Receivables average = (0 + 1,500,000) / 2 = 750,000.
    expect(ratio(result, "receivables_turnover").value).toBeCloseTo(6_000_000 / 750_000, 6);
    // Payables average = (1,000,000 + 700,000) / 2 = 850,000.
    expect(ratio(result, "payables_turnover").value).toBeCloseTo(600_000 / 850_000, 6);
    expect(ratio(result, "asset_turnover").value).toBeCloseTo(6_000_000 / 8_300_000, 6);
    expect(result.period.days).toBe(90);
  });

  it("produces the same display string the export uses, for every available ratio", async () => {
    const result = await report();
    const available = result.groups.flatMap((group) => group.ratios).filter((item) => item.status === "available");
    expect(available.length).toBeGreaterThan(10);
    for (const item of available) {
      expect(item.display, item.key).toBe(formatRatioValue(item.value!, item.unit));
    }
    // Nothing is ever rendered as a zero/infinity placeholder.
    for (const item of result.groups.flatMap((group) => group.ratios)) {
      if (item.status !== "available") expect(item.display).toBeNull();
      expect(item.display).not.toBe("Infinity");
      expect(item.display).not.toBe("NaN");
    }
  });
});

describe("classification, periods and missing data", () => {
  it("reports interest coverage as unavailable until the account is reviewed", async () => {
    const before = await report();
    expect(ratio(before, "interest_coverage").status).toBe("unavailable");
    expect(ratio(before, "interest_coverage").reason).toBe("interest_expense_not_classified");
    expect(before.warnings.join(" ")).toContain("هزینهٔ بهره");
    expect(before.mapping.interestExpenseAccountCodes).toEqual([]);

    await ratioService.setFinancialRatioMapping(biz.id, { interestExpenseAccountCodes: ["5800"] });
    const after = await report();
    expect(ratio(after, "interest_coverage").status).toBe("available");
    expect(ratio(after, "interest_coverage").value).toBe(50);
    expect(after.mapping.interestExpenseAccountCodes).toEqual(["5800"]);
  });

  it("refuses an interest account that is not an expense account in this business", async () => {
    await expect(
      ratioService.setFinancialRatioMapping(biz.id, { interestExpenseAccountCodes: ["4300"] }),
    ).rejects.toThrow("unknown_interest_account");
  });

  it("marks average-balance ratios unavailable when the period has no opening comparative", async () => {
    const result = await report({ dateFrom: "2024-12-31" });
    expect(result.checks.openingComparativesAvailable).toBe(false);
    expect(ratio(result, "return_on_assets").reason).toBe("no_opening_comparative");
    expect(ratio(result, "inventory_turnover").reason).toBe("no_opening_comparative");
    expect(ratio(result, "days_inventory_outstanding").reason).toBe("derived_unavailable");
    expect(result.warnings.join(" ")).toContain("ماندهٔ ابتدای دوره");
    // Point-in-time liquidity still computed from the closing balance.
    expect(ratio(result, "current_ratio").status).toBe("available");
  });

  it("compares with the immediately preceding period of the same length", async () => {
    const result = await report({ compare: true });
    expect(result.comparisonPeriod).toEqual({ dateFrom: "2024-10-03", dateTo: "2024-12-31" });
    // That window holds only the opening entry: no revenue, so the margin is
    // unavailable rather than a fabricated zero.
    const margin = ratio(result, "gross_margin");
    expect(margin.previous?.status).toBe("unavailable");
    expect(margin.change).toBeNull();
    expect(margin.changePct).toBeNull();
  });
});

describe("scope and dimensions", () => {
  it("keeps a branch-scoped report on that branch's slice of the same books", async () => {
    const branch = await report({ scope: branchScope(biz.loc1) });
    const pnl = await reportsService.getProfitAndLoss(biz.id, { dateFrom: FROM, dateTo: TO }, branchScope(biz.loc1));
    const balance = await reportsService.getBalanceSheet(biz.id, TO, branchScope(biz.loc1));

    expect(input(branch, "netRevenue")).toBe(5_000_000);
    expect(input(branch, "netRevenue")).toBe(pnl.totalRevenue);
    expect(input(branch, "totalAssets")).toBe(9_600_000);
    expect(input(branch, "totalAssets")).toBe(balance.totalAssets);
    expect(input(branch, "cashAndEquivalents")).toBe(7_700_000);
    expect(branch.checks.balanceSheetBalanced).toBe(true);

    const consolidated = await report();
    expect(input(consolidated, "netRevenue")).toBe(6_000_000);
    expect(input(consolidated, "cashAndEquivalents")).toBe(8_700_000);
  });

  it("restricts every input to the selected journal lines and says so", async () => {
    const dimension = { kind: "cost_center" as const, valueId: biz.costCenter };
    const result = await report({ dimension });
    expect(input(result, "netRevenue")).toBe(2_000_000);
    expect(input(result, "tradeReceivables")).toBe(2_000_000);
    expect(result.dimension).toEqual(dimension);
    expect(result.warnings.join(" ")).toContain("بُعد");
    expect(result.checks.balanceSheetBalanced).toBeNull();

    // Independently, straight from the tagged lines.
    const taggedRevenue = await db.query<{ credit: string }>(
      `SELECT COALESCE(SUM(jl.credit), 0)::text AS credit
         FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.entry_id
        WHERE je.business_id = $1 AND jl.account_id = $2 AND jl.cost_center_id = $3
          AND je.entry_date BETWEEN $4 AND $5`,
      [biz.id, acct.revenue, biz.costCenter, FROM, TO],
    );
    expect(Number(taggedRevenue.rows[0].credit)).toBe(2_000_000);
  });
});

describe("no stored balance", () => {
  it("reflects a new posting on the next calculation", async () => {
    const before = await report();
    expect(ratio(before, "current_ratio").status).toBe("available");

    await post("2025-03-31", [
      { account: acct.payable, debit: 700_000 },
      { account: acct.cash, credit: 700_000 },
    ]);

    const after = await report();
    expect(input(after, "cashAndEquivalents")).toBe(8_000_000);
    expect(input(after, "currentLiabilities")).toBe(0);
    expect(ratio(after, "current_ratio").status).toBe("unavailable");
    expect(ratio(after, "current_ratio").reason).toBe("zero_denominator");
    expect(ratio(after, "current_ratio").display).toBeNull();
    expect(after.checks.balanceSheetBalanced).toBe(true);
  });
});
