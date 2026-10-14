/**
 * Accounting dimensions (issue #868) — the read side, against a real database.
 *
 * A small, known book is posted through the real manual-journal path, and every
 * report is checked against figures worked out by hand:
 *
 *   §1  the account × dimension matrix puts each line in exactly one column and
 *       reconciles to the account's own total;
 *   §2  the profit-centre P&L groups revenue and cost by centre, and its groups
 *       add up to the statement the business reads with no dimension;
 *   §3  the trial balance and the account card filter every figure to the same
 *       subset, and the cost-centre card's opening and movement still close;
 *   §4  the journal list filters by dimension, and several dimensions match one
 *       line together — never one line for one kind and another for the other.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import type { LineDimensions } from "../src/lib/accounting-dimensions";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let dims: typeof import("../src/lib/accounting-dimensions-service");
let manual: typeof import("../src/lib/manual-journal-service");
let reports: typeof import("../src/lib/accounting-dimension-reports-service");
let ledgerReports: typeof import("../src/lib/ledger-reports-service");
let statements: typeof import("../src/lib/reports-service");
let journal: typeof import("../src/lib/journal-service");
let journalFilters: typeof import("../src/lib/journal-filters");

const biz = { id: "" };
const user = { id: "" };
const acct: Record<string, string> = {};
const loc = { center: "" };
const val: Record<string, string> = {};

const FROM = "2026-10-01";
const TO = "2026-10-31";

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
  databaseName = `pos_dim_reports_${randomUUID().replaceAll("-", "")}`;
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
  dims = await import("../src/lib/accounting-dimensions-service");
  manual = await import("../src/lib/manual-journal-service");
  reports = await import("../src/lib/accounting-dimension-reports-service");
  ledgerReports = await import("../src/lib/ledger-reports-service");
  statements = await import("../src/lib/reports-service");
  journal = await import("../src/lib/journal-service");
  journalFilters = await import("../src/lib/journal-filters");

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
  await db.query("DELETE FROM journal_entry_draft_lines");
  await db.query("DELETE FROM journal_entry_drafts");
  await db.query("DELETE FROM journal_lines");
  await db.query("DELETE FROM journal_entries");
  await db.query("DELETE FROM accounting_dimension_values");
  await db.query("DELETE FROM accounting_dimension_settings");
  await db.query("DELETE FROM businesses");

  const row = await db.query<{ id: string }>("INSERT INTO businesses (name, slug) VALUES ('Reports Co', $1) RETURNING id", [
    `reports-${randomUUID().slice(0, 8)}`,
  ]);
  biz.id = row.rows[0].id;
  user.id = (
    await db.query<{ id: string }>(
      `INSERT INTO users (business_id, role, full_name, pin_hash) VALUES ($1, 'owner', 'Owner', 'x') RETURNING id`,
      [biz.id],
    )
  ).rows[0].id;

  const accounts = await db.query<{ id: string; code: string }>(
    `INSERT INTO accounts (business_id, code, name, type)
     VALUES ($1, '1100', 'Cash', 'asset'),
            ($1, '1500', 'Inventory', 'asset'),
            ($1, '5300', 'Rent', 'expense'),
            ($1, '5100', 'Cost of goods', 'expense'),
            ($1, '4300', 'Sales', 'revenue')
     RETURNING id, code`,
    [biz.id],
  );
  const byCode: Record<string, string> = { "1100": "cash", "1500": "inventory", "5300": "rent", "5100": "cogs", "4300": "sales" };
  for (const r of accounts.rows) acct[byCode[r.code]] = r.id;

  loc.center = (
    await db.query<{ id: string }>(
      `INSERT INTO locations (business_id, name, timezone, is_active) VALUES ($1, 'Center', 'Asia/Tehran', true) RETURNING id`,
      [biz.id],
    )
  ).rows[0].id;

  await dims.saveDimensionSettings(biz.id, user.id, [
    { kind: "cost_center", isEnabled: true },
    { kind: "profit_center", isEnabled: true },
  ]);
  val.ccHq = (await dims.createDimensionValue(biz.id, user.id, { kind: "cost_center", code: "CC-HQ", name: "Head office" })).id;
  val.ccSales = (await dims.createDimensionValue(biz.id, user.id, { kind: "cost_center", code: "CC-SALES", name: "Sales floor" })).id;
  val.pcOnline = (await dims.createDimensionValue(biz.id, user.id, { kind: "profit_center", code: "PC-ONLINE", name: "Online" })).id;
  val.pcDineIn = (await dims.createDimensionValue(biz.id, user.id, { kind: "profit_center", code: "PC-DINE", name: "Dine in" })).id;

  // The book, posted through the real manual-journal path.
  //  E1  10-01  Dr Rent 600k [CC-HQ]  Dr Rent 400k [—]        Cr Cash 1,000k
  //  E2  10-02  Dr Rent 300k [CC-SALES]                        Cr Cash 300k
  //  E3  10-03  Dr Cash 900k          Cr Sales 900k [PC-ONLINE]
  //  E4  10-03  Dr Cash 200k          Cr Sales 200k [PC-DINE]
  //  E5  10-04  Dr Cash 100k          Cr Sales 100k [—]
  //  E6  10-05  Dr COGS 350k [PC-ONLINE]                       Cr Inventory 350k
  await post("10-01", [
    { accountId: acct.rent, debit: 600_000, credit: 0, dimensions: { cost_center: val.ccHq } },
    { accountId: acct.rent, debit: 400_000, credit: 0 },
    { accountId: acct.cash, debit: 0, credit: 1_000_000 },
  ]);
  await post("10-02", [
    { accountId: acct.rent, debit: 300_000, credit: 0, dimensions: { cost_center: val.ccSales } },
    { accountId: acct.cash, debit: 0, credit: 300_000 },
  ]);
  await post("10-03", [
    { accountId: acct.cash, debit: 900_000, credit: 0 },
    { accountId: acct.sales, debit: 0, credit: 900_000, dimensions: { profit_center: val.pcOnline } },
  ]);
  await post("10-03", [
    { accountId: acct.cash, debit: 200_000, credit: 0 },
    { accountId: acct.sales, debit: 0, credit: 200_000, dimensions: { profit_center: val.pcDineIn } },
  ]);
  await post("10-04", [
    { accountId: acct.cash, debit: 100_000, credit: 0 },
    { accountId: acct.sales, debit: 0, credit: 100_000 },
  ]);
  await post("10-05", [
    { accountId: acct.cogs, debit: 350_000, credit: 0, dimensions: { profit_center: val.pcOnline } },
    { accountId: acct.inventory, debit: 0, credit: 350_000 },
  ]);
});

async function post(day: string, lines: { accountId: string; debit: number; credit: number; dimensions?: LineDimensions }[]) {
  const draft = await manual.createDraft({
    businessId: biz.id,
    locationId: loc.center,
    entryDate: `2026-${day}`,
    memo: `Book ${day}`,
    lines,
    createdBy: user.id,
  });
  return manual.approveDraft({ businessId: biz.id, locationId: loc.center, draftId: draft.id, actorId: user.id });
}

describe("§1 the account × dimension matrix", () => {
  it("puts every line in one column, and each account's columns add up to its own total", async () => {
    const matrix = await reports.getAccountDimensionMatrix(biz.id, { kind: "cost_center", dateFrom: FROM, dateTo: TO });
    expect(matrix.reconciled).toBe(true);
    const rent = matrix.rows.find((r) => r.code === "5300")!;
    expect(rent.cells[val.ccHq]).toBe(600_000);
    expect(rent.cells[val.ccSales]).toBe(300_000);
    expect(rent.cells.unassigned).toBe(400_000);
    expect(rent.total).toBe(1_300_000);

    // Cash: net debit. Receipts 1,200k, payments 1,300k, so the book is 100k short.
    const cash = matrix.rows.find((r) => r.code === "1100")!;
    expect(cash.total).toBe(-100_000);
    expect(cash.cells.unassigned).toBe(-100_000);
    expect(matrix.grandTotal).toBe(matrix.rows.reduce((sum, r) => sum + r.total, 0));
  });

  it("limits to one account type when asked, for expenses by cost centre", async () => {
    const matrix = await reports.getAccountDimensionMatrix(biz.id, {
      kind: "cost_center",
      dateFrom: FROM,
      dateTo: TO,
      accountType: "expense",
    });
    // Cost of goods is an expense account too; its line carries a profit centre,
    // not a cost centre, so it sits in the unassigned column here.
    expect(matrix.rows.map((r) => r.code)).toEqual(["5100", "5300"]);
    expect(matrix.rows.find((r) => r.code === "5100")!.cells.unassigned).toBe(350_000);
    expect(matrix.grandTotal).toBe(1_650_000);
    expect(matrix.reconciled).toBe(true);
  });

  it("rejects a scope that is not two real days in order", async () => {
    await expect(
      reports.getAccountDimensionMatrix(biz.id, { kind: "cost_center", dateFrom: "2026-10-31", dateTo: "2026-10-01" }),
    ).rejects.toThrow("invalid_dimension_report_scope");
  });
});

describe("§2 the profit-centre P&L", () => {
  it("groups revenue and cost by centre, and the groups add up to the unfiltered statement", async () => {
    const report = await reports.getProfitAndLossByDimension(biz.id, { kind: "profit_center", dateFrom: FROM, dateTo: TO });
    expect(report.reconciled).toBe(true);
    const online = report.groups.find((g) => g.valueId === val.pcOnline)!;
    const dine = report.groups.find((g) => g.valueId === val.pcDineIn)!;
    const unassigned = report.groups.find((g) => g.valueId === null)!;

    expect(online).toMatchObject({ revenue: 900_000, costOfSales: 350_000, grossProfit: 550_000 });
    expect(dine).toMatchObject({ revenue: 200_000, netIncome: 200_000 });
    expect(unassigned).toMatchObject({ revenue: 100_000, totalExpenses: 1_300_000, netIncome: -1_200_000 });

    expect(report.total).toMatchObject({ revenue: 1_200_000, totalExpenses: 1_650_000, netIncome: -450_000 });
    const statement = await ledgerReports.getTrialBalance(biz.id, { dateFrom: FROM, dateTo: TO });
    const revenueFromTrialBalance = statement.accounts.find((a) => a.code === "4300")!;
    expect(Math.abs(Number(revenueFromTrialBalance.periodCredit))).toBe(report.total.revenue);
  });
});

describe("§3 the trial balance and the cost-centre account card", () => {
  it("filters every figure to one value, and echoes the filter it used", async () => {
    const report = await ledgerReports.getTrialBalance(biz.id, {
      dateFrom: FROM,
      dateTo: TO,
      dimension: { kind: "cost_center", valueId: val.ccHq },
    });
    expect(report.dimension).toEqual({ kind: "cost_center", valueId: val.ccHq });
    const rent = report.accounts.find((a) => a.code === "5300")!;
    expect(rent.periodDebit).toBe("600000");
    const cash = report.accounts.find((a) => a.code === "1100")!;
    expect(cash.periodDebit).toBe("0");
    expect(cash.periodCredit).toBe("0");
  });

  it("the unassigned filter shows only the lines that carry no value", async () => {
    const report = await ledgerReports.getTrialBalance(biz.id, {
      dateFrom: FROM,
      dateTo: TO,
      dimension: { kind: "cost_center", valueId: "unassigned" },
    });
    expect(report.accounts.find((a) => a.code === "5300")!.periodDebit).toBe("400000");
    // Both cash payments carry no value (1,000k and 300k), so the unassigned
    // cash credit is their sum. The rent line of the second payment is the one
    // that carries CC-SALES, and it is not in this column.
    expect(report.accounts.find((a) => a.code === "1100")!.periodCredit).toBe("1300000");
  });

  it("without a filter the report is unchanged, and carries no dimension", async () => {
    const report = await ledgerReports.getTrialBalance(biz.id, { dateFrom: FROM, dateTo: TO });
    expect(report.dimension).toBeNull();
    expect(report.accounts.find((a) => a.code === "5300")!.periodDebit).toBe("1300000");
    expect(report.trialBalanceBalanced).toBe(true);
  });

  it("the cost-centre card closes: opening plus movement equals the closing balance", async () => {
    // Open the card from the day after the first posting, so the opening balance is real.
    const card = await statements.getAccountStatement(
      biz.id,
      acct.rent,
      { dateFrom: "2026-10-02", dateTo: TO },
      { kind: "cost_center", valueId: val.ccHq },
    );
    expect(card).not.toBeNull();
    expect(card!.openingBalance).toBe(600_000);
    expect(card!.lines).toEqual([]);
    expect(card!.closingBalance).toBe(600_000);

    const whole = await statements.getAccountStatement(biz.id, acct.rent, { dateFrom: FROM, dateTo: TO }, {
      kind: "cost_center",
      valueId: val.ccSales,
    });
    expect(whole!.lines.map((l) => l.debit)).toEqual([300_000]);
    expect(whole!.closingBalance).toBe(300_000);
  });
});

describe("§4 the journal filtered by dimension", () => {
  function filtersFor(query: string) {
    const result = journalFilters.parseJournalFilters(new URLSearchParams(query));
    if ("error" in result) throw new Error(result.error);
    return result.filters;
  }

  it("lists only the documents whose lines carry the chosen value, with the labels on the line", async () => {
    const page = await journal.listJournalEntries(biz.id, filtersFor(`costCenter=${val.ccSales}`));
    expect(page.entries).toHaveLength(1);
    const line = page.entries[0].lines.find((l) => l.accountCode === "5300")!;
    expect(line.dimensions).toEqual([
      { kind: "cost_center", valueId: val.ccSales, code: "CC-SALES", name: "Sales floor", isActive: true },
    ]);
  });

  it("matches several dimensions only where one line carries all of them", async () => {
    const together = await journal.listJournalEntries(
      biz.id,
      filtersFor(`costCenter=${val.ccHq}&profitCenter=${val.pcOnline}`),
    );
    expect(together.entries).toEqual([]);
    const onOneLine = await journal.listJournalEntries(biz.id, filtersFor(`profitCenter=${val.pcOnline}`));
    expect(onOneLine.entries).toHaveLength(2);
  });

  it("reports the filter as active, so the screen offers to clear it", () => {
    expect(journalFilters.hasJournalFilters(filtersFor(`costCenter=${val.ccHq}`))).toBe(true);
    expect(journalFilters.hasJournalFilters(filtersFor(""))).toBe(false);
  });

  it("refuses a dimension parameter that is not an id, rather than ignoring it", () => {
    const result = journalFilters.parseJournalFilters(new URLSearchParams("costCenter=HQ"));
    expect(result).toEqual({ error: "invalid_filter" });
  });
});
