/**
 * Issue #867 exit criteria, proven against a real migrated database:
 *  - every journal entry gets a fiscal-year voucher number, in order, with no
 *    gap from a rolled-back posting;
 *  - the number is locked against plain SQL, a locked period refuses a
 *    renumber, and renumbering is audited and append-only;
 *  - an opening balance set is drafted, reviewed (maker-checker), posted
 *    exactly, and can only be undone by a reversal that no later posting blocks;
 *  - a next-year opening is generated from a closed prior year, keeps the A/R
 *    and A/P party attribution, leaves revenue and expense out, and reconciles
 *    to the prior close.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let fiscal: typeof import("../src/lib/fiscal-periods-service");
let closing: typeof import("../src/lib/closing-service");
let vouchers: typeof import("../src/lib/voucher-service");
let opening: typeof import("../src/lib/opening-balance-service");
let ar: typeof import("../src/lib/ar-service");
let jalali: typeof import("../src/lib/jalali");

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
  databaseName = `pos_vob_${randomUUID().replaceAll("-", "")}`;
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
  fiscal = await import("../src/lib/fiscal-periods-service");
  closing = await import("../src/lib/closing-service");
  vouchers = await import("../src/lib/voucher-service");
  opening = await import("../src/lib/opening-balance-service");
  ar = await import("../src/lib/ar-service");
  jalali = await import("../src/lib/jalali");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
}, 120_000);

afterAll(async () => {
  await db?.end();
  await dbLib
    ?.getPool()
    .end()
    .catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

// The audit table is append-only (even business cascade deletes are refused),
// so every test builds its own business and never deletes one.
interface Ctx {
  biz: string;
  owner: string;
  accountant: string;
  acct: Record<string, string>;
  locationId: string;
  supplierId: string;
  customerId: string;
  fy1404: string;
  fy1405: string;
}

async function newBusiness(): Promise<Ctx> {
  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ('Vouchers Co', $1) RETURNING id",
    [`vob-${randomUUID().slice(0, 8)}`],
  );
  const biz = bizRow.rows[0].id;

  const owner = (
    await db.query<{ id: string }>(
      `INSERT INTO users (business_id, role, full_name, pin_hash) VALUES ($1, 'owner', 'Owner', 'x') RETURNING id`,
      [biz],
    )
  ).rows[0].id;
  const accountant = (
    await db.query<{ id: string }>(
      `INSERT INTO users (business_id, role, full_name, pin_hash) VALUES ($1, 'accountant', 'Accountant', 'x') RETURNING id`,
      [biz],
    )
  ).rows[0].id;

  const accountRows = await db.query<{ id: string; code: string }>(
    `INSERT INTO accounts (business_id, code, name, type) VALUES
       ($1, '1100', 'Cash', 'asset'),
       ($1, '1200', 'Accounts receivable', 'asset'),
       ($1, '2100', 'Accounts payable', 'liability'),
       ($1, '3800', 'Retained earnings', 'equity'),
       ($1, '3900', 'Opening equity', 'equity'),
       ($1, '4300', 'Sales', 'revenue'),
       ($1, '5900', 'Other expense', 'expense')
     RETURNING id, code`,
    [biz],
  );
  const acct: Record<string, string> = {};
  for (const r of accountRows.rows) acct[r.code] = r.id;

  const locationId = (
    await db.query<{ id: string }>(`INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id`, [biz])
  ).rows[0].id;
  const supplierId = (
    await db.query<{ id: string }>(
      `INSERT INTO suppliers (location_id, name) VALUES ($1, 'Acme Supplies') RETURNING id`,
      [locationId],
    )
  ).rows[0].id;
  const customerId = (
    await db.query<{ id: string }>(
      `INSERT INTO parties (business_id, name, role) VALUES ($1, 'Customer One', 'customer') RETURNING id`,
      [biz],
    )
  ).rows[0].id;

  await fiscal.createFiscalYear(biz, 1404);
  await fiscal.createFiscalYear(biz, 1405);
  const years = await fiscal.listFiscalYears(biz);
  const fy1404 = years.find((y) => y.label.includes("1404") || (y as { jy?: number }).jy === 1404)!.id;
  const fy1405 = years.find((y) => y.label.includes("1405") || (y as { jy?: number }).jy === 1405)!.id;

  return { biz, owner, accountant, acct, locationId, supplierId, customerId, fy1404, fy1405 };
}

/** A balanced two-line entry written the way postJournalEntry does: the trigger numbers it. */
async function postEntry(ctx: Ctx, entryDate: string, debitAcct: string, creditAcct: string, amount: number): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO journal_entries (business_id, entry_date, memo, source_type, created_by)
     VALUES ($1, $2, 'test', 'manual', $3) RETURNING id`,
    [ctx.biz, entryDate, ctx.owner],
  );
  const entryId = rows[0].id;
  await db.query(
    `INSERT INTO journal_lines (entry_id, account_id, debit, credit) VALUES ($1, $2, $3, 0), ($1, $4, 0, $3)`,
    [entryId, debitAcct, amount, creditAcct],
  );
  return entryId;
}

async function voucherOf(entryId: string) {
  const { rows } = await db.query<{ voucher_year: number; voucher_number: string; voucher_no: string }>(
    `SELECT voucher_year, voucher_number::text AS voucher_number, voucher_no FROM journal_entries WHERE id = $1`,
    [entryId],
  );
  return { ...rows[0], voucher_number: Number(rows[0].voucher_number) };
}

async function accountBalance(accountId: string): Promise<number> {
  const { rows } = await db.query<{ net: string }>(
    `SELECT COALESCE(SUM(debit - credit), 0)::text AS net FROM journal_lines WHERE account_id = $1`,
    [accountId],
  );
  return Number(rows[0].net);
}

async function softCloseAll(ctx: Ctx, fiscalYearId: string) {
  for (const p of await fiscal.listPeriods(ctx.biz, fiscalYearId)) {
    await fiscal.setPeriodStatus(ctx.biz, p.id, "soft_closed", ctx.owner);
  }
}

async function rejection(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error("expected the call to be refused");
}

/** An opening set with the given lines, drafted for the 1405 year. */
async function draftOpening(ctx: Ctx, lines: Parameters<typeof opening.replaceOpeningBalanceLines>[2], effectiveDate = "2026-03-21") {
  const { set } = await opening.createOpeningBalanceSet(ctx.biz, ctx.owner, {
    fiscalYearId: ctx.fy1405,
    effectiveDate,
  });
  return opening.replaceOpeningBalanceLines(ctx.biz, set.id, lines);
}

describe("voucher numbering", () => {
  it("numbers each fiscal year in order and maps the Jalali year correctly", async () => {
    const ctx = await newBusiness();
    const a = await postEntry(ctx, "2025-04-01", ctx.acct["1100"], ctx.acct["4300"], 100);
    const b = await postEntry(ctx, "2025-04-02", ctx.acct["1100"], ctx.acct["4300"], 200);
    const c = await postEntry(ctx, "2026-03-22", ctx.acct["1100"], ctx.acct["4300"], 300);

    const va = await voucherOf(a);
    const vb = await voucherOf(b);
    const vc = await voucherOf(c);
    expect(va.voucher_year).toBe(1404);
    expect([va.voucher_number, vb.voucher_number]).toEqual([1, 2]);
    expect(vc.voucher_year).toBe(1405);
    expect(vc.voucher_number).toBe(1);
    expect(va.voucher_no).toBe("JV-1404-000001");
  });

  it("does not consume a number when a posting rolls back", async () => {
    const ctx = await newBusiness();
    await postEntry(ctx, "2025-04-01", ctx.acct["1100"], ctx.acct["4300"], 100);
    await db.query("BEGIN");
    await db.query(
      `INSERT INTO journal_entries (business_id, entry_date, memo, source_type, created_by)
       VALUES ($1, '2025-04-02', 'rolled back', 'manual', $2)`,
      [ctx.biz, ctx.owner],
    );
    await db.query("ROLLBACK");
    const next = await postEntry(ctx, "2025-04-03", ctx.acct["1100"], ctx.acct["4300"], 100);
    expect((await voucherOf(next)).voucher_number).toBe(2);
  });

  it("refuses a plain SQL change to a voucher number", async () => {
    const ctx = await newBusiness();
    const a = await postEntry(ctx, "2025-04-01", ctx.acct["1100"], ctx.acct["4300"], 100);
    await expect(db.query(`UPDATE journal_entries SET voucher_number = 99 WHERE id = $1`, [a])).rejects.toThrow(
      /voucher_identity_locked/,
    );
  });

  it("renumbers into a gap, audits it, and refuses a number beyond the sequence", async () => {
    const ctx = await newBusiness();
    await postEntry(ctx, "2025-04-01", ctx.acct["1100"], ctx.acct["4300"], 100);
    const middle = await postEntry(ctx, "2025-04-02", ctx.acct["1100"], ctx.acct["4300"], 100);
    const last = await postEntry(ctx, "2025-04-03", ctx.acct["1100"], ctx.acct["4300"], 100);

    // Remove the middle document to make a real gap.
    await db.query(`DELETE FROM journal_lines WHERE entry_id = $1`, [middle]);
    await db.query(`DELETE FROM journal_entries WHERE id = $1`, [middle]);

    const beyond = await rejection(
      vouchers.renumberVoucher(ctx.biz, ctx.owner, last, { toVoucherNumber: 9, reason: "fix" }),
    );
    expect(beyond).toMatch(/voucher_number_out_of_range/);

    const result = await vouchers.renumberVoucher(ctx.biz, ctx.owner, last, {
      toVoucherNumber: 2,
      reason: "Printed sheet had the wrong number",
    });
    expect(result.voucherNo).toBe("JV-1404-000002");
    expect(result.fromVoucherNumber).toBe(3);

    const gaps = await vouchers.numberingGapReport(ctx.biz, 1404);
    expect(gaps.gaps).toEqual([3]);

    const trail = await vouchers.voucherAuditTrail(ctx.biz, last);
    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({ action: "renumber", fromVoucherNo: "JV-1404-000003", toVoucherNo: "JV-1404-000002" });

    await expect(db.query(`UPDATE journal_voucher_audit SET reason = 'x'`)).rejects.toThrow(
      /journal_voucher_audit_is_append_only/,
    );
  });

  it("refuses to renumber a document whose period is locked", async () => {
    const ctx = await newBusiness();
    const a = await postEntry(ctx, "2025-04-01", ctx.acct["1100"], ctx.acct["4300"], 100);
    await postEntry(ctx, "2025-04-02", ctx.acct["1100"], ctx.acct["4300"], 100);
    await db.query(
      `UPDATE fiscal_periods SET status = 'locked' WHERE business_id = $1 AND $2::date BETWEEN starts_on AND ends_on`,
      [ctx.biz, "2025-04-01"],
    );
    const msg = await rejection(vouchers.renumberVoucher(ctx.biz, ctx.owner, a, { toVoucherNumber: 2, reason: "x" }));
    expect(msg).toMatch(/fiscal_period_locked/);
  });

  it("refuses a reference already used in the same business", async () => {
    const ctx = await newBusiness();
    const a = await postEntry(ctx, "2025-04-01", ctx.acct["1100"], ctx.acct["4300"], 100);
    const b = await postEntry(ctx, "2025-04-02", ctx.acct["1100"], ctx.acct["4300"], 100);
    await vouchers.setVoucherReference(ctx.biz, ctx.owner, a, { reference: "PAY-77", reason: "scan" });
    const msg = await rejection(vouchers.setVoucherReference(ctx.biz, ctx.owner, b, { reference: "PAY-77", reason: "scan" }));
    expect(msg).toMatch(/reference_in_use/);
  });

  it("refuses to move a document's date across a Jalali year", async () => {
    const ctx = await newBusiness();
    const a = await postEntry(ctx, "2025-04-01", ctx.acct["1100"], ctx.acct["4300"], 100);
    await expect(db.query(`UPDATE journal_entries SET entry_date = '2026-04-01' WHERE id = $1`, [a])).rejects.toThrow(
      /voucher_year_change_forbidden/,
    );
  });

  it("the SQL Jalali year matches the TypeScript calendar", async () => {
    const { rows } = await db.query<{ d: string; jy: number }>(
      `SELECT d::date::text AS d, app_jalali_year(d::date) AS jy
         FROM generate_series(DATE '2024-01-01', DATE '2030-12-31', INTERVAL '1 day') AS g(d)`,
    );
    let mismatches = 0;
    for (const row of rows) {
      const [y, m, day] = row.d.split("-").map(Number);
      if (jalali.toJalali(y, m, day).jy !== row.jy) mismatches++;
    }
    expect(rows.length).toBeGreaterThan(2000);
    expect(mismatches).toBe(0);
  });
});

describe("opening balances", () => {
  it("creates a draft only inside its fiscal year and returns the same set for the same key", async () => {
    const ctx = await newBusiness();
    const first = await opening.createOpeningBalanceSet(ctx.biz, ctx.owner, {
      fiscalYearId: ctx.fy1405,
      effectiveDate: "2026-03-21",
      idempotencyKey: "retry-1",
    });
    const again = await opening.createOpeningBalanceSet(ctx.biz, ctx.owner, {
      fiscalYearId: ctx.fy1405,
      effectiveDate: "2026-03-21",
      idempotencyKey: "retry-1",
    });
    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    expect(again.set.id).toBe(first.set.id);

    const outside = await rejection(
      opening.createOpeningBalanceSet(ctx.biz, ctx.owner, { fiscalYearId: ctx.fy1405, effectiveDate: "2025-01-01" }),
    );
    expect(outside).toMatch(/effective_date_outside_fiscal_year/);
  });

  it("refuses revenue and expense lines and an unbalanced submit", async () => {
    const ctx = await newBusiness();
    const revenue = await rejection(
      draftOpening(ctx, [
        { accountId: ctx.acct["4300"], debit: 0, credit: 100, provenance: "gl" },
        { accountId: ctx.acct["1100"], debit: 100, credit: 0, provenance: "cash_bank" },
      ]),
    );
    expect(revenue).toMatch(/invalid_lines/);

    const { set } = await opening.createOpeningBalanceSet(ctx.biz, ctx.owner, {
      fiscalYearId: ctx.fy1405,
      effectiveDate: "2026-03-21",
    });
    await opening.replaceOpeningBalanceLines(ctx.biz, set.id, [
      { accountId: ctx.acct["1100"], debit: 1000, credit: 0, provenance: "cash_bank" },
      { accountId: ctx.acct["3900"], debit: 0, credit: 900, provenance: "equity" },
    ]);
    const msg = await rejection(opening.submitOpeningBalanceSet(ctx.biz, ctx.owner, set.id));
    expect(msg).toMatch(/opening_not_balanced/);
  });

  it("needs a second person to approve, posts exactly, and then refuses edits", async () => {
    const ctx = await newBusiness();
    const { set } = await opening.createOpeningBalanceSet(ctx.biz, ctx.owner, {
      fiscalYearId: ctx.fy1405,
      effectiveDate: "2026-03-21",
    });
    await opening.replaceOpeningBalanceLines(ctx.biz, set.id, [
      { accountId: ctx.acct["1100"], debit: 1000, credit: 0, provenance: "cash_bank" },
      { accountId: ctx.acct["1200"], debit: 500, credit: 0, provenance: "ar", customerId: ctx.customerId },
      { accountId: ctx.acct["3900"], debit: 0, credit: 1500, provenance: "equity" },
    ]);
    await opening.submitOpeningBalanceSet(ctx.biz, ctx.owner, set.id);

    const selfApprove = await rejection(opening.approveOpeningBalanceSet(ctx.biz, ctx.owner, set.id));
    expect(selfApprove).toMatch(/self_approval_forbidden/);

    await opening.approveOpeningBalanceSet(ctx.biz, ctx.accountant, set.id);
    const posted = await opening.postOpeningBalanceSet(ctx.biz, ctx.accountant, set.id);
    expect(posted.status).toBe("posted");
    expect(posted.journalEntryId).not.toBeNull();

    const entry = await db.query<{ entry_date: string; source_type: string }>(
      `SELECT entry_date::text AS entry_date, source_type FROM journal_entries WHERE id = $1`,
      [posted.journalEntryId],
    );
    expect(entry.rows[0]).toEqual({ entry_date: "2026-03-21", source_type: "opening_balance" });
    expect(await accountBalance(ctx.acct["1100"])).toBe(1000);
    expect(await accountBalance(ctx.acct["1200"])).toBe(500);
    expect((await voucherOf(posted.journalEntryId!)).voucher_year).toBe(1405);

    const edit = await rejection(
      opening.replaceOpeningBalanceLines(ctx.biz, set.id, [
        { accountId: ctx.acct["1100"], debit: 1, credit: 0, provenance: "cash_bank" },
        { accountId: ctx.acct["3900"], debit: 0, credit: 1, provenance: "equity" },
      ]),
    );
    expect(edit).toMatch(/opening_not_editable/);
  });

  it("refuses to reverse while a later posting depends on the opening, and reverses once it is gone", async () => {
    const ctx = await newBusiness();
    const { set } = await opening.createOpeningBalanceSet(ctx.biz, ctx.owner, {
      fiscalYearId: ctx.fy1405,
      effectiveDate: "2026-03-21",
    });
    await opening.replaceOpeningBalanceLines(ctx.biz, set.id, [
      { accountId: ctx.acct["1100"], debit: 1000, credit: 0, provenance: "cash_bank" },
      { accountId: ctx.acct["3900"], debit: 0, credit: 1000, provenance: "equity" },
    ]);
    await opening.submitOpeningBalanceSet(ctx.biz, ctx.owner, set.id);
    await opening.approveOpeningBalanceSet(ctx.biz, ctx.accountant, set.id);
    const posted = await opening.postOpeningBalanceSet(ctx.biz, ctx.accountant, set.id);

    const dependent = await postEntry(ctx, "2026-04-01", ctx.acct["1100"], ctx.acct["4300"], 200);
    const blocked = await rejection(opening.reverseOpeningBalanceSet(ctx.biz, ctx.accountant, set.id, "wrong amount"));
    expect(blocked).toMatch(/opening_has_dependent_postings/);

    await db.query(`DELETE FROM journal_lines WHERE entry_id = $1`, [dependent]);
    await db.query(`DELETE FROM journal_entries WHERE id = $1`, [dependent]);

    const reversed = await opening.reverseOpeningBalanceSet(ctx.biz, ctx.accountant, set.id, "wrong amount");
    expect(reversed.status).toBe("reversed");
    expect(reversed.reversalEntryId).not.toBeNull();
    expect(await accountBalance(ctx.acct["1100"])).toBe(0);
    expect(posted.journalEntryId).not.toBeNull();
  });

  it("keeps a single posted opening per fiscal year", async () => {
    const ctx = await newBusiness();
    const lines = [
      { accountId: ctx.acct["1100"], debit: 1000, credit: 0, provenance: "cash_bank" },
      { accountId: ctx.acct["3900"], debit: 0, credit: 1000, provenance: "equity" },
    ];
    const first = (await draftOpening(ctx, lines)).id;
    await opening.submitOpeningBalanceSet(ctx.biz, ctx.owner, first);
    await opening.approveOpeningBalanceSet(ctx.biz, ctx.accountant, first);
    await opening.postOpeningBalanceSet(ctx.biz, ctx.accountant, first);

    const second = (await draftOpening(ctx, lines)).id;
    await opening.submitOpeningBalanceSet(ctx.biz, ctx.owner, second);
    await opening.approveOpeningBalanceSet(ctx.biz, ctx.accountant, second);
    const msg = await rejection(opening.postOpeningBalanceSet(ctx.biz, ctx.accountant, second));
    expect(msg).toMatch(/opening_already_posted/);
  });

  it("does not show one business's opening to another", async () => {
    const ours = await newBusiness();
    const theirs = await newBusiness();
    const { set } = await opening.createOpeningBalanceSet(ours.biz, ours.owner, {
      fiscalYearId: ours.fy1405,
      effectiveDate: "2026-03-21",
    });
    const msg = await rejection(opening.getOpeningBalanceSet(theirs.biz, set.id));
    expect(msg).toMatch(/opening_set_not_found/);
  });
});

describe("carry-forward into the next fiscal year", () => {
  it("is refused until the prior year is closed", async () => {
    const ctx = await newBusiness();
    const msg = await rejection(opening.generateCarryForwardProposal(ctx.biz, ctx.owner, ctx.fy1405));
    expect(msg).toMatch(/prior_fiscal_year_not_closed/);
  });

  it("carries balance-sheet balances with party attribution, leaves out revenue and expense, and reconciles to the prior close", async () => {
    const ctx = await newBusiness();

    // 1404: an attributed opening, then a sale and an expense, then year-end close.
    const { set: open1404 } = await opening.createOpeningBalanceSet(ctx.biz, ctx.owner, {
      fiscalYearId: ctx.fy1404,
      effectiveDate: "2025-03-21",
    });
    await opening.replaceOpeningBalanceLines(ctx.biz, open1404.id, [
      { accountId: ctx.acct["1100"], debit: 1_000_000, credit: 0, provenance: "cash_bank" },
      { accountId: ctx.acct["1200"], debit: 500_000, credit: 0, provenance: "ar", customerId: ctx.customerId, sourceRef: "INV-OLD-1" },
      { accountId: ctx.acct["2100"], debit: 0, credit: 300_000, provenance: "ap", supplierId: ctx.supplierId, sourceRef: "BILL-OLD-9" },
      { accountId: ctx.acct["3900"], debit: 0, credit: 1_200_000, provenance: "equity" },
    ]);
    await opening.submitOpeningBalanceSet(ctx.biz, ctx.owner, open1404.id);
    await opening.approveOpeningBalanceSet(ctx.biz, ctx.accountant, open1404.id);
    await opening.postOpeningBalanceSet(ctx.biz, ctx.accountant, open1404.id);

    await postEntry(ctx, "2025-06-01", ctx.acct["1100"], ctx.acct["4300"], 800_000);
    await postEntry(ctx, "2025-07-01", ctx.acct["5900"], ctx.acct["1100"], 100_000);

    await softCloseAll(ctx, ctx.fy1404);
    const closed = await closing.closeFiscalYear(ctx.biz, ctx.fy1404, ctx.owner);
    expect(closed.netIncome).toBe(700_000);

    // Next year: a generated proposal, exactly the balance sheet at close.
    const gen = await opening.generateCarryForwardProposal(ctx.biz, ctx.owner, ctx.fy1405);
    expect(gen.created).toBe(true);
    expect(gen.set.kind).toBe("carry_forward");
    expect(gen.set.effectiveDate).toBe("2026-03-21");

    const byCode = new Map(gen.set.lines.map((l) => [l.accountCode, l]));
    expect(byCode.has("4300")).toBe(false);
    expect(byCode.has("5900")).toBe(false);
    expect(byCode.get("1100")).toMatchObject({ debit: 1_700_000, credit: 0 });
    expect(byCode.get("1200")).toMatchObject({ debit: 500_000, customerId: ctx.customerId });
    expect(byCode.get("2100")).toMatchObject({ credit: 300_000, supplierId: ctx.supplierId });
    expect(byCode.get("3800")).toMatchObject({ credit: 700_000 });
    expect(byCode.get("3900")).toMatchObject({ credit: 1_200_000 });
    expect(gen.set.totals.totalDebit).toBe(gen.set.totals.totalCredit);

    // Generating again returns the same proposal, not a second one.
    const again = await opening.generateCarryForwardProposal(ctx.biz, ctx.owner, ctx.fy1405);
    expect(again.created).toBe(false);
    expect(again.set.id).toBe(gen.set.id);

    // Reconciliation to the prior close, then the approval gate.
    const comparison = await opening.priorCloseComparison(ctx.biz, ctx.fy1405);
    expect(comparison.closed).toBe(true);

    await opening.submitOpeningBalanceSet(ctx.biz, ctx.owner, gen.set.id);
    await opening.approveOpeningBalanceSet(ctx.biz, ctx.accountant, gen.set.id);
    const posted = await opening.postOpeningBalanceSet(ctx.biz, ctx.accountant, gen.set.id);
    expect(posted.status).toBe("posted");
    // A carry-forward is a reconciled register: it adds no journal entry, so
    // the ledger keeps one copy of each balance.
    expect(posted.journalEntryId).toBeNull();
    expect(await accountBalance(ctx.acct["1100"])).toBe(1_700_000);
    const reverseCf = await rejection(opening.reverseOpeningBalanceSet(ctx.biz, ctx.owner, gen.set.id, "redo"));
    expect(reverseCf).toMatch(/carry_forward_not_reversible/);

    // Party attribution survived: the customer's A/R is still 500,000 in the new year.
    const arRows = await ar.listCustomerBalances(ctx.biz);
    const mine = arRows.find((r) => r.customerId === ctx.customerId);
    expect(mine?.balance).toBe(500_000);
    expect((await ar.getCustomerArBalance(ctx.biz, ctx.customerId)).balance).toBe(500_000);
  });

  it("refuses a first opening when balance-sheet activity already sits before its date", async () => {
    const ctx = await newBusiness();
    await postEntry(ctx, "2025-04-01", ctx.acct["1100"], ctx.acct["3900"], 500);
    const { set } = await opening.createOpeningBalanceSet(ctx.biz, ctx.owner, {
      fiscalYearId: ctx.fy1405,
      effectiveDate: "2026-03-21",
    });
    await opening.replaceOpeningBalanceLines(ctx.biz, set.id, [
      { accountId: ctx.acct["1100"], debit: 1000, credit: 0, provenance: "cash_bank" },
      { accountId: ctx.acct["3900"], debit: 0, credit: 1000, provenance: "equity" },
    ]);
    await opening.submitOpeningBalanceSet(ctx.biz, ctx.owner, set.id);
    await opening.approveOpeningBalanceSet(ctx.biz, ctx.accountant, set.id);
    const msg = await rejection(opening.postOpeningBalanceSet(ctx.biz, ctx.accountant, set.id));
    expect(msg).toMatch(/opening_would_duplicate_ledger/);
  });
});
