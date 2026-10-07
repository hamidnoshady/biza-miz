/**
 * Phase 16 exit criteria: P&L/Balance Sheet/Cash Flow each get period
 * comparison and drill-down to the journal entries behind any figure. This
 * proves the DB-touching parts of reports-service.ts (not unit-tested per
 * repo convention) actually compute the right numbers against real posted
 * entries, not just that the pure date-shifting logic in reports.ts is right
 * (that's reports.test.ts's job).
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let reportsService: typeof import("../src/lib/reports-service");

const biz = { id: "" };
const acct = { cash: "", bankClearing: "", revenue: "", expense: "", cogs: "", salaries: "" };

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
  databaseName = `pos_finstatements_${randomUUID().replaceAll("-", "")}`;

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
  // journal_lines.account_id is ON DELETE RESTRICT (not CASCADE), so clear
  // the ledger explicitly before cascading the business away, rather than
  // relying on Postgres's cascade resolution order across the two paths
  // (businesses -> journal_entries -> journal_lines, and businesses -> accounts).
  await db.query("DELETE FROM journal_lines");
  await db.query("DELETE FROM journal_entries");
  await db.query("DELETE FROM businesses");

  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ('Statements Co', $1) RETURNING id",
    [`stmt-${randomUUID().slice(0, 8)}`],
  );
  biz.id = bizRow.rows[0].id;

  const accounts = await db.query<{ id: string; code: string }>(
    `INSERT INTO accounts (business_id, code, name, type)
     VALUES ($1, '1100', 'Cash', 'asset'), ($1, '1120', 'Card clearing', 'asset'),
            ($1, '4300', 'Sales', 'revenue'), ($1, '5900', 'Other expense', 'expense'),
            ($1, '5100', 'COGS', 'expense'), ($1, '5200', 'Salaries', 'expense')
     RETURNING id, code`,
    [biz.id],
  );
  for (const r of accounts.rows) {
    if (r.code === "1100") acct.cash = r.id;
    if (r.code === "1120") acct.bankClearing = r.id;
    if (r.code === "4300") acct.revenue = r.id;
    if (r.code === "5900") acct.expense = r.id;
    if (r.code === "5100") acct.cogs = r.id;
    if (r.code === "5200") acct.salaries = r.id;
  }
});

/** Posts a balanced two-line entry directly, mirroring what postJournalEntry does. */
async function postEntry(entryDate: string, sourceType: string, memo: string, debitAcct: string, creditAcct: string, amount: number) {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO journal_entries (business_id, entry_date, memo, source_type)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [biz.id, entryDate, memo, sourceType],
  );
  const entryId = rows[0].id;
  await db.query(
    `INSERT INTO journal_lines (entry_id, account_id, debit, credit) VALUES ($1, $2, $3, 0), ($1, $4, 0, $3)`,
    [entryId, debitAcct, amount, creditAcct],
  );
  return entryId;
}

describe("getCashFlow", () => {
  it("computes opening/closing cash and groups movements by source type", async () => {
    // Before the period: an order sale that establishes an opening balance.
    await postEntry("2025-03-15", "order", "opening sale", acct.cash, acct.revenue, 500_000);
    // Within the period.
    await postEntry("2025-04-05", "order", "in-period sale", acct.cash, acct.revenue, 300_000);
    await postEntry("2025-04-10", "manual", "cash withdrawal", acct.expense, acct.cash, 100_000);

    const cf = await reportsService.getCashFlow(biz.id, { dateFrom: "2025-04-01", dateTo: "2025-04-30" });

    expect(cf.openingCash).toBe(500_000);
    expect(cf.closingCash).toBe(700_000); // 500,000 + 300,000 - 100,000
    expect(cf.netChange).toBe(200_000);

    const bySource = Object.fromEntries(cf.lines.map((l) => [l.sourceType, l.amount]));
    expect(bySource.order).toBe(300_000);
    expect(bySource.manual).toBe(-100_000);
  });

  // Dashboard audit F02/F10: card money on its way from the PSP is not cash.
  // A card sale moves it into clearing (disclosed, not counted); the cash flow
  // happens when the settlement reaches the drawer/bank, as an operating inflow.
  it("discloses card clearing separately and counts the settlement as the cash inflow", async () => {
    await postEntry("2025-04-01", "order", "card sale", acct.bankClearing, acct.revenue, 150_000);
    const beforeSettlement = await reportsService.getCashFlow(biz.id, { dateFrom: "2025-04-01", dateTo: "2025-04-30" });
    expect(beforeSettlement.closingCash).toBe(0);
    expect(beforeSettlement.clearingChange).toBe(150_000);

    await postEntry("2025-04-03", "manual", "PSP settlement", acct.cash, acct.bankClearing, 150_000);
    const cf = await reportsService.getCashFlow(biz.id, { dateFrom: "2025-04-01", dateTo: "2025-04-30" });
    expect(cf.closingCash).toBe(150_000);
    expect(cf.clearingChange).toBe(0);
    expect(cf.activities.operating).toBe(150_000);
  });

  it("classifies cash movements by activity from the counter-account", async () => {
    const extra = await db.query<{ id: string; code: string }>(
      `INSERT INTO accounts (business_id, code, name, type)
       VALUES ($1, '1510', 'Equipment', 'asset'), ($1, '3100', 'Owner capital', 'equity'), ($1, '1131', 'Petty cash B', 'asset')
       RETURNING id, code`,
      [biz.id],
    );
    const id = (code: string) => extra.rows.find((r) => r.code === code)!.id;
    await postEntry("2025-05-02", "manual", "owner injects capital", acct.cash, id("3100"), 1_000_000);
    await postEntry("2025-05-03", "manual", "buy an oven", id("1510"), acct.cash, 400_000);
    await postEntry("2025-05-04", "manual", "fund petty cash", id("1131"), acct.cash, 50_000);
    await postEntry("2025-05-05", "order", "cash sale", acct.cash, acct.revenue, 80_000);

    const cf = await reportsService.getCashFlow(biz.id, { dateFrom: "2025-05-01", dateTo: "2025-05-31" });
    expect(cf.activities).toEqual({ operating: 80_000, investing: -400_000, financing: 1_000_000 });
    // Funding petty cash is a transfer between two cash accounts — no flow.
    expect(cf.netChange).toBe(680_000);
    expect(cf.lines.every((l) => !/[A-Za-z_]/.test(l.label))).toBe(true);
  });
});

describe("getProfitAndLoss", () => {
  it("splits cost of sales and labor out of expenses for gross profit and prime cost", async () => {
    await postEntry("2025-04-01", "order", "sale", acct.cash, acct.revenue, 1_000_000);
    await postEntry("2025-04-02", "order", "cogs", acct.cogs, acct.cash, 300_000);
    await postEntry("2025-04-03", "manual", "payroll", acct.salaries, acct.cash, 200_000);
    await postEntry("2025-04-04", "manual", "rent", acct.expense, acct.cash, 100_000);

    const pnl = await reportsService.getProfitAndLoss(biz.id, { dateFrom: "2025-04-01", dateTo: "2025-04-30" });

    expect(pnl.totalRevenue).toBe(1_000_000);
    expect(pnl.costOfSales).toBe(300_000);
    expect(pnl.grossProfit).toBe(700_000);
    expect(pnl.laborCost).toBe(200_000);
    expect(pnl.primeCost).toBe(500_000);
    expect(pnl.operatingExpenses).toBe(100_000);
    expect(pnl.totalExpenses).toBe(600_000);
    expect(pnl.netIncome).toBe(400_000);
  });
});

describe("getProfitAndLossComparison", () => {
  it("computes the previous period as the same-length range immediately before", async () => {
    await postEntry("2025-03-10", "order", "march sale", acct.cash, acct.revenue, 400_000);
    await postEntry("2025-04-10", "order", "april sale", acct.cash, acct.revenue, 600_000);

    const cmp = await reportsService.getProfitAndLossComparison(biz.id, {
      dateFrom: "2025-04-01",
      dateTo: "2025-04-30",
    });

    expect(cmp.current.totalRevenue).toBe(600_000);
    expect(cmp.previous).not.toBeNull();
    expect(cmp.previous!.totalRevenue).toBe(400_000);
  });

  it("returns null previous for an open-ended range", async () => {
    const cmp = await reportsService.getProfitAndLossComparison(biz.id, { dateTo: "2025-04-30" });
    expect(cmp.previous).toBeNull();
  });
});

describe("getAccountDrillDown", () => {
  it("returns exactly the journal lines posted to that account in range", async () => {
    const e1 = await postEntry("2025-04-05", "order", "sale one", acct.cash, acct.revenue, 100_000);
    const e2 = await postEntry("2025-04-06", "order", "sale two", acct.cash, acct.revenue, 200_000);
    await postEntry("2025-03-01", "order", "outside range", acct.cash, acct.revenue, 999_000);

    const page = await reportsService.getAccountDrillDown(biz.id, "4300", {
      dateFrom: "2025-04-01",
      dateTo: "2025-04-30",
    });
    const lines = page.lines;

    expect(lines).toHaveLength(2);
    expect(page.hasMore).toBe(false);
    const entryIds = lines.map((l) => l.entryId).sort();
    expect(entryIds).toEqual([e1, e2].sort());
    expect(lines.every((l) => BigInt(l.credit) > 0n && l.debit === "0")).toBe(true);
    // The window totals are what a report figure reconciles against.
    expect(page.totals.credit).toBe("300000");
    expect(page.totals.debit).toBe("0");
  });
});

describe("getAccountStatement", () => {
  it("returns null for an account that doesn't belong to this business", async () => {
    expect(await reportsService.getAccountStatement(biz.id, randomUUID())).toBeNull();
  });

  it("computes a running balance for a credit-normal (revenue) account, chronologically", async () => {
    await postEntry("2025-04-05", "order", "sale one", acct.cash, acct.revenue, 100_000);
    await postEntry("2025-04-03", "order", "sale two", acct.cash, acct.revenue, 40_000);

    const statement = await reportsService.getAccountStatement(biz.id, acct.revenue);
    expect(statement).not.toBeNull();
    expect(statement!.normalBalance).toBe("credit");
    expect(statement!.openingBalance).toBe(0);
    // Oldest first, regardless of insertion order.
    expect(statement!.lines.map((l) => l.date)).toEqual(["2025-04-03", "2025-04-05"]);
    expect(statement!.lines.map((l) => l.balance)).toEqual([40_000, 140_000]);
    expect(statement!.closingBalance).toBe(140_000);
  });

  it("computes a running balance for a debit-normal (expense) account", async () => {
    await postEntry("2025-04-01", "manual", "rent", acct.expense, acct.cash, 50_000);
    await postEntry("2025-04-10", "manual", "utilities", acct.expense, acct.cash, 20_000);

    const statement = await reportsService.getAccountStatement(biz.id, acct.expense);
    expect(statement!.normalBalance).toBe("debit");
    expect(statement!.lines.map((l) => l.balance)).toEqual([50_000, 70_000]);
    expect(statement!.closingBalance).toBe(70_000);
  });

  it("carries movement before dateFrom into openingBalance, and only lists lines within range", async () => {
    await postEntry("2025-03-01", "order", "before range", acct.cash, acct.revenue, 500_000);
    const e2 = await postEntry("2025-04-05", "order", "in range", acct.cash, acct.revenue, 100_000);
    await postEntry("2025-05-01", "order", "after range", acct.cash, acct.revenue, 900_000);

    const statement = await reportsService.getAccountStatement(biz.id, acct.revenue, {
      dateFrom: "2025-04-01",
      dateTo: "2025-04-30",
    });
    expect(statement!.openingBalance).toBe(500_000);
    expect(statement!.lines).toHaveLength(1);
    expect(statement!.lines[0].entryId).toBe(e2);
    expect(statement!.lines[0].balance).toBe(600_000);
    expect(statement!.closingBalance).toBe(600_000);
  });

  it("an account with no postings has a zero opening and closing balance and no lines", async () => {
    const statement = await reportsService.getAccountStatement(biz.id, acct.salaries);
    expect(statement!.openingBalance).toBe(0);
    expect(statement!.lines).toEqual([]);
    expect(statement!.closingBalance).toBe(0);
  });
});

/**
 * `COST_OF_SALES_CODES` used to be one flat list naming only F&B's codes, and
 * `getProfitAndLoss` filtered against it for every business. A jeweller's COGS
 * (5110) therefore fell into operating expense and their gross profit came out
 * equal to total revenue — the report was not wrong by a little, it was reporting
 * a shop with no cost of goods at all.
 */
describe("getProfitAndLoss for a business that is not a café", () => {
  it("counts the jewellery shop's own cost of goods sold", async () => {
    const bizRow = await db.query<{ id: string }>(
      "INSERT INTO businesses (name, slug, industry) VALUES ('Gold Co', $1, 'jewelry') RETURNING id",
      [`gold-${randomUUID().slice(0, 8)}`],
    );
    const jeweller = bizRow.rows[0].id;
    const accounts = await db.query<{ id: string; code: string }>(
      `INSERT INTO accounts (business_id, code, name, type)
       VALUES ($1, '1100', 'Cash', 'asset'), ($1, '4500', 'Gold sales', 'revenue'),
              ($1, '5110', 'Gold COGS', 'expense'), ($1, '5300', 'Rent', 'expense')
       RETURNING id, code`,
      [jeweller],
    );
    const byCode = Object.fromEntries(accounts.rows.map((r) => [r.code, r.id]));

    const entry = await db.query<{ id: string }>(
      `INSERT INTO journal_entries (business_id, entry_date, memo, source_type)
       VALUES ($1, '2025-04-01', 'sale', 'manual') RETURNING id`,
      [jeweller],
    );
    await db.query(
      `INSERT INTO journal_lines (entry_id, account_id, debit, credit) VALUES
         ($1, $2, 1000000, 0), ($1, $3, 0, 1000000),
         ($1, $4, 600000, 0), ($1, $2, 0, 600000),
         ($1, $5, 100000, 0), ($1, $2, 0, 100000)`,
      [entry.rows[0].id, byCode["1100"], byCode["4500"], byCode["5110"], byCode["5300"]],
    );

    const pnl = await reportsService.getProfitAndLoss(jeweller, {
      dateFrom: "2025-04-01",
      dateTo: "2025-04-30",
    });
    expect(pnl.totalRevenue).toBe(1_000_000);
    expect(pnl.costOfSales).toBe(600_000);
    expect(pnl.grossProfit).toBe(400_000);
    expect(pnl.operatingExpenses).toBe(100_000);
  });
});

describe("getBalanceSheet's جاری/غیرجاری split", () => {
  it("puts fixed assets and borrowings on the non-current side and everything else on the current one", async () => {
    const accounts = await db.query<{ id: string; code: string }>(
      `INSERT INTO accounts (business_id, code, name, type)
       VALUES ($1, '1500', 'Equipment', 'asset'), ($1, '2100', 'AP', 'liability'),
              ($1, '2500', 'Borrowings', 'liability')
       RETURNING id, code`,
      [biz.id],
    );
    const byCode = Object.fromEntries(accounts.rows.map((r) => [r.code, r.id]));

    // Cash 400 + equipment 600, funded by AP 200, borrowings 800.
    const entry = await db.query<{ id: string }>(
      `INSERT INTO journal_entries (business_id, entry_date, memo, source_type)
       VALUES ($1, '2025-04-01', 'opening', 'manual') RETURNING id`,
      [biz.id],
    );
    await db.query(
      `INSERT INTO journal_lines (entry_id, account_id, debit, credit) VALUES
         ($1, $2, 400000, 0), ($1, $3, 600000, 0),
         ($1, $4, 0, 200000), ($1, $5, 0, 800000)`,
      [entry.rows[0].id, acct.cash, byCode["1500"], byCode["2100"], byCode["2500"]],
    );

    const sheet = await reportsService.getBalanceSheet(biz.id, "2025-04-30");
    expect(sheet.nonCurrentAssets).toBe(600_000);
    expect(sheet.currentAssets).toBe(400_000);
    expect(sheet.nonCurrentLiabilities).toBe(800_000);
    expect(sheet.currentLiabilities).toBe(200_000);
    // The split partitions rather than filters: nothing is counted twice, and
    // nothing goes missing.
    expect(sheet.currentAssets + sheet.nonCurrentAssets).toBe(sheet.totalAssets);
    expect(sheet.currentLiabilities + sheet.nonCurrentLiabilities).toBe(sheet.totalLiabilities);
    expect(sheet.balanced).toBe(true);
  });
});
