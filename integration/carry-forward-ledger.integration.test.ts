/**
 * ESH-165 / GH #1334 — a fiscal-year carry-forward must never double-count.
 *
 * The ledger model under test (the one documented in
 * docs/architecture/ledger-model.md): the books are **continuous**. A
 * carry-forward set posts an ordinary, numbered, reversible journal entry at
 * the new year's first day, but that entry is a *documentary snapshot* of
 * balances the ledger already carries — it is excluded from every balance
 * read. History is never rewritten, so:
 *
 *   • a known permanent balance (here: 100,000,000 Rial of cash at the end of
 *     1404) appears **exactly once** in the next year's opening, movement and
 *     closing figures — the snapshot is not movement, not closing, not a
 *     second opening;
 *   • opening + current-year movement = closing, digit for digit, in Rial;
 *   • the prior year's as-of reports stay correct after the next year's
 *     opening is posted;
 *   • the *next* transition (1405 → 1406) does not compound: the snapshot of
 *     1405 is not read as history;
 *   • what is NOT a carry-forward stays counted — a manual initial-opening
 *     set and the setup wizard's own `source_type = 'opening'` entry are
 *     real ledger history and are never excluded;
 *   • the snapshot itself stays a first-class *document*: numbered
 *     (OP-1405-000001), listed in the journal, counted by whole-ledger
 *     integrity, and controllably reversible.
 *
 * Run before the fix, the assertions below fail on the doubled figures
 * (cash closing 200,000,000 instead of 100,000,000, a phantom financing
 * inflow in the cash-flow statement, an unattributed A/R residual equal to
 * the snapshot, …) — that failure is the reproduction this issue demanded.
 *
 * Retry, reversal, permission-matrix, fiscal-lock and tenant/RLS behaviour
 * of the opening set itself are pinned by
 * integration/opening-balances.integration.test.ts and
 * src/app/api/ledger/issue-867-permission-matrix.test.ts; this file pins the
 * *reporting* semantics across the transition.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import {
  setAuthorizationSnapshot,
  withAuthorizationContext,
} from "../src/lib/authorization-context";
import { UNKNOWN_CUSTOMER_KEY } from "../src/lib/aging";
import { parseJournalFilters } from "../src/lib/journal-filters";
import { BUSINESS_WIDE_SCOPE, branchScope } from "../src/lib/report-scope";
import { filterTrialBalanceRows } from "../src/lib/trial-balance";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let ledgerService: typeof import("../src/lib/ledger-service");
let openingService: typeof import("../src/lib/opening-balances-service");
let fiscalService: typeof import("../src/lib/fiscal-periods-service");
let closingService: typeof import("../src/lib/closing-service");
let ledgerReports: typeof import("../src/lib/ledger-reports-service");
let reportsService: typeof import("../src/lib/reports-service");
let arService: typeof import("../src/lib/ar-service");
let apService: typeof import("../src/lib/ap-service");
let dimReports: typeof import("../src/lib/accounting-dimension-reports-service");
let finAccounts: typeof import("../src/lib/financial-accounts-service");
let journalService: typeof import("../src/lib/journal-service");

const biz = { id: "", locationId: "" };
const user = { id: "" };
const acct: Record<string, string> = {};
const party = { customerOne: "", customerTwo: "", supplierOne: "" };
const supplier = { one: "" };
const years: Record<string, string> = {};

/** 1404 runs 2025-03-21 → 2026-03-20; 1405 runs 2026-03-21 → 2027-03-20; 1406 follows. */
const D = {
  inside1404: "2025-06-15",
  later1404: "2025-11-01",
  end1404: "2026-03-20",
  start1405: "2026-03-21",
  mid1405: "2026-09-01",
  sale1405: "2026-06-01",
  end1405: "2027-03-20",
  start1406: "2027-03-21",
  mid1406: "2027-06-01",
};

/** The known permanent balance the whole issue is about. */
const CASH_1404 = 100_000_000;

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

/**
 * Run `fn` as the test's owner — the fiscal-period lock trigger only lets a
 * soft-close/closing session's own postings through (migration 0216), exactly
 * like the real /close route's request.
 */
async function asOwner<T>(fn: () => Promise<T>): Promise<T> {
  return withAuthorizationContext(async () => {
    setAuthorizationSnapshotForTest();
    return dbLib.withTenant(biz.id, fn, { userId: user.id });
  });
}

function setAuthorizationSnapshotForTest() {
  setAuthorizationSnapshot({
    businessId: biz.id,
    userId: user.id,
    membershipActive: true,
    businessActive: true,
    canCloseFiscalPeriod: true,
  });
}

beforeAll(async () => {
  databaseName = `pos_cf_ledger_${randomUUID().replaceAll("-", "")}`;

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
  ledgerService = await import("../src/lib/ledger-service");
  openingService = await import("../src/lib/opening-balances-service");
  fiscalService = await import("../src/lib/fiscal-periods-service");
  closingService = await import("../src/lib/closing-service");
  ledgerReports = await import("../src/lib/ledger-reports-service");
  reportsService = await import("../src/lib/reports-service");
  arService = await import("../src/lib/ar-service");
  apService = await import("../src/lib/ap-service");
  dimReports = await import("../src/lib/accounting-dimension-reports-service");
  finAccounts = await import("../src/lib/financial-accounts-service");
  journalService = await import("../src/lib/journal-service");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
}, 180_000);

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
  // A fresh scratch database per file: TRUNCATE CASCADE reaches every child
  // table without hand-ordering twenty FKs.
  await db.query(`TRUNCATE
    opening_balance_lines, opening_balance_sets, voucher_renumber_log, voucher_sequences,
    summary_voucher_sources, summary_vouchers,
    fixed_asset_depreciation_entries, fixed_assets, cheques, orders, purchases,
    journal_lines, journal_entries, fiscal_periods, fiscal_years,
    suppliers, parties, accounts, users, locations, businesses
    CASCADE`);

  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ('CF Ledger Co', $1) RETURNING id",
    [`cf-${randomUUID().slice(0, 8)}`],
  );
  biz.id = bizRow.rows[0].id;

  const locRow = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [biz.id],
  );
  biz.locationId = locRow.rows[0].id;

  const userRow = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, pin_hash) VALUES ($1, 'owner', 'Owner', 'x') RETURNING id`,
    [biz.id],
  );
  user.id = userRow.rows[0].id;

  const accounts = await db.query<{ id: string; code: string }>(
    `INSERT INTO accounts (business_id, code, name, type)
     VALUES ($1, '1100', 'Cash', 'asset'),
            ($1, '1200', 'Accounts Receivable', 'asset'),
            ($1, '1300', 'Inventory', 'asset'),
            ($1, '2100', 'Accounts Payable', 'liability'),
            ($1, '3800', 'Retained earnings', 'equity'),
            ($1, '3900', 'Opening equity', 'equity'),
            ($1, '7000', 'Sales', 'revenue'),
            ($1, '8000', 'Expenses', 'expense')
     RETURNING id, code`,
    [biz.id],
  );
  for (const r of accounts.rows) acct[r.code] = r.id;

  const parties = await db.query<{ id: string; role: string }>(
    `INSERT INTO parties (business_id, name, role)
     VALUES ($1, 'مشتری یک', 'customer'), ($1, 'مشتری دو', 'customer'), ($1, 'تأمین‌کننده الف', 'supplier')
     RETURNING id, role`,
    [biz.id],
  );
  party.customerOne = parties.rows[0].id;
  party.customerTwo = parties.rows[1].id;
  party.supplierOne = parties.rows[2].id;

  const supplierRow = await db.query<{ id: string }>(
    "INSERT INTO suppliers (location_id, name, party_id) VALUES ($1, 'تأمین‌کننده الف', $2) RETURNING id",
    [biz.locationId, party.supplierOne],
  );
  supplier.one = supplierRow.rows[0].id;

  for (const jy of [1404, 1405, 1406]) {
    years[String(jy)] = (await fiscalService.createFiscalYear(biz.id, jy)).id;
  }
});

/** One ordinary posting through the real path (the one every document uses). */
async function postEntry(
  entryDate: string,
  sourceType: string,
  sourceId: string | null,
  memo: string,
  lines: { accountId: string; debit: number; credit: number }[],
): Promise<string> {
  const client = await dbLib.getPool().connect();
  try {
    await client.query("BEGIN");
    const entryId = await ledgerService.postJournalEntry(client, {
      businessId: biz.id,
      locationId: biz.locationId,
      entryDate,
      memo,
      sourceType,
      sourceId,
      createdBy: user.id,
      lines,
    });
    await client.query("COMMIT");
    return entryId as string;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

const rowFor = (report: Awaited<ReturnType<typeof ledgerReports.getTrialBalance>>, code: string) =>
  report.accounts.find((row) => row.code === code)!;

/** A balanced two-line shape against cash and opening equity. */
function cashEquityLines(amount: number) {
  return [
    { accountId: acct["1100"], debit: amount, credit: 0 },
    { accountId: acct["3900"], debit: 0, credit: amount },
  ];
}

/** Soft-close every period of `label`, then close the year for real. */
async function closeYear(label: "1404" | "1405") {
  const periods = await fiscalService.listPeriods(biz.id, years[label]);
  expect(periods).toHaveLength(12);
  for (const period of periods) {
    await fiscalService.setPeriodStatus(biz.id, period.id, "soft_closed", user.id);
  }
  return asOwner(() => closingService.closeFiscalYear(biz.id, years[label], user.id));
}

/**
 * A closed 1404 whose *known* permanent balance is exactly 100,000,000 Rial
 * of cash — the figure every assertion below proves appears exactly once:
 *
 *   capital injected        Dr 1100 105,000,000 / Cr 3900
 *   credit sale C1 (order)  Dr 1200   5,000,000 / Cr 7000
 *   credit sale C2 (order)  Dr 1200   3,000,000 / Cr 7000
 *   credit purchase         Dr 1300   2,000,000 / Cr 2100
 *   cash expense            Dr  8000  5,000,000 / Cr 1100
 *   → cash 100,000,000 · A/R 8,000,000 · inventory 2,000,000 ·
 *     A/P 2,000,000 · equity 105,000,000 · net income 3,000,000
 *
 * Soft-closes every period and closes the year (P&L → retained earnings).
 */
async function seedAndClose1404(): Promise<void> {
  await postEntry(D.inside1404, "manual", null, "سرمایه اولیه", [
    { accountId: acct["1100"], debit: 105_000_000, credit: 0 },
    { accountId: acct["3900"], debit: 0, credit: 105_000_000 },
  ]);
  const orderOne = await db.query<{ id: string }>(
    `INSERT INTO orders (location_id, order_number, status, customer_id, total, opened_at, closed_at)
     VALUES ($1, 1, 'completed', $2, 5000000, $3, $3) RETURNING id`,
    [biz.locationId, party.customerOne, D.inside1404],
  );
  await postEntry(D.inside1404, "order", orderOne.rows[0].id, "فروش نسیه", [
    { accountId: acct["1200"], debit: 5_000_000, credit: 0 },
    { accountId: acct["7000"], debit: 0, credit: 5_000_000 },
  ]);
  const orderTwo = await db.query<{ id: string }>(
    `INSERT INTO orders (location_id, order_number, status, customer_id, total, opened_at, closed_at)
     VALUES ($1, 2, 'completed', $2, 3000000, $3, $3) RETURNING id`,
    [biz.locationId, party.customerTwo, D.inside1404],
  );
  await postEntry(D.inside1404, "order", orderTwo.rows[0].id, "فروش نسیه", [
    { accountId: acct["1200"], debit: 3_000_000, credit: 0 },
    { accountId: acct["7000"], debit: 0, credit: 3_000_000 },
  ]);
  const purchase = await db.query<{ id: string }>(
    `INSERT INTO purchases (location_id, supplier_id, status, total, settlement_method, note, received_at)
     VALUES ($1, $2, 'received', 2000000, 'credit', 'خرید', $3) RETURNING id`,
    [biz.locationId, supplier.one, D.inside1404],
  );
  await postEntry(D.inside1404, "purchase", purchase.rows[0].id, "خرید نسیه", [
    { accountId: acct["1300"], debit: 2_000_000, credit: 0 },
    { accountId: acct["2100"], debit: 0, credit: 2_000_000 },
  ]);
  await postEntry(D.inside1404, "manual", null, "هزینه نقد", [
    { accountId: acct["8000"], debit: 5_000_000, credit: 0 },
    { accountId: acct["1100"], debit: 0, credit: 5_000_000 },
  ]);

  const close = await closeYear("1404");
  expect(close.netIncome).toBe("3000000");
  expect(close.closingEntryId).toBeTruthy();
}

interface PostedCarryForward {
  setId: string;
  entryId: string;
  voucherNumber: string | null;
  lines: NonNullable<Awaited<ReturnType<typeof openingService.getOpeningSet>>>["lines"];
}

/** generate → submit → approve → post, the ordinary reviewed path. */
async function generateAndPostCarryForward(from: "1404" | "1405", to: "1405" | "1406"): Promise<PostedCarryForward> {
  const generated = await openingService.generateCarryForward({
    businessId: biz.id,
    fromYearId: years[from],
    toYearId: years[to],
    actorId: user.id,
  });
  expect(generated.balanced).toBe(true);
  expect(generated.notes).toEqual([]); // every register agreed with the GL

  const detail = await openingService.getOpeningSet(biz.id, generated.setId);
  expect(detail?.set).toMatchObject({
    fiscalYearLabel: to,
    source: "carry_forward",
    status: "draft",
    carryForwardFromYearId: years[from],
  });

  await openingService.submitOpeningSet({ businessId: biz.id, setId: generated.setId, actorId: user.id });
  const approveCheck = await openingService.approveOpeningSet({
    businessId: biz.id,
    setId: generated.setId,
    actorId: user.id,
  });
  expect(approveCheck?.matched).toBe(true);
  const { entryId, voucherNumber } = await openingService.postOpeningSet({
    businessId: biz.id,
    setId: generated.setId,
    actorId: user.id,
  });
  expect(voucherNumber).toBe(`OP-${to}-000001`);
  return { setId: generated.setId, entryId, voucherNumber, lines: detail?.lines ?? [] };
}

// ---------------------------------------------------------------------------
// The reproduction: one known balance, counted once everywhere
// ---------------------------------------------------------------------------

describe("a posted carry-forward is a snapshot of the ledger, not new history", () => {
  it("counts the 100,000,000 Rial cash balance exactly once across every new-year read", async () => {
    await seedAndClose1404();

    // Ground truth, straight from the ledger: before any snapshot, 1404's
    // history leaves cash at exactly the known permanent balance.
    const { rows: history } = await db.query<{ net: string }>(
      `SELECT COALESCE(SUM(jl.debit - jl.credit), 0)::text AS net
         FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.entry_id
        WHERE je.business_id = $1 AND jl.account_id = $2 AND je.entry_date < $3`,
      [biz.id, acct["1100"], D.start1405],
    );
    expect(history[0].net).toBe(String(CASH_1404));

    const { setId, entryId } = await generateAndPostCarryForward("1404", "1405");

    // The snapshot itself: one ordinary numbered entry on the year's first day.
    const { rows: entryRows } = await db.query<{ entry_date: string; source_type: string; voucher_number: string }>(
      "SELECT entry_date::text AS entry_date, source_type, voucher_number FROM journal_entries WHERE id = $1",
      [entryId],
    );
    expect(entryRows[0]).toMatchObject({
      entry_date: D.start1405,
      source_type: "opening",
      voucher_number: "OP-1405-000001",
    });

    // ── Detailed trial balance for the new year ────────────────────────────
    // History lands in the opening column (dated before dateFrom); the
    // snapshot lands on dateFrom itself and must contribute to *nothing* —
    // it is not movement and not closing.
    const tb = await ledgerReports.getTrialBalance(biz.id, {
      dateFrom: D.start1405,
      dateTo: D.end1405,
    });
    const cash = rowFor(tb, "1100");
    expect(cash.openingDebit).toBe(String(CASH_1404));
    expect(cash.periodDebit, "the carry-forward must not count as current-year movement").toBe("0");
    expect(cash.periodCredit).toBe("0");
    expect(cash.closingDebit, "the carried balance must appear exactly once in the closing column").toBe(
      String(CASH_1404),
    );
    // opening + movement = closing, in exact Rial.
    const net = (r: typeof cash) =>
      BigInt(r.openingDebit) - BigInt(r.openingCredit) + BigInt(r.periodDebit) - BigInt(r.periodCredit);
    expect(net(cash)).toBe(BigInt(cash.closingDebit) - BigInt(cash.closingCredit));

    const ar = rowFor(tb, "1200");
    expect(ar.openingDebit).toBe("8000000");
    expect(ar.periodDebit).toBe("0");
    expect(ar.closingDebit).toBe("8000000");
    const ap = rowFor(tb, "2100");
    expect(ap.openingCredit).toBe("2000000");
    expect(ap.closingCredit).toBe("2000000");
    const capital = rowFor(tb, "3900");
    expect(capital.openingCredit).toBe("105000000");
    expect(capital.periodCredit).toBe("0");
    expect(capital.closingCredit).toBe("105000000");
    expect(rowFor(tb, "3800").closingCredit).toBe("3000000");
    // Temporary accounts closed to retained earnings in 1404: zero here.
    expect(rowFor(tb, "7000").closingDebit).toBe("0");
    expect(rowFor(tb, "7000").closingCredit).toBe("0");
    expect(rowFor(tb, "8000").closingDebit).toBe("0");

    expect(tb.totals.openingDebit).toBe("110000000");
    expect(tb.totals.openingCredit).toBe("110000000");
    expect(tb.totals.closingDebit).toBe("110000000");
    expect(tb.totals.closingCredit).toBe("110000000");
    expect(tb.trialBalanceBalanced).toBe(true);
    // The snapshot is still a document: whole-ledger integrity and the
    // activity window count it, the balance columns do not.
    expect(tb.integrity.entryCount).toBe(7); // capital, 2 orders, purchase, expense, year close, snapshot
    expect(tb.activity.entryCount).toBe(7);

    // ── As-of (closing-only) trial balance mid-1405 ───────────────────────
    const asOf = await ledgerReports.getTrialBalance(biz.id, { asOf: D.mid1405 });
    expect(rowFor(asOf, "1100").closingDebit, "as-of closing must count history once").toBe(String(CASH_1404));
    expect(rowFor(asOf, "1200").closingDebit).toBe("8000000");
    expect(asOf.totals.closingDebit).toBe("110000000");
    expect(asOf.totals.closingCredit).toBe("110000000");

    // ── Account statement + drill-down for cash in 1405 ───────────────────
    const statement = await reportsService.getAccountStatement(biz.id, acct["1100"], {
      dateFrom: D.start1405,
      dateTo: D.end1405,
    });
    expect(statement).not.toBeNull();
    expect(statement!.openingBalance).toBe(CASH_1404);
    expect(statement!.lines, "the snapshot is not an account movement").toHaveLength(0);
    expect(statement!.closingBalance).toBe(CASH_1404);

    const drill = await reportsService.getAccountDrillDown(biz.id, "1100", {
      dateFrom: D.start1405,
      dateTo: D.end1405,
    });
    expect(drill.totalLines).toBe(0);
    expect(drill.totals.debit).toBe("0");
    expect(drill.totals.credit).toBe("0");
    expect(drill.totals.signedBalance).toBe("0");

    // ── Balance sheet as of mid-1405 ──────────────────────────────────────
    const sheet = await reportsService.getBalanceSheet(biz.id, D.mid1405, BUSINESS_WIDE_SCOPE);
    expect(sheet.balanced).toBe(true);
    const cashLine = sheet.assets.find((l) => l.accountCode === "1100");
    expect(cashLine?.amount, "balance-sheet cash must be counted once").toBe(CASH_1404);
    expect(sheet.totalAssets).toBe(110_000_000); // 100M cash + 8M A/R + 2M inventory
    expect(sheet.totalLiabilities).toBe(2_000_000);
    expect(sheet.totalEquity).toBe(108_000_000); // 105M capital + 3M retained earnings
    expect(sheet.retainedEarnings).toBe(0); // P&L closed into 3800 in 1404
    // A branch-scoped read of the same ledger agrees with the business-wide one.
    const branchSheet = await reportsService.getBalanceSheet(biz.id, D.mid1405, branchScope(biz.locationId));
    expect(branchSheet.assets.find((l) => l.accountCode === "1100")?.amount).toBe(CASH_1404);

    // ── A/R subledger + reconciliation + aging ────────────────────────────
    const customers = await arService.listCustomerBalances(biz.id);
    expect(customers, "only the attributed customers — no snapshot residual").toHaveLength(2);
    expect(customers.find((c) => c.customerId === party.customerOne)?.balance).toBe(5_000_000);
    expect(customers.find((c) => c.customerId === party.customerTwo)?.balance).toBe(3_000_000);
    expect(customers.some((c) => c.customerId === UNKNOWN_CUSTOMER_KEY)).toBe(false);

    const arRecon = await arService.getArReconciliationSummary(biz.id);
    expect(arRecon.controlBalance).toBe(8_000_000);
    expect(arRecon.netTotal).toBe(8_000_000);
    expect(arRecon.unattributedBalance).toBe(0);
    expect(arRecon.reconciles).toBe(true);
    expect(arRecon.difference).toBe(0);

    const arAging = await arService.getArAging(biz.id, D.mid1405);
    expect(arAging.totals.total).toBe(8_000_000);
    expect(arAging.rows).toHaveLength(2);

    // ── A/P subledger + aging ─────────────────────────────────────────────
    const suppliers = await apService.listSupplierBalances(biz.id);
    expect(suppliers, "only the attributed supplier — no snapshot residual").toHaveLength(1);
    expect(suppliers[0].supplierId).toBe(supplier.one);
    expect(suppliers[0].balance).toBe(2_000_000);
    const apAging = await apService.getApAging(biz.id, D.mid1405);
    expect(apAging.totals.total).toBe(2_000_000);
    expect(apAging.rows).toHaveLength(1);

    // ── Cash-flow statement for the new year ──────────────────────────────
    // No real cash moved in 1405: the snapshot must not appear as a phantom
    // financing inflow, and closing cash stays at the carried balance.
    const cashFlow = await reportsService.getCashFlow(
      biz.id,
      { dateFrom: D.start1405, dateTo: D.end1405 },
      BUSINESS_WIDE_SCOPE,
    );
    expect(cashFlow.openingCash).toBe(CASH_1404);
    expect(cashFlow.closingCash, "closing cash must be counted once").toBe(CASH_1404);
    expect(cashFlow.netChange).toBe(0);
    expect(cashFlow.activities).toEqual({ operating: 0, investing: 0, financing: 0 });
    expect(cashFlow.lines).toHaveLength(0);

    // ── Dashboard KPIs (the accounting app's overview) ────────────────────
    const overview = await ledgerReports.getLedgerOverview(biz.id, { asOfDate: D.mid1405 });
    expect(overview.cashAndBank).toBe(String(CASH_1404));
    expect(overview.receivables).toBe("8000000");
    expect(overview.payables).toBe("2000000");

    // ── Dimension reports over the new year ───────────────────────────────
    const matrix = await dimReports.getAccountDimensionMatrix(biz.id, {
      kind: "cost_center",
      dateFrom: D.start1405,
      dateTo: D.end1405,
    });
    expect(matrix.rows.find((r) => r.code === "1100")?.total ?? 0).toBe(0);
    expect(matrix.reconciled).toBe(true);

    // ── Financial-account balance (the cash container's own read) ─────────
    expect(await finAccounts.financialAccountBalanceAsOf(biz.id, acct["1100"], D.mid1405)).toBe(
      String(CASH_1404),
    );

    // ── The reporting view every standard report/export reads ─────────────
    // Net, because the seed's gross cash debits are 105M against a 5M
    // credit: the known balance is the 100M net, and a counted snapshot
    // would push the net to 200M.
    const { rows: viewRows } = await db.query<{ net: string; gross_debit: string }>(
      `SELECT COALESCE(SUM(debit) - SUM(credit), 0)::text AS net,
              COALESCE(SUM(debit), 0)::text AS gross_debit
         FROM v_ledger_by_account
        WHERE business_id = $1 AND account_code = '1100' AND entry_date <= $2`,
      [biz.id, D.mid1405],
    );
    expect(viewRows[0].net, "v_ledger_by_account must exclude the snapshot").toBe(String(CASH_1404));
    expect(viewRows[0].gross_debit, "history in the view must stay untouched").toBe("105000000");

    // ── The export path prints the same figures ───────────────────────────
    const exportRows = filterTrialBalanceRows(tb.accounts, {
      presentation: "detailed",
      includeZeroBalances: true,
      accountStatus: "all",
    });
    expect(exportRows.find((r) => r.code === "1100")?.closingDebit).toBe(String(CASH_1404));

    // Sanity: the snapshot row itself still exists in the raw ledger — it is
    // excluded from *reads*, never deleted or rewritten.
    const { rows: snapshotLines } = await db.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM journal_lines WHERE entry_id = $1",
      [entryId],
    );
    expect(snapshotLines[0].n).toBe("7");
    const { rows: setIdRows } = await db.query<{ source: string }>(
      "SELECT source FROM opening_balance_sets WHERE id = $1",
      [setId],
    );
    expect(setIdRows[0].source).toBe("carry_forward");
  }, 30_000);

  it("leaves prior-year as-of figures untouched once the next year's opening is posted", async () => {
    await seedAndClose1404();

    const tbBefore = await ledgerReports.getTrialBalance(biz.id, { asOf: D.end1404 });
    const cashBefore = rowFor(tbBefore, "1100");
    expect(cashBefore.closingDebit).toBe(String(CASH_1404));
    const sheetBefore = await reportsService.getBalanceSheet(biz.id, D.end1404, BUSINESS_WIDE_SCOPE);
    expect(sheetBefore.totalAssets).toBe(110_000_000);

    await generateAndPostCarryForward("1404", "1405");

    // The snapshot is dated in the new year: the closed year's as-of reads
    // are byte-for-byte what they were before it was posted.
    const tbAfter = await ledgerReports.getTrialBalance(biz.id, { asOf: D.end1404 });
    expect(rowFor(tbAfter, "1100")).toEqual(cashBefore);
    expect(tbAfter.totals).toEqual(tbBefore.totals);

    const sheetAfter = await reportsService.getBalanceSheet(biz.id, D.end1404, BUSINESS_WIDE_SCOPE);
    expect(sheetAfter.totalAssets).toBe(sheetBefore.totalAssets);
    expect(sheetAfter.totalEquity).toBe(sheetBefore.totalEquity);
    expect(sheetAfter.assets).toEqual(sheetBefore.assets);

    // The full 1404 period, opened and closed in its own window, still
    // closes at the known balance after the new year exists.
    const periods1404 = await fiscalService.listPeriods(biz.id, years["1404"]);
    const fullYear = await ledgerReports.getTrialBalance(biz.id, {
      dateFrom: periods1404[0].startsOn,
      dateTo: D.end1404,
    });
    expect(rowFor(fullYear, "1100").closingDebit).toBe(String(CASH_1404));
    expect(fullYear.totals.closingDebit).toBe("110000000");
  }, 30_000);

  it("does not compound at the following transition (1405 → 1406)", async () => {
    await seedAndClose1404();
    await generateAndPostCarryForward("1404", "1405");

    // Real 1405 activity: a cash sale, so the year has something to close.
    await postEntry(D.sale1405, "manual", null, "فروش نقد ۱۴۰۵", [
      { accountId: acct["1100"], debit: 1_000_000, credit: 0 },
      { accountId: acct["7000"], debit: 0, credit: 1_000_000 },
    ]);
    const close1405 = await closeYear("1405");
    expect(close1405.netIncome).toBe("1000000");

    // The second transition reads history through 1405's end. The 1405
    // snapshot (dated 2026-03-21) is in that window and must not be read as
    // history — otherwise the 1406 proposal compounds the duplication.
    const generated = await openingService.generateCarryForward({
      businessId: biz.id,
      fromYearId: years["1405"],
      toYearId: years["1406"],
      actorId: user.id,
    });
    expect(generated.balanced).toBe(true);
    expect(generated.notes).toEqual([]);
    const detail = await openingService.getOpeningSet(biz.id, generated.setId);
    const lines = detail?.lines ?? [];

    const cashLine = lines.find((l) => l.accountCode === "1100");
    expect(cashLine?.debit, "1406 cash = 1404 balance + real 1405 movement, never the snapshot twice").toBe(
      "101000000",
    );
    // A/R: per-customer attribution only — no unattributed residual equal to
    // the snapshot.
    const arLines = lines.filter((l) => l.accountCode === "1200");
    expect(arLines.filter((l) => !l.partyId)).toHaveLength(0);
    const arDebit = arLines.reduce((sum, l) => sum + BigInt(l.debit), 0n);
    expect(arDebit).toBe(8_000_000n);
    expect(arLines.find((l) => l.partyId === party.customerOne)?.debit).toBe("5000000");
    expect(arLines.find((l) => l.partyId === party.customerTwo)?.debit).toBe("3000000");
    // Plain balance-sheet accounts carry their real ledger balances.
    expect(lines.find((l) => l.accountCode === "1300")?.debit).toBe("2000000");
    expect(lines.find((l) => l.accountCode === "2100")?.credit).toBe("2000000");
    expect(lines.find((l) => l.accountCode === "3900")?.credit).toBe("105000000");
    expect(lines.find((l) => l.accountCode === "3800")?.credit).toBe("4000000"); // 3M (1404) + 1M (1405)
    // Never revenue/expense lines.
    expect(lines.every((l) => l.accountCode !== "7000" && l.accountCode !== "8000")).toBe(true);

    const reconciliation = await openingService.reconcileCarryForwardSet(biz.id, generated.setId);
    expect(reconciliation?.matched).toBe(true);

    const posted = await (async () => {
      await openingService.submitOpeningSet({ businessId: biz.id, setId: generated.setId, actorId: user.id });
      const approveCheck = await openingService.approveOpeningSet({
        businessId: biz.id,
        setId: generated.setId,
        actorId: user.id,
      });
      expect(approveCheck?.matched).toBe(true);
      return openingService.postOpeningSet({ businessId: biz.id, setId: generated.setId, actorId: user.id });
    })();
    expect(posted.voucherNumber).toBe("OP-1406-000001");

    // And 1406's own as-of reads still count the balance exactly once:
    // 1404's balance + the real 1405 sale, with both snapshots excluded.
    const tb1406 = await ledgerReports.getTrialBalance(biz.id, { asOf: D.mid1406 });
    expect(rowFor(tb1406, "1100").closingDebit).toBe("101000000");
    expect(rowFor(tb1406, "1200").closingDebit).toBe("8000000");
  }, 30_000);
});

// ---------------------------------------------------------------------------
// What must stay counted: manual openings and the wizard are not snapshots
// ---------------------------------------------------------------------------

describe("only the carry-forward snapshot is excluded", () => {
  it("counts a manual initial opening and a wizard entry exactly once, distinct from the carry-forward", async () => {
    // A manual initial-opening set for 1404 — the business's own starting
    // books. It is real history: it must be counted in the ledger *and*
    // carried into 1405 as part of history (via the snapshot's derivation).
    const { setId: manualId } = await openingService.createOpeningSet({
      businessId: biz.id,
      fiscalYearLabel: "1404",
      effectiveDate: D.inside1404,
      note: null,
      lines: cashEquityLines(2_500_000),
      actorId: user.id,
    });
    await openingService.submitOpeningSet({ businessId: biz.id, setId: manualId, actorId: user.id });
    const manualApproval = await openingService.approveOpeningSet({
      businessId: biz.id,
      setId: manualId,
      actorId: user.id,
    });
    expect(manualApproval).toBeNull(); // a manual set has no prior close to reconcile to
    const manualPost = await openingService.postOpeningSet({ businessId: biz.id, setId: manualId, actorId: user.id });
    expect(manualPost.voucherNumber).toBe("OP-1404-000001");

    // 1404 activity on top of it: cash 2.5M + 10M capital − 0.5M expense = 12M.
    await postEntry(D.later1404, "manual", null, "سرمایه", [
      { accountId: acct["1100"], debit: 10_000_000, credit: 0 },
      { accountId: acct["3900"], debit: 0, credit: 10_000_000 },
    ]);
    const order = await db.query<{ id: string }>(
      `INSERT INTO orders (location_id, order_number, status, customer_id, total, opened_at, closed_at)
       VALUES ($1, 1, 'completed', $2, 5000000, $3, $3) RETURNING id`,
      [biz.locationId, party.customerOne, D.later1404],
    );
    await postEntry(D.later1404, "order", order.rows[0].id, "فروش نسیه", [
      { accountId: acct["1200"], debit: 5_000_000, credit: 0 },
      { accountId: acct["7000"], debit: 0, credit: 5_000_000 },
    ]);
    await postEntry(D.later1404, "manual", null, "هزینه نقد", [
      { accountId: acct["8000"], debit: 500_000, credit: 0 },
      { accountId: acct["1100"], debit: 0, credit: 500_000 },
    ]);

    const close = await closeYear("1404");
    expect(close.netIncome).toBe("4500000"); // 5M sale − 0.5M expense

    const carryForward = await generateAndPostCarryForward("1404", "1405");
    // The manual opening was *included* when the snapshot was derived:
    // cash 2.5M + 10M − 0.5M = 12,000,000.
    expect(carryForward.lines.find((l) => l.accountCode === "1100")?.debit).toBe("12000000");

    // The setup wizard's own opening entry for 1405 — `source_type='opening'`
    // but *not* a carry-forward set: real ledger history, counted as movement.
    await postEntry(D.start1405, "opening", randomUUID(), "سند افتتاحیه راه‌اندازی", cashEquityLines(100_000));

    const tb = await ledgerReports.getTrialBalance(biz.id, {
      dateFrom: D.start1405,
      dateTo: D.end1405,
    });
    const cash = rowFor(tb, "1100");
    // History (manual opening + activity) in the opening column — a blanket
    // `source_type = 'opening'` exclusion would wrongly report 9,500,000.
    expect(cash.openingDebit, "the manual initial opening stays counted").toBe("12000000");
    // Only the wizard entry moved in 1405 — the snapshot contributes nothing.
    expect(cash.periodDebit).toBe("100000");
    expect(cash.closingDebit).toBe("12100000");

    const capital = rowFor(tb, "3900");
    expect(capital.openingCredit).toBe("12500000"); // 2.5M manual + 10M injection
    expect(capital.periodCredit).toBe("100000");
    expect(capital.closingCredit).toBe("12600000");

    expect(tb.totals.closingDebit).toBe(tb.totals.closingCredit);
    expect(tb.trialBalanceBalanced).toBe(true);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// The snapshot stays a document: listed, numbered, reversible
// ---------------------------------------------------------------------------

describe("the carry-forward entry remains an ordinary journal document", () => {
  it("stays listed and numbered in the journal while balances exclude it, and reverses cleanly", async () => {
    await seedAndClose1404();
    const { setId, entryId } = await generateAndPostCarryForward("1404", "1405");

    // The journal (document view) lists it for the new year — documents are
    // never hidden by the balance-read exclusion.
    const parsed = parseJournalFilters(new URLSearchParams(`dateFrom=${D.start1405}&dateTo=${D.end1405}`));
    if ("error" in parsed) throw new Error(parsed.error);
    const page = await journalService.listJournalEntries(biz.id, parsed.filters);
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]).toMatchObject({ id: entryId, sourceType: "opening", sourceId: setId });

    // Balances exclude it (period movement zero) while whole-ledger integrity
    // still counts the document.
    const tb = await ledgerReports.getTrialBalance(biz.id, { dateFrom: D.start1405, dateTo: D.end1405 });
    expect(rowFor(tb, "1100").periodDebit).toBe("0");
    expect(rowFor(tb, "1100").closingDebit).toBe(String(CASH_1404));
    expect(tb.integrity.entryCount).toBe(7);
    expect(tb.integrity.ledgerHealthy).toBe(true);

    // Controlled reversal: a mirror entry dated today, same source set —
    // both sides of the snapshot leave the balance reads together, so the
    // ledger's real history (100,000,000) stands untouched either way.
    const { reversalEntryId } = await openingService.reverseOpeningSet({
      businessId: biz.id,
      setId,
      reason: "تراز انتقالی برای آزمون",
      actorId: user.id,
    });
    const { rows: reversalRows } = await db.query<{ posting_kind: string; source_type: string }>(
      "SELECT posting_kind, source_type FROM journal_entries WHERE id = $1",
      [reversalEntryId],
    );
    expect(reversalRows[0]).toMatchObject({ posting_kind: "opening_reversal", source_type: "opening" });

    const afterReversal = await ledgerReports.getTrialBalance(biz.id, { asOf: D.mid1405 });
    expect(rowFor(afterReversal, "1100").closingDebit, "history stands after the snapshot reverses").toBe(
      String(CASH_1404),
    );
    expect(afterReversal.totals.closingDebit).toBe("110000000");

    const setAfter = await openingService.getOpeningSet(biz.id, setId);
    expect(setAfter?.set.status).toBe("reversed");
    expect(setAfter?.set.reversalEntryId).toBe(reversalEntryId);
  }, 30_000);
});
