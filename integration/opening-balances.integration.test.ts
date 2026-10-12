/**
 * Issue #867 — opening balances & fiscal carry-forward, end to end.
 *
 * The set's one-way life (draft → review → approved → posted → reversed)
 * through the real posting path — the posted set is an ordinary journal
 * entry (`source_type = 'opening'`, dated at its effective date, numbered
 * from the opening book), so the fiscal-period lock, RLS and every report
 * apply to it with no special case. The carry-forward rule reads a *closed*
 * prior year and must survive the transition with its attribution: A/R per
 * customer, A/P per supplier, cheques per serial, fixed assets per item, and
 * the prior year's result in equity — never as revenue/expense lines.
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
let ledgerService: typeof import("../src/lib/ledger-service");
let openingService: typeof import("../src/lib/opening-balances-service");
let fiscalService: typeof import("../src/lib/fiscal-periods-service");
let closingService: typeof import("../src/lib/closing-service");

const biz = { id: "", locationId: "" };
const user = { id: "" };
const acct: Record<string, string> = {};
const party = { customerOne: "", customerTwo: "", supplierOne: "" };
const customer = { one: "", two: "" };
const supplier = { one: "" };
const years: Record<string, string> = {};

/** 1404 runs 2025-03-21 → 2026-03-20; 1405 runs 2026-03-21 → 2027-03-20. */
const D = {
  inside1404: "2025-06-15",
  later1404: "2025-11-01",
  end1404: "2026-03-20",
  start1405: "2026-03-21",
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
  databaseName = `pos_opening_balances_${randomUUID().replaceAll("-", "")}`;

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
  // A fresh scratch database per file: TRUNCATE CASCADE reaches every child
  // table (including tables other suites' businesses never touch) without
  // hand-ordering twenty FKs.
  await db.query(`TRUNCATE
    opening_balance_lines, opening_balance_sets, voucher_renumber_log, voucher_sequences,
    summary_voucher_sources, summary_vouchers,
    fixed_asset_depreciation_entries, fixed_assets, cheques, orders, purchases,
    journal_lines, journal_entries, fiscal_periods, fiscal_years,
    suppliers, parties, accounts, users, locations, businesses
    CASCADE`);

  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ('Opening Co', $1) RETURNING id",
    [`opening-${randomUUID().slice(0, 8)}`],
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
            ($1, '1241', 'Cheques on hand', 'asset'),
            ($1, '1300', 'Inventory', 'asset'),
            ($1, '1500', 'Fixed assets', 'asset'),
            ($1, '1510', 'Accumulated depreciation', 'asset'),
            ($1, '2100', 'Accounts Payable', 'liability'),
            ($1, '2121', 'Cheques issued', 'liability'),
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

  // Customers ARE parties (0137 merged the directory); orders point at the party.
  customer.one = party.customerOne;
  customer.two = party.customerTwo;

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

/** A balanced two-line set against cash and opening equity. */
function cashEquityLines(amount = 1_000_000) {
  return [
    { accountId: acct["1100"], debit: amount, credit: 0 },
    { accountId: acct["3900"], debit: 0, credit: amount },
  ];
}

async function postSet(fiscalYearLabel: string, effectiveDate: string, amount = 1_000_000): Promise<string> {
  const { setId } = await openingService.createOpeningSet({
    businessId: biz.id,
    fiscalYearLabel,
    effectiveDate,
    note: "پیش‌نویس آزمون",
    lines: cashEquityLines(amount),
    actorId: user.id,
  });
  await openingService.submitOpeningSet({ businessId: biz.id, setId, actorId: user.id });
  await openingService.approveOpeningSet({ businessId: biz.id, setId, actorId: user.id });
  const { entryId } = await openingService.postOpeningSet({ businessId: biz.id, setId, actorId: user.id });
  expect(entryId).toBeTruthy();
  return setId;
}

// ---------------------------------------------------------------------------
// The manual set's one-way life
// ---------------------------------------------------------------------------

describe("a manual opening set", () => {
  it("moves draft → review → approved → posted, posting one ordinary numbered entry", async () => {
    const { setId } = await openingService.createOpeningSet({
      businessId: biz.id,
      fiscalYearLabel: "1404",
      effectiveDate: D.inside1404,
      note: null,
      lines: cashEquityLines(2_500_000),
      actorId: user.id,
    });

    const listed = await openingService.listOpeningSets(biz.id);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      id: setId,
      fiscalYearLabel: "1404",
      effectiveDate: D.inside1404,
      status: "draft",
      source: "manual",
      totalDebit: "2500000",
      totalCredit: "2500000",
    });

    const detail = await openingService.getOpeningSet(biz.id, setId);
    expect(detail?.set.status).toBe("draft");
    expect(detail?.lines).toHaveLength(2);
    expect(detail?.lines.find((l) => l.accountCode === "1100")).toMatchObject({ debit: "2500000" });

    await openingService.submitOpeningSet({ businessId: biz.id, setId, actorId: user.id });
    // The same transition twice is a state error, not a silent success.
    await expect(
      openingService.submitOpeningSet({ businessId: biz.id, setId, actorId: user.id }),
    ).rejects.toThrow("invalid_status");

    const reconciliation = await openingService.approveOpeningSet({
      businessId: biz.id,
      setId,
      actorId: user.id,
    });
    expect(reconciliation).toBeNull(); // a manual set has no prior close to reconcile to

    const { entryId, voucherNumber } = await openingService.postOpeningSet({
      businessId: biz.id,
      setId,
      actorId: user.id,
    });
    expect(voucherNumber).toBe("OP-1404-000001");

    // The set is now one ordinary journal entry: same source, same date, same lines.
    const { rows } = await db.query<{
      id: string;
      source_type: string;
      posting_kind: string;
      entry_date: string;
      voucher_number: string;
    }>(
      "SELECT id, source_type, posting_kind, entry_date::text AS entry_date, voucher_number FROM journal_entries WHERE id = $1",
      [entryId],
    );
    expect(rows[0]).toMatchObject({
      source_type: "opening",
      posting_kind: "opening",
      entry_date: D.inside1404,
      voucher_number: "OP-1404-000001",
    });
    const { rows: lineRows } = await db.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM journal_lines WHERE entry_id = $1",
      [entryId],
    );
    expect(lineRows[0].n).toBe("2");

    const after = await openingService.getOpeningSet(biz.id, setId);
    expect(after?.set.status).toBe("posted");
    expect(after?.set.postedAt).toBeTruthy();
    expect(after?.set.journalEntryId).toBe(entryId);
  });

  it("refuses shapes that are not a balanced multi-account set", async () => {
    const base = {
      businessId: biz.id,
      fiscalYearLabel: "1404",
      effectiveDate: D.inside1404,
      actorId: user.id,
    };
    await expect(
      openingService.createOpeningSet({
        ...base,
        lines: [
          { accountId: acct["1100"], debit: 100, credit: 0 },
          { accountId: acct["3900"], debit: 0, credit: 90 },
        ],
      }),
    ).rejects.toThrow("not_balanced");
    await expect(
      openingService.createOpeningSet({
        ...base,
        lines: [
          { accountId: acct["1100"], debit: 100, credit: 0 },
          { accountId: acct["1100"], debit: 0, credit: 100 },
        ],
      }),
    ).rejects.toThrow("single_account_set");
    await expect(
      openingService.createOpeningSet({ ...base, fiscalYearLabel: "14a4", lines: cashEquityLines() }),
    ).rejects.toThrow("invalid_fiscal_year");
    await expect(
      openingService.createOpeningSet({ ...base, effectiveDate: null, lines: cashEquityLines() }),
    ).rejects.toThrow("invalid_effective_date");
    await expect(
      openingService.createOpeningSet({ ...base, effectiveDate: "2026-04-01", lines: cashEquityLines() }),
    ).rejects.toThrow("effective_date_outside_fiscal_year");
  });

  it("allows exactly one posted opening per fiscal year — and answers for the wizard's entry", async () => {
    await postSet("1404", D.inside1404);

    // The second set for 1404 is refused at approval: a year cannot be
    // approved twice, and posting never gets the chance to duplicate it.
    const { setId } = await openingService.createOpeningSet({
      businessId: biz.id,
      fiscalYearLabel: "1404",
      effectiveDate: D.later1404,
      lines: cashEquityLines(500_000),
      actorId: user.id,
    });
    await openingService.submitOpeningSet({ businessId: biz.id, setId, actorId: user.id });
    await expect(
      openingService.approveOpeningSet({ businessId: biz.id, setId, actorId: user.id }),
    ).rejects.toThrow("opening_set_already_posted");
    // The set itself was not touched: still in review, nothing posted.
    const after = await openingService.getOpeningSet(biz.id, setId);
    expect(after?.set.status).toBe("review");

    // The wizard's own opening entry, dated in 1405, blocks a 1405 opening too.
    await postEntry(
      D.start1405,
      "opening",
      randomUUID(),
      "سند افتتاحیه راه‌اندازی",
      cashEquityLines(100_000),
    );
    const { setId: set1405 } = await openingService.createOpeningSet({
      businessId: biz.id,
      fiscalYearLabel: "1405",
      effectiveDate: D.start1405,
      lines: cashEquityLines(100_000),
      actorId: user.id,
    });
    await openingService.submitOpeningSet({ businessId: biz.id, setId: set1405, actorId: user.id });
    await expect(
      openingService.approveOpeningSet({ businessId: biz.id, setId: set1405, actorId: user.id }),
    ).rejects.toThrow("opening_entry_exists_for_year");
  });

  it("reverses to a mirror entry dated today — never backdated, never destructive", async () => {
    const setId = await postSet("1404", D.inside1404, 750_000);

    await expect(
      openingService.reverseOpeningSet({ businessId: biz.id, setId, reason: "", actorId: user.id }),
    ).rejects.toThrow("reason_required");

    const { reversalEntryId } = await openingService.reverseOpeningSet({
      businessId: biz.id,
      setId,
      reason: "مبلغ نقد افتتاحیه اشتباه بود",
      actorId: user.id,
    });

    const today = new Date().toISOString().slice(0, 10);
    const { rows } = await db.query<{ id: string; posting_kind: string; entry_date: string; reversed_at: string }>(
      "SELECT id, posting_kind, entry_date::text AS entry_date, reversed_at::text AS reversed_at FROM journal_entries WHERE id = $1",
      [reversalEntryId],
    );
    expect(rows[0]).toMatchObject({
      posting_kind: "opening_reversal",
      entry_date: today,
    });
    expect(rows[0].reversed_at).toBeFalsy(); // the reversal is not itself marked reversed

    const after = await openingService.getOpeningSet(biz.id, setId);
    expect(after?.set.status).toBe("reversed");
    expect(after?.set.reversedReason).toBe("مبلغ نقد افتتاحیه اشتباه بود");
    expect(after?.set.reversalEntryId).toBe(reversalEntryId);

    // Original plus mirror: the net effect on every account is zero.
    const { rows: net } = await db.query<{ n: string }>(
      `SELECT (SUM(jl.debit) - SUM(jl.credit))::text AS n
         FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.entry_id
        WHERE je.business_id = $1 AND je.source_type = 'opening'`,
      [biz.id],
    );
    expect(net[0].n).toBe("0");
  });

  it("refuses the reversal once any entry is dated after the effective date", async () => {
    const setId = await postSet("1404", D.inside1404);

    await postEntry(
      D.later1404,
      "manual",
      null,
      "ثبت بعد از تاریخ مؤثر",
      [
        { accountId: acct["8000"], debit: 1000, credit: 0 },
        { accountId: acct["1100"], debit: 0, credit: 1000 },
      ],
    );

    await expect(
      openingService.reverseOpeningSet({
        businessId: biz.id,
        setId,
        reason: "الان نمی‌شود",
        actorId: user.id,
      }),
    ).rejects.toThrow("dependent_postings_exist");

    const after = await openingService.getOpeningSet(biz.id, setId);
    expect(after?.set.status).toBe("posted");
  });
});

// ---------------------------------------------------------------------------
// The fiscal transition
// ---------------------------------------------------------------------------

/**
 * A closed 1404 with real attribution:
 *
 *   AR  C1 5,000,000 + C2 3,000,000 (orders)        → 1200 net 8,000,000
 *   AP  S1 2,000,000 (credit purchase)              → 2100 net −2,000,000
 *   cheque on hand 2,000,000 (register = GL)        → 1241 net 2,000,000
 *   fixed asset 6,000,000, depreciated 1,200,000    → 1500/1510
 *   cash paid out 10,000,000                         → 1100 net −10,000,000
 *   revenue 10,000,000 · expenses 5,200,000          → a 4,800,000 profit
 *
 * Soft-closes every period and closes the year (P&L → retained earnings).
 */
async function closeYear1404WithActivity(): Promise<{ chequeId: string; assetId: string; closingEntryId: string }> {
  // C1's order: Dr AR / Cr Sales.
  const orderOne = await db.query<{ id: string }>(
    `INSERT INTO orders (location_id, order_number, status, customer_id, total, opened_at, closed_at)
     VALUES ($1, 1, 'completed', $2, 5000000, $3, $3) RETURNING id`,
    [biz.locationId, customer.one, D.inside1404],
  );
  await postEntry(D.inside1404, "order", orderOne.rows[0].id, "فروش نسیه", [
    { accountId: acct["1200"], debit: 5_000_000, credit: 0 },
    { accountId: acct["7000"], debit: 0, credit: 5_000_000 },
  ]);
  // C2's order.
  const orderTwo = await db.query<{ id: string }>(
    `INSERT INTO orders (location_id, order_number, status, customer_id, total, opened_at, closed_at)
     VALUES ($1, 2, 'completed', $2, 3000000, $3, $3) RETURNING id`,
    [biz.locationId, customer.two, D.inside1404],
  );
  await postEntry(D.inside1404, "order", orderTwo.rows[0].id, "فروش نسیه", [
    { accountId: acct["1200"], debit: 3_000_000, credit: 0 },
    { accountId: acct["7000"], debit: 0, credit: 3_000_000 },
  ]);
  // S1's credit purchase: Dr Inventory / Cr AP.
  const purchase = await db.query<{ id: string }>(
    `INSERT INTO purchases (location_id, supplier_id, status, total, settlement_method, note, received_at)
     VALUES ($1, $2, 'received', 2000000, 'credit', 'خرید', $3) RETURNING id`,
    [biz.locationId, supplier.one, D.inside1404],
  );
  await postEntry(D.inside1404, "purchase", purchase.rows[0].id, "خرید نسیه", [
    { accountId: acct["1300"], debit: 2_000_000, credit: 0 },
    { accountId: acct["2100"], debit: 0, credit: 2_000_000 },
  ]);
  // Cash expense.
  await postEntry(D.inside1404, "manual", null, "هزینه نقد", [
    { accountId: acct["8000"], debit: 4_000_000, credit: 0 },
    { accountId: acct["1100"], debit: 0, credit: 4_000_000 },
  ]);
  // A cheque received for a sale: Dr 1241 / Cr Sales — the register's only cheque.
  const cheque = await db.query<{ id: string }>(
    `INSERT INTO cheques (business_id, location_id, direction, status, serial_number, sayad_id, bank_name,
                           amount, issue_date, due_date, counterparty_name)
     VALUES ($1, $2, 'receivable', 'on_hand', '81234', '1234567890123456', 'بانک آزمون',
             2000000, $3, '2025-12-01', 'چک‌دهنده') RETURNING id`,
    [biz.id, biz.locationId, D.inside1404],
  );
  await postEntry(D.inside1404, "cheque", cheque.rows[0].id, "دریافت چک", [
    { accountId: acct["1241"], debit: 2_000_000, credit: 0 },
    { accountId: acct["7000"], debit: 0, credit: 2_000_000 },
  ]);
  // A fixed asset bought for cash, then depreciated.
  const asset = await db.query<{ id: string }>(
    `INSERT INTO fixed_assets (business_id, location_id, name, acquisition_date, cost, salvage_value,
                               useful_life_months, created_by, code, asset_account_id)
     VALUES ($1, $2, 'ماشین آزمون', $3, 6000000, 0, 24, $4, 'FA-1', $5) RETURNING id`,
    [biz.id, biz.locationId, D.inside1404, user.id, acct["1500"]],
  );
  await postEntry(D.inside1404, "fixed_asset_acquisition", asset.rows[0].id, "خرید دارایی", [
    { accountId: acct["1500"], debit: 6_000_000, credit: 0 },
    { accountId: acct["1100"], debit: 0, credit: 6_000_000 },
  ]);
  await db.query(
    `INSERT INTO fixed_asset_depreciation_entries (fixed_asset_id, period_label, entry_date, amount)
     VALUES ($1, 'شهریور 1404', $2, 1200000)`,
    [asset.rows[0].id, D.inside1404],
  );
  await postEntry(D.inside1404, "fixed_asset_depreciation", asset.rows[0].id, "استهلاک", [
    { accountId: acct["8000"], debit: 1_200_000, credit: 0 },
    { accountId: acct["1510"], debit: 0, credit: 1_200_000 },
  ]);

  // The year is only transitionable closed: every period soft-closed, then closed.
  const periods = await fiscalService.listPeriods(biz.id, years["1404"]);
  expect(periods).toHaveLength(12);
  for (const period of periods) {
    await fiscalService.setPeriodStatus(biz.id, period.id, "soft_closed", user.id);
  }
  const close = await closingService.closeFiscalYear(biz.id, years["1404"], user.id);
  expect(close.netIncome).toBe(4_800_000);
  expect(close.closingEntryId).toBeTruthy();

  return { chequeId: cheque.rows[0].id, assetId: asset.rows[0].id, closingEntryId: close.closingEntryId as string };
}

describe("the fiscal transition", () => {
  it("refuses a transition from an unclosed year, and between non-consecutive years", async () => {
    await expect(
      openingService.generateCarryForward({
        businessId: biz.id,
        fromYearId: years["1404"],
        toYearId: years["1405"],
        actorId: user.id,
      }),
    ).rejects.toThrow("prior_year_not_closed");

    await expect(
      openingService.generateCarryForward({
        businessId: biz.id,
        fromYearId: years["1404"],
        toYearId: years["1406"],
        actorId: user.id,
      }),
    ).rejects.toThrow("years_not_consecutive");

    const { rows } = await db.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM opening_balance_sets WHERE business_id = $1",
      [biz.id],
    );
    expect(rows[0].n).toBe("0");
  });

  it("carries the closed year into next year's draft — with its attribution — and posts it reconciled", async () => {
    const { chequeId, assetId } = await closeYear1404WithActivity();

    const generated = await openingService.generateCarryForward({
      businessId: biz.id,
      fromYearId: years["1404"],
      toYearId: years["1405"],
      actorId: user.id,
    });
    expect(generated.idempotent).toBe(false);
    expect(generated.balanced).toBe(true);
    expect(generated.notes).toEqual([]); // every register agreed with the GL

    const detail = await openingService.getOpeningSet(biz.id, generated.setId);
    expect(detail?.set).toMatchObject({
      fiscalYearLabel: "1405",
      effectiveDate: D.start1405,
      source: "carry_forward",
      status: "draft",
      carryForwardFromYearId: years["1404"],
    });
    const lines = detail?.lines ?? [];

    // A/R replaced by its customers — the attribution survives the transition.
    expect(
      lines.find((l) => l.partyType === "customer" && l.partyId === party.customerOne),
    ).toMatchObject({ accountId: acct["1200"], debit: "5000000", credit: "0" });
    expect(
      lines.find((l) => l.partyType === "customer" && l.partyId === party.customerTwo),
    ).toMatchObject({ accountId: acct["1200"], debit: "3000000", credit: "0" });
    // A/P replaced by its supplier, as a credit.
    expect(
      lines.find((l) => l.partyType === "supplier" && l.partyId === party.supplierOne),
    ).toMatchObject({ accountId: acct["2100"], debit: "0", credit: "2000000" });
    // The cheque keeps its serial (register and GL agreed to the Rial).
    expect(lines.find((l) => l.partyType === "cheque")).toMatchObject({
      accountId: acct["1241"],
      debit: "2000000",
      partyId: chequeId,
    });
    // The asset keeps its identity, its accumulated depreciation is one line.
    expect(lines.find((l) => l.partyType === "fixed_asset")).toMatchObject({
      accountId: acct["1500"],
      debit: "6000000",
      partyId: assetId,
    });
    expect(lines.find((l) => l.accountCode === "1510")).toMatchObject({ debit: "0", credit: "1200000" });
    // Plain balance-sheet accounts carry by total…
    expect(lines.find((l) => l.accountCode === "1100")).toMatchObject({ debit: "0", credit: "10000000" });
    // …and the prior year's profit sits in retained earnings — never as revenue/expense lines.
    expect(lines.find((l) => l.accountCode === "3800")).toMatchObject({ debit: "0", credit: "4800000" });
    expect(lines.every((l) => l.accountCode !== "7000" && l.accountCode !== "8000")).toBe(true);

    // The open proves itself against the close it came from.
    const reconciliation = await openingService.reconcileCarryForwardSet(biz.id, generated.setId);
    expect(reconciliation?.matched).toBe(true);
    expect(BigInt(reconciliation!.totals.actualDebit)).toBe(BigInt(reconciliation!.totals.expectedDebit));

    // A retry of the same transition returns the same set, never a second.
    const retry = await openingService.generateCarryForward({
      businessId: biz.id,
      fromYearId: years["1404"],
      toYearId: years["1405"],
      actorId: user.id,
    });
    expect(retry.idempotent).toBe(true);
    expect(retry.setId).toBe(generated.setId);

    // The set then takes the ordinary review → approve → post path into 1405.
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
    expect(voucherNumber).toBe("OP-1405-000001");
    const { rows } = await db.query<{ entry_date: string; source_type: string }>(
      "SELECT entry_date::text AS entry_date, source_type FROM journal_entries WHERE id = $1",
      [entryId],
    );
    expect(rows[0]).toMatchObject({ entry_date: D.start1405, source_type: "opening" });
  });

  it("lets a doctored proposal fail the reconciliation gate at approval", async () => {
    const generated = await (async () => {
      await closeYear1404WithActivity();
      return openingService.generateCarryForward({
        businessId: biz.id,
        fromYearId: years["1404"],
        toYearId: years["1405"],
        actorId: user.id,
      });
    })();

    // The ledger may have moved since the proposal was written. Tamper by
    // shifting a Rial between two credit lines: the set stays balanced (so the
    // update is accepted) but no longer matches the books, so the
    // re-derivation at approval must refuse it.
    const toPut = (ls: typeof generated.lines) =>
      ls.map((l) => ({
        accountId: l.accountId,
        debit: Number(l.debit),
        credit: Number(l.credit),
        partyType: l.partyType,
        partyId: l.partyId,
        reference: l.reference,
        sourceNote: l.sourceNote,
      }));
    const tampered = toPut(generated.lines).map((l) => {
      if (l.accountId === acct["1100"]) return { ...l, credit: l.credit + 1_000_000 };
      if (l.accountId === acct["1510"]) return { ...l, credit: l.credit - 1_000_000 };
      return l;
    });
    await openingService.updateOpeningSetLines({
      businessId: biz.id,
      setId: generated.setId,
      lines: tampered,
      note: "دست‌کاری برای آزمون",
      actorId: user.id,
    });
    await openingService.submitOpeningSet({ businessId: biz.id, setId: generated.setId, actorId: user.id });
    await expect(
      openingService.approveOpeningSet({ businessId: biz.id, setId: generated.setId, actorId: user.id }),
    ).rejects.toThrow("reconciliation_failed");

    // The proposal's own lines pass — the gate is a comparison, not a veto.
    await openingService.updateOpeningSetLines({
      businessId: biz.id,
      setId: generated.setId,
      lines: toPut(generated.lines),
      note: null,
      actorId: user.id,
    });
    const reconciliation = await openingService.approveOpeningSet({
      businessId: biz.id,
      setId: generated.setId,
      actorId: user.id,
    });
    expect(reconciliation?.matched).toBe(true);
  });
});
