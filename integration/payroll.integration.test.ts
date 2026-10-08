/**
 * Phase 16 scope: "Payroll entries — staff cost accrual and payment
 * postings (journal-level, not a payroll engine)." Proves: accrual posts a
 * balanced entry against every active staff member's current monthly_wage,
 * snapshotting each person's amount so it survives a later wage change;
 * paying an accrued run posts the other half and can't happen twice; and a
 * run with no wages set is refused rather than posting a zero entry.
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
let payrollService: typeof import("../src/lib/payroll-service");
let fiscalService: typeof import("../src/lib/fiscal-periods-service");
let provisioning: typeof import("../src/lib/business-provisioning");

const biz = { id: "" };
const acct = { cash: "", salariesExpense: "", salariesPayable: "" };
const staff = { a: "", b: "" };
const owner = { id: "" };

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
  databaseName = `pos_payroll_${randomUUID().replaceAll("-", "")}`;

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
  payrollService = await import("../src/lib/payroll-service");
  fiscalService = await import("../src/lib/fiscal-periods-service");
  provisioning = await import("../src/lib/business-provisioning");

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
  await db.query("DELETE FROM payroll_advances");
  await db.query("DELETE FROM payroll_run_lines");
  await db.query("DELETE FROM payroll_runs");
  await db.query("DELETE FROM journal_lines");
  await db.query("DELETE FROM journal_entries");
  await db.query("DELETE FROM businesses");

  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ('Payroll Co', $1) RETURNING id",
    [`payroll-${randomUUID().slice(0, 8)}`],
  );
  biz.id = bizRow.rows[0].id;

  const ownerRow = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, pin_hash) VALUES ($1, 'owner', 'Owner', 'x') RETURNING id`,
    [biz.id],
  );
  owner.id = ownerRow.rows[0].id;

  const staffRows = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, pin_hash, monthly_wage)
     VALUES ($1, 'cashier', 'Staff A', 'x', 30000000), ($1, 'waiter', 'Staff B', 'x', 20000000)
     RETURNING id`,
    [biz.id],
  );
  staff.a = staffRows.rows[0].id;
  staff.b = staffRows.rows[1].id;

  const accounts = await db.query<{ id: string; code: string }>(
    `INSERT INTO accounts (business_id, code, name, type)
     VALUES ($1, '1100', 'Cash', 'asset'), ($1, '5200', 'Salaries expense', 'expense'), ($1, '2300', 'Salaries payable', 'liability')
     RETURNING id, code`,
    [biz.id],
  );
  for (const r of accounts.rows) {
    if (r.code === "1100") acct.cash = r.id;
    if (r.code === "5200") acct.salariesExpense = r.id;
    if (r.code === "2300") acct.salariesPayable = r.id;
  }
});

describe("setWage / listStaffWages", () => {
  it("sets and lists a staff member's monthly wage", async () => {
    await payrollService.setWage(biz.id, staff.a, 35_000_000);
    const list = await payrollService.listStaffWages(biz.id);
    expect(list.find((s) => s.id === staff.a)!.monthlyWage).toBe(35_000_000);
  });

  it("rejects a negative wage", async () => {
    await expect(payrollService.setWage(biz.id, staff.a, -1)).rejects.toThrow("invalid_amount");
  });

  it("404s setting a wage for a user that doesn't exist", async () => {
    await expect(payrollService.setWage(biz.id, randomUUID(), 10_000_000)).rejects.toThrow("user_not_found");
  });

  // A non-uuid used to reach `WHERE id = $1` against a uuid column, which
  // raises `invalid input syntax for type uuid` — a 500 and «خطای غیرمنتظره»
  // where an honest 404 belongs.
  it("404s (not 500) for an id that isn't a uuid", async () => {
    await expect(payrollService.setWage(biz.id, "not-a-uuid", 10_000_000)).rejects.toThrow("user_not_found");
  });

  it("rejects a fractional wage", async () => {
    await expect(payrollService.setWage(biz.id, staff.a, 1_000.5)).rejects.toThrow("invalid_amount");
  });

  it("clears a wage when passed null", async () => {
    await payrollService.setWage(biz.id, staff.a, null);
    const list = await payrollService.listStaffWages(biz.id);
    expect(list.find((s) => s.id === staff.a)!.monthlyWage).toBeNull();
  });
});

describe("accruePayroll", () => {
  it("posts a balanced entry summing every active staff member's current wage", async () => {
    const run = await payrollService.accruePayroll({
      businessId: biz.id,
      locationId: null,
      periodKey: "1404-05",
      accrualDate: "2025-05-20",
      createdBy: owner.id,
    });
    expect(run.totalAmount).toBe(50_000_000);
    expect(run.status).toBe("accrued");
    expect(run.lines.map((l) => l.amount).sort((a, b) => a - b)).toEqual([20_000_000, 30_000_000]);

    const { rows: entries } = await db.query(
      `SELECT source_type, source_id, entry_date::text AS entry_date FROM journal_entries WHERE business_id = $1`,
      [biz.id],
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ source_type: "payroll_accrual", source_id: run.id, entry_date: "2025-05-20" });

    const { rows: lines } = await db.query(
      `SELECT account_id, debit, credit FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id WHERE je.business_id = $1 ORDER BY debit DESC`,
      [biz.id],
    );
    expect(lines).toEqual([
      { account_id: acct.salariesExpense, debit: "50000000", credit: "0" },
      { account_id: acct.salariesPayable, debit: "0", credit: "50000000" },
    ]);
  });

  it("snapshots each person's amount so a later wage change doesn't affect a past run", async () => {
    const run = await payrollService.accruePayroll({
      businessId: biz.id,
      locationId: null,
      periodKey: "1404-05",
      createdBy: owner.id,
    });
    await payrollService.setWage(biz.id, staff.a, 99_000_000);

    const runs = await payrollService.listPayrollRuns(biz.id);
    const reloaded = runs.find((r) => r.id === run.id)!;
    expect(reloaded.totalAmount).toBe(50_000_000);
    expect(reloaded.lines.find((l) => l.userId === staff.a)!.amount).toBe(30_000_000);
  });

  it("excludes staff with no wage set or a zero wage", async () => {
    await db.query(`UPDATE users SET monthly_wage = 0 WHERE id = $1`, [staff.b]);
    const run = await payrollService.accruePayroll({
      businessId: biz.id,
      locationId: null,
      periodKey: "1404-05",
      createdBy: owner.id,
    });
    expect(run.totalAmount).toBe(30_000_000);
    expect(run.lines).toHaveLength(1);
  });

  it("refuses to accrue when no staff has a wage set", async () => {
    await db.query(`UPDATE users SET monthly_wage = NULL WHERE business_id = $1`, [biz.id]);
    await expect(
      payrollService.accruePayroll({ businessId: biz.id, locationId: null, periodKey: "1404-05", createdBy: owner.id }),
    ).rejects.toThrow("no_wages_set");
  });

  // The period is a Jalali month from a selector (audit F11), not free text.
  it.each(["", "  ", "مرداد ۱۴۰۴", "1404-13", "1404-5", "1404-00"])("rejects the period %j", async (periodKey) => {
    await expect(
      payrollService.accruePayroll({ businessId: biz.id, locationId: null, periodKey, createdBy: owner.id }),
    ).rejects.toThrow("invalid_period");
  });

  it("rejects a month that has not started yet", async () => {
    await expect(
      payrollService.accruePayroll({ businessId: biz.id, locationId: null, periodKey: "1499-01", createdBy: owner.id }),
    ).rejects.toThrow("period_in_future");
  });

  it("stores the month as a key and a Persian label", async () => {
    const run = await payrollService.accruePayroll({
      businessId: biz.id,
      locationId: null,
      periodKey: "1404-05",
      createdBy: owner.id,
    });
    expect(run.periodKey).toBe("1404-05");
    expect(run.periodLabel).toBe("مرداد 1404");
    // A closed month with no date given is dated on its own last day (31 مرداد 1404).
    expect(run.accrualDate).toBe("2025-08-22");
  });

  it("allows one standing run per month, and a new one once it is voided", async () => {
    const run = await payrollService.accruePayroll({
      businessId: biz.id,
      locationId: null,
      periodKey: "1404-05",
      createdBy: owner.id,
    });
    await expect(
      payrollService.accruePayroll({ businessId: biz.id, locationId: null, periodKey: "1404-05", createdBy: owner.id }),
    ).rejects.toThrow("period_already_accrued");
    await payrollService.voidPayrollRun({ businessId: biz.id, locationId: null, runId: run.id, actorId: owner.id });
    const again = await payrollService.accruePayroll({
      businessId: biz.id,
      locationId: null,
      periodKey: "1404-05",
      createdBy: owner.id,
    });
    expect(again.status).toBe("accrued");
  });

  it("keeps reading a run recorded with a free-text period before audit F11", async () => {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO payroll_runs (business_id, period_label, total_amount, accrual_date)
       VALUES ($1, 'مرداد قدیمی', 30000000, '2025-05-20') RETURNING id`,
      [biz.id],
    );
    await db.query(`INSERT INTO payroll_run_lines (run_id, user_id, amount) VALUES ($1, $2, 30000000)`, [
      rows[0].id,
      staff.a,
    ]);
    const [legacy] = await payrollService.listPayrollRuns(biz.id);
    expect(legacy).toMatchObject({ periodKey: null, periodLabel: "مرداد قدیمی", totalAmount: 30_000_000, netAmount: 30_000_000 });
    expect(legacy.lines[0]).toMatchObject({ amount: 30_000_000, baseSalaryRial: 30_000_000, grossRial: 30_000_000, netPayRial: 30_000_000 });
  });

  /*
   * Both of these used to reach the entry's `COALESCE($3::date, CURRENT_DATE)`
   * and fail there as SQLSTATE 22007/22008, which no route maps — so the
   * caller saw a 500 and «خطای غیرمنتظره» rather than "that date is invalid".
   */
  it("rejects a malformed accrual date with a 400, not a date-cast 500", async () => {
    await expect(
      payrollService.accruePayroll({
        businessId: biz.id,
        locationId: null,
        periodKey: "1404-05",
        accrualDate: "banana",
        createdBy: owner.id,
      }),
    ).rejects.toThrow("invalid_accrual_date");
  });

  it("rejects a well-shaped but non-existent accrual date", async () => {
    await expect(
      payrollService.accruePayroll({
        businessId: biz.id,
        locationId: null,
        periodKey: "1404-05",
        accrualDate: "2025-02-31",
        createdBy: owner.id,
      }),
    ).rejects.toThrow("invalid_accrual_date");
  });

  it("treats a whitespace-only accrual date as absent (the month's default date) rather than crashing", async () => {
    const run = await payrollService.accruePayroll({
      businessId: biz.id,
      locationId: null,
      periodKey: "1404-05",
      accrualDate: "   ",
      createdBy: owner.id,
    });
    const { rows } = await db.query<{ entry_date: string }>(
      `SELECT entry_date::text AS entry_date FROM journal_entries
        WHERE business_id = $1 AND source_type = 'payroll_accrual'`,
      [biz.id],
    );
    // The run row and its journal entry share one date — the desync this
    // normalisation exists to prevent.
    expect(rows[0].entry_date).toBe(run.accrualDate);
  });

  // Nothing may be left behind when the date is refused: the run row, its
  // lines and the journal entry are one transaction.
  it("writes no run when the accrual is refused", async () => {
    await expect(
      payrollService.accruePayroll({
        businessId: biz.id,
        locationId: null,
        periodKey: "1404-05",
        accrualDate: "2025-02-31",
        createdBy: owner.id,
      }),
    ).rejects.toThrow("invalid_accrual_date");

    const { rows } = await db.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM payroll_runs WHERE business_id = $1",
      [biz.id],
    );
    expect(Number(rows[0].count)).toBe(0);
  });

  it("rejects accruing into a locked fiscal period", async () => {
    await fiscalService.createFiscalYear(biz.id, 1404);
    const [year] = await fiscalService.listFiscalYears(biz.id);
    const [farvardin] = await fiscalService.listPeriods(biz.id, year.id);
    await fiscalService.setPeriodStatus(biz.id, farvardin.id, "soft_closed", owner.id);
    await fiscalService.setPeriodStatus(biz.id, farvardin.id, "locked", owner.id);

    await expect(
      payrollService.accruePayroll({
        businessId: biz.id,
        locationId: null,
        periodKey: "1404-01",
        accrualDate: farvardin.startsOn,
        createdBy: owner.id,
      }),
    ).rejects.toThrow("fiscal_period_locked");
  });
});

describe("payPayroll", () => {
  it("posts the payment half and marks the run paid", async () => {
    const run = await payrollService.accruePayroll({
      businessId: biz.id,
      locationId: null,
      periodKey: "1404-05",
      createdBy: owner.id,
    });

    const paid = await payrollService.payPayroll({
      businessId: biz.id,
      locationId: null,
      runId: run.id,
      method: "cash",
      actorId: owner.id,
    });
    expect(paid.status).toBe("paid");
    expect(paid.paidDate).not.toBeNull();

    const { rows: entries } = await db.query(
      `SELECT source_type, source_id FROM journal_entries WHERE business_id = $1 AND source_type = 'payroll_payment'`,
      [biz.id],
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].source_id).toBe(run.id);

    const { rows: lines } = await db.query(
      `SELECT account_id, debit, credit FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.entry_id
        WHERE je.source_type = 'payroll_payment' AND je.business_id = $1 ORDER BY debit DESC`,
      [biz.id],
    );
    expect(lines).toEqual([
      { account_id: acct.salariesPayable, debit: "50000000", credit: "0" },
      { account_id: acct.cash, debit: "0", credit: "50000000" },
    ]);
  });

  it("404s paying a run that doesn't exist", async () => {
    await expect(
      payrollService.payPayroll({ businessId: biz.id, locationId: null, runId: randomUUID(), method: "cash", actorId: owner.id }),
    ).rejects.toThrow("run_not_found");
  });

  it("404s (not 500) paying a run id that isn't a uuid", async () => {
    await expect(
      payrollService.payPayroll({ businessId: biz.id, locationId: null, runId: "nope", method: "cash", actorId: owner.id }),
    ).rejects.toThrow("run_not_found");
  });

  it("rejects a malformed paid date with a 400, not a date-cast 500", async () => {
    const run = await payrollService.accruePayroll({
      businessId: biz.id,
      locationId: null,
      periodKey: "1404-05",
      createdBy: owner.id,
    });
    await expect(
      payrollService.payPayroll({
        businessId: biz.id,
        locationId: null,
        runId: run.id,
        method: "cash",
        paidDate: "2025-02-31",
        actorId: owner.id,
      }),
    ).rejects.toThrow("invalid_paid_date");

    // And the run is still payable — a refused date must not half-pay it.
    const [reloaded] = await payrollService.listPayrollRuns(biz.id);
    expect(reloaded.status).toBe("accrued");
  });

  it("credits the bank-clearing account when the method is bank", async () => {
    const run = await payrollService.accruePayroll({
      businessId: biz.id,
      locationId: null,
      periodKey: "1404-05",
      createdBy: owner.id,
    });
    // 1120 has to exist for the bank path; the fixture's chart only has 1100.
    const bankClearing = await db.query<{ id: string }>(
      `INSERT INTO accounts (business_id, code, name, type) VALUES ($1, '1120', 'Bank clearing', 'asset') RETURNING id`,
      [biz.id],
    );
    await payrollService.payPayroll({
      businessId: biz.id,
      locationId: null,
      runId: run.id,
      method: "bank",
      actorId: owner.id,
    });

    const { rows } = await db.query<{ account_id: string; credit: string }>(
      `SELECT jl.account_id, jl.credit::text AS credit FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.entry_id
        WHERE je.business_id = $1 AND je.source_type = 'payroll_payment' AND jl.credit > 0`,
      [biz.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].account_id).toBe(bankClearing.rows[0].id);
    // Not the till: the whole point of the method switch.
    expect(rows[0].account_id).not.toBe(acct.cash);
  });

  /**
   * The double-payment race.
   *
   * The status check used to run on an unlocked read *before* the transaction
   * opened, so two concurrent clicks (a double-click, or the run open in two
   * tabs) both saw `accrued` and both posted a payment: the wage bill left
   * Cash twice and salariesPayable went negative, with nothing in the UI to
   * show it. `SELECT … FOR UPDATE` inside the transaction is what serialises
   * them.
   *
   * The interleaving is forced rather than hoped for. Firing both calls with
   * `Promise.allSettled` only *sometimes* produces the overlap — it passed
   * against the unfixed service often enough to be worthless as a regression
   * test. Holding a competing lock on the row until the payment is in flight
   * guarantees the second call reaches its status check after the first has
   * committed, which is exactly the window the bug lived in.
   */
  it("pays only once when two payments race", async () => {
    const run = await payrollService.accruePayroll({
      businessId: biz.id,
      locationId: null,
      periodKey: "1404-05",
      createdBy: owner.id,
    });

    /*
     * A competing transaction pays the run while this call is in flight.
     *
     * It holds the row locked, so the call under test stalls; the competitor
     * then commits `status = 'paid'` and releases. What happens on resume is
     * the whole question. Reading the status inside the transaction with
     * `FOR UPDATE` means the read happens *after* that commit and returns
     * 'paid', so the payment is refused. The unfixed version had already read
     * 'accrued' on an unlocked connection before the transaction even opened,
     * so it carried that stale answer past the competitor and posted a second
     * payment — cash credited twice for one wage bill.
     *
     * Racing two real payPayroll calls does not test this: it passes against
     * the unfixed service whenever the scheduler happens not to overlap them.
     */
    const competitor = new Client({ connectionString: urlFor(databaseName) });
    await competitor.connect();
    await competitor.query("SELECT set_config('app.rls_bypass', 'on', true)");
    await competitor.query("BEGIN");
    await competitor.query("SELECT id FROM payroll_runs WHERE id = $1 FOR UPDATE", [run.id]);

    const inFlight = payrollService
      .payPayroll({ businessId: biz.id, locationId: null, runId: run.id, method: "cash", actorId: owner.id })
      .then(() => "posted" as const)
      .catch((e: unknown) => (e instanceof Error ? e.message : String(e)));

    // Let it reach the lock wait, then commit the competing payment.
    await new Promise((resolve) => setTimeout(resolve, 250));
    await competitor.query("UPDATE payroll_runs SET status = 'paid', paid_date = CURRENT_DATE WHERE id = $1", [run.id]);
    await competitor.query("COMMIT");
    await competitor.end();

    expect(await inFlight).toBe("already_paid");

    // Nothing was posted: the competitor only flipped the status, so any
    // payment entry here is the duplicate this test exists to catch.
    const { rows: entries } = await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM journal_entries
        WHERE business_id = $1 AND source_type = 'payroll_payment'`,
      [biz.id],
    );
    expect(Number(entries[0].count)).toBe(0);

    const { rows: cash } = await db.query<{ credit: string }>(
      `SELECT COALESCE(SUM(jl.credit), 0)::text AS credit FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.entry_id
        WHERE je.business_id = $1 AND jl.account_id = $2`,
      [biz.id, acct.cash],
    );
    expect(Number(cash[0].credit)).toBe(0);
  });

  it("refuses to pay an already-paid run", async () => {
    const run = await payrollService.accruePayroll({
      businessId: biz.id,
      locationId: null,
      periodKey: "1404-05",
      createdBy: owner.id,
    });
    await payrollService.payPayroll({ businessId: biz.id, locationId: null, runId: run.id, method: "cash", actorId: owner.id });

    await expect(
      payrollService.payPayroll({ businessId: biz.id, locationId: null, runId: run.id, method: "cash", actorId: owner.id }),
    ).rejects.toThrow("already_paid");
  });

  it("treats an empty-string paidDate as today rather than crashing on a date cast", async () => {
    const run = await payrollService.accruePayroll({
      businessId: biz.id,
      locationId: null,
      periodKey: "1404-05",
      createdBy: owner.id,
    });
    const paid = await payrollService.payPayroll({
      businessId: biz.id,
      locationId: null,
      runId: run.id,
      method: "cash",
      paidDate: "   ",
      actorId: owner.id,
    });
    expect(paid.status).toBe("paid");
    expect(paid.paidDate).not.toBeNull();

    // The run's paid_date and the payment entry's date agree (both today).
    const { rows } = await db.query<{ entry_date: string }>(
      `SELECT entry_date::text AS entry_date FROM journal_entries WHERE business_id = $1 AND source_type = 'payroll_payment'`,
      [biz.id],
    );
    expect(rows[0].entry_date).toBe(paid.paidDate);
  });
});

describe("voidPayrollRun", () => {
  it("reverses an accrued (unpaid) run with a single mirror entry and marks it voided", async () => {
    const run = await payrollService.accruePayroll({
      businessId: biz.id,
      locationId: null,
      periodKey: "1404-05",
      accrualDate: "2025-05-20",
      createdBy: owner.id,
    });

    const voided = await payrollService.voidPayrollRun({
      businessId: biz.id,
      locationId: null,
      runId: run.id,
      actorId: owner.id,
    });
    expect(voided.status).toBe("voided");
    expect(voided.voidedDate).not.toBeNull();

    // Original accrual + its mirror = two entries; the mirror swaps debit/credit.
    const { rows: entries } = await db.query<{ source_type: string; reverses_entry_id: string | null }>(
      `SELECT source_type, reverses_entry_id FROM journal_entries WHERE business_id = $1 ORDER BY posted_at`,
      [biz.id],
    );
    expect(entries.map((e) => e.source_type).sort()).toEqual(["payroll_accrual", "payroll_accrual_void"]);
    const mirror = entries.find((e) => e.source_type === "payroll_accrual_void")!;
    expect(mirror.reverses_entry_id).not.toBeNull();

    // The two entries net to zero on every account (5200 and 2300).
    const { rows: net } = await db.query<{ code: string; net: string }>(
      `SELECT a.code, (SUM(jl.debit) - SUM(jl.credit))::text AS net
         FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.entry_id
         JOIN accounts a ON a.id = jl.account_id
        WHERE je.business_id = $1 GROUP BY a.code`,
      [biz.id],
    );
    for (const r of net) expect(Number(r.net)).toBe(0);
  });

  it("reverses both the accrual and the payment of a paid run", async () => {
    const run = await payrollService.accruePayroll({
      businessId: biz.id,
      locationId: null,
      periodKey: "1404-05",
      createdBy: owner.id,
    });
    await payrollService.payPayroll({ businessId: biz.id, locationId: null, runId: run.id, method: "cash", actorId: owner.id });

    const voided = await payrollService.voidPayrollRun({
      businessId: biz.id,
      locationId: null,
      runId: run.id,
      actorId: owner.id,
    });
    expect(voided.status).toBe("voided");

    const { rows: bySource } = await db.query<{ source_type: string; count: string }>(
      `SELECT source_type, COUNT(*)::text AS count FROM journal_entries WHERE business_id = $1 GROUP BY source_type ORDER BY source_type`,
      [biz.id],
    );
    const counts = Object.fromEntries(bySource.map((r) => [r.source_type, Number(r.count)]));
    expect(counts).toMatchObject({
      payroll_accrual: 1,
      payroll_accrual_void: 1,
      payroll_payment: 1,
      payroll_payment_void: 1,
    });

    // Every account nets to zero once both halves are reversed.
    const { rows: net } = await db.query<{ net: string }>(
      `SELECT (SUM(jl.debit) - SUM(jl.credit))::text AS net
         FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
        WHERE je.business_id = $1 GROUP BY jl.account_id`,
      [biz.id],
    );
    for (const r of net) expect(Number(r.net)).toBe(0);
  });

  it("refuses to void an already-voided run", async () => {
    const run = await payrollService.accruePayroll({
      businessId: biz.id,
      locationId: null,
      periodKey: "1404-05",
      createdBy: owner.id,
    });
    await payrollService.voidPayrollRun({ businessId: biz.id, locationId: null, runId: run.id, actorId: owner.id });

    await expect(
      payrollService.voidPayrollRun({ businessId: biz.id, locationId: null, runId: run.id, actorId: owner.id }),
    ).rejects.toThrow("already_voided");
  });

  it("404s voiding a run that doesn't exist", async () => {
    await expect(
      payrollService.voidPayrollRun({ businessId: biz.id, locationId: null, runId: randomUUID(), actorId: owner.id }),
    ).rejects.toThrow("run_not_found");
  });

  it("404s (not 500) voiding a run id that isn't a uuid", async () => {
    await expect(
      payrollService.voidPayrollRun({ businessId: biz.id, locationId: null, runId: "nope", actorId: owner.id }),
    ).rejects.toThrow("run_not_found");
  });

  // Same race as paying: two «ابطال» clicks both read `accrued` on an unlocked
  // check and both mirrored the run's entries, double-reversing it. Forced the
  // same way — see the payment race for why allSettled alone proves nothing.
  it("voids only once when two voids race", async () => {
    const run = await payrollService.accruePayroll({
      businessId: biz.id,
      locationId: null,
      periodKey: "1404-05",
      createdBy: owner.id,
    });

    const competitor = new Client({ connectionString: urlFor(databaseName) });
    await competitor.connect();
    await competitor.query("SELECT set_config('app.rls_bypass', 'on', true)");
    await competitor.query("BEGIN");
    await competitor.query("SELECT id FROM payroll_runs WHERE id = $1 FOR UPDATE", [run.id]);

    const inFlight = payrollService
      .voidPayrollRun({ businessId: biz.id, locationId: null, runId: run.id, actorId: owner.id })
      .then(() => "voided" as const)
      .catch((e: unknown) => (e instanceof Error ? e.message : String(e)));

    await new Promise((resolve) => setTimeout(resolve, 250));
    await competitor.query("UPDATE payroll_runs SET status = 'voided', voided_at = now() WHERE id = $1", [run.id]);
    await competitor.query("COMMIT");
    await competitor.end();

    expect(await inFlight).toBe("already_voided");

    // No reversal was mirrored, so the accrual stands exactly once.
    const { rows } = await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM journal_entries
        WHERE business_id = $1 AND source_type = 'payroll_accrual_void'`,
      [biz.id],
    );
    expect(Number(rows[0].count)).toBe(0);
  });

  it("refuses to pay a voided run", async () => {
    const run = await payrollService.accruePayroll({
      businessId: biz.id,
      locationId: null,
      periodKey: "1404-05",
      createdBy: owner.id,
    });
    await payrollService.voidPayrollRun({ businessId: biz.id, locationId: null, runId: run.id, actorId: owner.id });

    await expect(
      payrollService.payPayroll({ businessId: biz.id, locationId: null, runId: run.id, method: "cash", actorId: owner.id }),
    ).rejects.toThrow("run_voided");
  });
});

/**
 * Payroll is not an F&B feature: `industry-profile.ts` puts `ledger` in
 * CORE_MODULES, so /dashboard/ledger → «حقوق و دستمزد» is offered to a jeweller
 * and a cosmetics shop exactly as it is to a café. Their seeded charts, though,
 * were written as "the generic accounts plus this trade's inventory/revenue/COGS
 * triple" and never picked up 5200 — so every one of those businesses got
 * `ledger_account_missing: 5200` the first time it ran payroll.
 *
 * This seeds from the real template rather than hand-inserting the accounts,
 * which is the whole point: hand-inserting is what let the gap hide.
 */
describe("payroll for a business that is not a café", () => {
  it.each(["jewelry", "watch", "accessories", "cosmetics"] as const)(
    "accrues against the %s template's own chart",
    async (industry) => {
      const bizRow = await db.query<{ id: string }>(
        "INSERT INTO businesses (name, slug, industry) VALUES ($1, $2, $3) RETURNING id",
        [`${industry} Co`, `${industry}-${randomUUID().slice(0, 8)}`, industry],
      );
      const businessId = bizRow.rows[0].id;

      await db.query(
        `INSERT INTO users (business_id, role, full_name, pin_hash, monthly_wage)
         VALUES ($1, 'cashier', 'Staff', 'x', 25000000)`,
        [businessId],
      );

      const client = await dbLib.getPool().connect();
      try {
        await provisioning.seedChartOfAccounts(client, businessId, industry);
      } finally {
        client.release();
      }

      const run = await payrollService.accruePayroll({
        businessId,
        locationId: null,
        periodKey: "1404-05",
        createdBy: null,
      });
      expect(run.totalAmount).toBe(25_000_000);

      // And it landed in the right two accounts, not merely "somewhere".
      const { rows } = await db.query<{ code: string; debit: string; credit: string }>(
        `SELECT a.code, jl.debit::text AS debit, jl.credit::text AS credit
           FROM journal_lines jl
           JOIN journal_entries je ON je.id = jl.entry_id
           JOIN accounts a ON a.id = jl.account_id
          WHERE je.business_id = $1 AND je.source_type = 'payroll_accrual'
          ORDER BY a.code`,
        [businessId],
      );
      expect(rows.map((r) => r.code)).toEqual(["2300", "5200"]);
      expect(Number(rows.find((r) => r.code === "5200")!.debit)).toBe(25_000_000);
      expect(Number(rows.find((r) => r.code === "2300")!.credit)).toBe(25_000_000);
    },
  );
});

/**
 * Audit F11 — gross-to-net. The rates are the business's own (nothing
 * statutory is assumed); these are fixture values. Seeded from the real chart
 * so the accounts a run posts to are the ones every business is given.
 */
describe("gross-to-net payroll (audit F11)", () => {
  const SETTINGS = {
    employeeInsurancePercent: 7,
    employerInsurancePercent: 20,
    unemploymentInsurancePercent: 3,
    insuranceCeilingRial: null,
    nonTaxableAllowancesInsurable: false,
    deductEmployeeInsuranceFromTaxable: true,
    taxExemptThresholdRial: 100_000_000,
    taxBrackets: [
      { upToRial: 140_000_000, ratePercent: 10 },
      { upToRial: 230_000_000, ratePercent: 15 },
      { upToRial: null, ratePercent: 20 },
    ],
  };
  const full = { id: "", a: "", b: "", owner: "" };

  async function linesByCode(
    businessId: string,
    sourceType: string,
  ): Promise<Record<string, { debit: number; credit: number }>> {
    const { rows } = await db.query<{ code: string; debit: string; credit: string }>(
      `SELECT a.code, SUM(jl.debit)::text AS debit, SUM(jl.credit)::text AS credit
         FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.entry_id
         JOIN accounts a ON a.id = jl.account_id
        WHERE je.business_id = $1 AND je.source_type = $2
        GROUP BY a.code ORDER BY a.code`,
      [businessId, sourceType],
    );
    return Object.fromEntries(rows.map((r) => [r.code, { debit: Number(r.debit), credit: Number(r.credit) }]));
  }

  async function outstanding(userId: string): Promise<number> {
    return (await payrollService.listStaffWages(full.id)).find((s) => s.id === userId)!.advanceOutstanding;
  }

  beforeEach(async () => {
    const bizRow = await db.query<{ id: string }>(
      "INSERT INTO businesses (name, slug, industry) VALUES ('G2N Co', $1, 'food_service') RETURNING id",
      [`g2n-${randomUUID().slice(0, 8)}`],
    );
    full.id = bizRow.rows[0].id;
    const client = await dbLib.getPool().connect();
    try {
      await provisioning.seedChartOfAccounts(client, full.id, "food_service");
    } finally {
      client.release();
    }
    const people = await db.query<{ id: string }>(
      `INSERT INTO users (business_id, role, full_name, pin_hash, monthly_wage)
       VALUES ($1, 'owner', 'Owner', 'x', NULL), ($1, 'cashier', 'A', 'x', 200000000), ($1, 'waiter', 'B', 'x', 120000000)
       RETURNING id`,
      [full.id],
    );
    [full.owner, full.a, full.b] = people.rows.map((r) => r.id);
  });

  it("with no settings entered, posts gross = net and no deduction", async () => {
    const run = await payrollService.accruePayroll({
      businessId: full.id,
      locationId: null,
      periodKey: "1404-05",
      createdBy: full.owner,
    });
    expect(run.totalAmount).toBe(320_000_000);
    expect(run.netAmount).toBe(320_000_000);
    for (const line of run.lines) {
      expect(line.netPayRial).toBe(line.grossRial);
      expect(line.employeeInsuranceRial + line.employerInsuranceRial + line.incomeTaxRial).toBe(0);
    }
    expect(await linesByCode(full.id, "payroll_accrual")).toEqual({
      "2300": { debit: 0, credit: 320_000_000 },
      "5200": { debit: 320_000_000, credit: 0 },
    });
  });

  it("saves the settings, computes every line and posts a balanced accrual to the Rial", async () => {
    await payrollService.savePayrollSettings(full.id, SETTINGS);
    expect(await payrollService.getPayrollSettings(full.id)).toEqual(SETTINGS);
    await payrollService.setStaffPayTerms(full.id, full.a, {
      taxableAllowance: 30_000_000,
      nonTaxableAllowance: 15_000_000,
      fixedDeduction: 2_000_000,
    });
    const advance = await payrollService.recordAdvance({
      businessId: full.id,
      locationId: null,
      userId: full.a,
      amount: 5_000_000,
      method: "cash",
      advanceDate: "2025-08-01",
      createdBy: full.owner,
    });
    expect(advance.status).toBe("active");
    expect(await linesByCode(full.id, "payroll_advance")).toEqual({
      "1100": { debit: 0, credit: 5_000_000 },
      "1260": { debit: 5_000_000, credit: 0 },
    });
    expect(await outstanding(full.a)).toBe(5_000_000);

    const run = await payrollService.accruePayroll({
      businessId: full.id,
      locationId: null,
      periodKey: "1404-05",
      overtime: { [full.a]: 10_000_000 },
      createdBy: full.owner,
    });

    expect(run.lines.find((l) => l.userId === full.a)).toMatchObject({
      grossRial: 255_000_000,
      insuranceBaseRial: 240_000_000,
      employeeInsuranceRial: 16_800_000,
      employerInsuranceRial: 48_000_000,
      unemploymentInsuranceRial: 7_200_000,
      taxableIncomeRial: 223_200_000,
      incomeTaxRial: 16_480_000,
      otherDeductionsRial: 2_000_000,
      advanceRecoveryRial: 5_000_000,
      netPayRial: 214_720_000,
    });
    expect(run.lines.find((l) => l.userId === full.b)).toMatchObject({
      grossRial: 120_000_000,
      employeeInsuranceRial: 8_400_000,
      employerInsuranceRial: 24_000_000,
      unemploymentInsuranceRial: 3_600_000,
      incomeTaxRial: 1_160_000,
      netPayRial: 110_440_000,
    });
    expect(run.totalAmount).toBe(375_000_000);
    expect(run.netAmount).toBe(325_160_000);

    const accrual = await linesByCode(full.id, "payroll_accrual");
    expect(accrual).toEqual({
      "1260": { debit: 0, credit: 5_000_000 },
      "2300": { debit: 0, credit: 325_160_000 },
      "2460": { debit: 0, credit: 108_000_000 },
      "2470": { debit: 0, credit: 17_640_000 },
      "2490": { debit: 0, credit: 2_000_000 },
      "5200": { debit: 375_000_000, credit: 0 },
      "5220": { debit: 82_800_000, credit: 0 },
    });
    const debits = Object.values(accrual).reduce((s, l) => s + l.debit, 0);
    const credits = Object.values(accrual).reduce((s, l) => s + l.credit, 0);
    expect(debits).toBe(credits);

    // The advance is recovered: nothing is owed any more, and it cannot be voided.
    expect(await outstanding(full.a)).toBe(0);
    await expect(
      payrollService.voidAdvance({ businessId: full.id, locationId: null, advanceId: advance.id, actorId: full.owner }),
    ).rejects.toThrow("advance_already_recovered");

    // Paying the run moves the net only; the withholdings stay in their payables.
    await payrollService.payPayroll({
      businessId: full.id,
      locationId: null,
      runId: run.id,
      method: "cash",
      actorId: full.owner,
    });
    expect(await linesByCode(full.id, "payroll_payment")).toEqual({
      "1100": { debit: 0, credit: 325_160_000 },
      "2300": { debit: 325_160_000, credit: 0 },
    });

    // Voiding the run gives the recovery back.
    await payrollService.voidPayrollRun({ businessId: full.id, locationId: null, runId: run.id, actorId: full.owner });
    expect(await outstanding(full.a)).toBe(5_000_000);
  });

  it("caps the insurance base at the ceiling the business entered", async () => {
    await payrollService.savePayrollSettings(full.id, { ...SETTINGS, insuranceCeilingRial: 150_000_000 });
    const run = await payrollService.accruePayroll({
      businessId: full.id,
      locationId: null,
      periodKey: "1404-05",
      createdBy: full.owner,
    });
    const a = run.lines.find((l) => l.userId === full.a)!;
    expect(a.insuranceBaseRial).toBe(150_000_000);
    expect(a.employeeInsuranceRial).toBe(10_500_000);
  });

  it("recovers an advance larger than the month's pay in part and carries the rest", async () => {
    await payrollService.recordAdvance({
      businessId: full.id,
      locationId: null,
      userId: full.b,
      amount: 150_000_000,
      method: "cash",
      createdBy: full.owner,
    });
    const run = await payrollService.accruePayroll({
      businessId: full.id,
      locationId: null,
      periodKey: "1404-05",
      createdBy: full.owner,
    });
    const b = run.lines.find((l) => l.userId === full.b)!;
    expect(b.advanceRecoveryRial).toBe(120_000_000);
    expect(b.netPayRial).toBe(0);
    expect(await outstanding(full.b)).toBe(30_000_000);
  });

  it("voids an advance that has not been recovered, mirroring its entry", async () => {
    const advance = await payrollService.recordAdvance({
      businessId: full.id,
      locationId: null,
      userId: full.a,
      amount: 4_000_000,
      method: "cash",
      createdBy: full.owner,
    });
    const voided = await payrollService.voidAdvance({
      businessId: full.id,
      locationId: null,
      advanceId: advance.id,
      actorId: full.owner,
    });
    expect(voided.status).toBe("voided");
    const { rows } = await db.query<{ net: string }>(
      `SELECT (SUM(jl.debit) - SUM(jl.credit))::text AS net
         FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
        WHERE je.business_id = $1 GROUP BY jl.account_id`,
      [full.id],
    );
    for (const r of rows) expect(Number(r.net)).toBe(0);
    expect(await outstanding(full.a)).toBe(0);
  });

  it("refuses invalid settings without saving them", async () => {
    await expect(
      payrollService.savePayrollSettings(full.id, { taxBrackets: [{ upToRial: 100, ratePercent: 10 }] }),
    ).rejects.toThrow("last_bracket_must_be_open");
    expect(await payrollService.getPayrollSettings(full.id)).toMatchObject({
      taxBrackets: [],
      employeeInsurancePercent: null,
    });
  });

  it("refuses overtime for someone who is not on the run", async () => {
    await expect(
      payrollService.accruePayroll({
        businessId: full.id,
        locationId: null,
        periodKey: "1404-05",
        overtime: { [full.owner]: 1_000 },
        createdBy: full.owner,
      }),
    ).rejects.toThrow("invalid_overtime");
  });
});
