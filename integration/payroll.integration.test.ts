/**
 * Phase 16 scope: "Payroll entries — staff cost accrual and payment
 * postings (journal-level, not a payroll engine)." Proves: accrual posts a
 * balanced entry against every active staff member's current monthly_wage,
 * snapshotting each person's amount so it survives a later wage change;
 * paying an accrued run posts the other half and can't happen twice; and a
 * run with no wages set is refused rather than posting a zero entry.
 *
 * Issue #835 hardened it, and this file is where each claim is pinned:
 *
 *   - payroll is business-wide (NULL location) and a payment or void can never
 *     move to another branch than the run's own;
 *   - one standing run per period, however the period is spelled, and a retry
 *     with the same idempotency key returns the run instead of a second one —
 *     under concurrency too;
 *   - a run line is an immutable identity snapshot (rename / removal);
 *   - wage changes are audited, append-only, and attributed;
 *   - the payment date reaches the journal and the run, and never precedes the
 *     accrual; the payment leaves a cash/bank account, not card money in transit;
 *   - the history is ordered, stable and bounded;
 *   - money is exact beyond 2^53;
 *   - commission is settled by the run that pays wages, and account 2300 ties out.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import type { Industry } from "../src/lib/industries";
import { toJalali, todayJalali } from "../src/lib/jalali";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let payrollService: typeof import("../src/lib/payroll-service");
let payrollAccounts: typeof import("../src/lib/payroll-accounts");
let advancesService: typeof import("../src/lib/payroll-advances-service");
let fiscalService: typeof import("../src/lib/fiscal-periods-service");
let provisioning: typeof import("../src/lib/business-provisioning");
let commissionService: typeof import("../src/lib/commission-service");

const biz = { id: "" };
const acct = {
  cash: "",
  bank: "",
  bankClearing: "",
  receivable: "",
  salariesExpense: "",
  salariesPayable: "",
  commissionExpense: "",
};
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
  payrollAccounts = await import("../src/lib/payroll-accounts");
  advancesService = await import("../src/lib/payroll-advances-service");
  fiscalService = await import("../src/lib/fiscal-periods-service");
  provisioning = await import("../src/lib/business-provisioning");
  commissionService = await import("../src/lib/commission-service");

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
  // Cascades to users, accounts, locations, commission_* and the append-only
  // payroll_pay_term_changes (whose guard lets the cascade of a business through).
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
     VALUES ($1, '1100', 'Cash', 'asset'),
            ($1, '1110', 'Bank', 'asset'),
            ($1, '1120', 'Bank clearing', 'asset'),
            ($1, '1200', 'Receivable', 'asset'),
            ($1, '5200', 'Salaries expense', 'expense'),
            ($1, '5210', 'Commission expense', 'expense'),
            ($1, '2300', 'Salaries payable', 'liability')
     RETURNING id, code`,
    [biz.id],
  );
  for (const r of accounts.rows) {
    if (r.code === "1100") acct.cash = r.id;
    if (r.code === "1110") acct.bank = r.id;
    if (r.code === "1120") acct.bankClearing = r.id;
    if (r.code === "1200") acct.receivable = r.id;
    if (r.code === "5200") acct.salariesExpense = r.id;
    if (r.code === "5210") acct.commissionExpense = r.id;
    if (r.code === "2300") acct.salariesPayable = r.id;
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A closed month (Mordad 1404 = 2025-07-23 … 2025-08-22), for tests that need a fixed, past period. */
const MORDAD = "1404-05";

/**
 * The Jalali month the suite is running in. A run's default accrual date is the
 * last day of a *closed* month but **today** while the month is still running,
 * so the shared default is the current month: «accrue now» is dated today, and
 * commission accrued today is inside its cut-off.
 */
const CURRENT_PERIOD = (() => {
  const today = todayJalali();
  return `${today.jy}-${String(today.jm).padStart(2, "0")}`;
})();

/** Accrue with the defaults most tests share: business-wide, owner, the current month. */
function accrue(overrides: Record<string, unknown> = {}) {
  return payrollService.accruePayroll({
    businessId: biz.id,
    createdBy: owner.id,
    periodKey: CURRENT_PERIOD,
    ...overrides,
  } as Parameters<typeof payrollService.accruePayroll>[0]);
}

/**
 * One member's wage, through the general pay-terms entry point — with the actor
 * and the reason, the shape these tests were written against.
 */
function setWage(params: {
  businessId: string;
  userId: string;
  monthlyWage: unknown;
  actorId: string | null;
  reason?: unknown;
}) {
  const { monthlyWage, ...rest } = params;
  return payrollService.setStaffPayTerms({ ...rest, patch: { monthlyWage } } as Parameters<
    typeof payrollService.setStaffPayTerms
  >[0]);
}

function pay(runId: string, overrides: Record<string, unknown> = {}) {
  return payrollService.payPayroll({
    businessId: biz.id,
    runId,
    method: "cash",
    actorId: owner.id,
    ...overrides,
  } as Parameters<typeof payrollService.payPayroll>[0]);
}

function voidRun(runId: string, overrides: Record<string, unknown> = {}) {
  return payrollService.voidPayrollRun({
    businessId: biz.id,
    runId,
    actorId: owner.id,
    ...overrides,
  } as Parameters<typeof payrollService.voidPayrollRun>[0]);
}

async function message(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "resolved";
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

interface EntryRow {
  id: string;
  source_type: string;
  location_id: string | null;
  entry_date: string;
}

async function entriesFor(runId: string): Promise<EntryRow[]> {
  const { rows } = await db.query<EntryRow>(
    `SELECT id, source_type, location_id, entry_date::text AS entry_date FROM journal_entries
      WHERE business_id = $1 AND source_id = $2 ORDER BY posted_at, id`,
    [biz.id, runId],
  );
  return rows;
}

async function count(sql: string, params: unknown[] = [biz.id]): Promise<number> {
  const { rows } = await db.query<{ n: string }>(sql, params);
  return Number(rows[0].n);
}

/** Credits − debits on 2300, as exact text. */
async function payableBalance(): Promise<string> {
  const { rows } = await db.query<{ balance: string }>(
    `SELECT COALESCE(SUM(jl.credit - jl.debit), 0)::text AS balance FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.entry_id WHERE je.business_id = $1 AND jl.account_id = $2`,
    [biz.id, acct.salariesPayable],
  );
  return rows[0].balance;
}

async function addBranch(name: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO locations (business_id, name) VALUES ($1, $2) RETURNING id`,
    [biz.id, name],
  );
  return rows[0].id;
}

// ---------------------------------------------------------------------------
// Wages
// ---------------------------------------------------------------------------

describe("setStaffPayTerms / listStaffWages", () => {
  const change = (monthlyWage: unknown, extra: Record<string, unknown> = {}, userId = staff.a) =>
    setWage({ businessId: biz.id, userId, monthlyWage, actorId: owner.id, ...extra });
  const terms = (patch: Record<string, unknown>, userId = staff.a) =>
    payrollService.setStaffPayTerms({ businessId: biz.id, userId, patch, actorId: owner.id });
  const listed = async (userId = staff.a) => (await payrollService.listStaffWages(biz.id)).find((s) => s.id === userId)!;

  it("sets and lists a staff member's monthly wage as exact text", async () => {
    await change(35_000_000);
    const member = await listed();
    expect(member.monthlyWage).toBe("35000000");
    expect(typeof member.monthlyWage).toBe("string");
  });

  it("lists every standing term as exact text, none by default, with no advance owed", async () => {
    expect(await listed()).toMatchObject({
      monthlyWage: "30000000",
      taxableAllowance: "0",
      nonTaxableAllowance: "0",
      fixedDeduction: "0",
      advanceOutstanding: "0",
    });
  });

  it("rejects a negative wage", async () => {
    expect(await message(change(-1))).toBe("invalid_amount");
  });

  it("404s setting a wage for a user that doesn't exist", async () => {
    expect(await message(change(1000, {}, randomUUID()))).toBe("user_not_found");
  });

  it("404s (not 500) for an id that isn't a uuid", async () => {
    expect(await message(change(1000, {}, "not-a-uuid"))).toBe("user_not_found");
  });

  it("rejects a fractional wage, a number past the safe range, and a non-numeric one", async () => {
    expect(await message(change(1234.5))).toBe("invalid_amount");
    expect(await message(change(Number.MAX_SAFE_INTEGER + 2))).toBe("invalid_amount");
    expect(await message(change(Number.NaN))).toBe("invalid_amount");
    expect(await message(change("12abc"))).toBe("invalid_amount");
    expect(await message(change("-5"))).toBe("invalid_amount");
    expect(await message(change(true as never))).toBe("invalid_amount");
    expect(await message(change([] as never))).toBe("invalid_amount");
    expect(await message(change(undefined as never))).toBe("invalid_amount");
  });

  it("refuses an amount the bigint column cannot hold as out of range, not a database error", async () => {
    expect(await message(change("9223372036854775808"))).toBe("amount_out_of_range");
    await change("9223372036854775807"); // the largest value that fits
    expect((await listed()).monthlyWage).toBe("9223372036854775807");
  });

  it("clears a wage when passed null", async () => {
    await change(null);
    expect((await listed()).monthlyWage).toBeNull();
  });

  it("does not touch a member of another business", async () => {
    const other = await db.query<{ id: string }>(
      "INSERT INTO businesses (name, slug) VALUES ('Other', $1) RETURNING id",
      [`other-${randomUUID().slice(0, 8)}`],
    );
    const stranger = await db.query<{ id: string }>(
      `INSERT INTO users (business_id, role, full_name, pin_hash, monthly_wage) VALUES ($1, 'cashier', 'Stranger', 'x', 1) RETURNING id`,
      [other.rows[0].id],
    );
    expect(await message(change(5, {}, stranger.rows[0].id))).toBe("user_not_found");
    const { rows } = await db.query(`SELECT monthly_wage::text FROM users WHERE id = $1`, [stranger.rows[0].id]);
    expect(rows[0].monthly_wage).toBe("1");
  });

  // Main's audit F11 gave each member three more standing terms; the same rules hold for them.
  it("sets the allowances and the fixed deduction, and writes only the keys present", async () => {
    await terms({ taxableAllowance: 5_000_000, nonTaxableAllowance: 2_000_000, fixedDeduction: 1_000_000 });
    expect(await listed()).toMatchObject({
      monthlyWage: "30000000", // untouched: it was not in the patch
      taxableAllowance: "5000000",
      nonTaxableAllowance: "2000000",
      fixedDeduction: "1000000",
    });
    await terms({ taxableAllowance: 0 });
    expect(await listed()).toMatchObject({ monthlyWage: "30000000", taxableAllowance: "0", fixedDeduction: "1000000" });
  });

  it("refuses a patch that names none of the terms, rather than clearing a wage", async () => {
    expect(await message(terms({}))).toBe("bad_request");
    expect(await message(terms({ somethingElse: 5 }))).toBe("bad_request");
    expect((await listed()).monthlyWage).toBe("30000000");
  });

  it("lets only the wage be unset: an allowance or deduction is an amount, zero meaning none", async () => {
    for (const term of ["taxableAllowance", "nonTaxableAllowance", "fixedDeduction"]) {
      expect(await message(terms({ [term]: null })), term).toBe("invalid_amount");
      expect(await message(terms({ [term]: "abc" })), term).toBe("invalid_amount");
      expect(await message(terms({ [term]: -1 })), term).toBe("invalid_amount");
    }
    expect(await listed()).toMatchObject({ taxableAllowance: "0", nonTaxableAllowance: "0", fixedDeduction: "0" });
  });

  it("changes nothing at all when one of several terms is invalid (no partial save)", async () => {
    expect(await message(terms({ monthlyWage: 40_000_000, taxableAllowance: -5 }))).toBe("invalid_amount");
    expect(await listed()).toMatchObject({ monthlyWage: "30000000", taxableAllowance: "0" });
    expect(await count(`SELECT COUNT(*)::text AS n FROM payroll_pay_term_changes WHERE business_id = $1`)).toBe(0);
  });

  // A patch carries up to four amounts; the route answers `{ error, field }`, so the box that is wrong is named.
  it("names the term it refused, whichever way the amount is wrong", async () => {
    const refusal = async (patch: Record<string, unknown>) => {
      const err = await terms(patch).then(
        () => null,
        (e: unknown) => e,
      );
      if (!(err instanceof Error)) return null;
      return { code: err.message, field: (err as { details?: { field?: unknown } }).details?.field };
    };
    expect(await refusal({ nonTaxableAllowance: -1 })).toEqual({ code: "invalid_amount", field: "nonTaxableAllowance" });
    expect(await refusal({ fixedDeduction: 1234.5 })).toEqual({ code: "invalid_amount", field: "fixedDeduction" });
    expect(await refusal({ taxableAllowance: Number.MAX_SAFE_INTEGER + 2 })).toEqual({ code: "invalid_amount", field: "taxableAllowance" });
    expect(await refusal({ taxableAllowance: null })).toEqual({ code: "invalid_amount", field: "taxableAllowance" });
    expect(await refusal({ monthlyWage: "9223372036854775808" })).toEqual({ code: "amount_out_of_range", field: "monthlyWage" });
    // With a valid term beside it, the bad one is the one named — and nothing is saved.
    expect(await refusal({ monthlyWage: 40_000_000, fixedDeduction: -5 })).toEqual({ code: "invalid_amount", field: "fixedDeduction" });
    expect(await listed()).toMatchObject({ monthlyWage: "30000000", fixedDeduction: "0" });
    expect(await count(`SELECT COUNT(*)::text AS n FROM payroll_pay_term_changes WHERE business_id = $1`)).toBe(0);
  });
});

describe("pay-term change audit (issue #835 §6)", () => {
  const change = (monthlyWage: unknown, extra: Record<string, unknown> = {}, userId = staff.a) =>
    setWage({ businessId: biz.id, userId, monthlyWage, actorId: owner.id, ...extra });
  const history = async (userId = staff.a, options: { limit?: number; cursor?: string | null } = {}) =>
    payrollService.listPayTermChanges(biz.id, userId, options);

  it("records previous amount, new amount, who changed it and when", async () => {
    const before = Date.now();
    const result = await change(35_000_000);
    expect(result).toEqual({
      changed: true,
      changes: [{ term: "monthlyWage", previousAmount: "30000000", newAmount: "35000000" }],
    });

    const { changes } = await history();
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      userId: staff.a,
      employeeName: "Staff A",
      term: "monthlyWage",
      previousAmount: "30000000",
      newAmount: "35000000",
      changedBy: owner.id,
      changedByName: "Owner",
      reason: null,
    });
    const at = Date.parse(changes[0].changedAt);
    expect(at).toBeGreaterThanOrEqual(before - 2000);
    expect(at).toBeLessThanOrEqual(Date.now() + 2000);
  });

  it("records a reason, and a clear as a change to null", async () => {
    await change(null, { reason: "  قرارداد پایان یافت  " });
    const { changes } = await history();
    expect(changes[0]).toMatchObject({ previousAmount: "30000000", newAmount: null, reason: "قرارداد پایان یافت" });
  });

  it("records setting a wage on a member who had none as previous = null", async () => {
    await db.query(`UPDATE users SET monthly_wage = NULL WHERE id = $1`, [staff.a]);
    await change(1_000_000);
    const { changes } = await history();
    expect(changes[0]).toMatchObject({ previousAmount: null, newAmount: "1000000" });
  });

  it("audits the allowances and the fixed deduction, one row per term that changed", async () => {
    const result = await payrollService.setStaffPayTerms({
      businessId: biz.id,
      userId: staff.a,
      patch: { monthlyWage: 30_000_000, taxableAllowance: 4_000_000, fixedDeduction: 500_000 },
      actorId: owner.id,
      reason: "annual review",
    });
    // The wage did not change, so it is not in the history; the other two are.
    expect(result.changes.map((c) => c.term).sort()).toEqual(["fixedDeduction", "taxableAllowance"]);
    const { changes } = await history();
    expect(changes.map((c) => c.term).sort()).toEqual(["fixedDeduction", "taxableAllowance"]);
    expect(changes.find((c) => c.term === "taxableAllowance")).toMatchObject({
      previousAmount: "0",
      newAmount: "4000000",
      reason: "annual review",
      changedBy: owner.id,
    });
    expect(changes.find((c) => c.term === "fixedDeduction")).toMatchObject({ previousAmount: "0", newAmount: "500000" });
  });

  it("writes nothing when the wage is unchanged", async () => {
    expect(await change(30_000_000)).toMatchObject({ changed: false, changes: [] });
    expect(await count(`SELECT COUNT(*)::text AS n FROM payroll_pay_term_changes WHERE business_id = $1`)).toBe(0);
    await change(null);
    expect(await change(null)).toMatchObject({ changed: false });
    expect(await count(`SELECT COUNT(*)::text AS n FROM payroll_pay_term_changes WHERE business_id = $1`)).toBe(1);
  });

  it("chains: each change's previous amount is the one before it, newest first", async () => {
    await change(31_000_000);
    await change(32_000_000);
    await change(33_000_000);
    const { changes } = await history();
    expect(changes.map((c) => [c.previousAmount, c.newAmount])).toEqual([
      ["32000000", "33000000"],
      ["31000000", "32000000"],
      ["30000000", "31000000"],
    ]);
  });

  it("applies exactly one change per concurrent write, with a consistent chain", async () => {
    await Promise.all([change(41_000_000), change(42_000_000), change(43_000_000)]);
    const { changes } = await history();
    expect(changes).toHaveLength(3);
    // Oldest-first, every previous amount is the previous row's new amount.
    const chain = [...changes].reverse();
    expect(chain[0].previousAmount).toBe("30000000");
    for (let i = 1; i < chain.length; i++) expect(chain[i].previousAmount).toBe(chain[i - 1].newAmount);
    const current = (await payrollService.listStaffWages(biz.id)).find((s) => s.id === staff.a)!.monthlyWage;
    expect(chain[chain.length - 1].newAmount).toBe(current);
  });

  it("rejects a bad reason and writes nothing", async () => {
    expect(await message(change(36_000_000, { reason: "x".repeat(501) }))).toBe("invalid_wage_reason");
    expect(await message(change(36_000_000, { reason: 42 }))).toBe("invalid_wage_reason");
    const list = await payrollService.listStaffWages(biz.id);
    expect(list.find((s) => s.id === staff.a)!.monthlyWage).toBe("30000000");
    expect(await count(`SELECT COUNT(*)::text AS n FROM payroll_pay_term_changes WHERE business_id = $1`)).toBe(0);
  });

  it("keeps the actor's name as it was and survives the actor leaving", async () => {
    await change(35_000_000);
    await db.query(`UPDATE users SET full_name = 'Renamed Owner' WHERE id = $1`, [owner.id]);
    await db.query(`DELETE FROM users WHERE id = $1`, [owner.id]);
    const { changes } = await history();
    expect(changes[0]).toMatchObject({ changedBy: owner.id, changedByName: "Owner" });
  });

  it("is append-only: a direct UPDATE or DELETE is refused by the database", async () => {
    await change(35_000_000);
    await expect(db.query(`UPDATE payroll_pay_term_changes SET new_amount = 1 WHERE business_id = $1`, [biz.id])).rejects.toThrow(
      /append-only/,
    );
    await expect(db.query(`UPDATE payroll_pay_term_changes SET reason = 'edited' WHERE business_id = $1`, [biz.id])).rejects.toThrow(
      /append-only/,
    );
    await expect(db.query(`DELETE FROM payroll_pay_term_changes WHERE business_id = $1`, [biz.id])).rejects.toThrow(/append-only/);
    expect(await count(`SELECT COUNT(*)::text AS n FROM payroll_pay_term_changes WHERE business_id = $1`)).toBe(1);
  });

  it("only ever records an unset wage, never an unset allowance (the database says so too)", async () => {
    await expect(
      db.query(
        `INSERT INTO payroll_pay_term_changes (business_id, user_id, employee_name_snapshot, term, previous_amount, new_amount)
         VALUES ($1, $2, 'x', 'monthly_taxable_allowance', 5, NULL)`,
        [biz.id, staff.a],
      ),
    ).rejects.toMatchObject({ constraint: "payroll_pay_term_changes_only_the_wage_unsets" });
    await expect(
      db.query(
        `INSERT INTO payroll_pay_term_changes (business_id, user_id, employee_name_snapshot, term, previous_amount, new_amount)
         VALUES ($1, $2, 'x', 'monthly_wage', 5, 5)`,
        [biz.id, staff.a],
      ),
    ).rejects.toMatchObject({ constraint: "payroll_pay_term_changes_is_a_change" });
  });

  it("is still removed when its whole business is (the cascade is allowed)", async () => {
    await change(35_000_000);
    await db.query(`DELETE FROM businesses WHERE id = $1`, [biz.id]);
    expect(await count(`SELECT COUNT(*)::text AS n FROM payroll_pay_term_changes WHERE business_id = $1`)).toBe(0);
  });

  it("is readable for a member who has since been removed, and scoped to its own business", async () => {
    await change(35_000_000);
    await db.query(`DELETE FROM users WHERE id = $1`, [staff.a]);
    const { changes } = await history();
    expect(changes).toHaveLength(1);
    expect(changes[0].employeeName).toBe("Staff A");

    const other = await db.query<{ id: string }>(
      "INSERT INTO businesses (name, slug) VALUES ('Other', $1) RETURNING id",
      [`other-${randomUUID().slice(0, 8)}`],
    );
    expect((await payrollService.listPayTermChanges(other.rows[0].id, staff.a)).changes).toEqual([]);
    expect(await message(payrollService.listPayTermChanges(biz.id, "nope"))).toBe("user_not_found");
  });

  it("paginates with a cursor, newest first", async () => {
    // Five rows with explicit, distinct `changed_at` values. Written through the
    // service they are stamped by the database clock, so two writes can share a
    // timestamp, and the newest-first order between them then falls to the
    // random id tie-break (CI failed on exactly that order once). The assertions
    // below are unchanged: they test the keyset cursor, not clock resolution.
    for (let wage = 31; wage <= 35; wage++) {
      await db.query(
        `INSERT INTO payroll_pay_term_changes
           (business_id, user_id, employee_name_snapshot, term, previous_amount, new_amount, changed_at)
         VALUES ($1, $2, 'Staff A', 'monthly_wage', $3, $4,
                 '2026-01-01T00:00:00Z'::timestamptz + make_interval(mins => $5::int))`,
        [biz.id, staff.a, (wage - 1) * 1_000_000, wage * 1_000_000, wage],
      );
    }
    const first = await history(staff.a, { limit: 2 });
    expect(first.changes.map((c) => c.newAmount)).toEqual(["35000000", "34000000"]);
    expect(first.nextCursor).not.toBeNull();
    const second = await history(staff.a, { limit: 2, cursor: first.nextCursor });
    expect(second.changes.map((c) => c.newAmount)).toEqual(["33000000", "32000000"]);
    const third = await history(staff.a, { limit: 2, cursor: second.nextCursor });
    expect(third.changes.map((c) => c.newAmount)).toEqual(["31000000"]);
    expect(third.nextCursor).toBeNull();
    expect(await message(payrollService.listPayTermChanges(biz.id, staff.a, { cursor: "garbage" }))).toBe("invalid_cursor");
  });
});

// ---------------------------------------------------------------------------
// Accrual
// ---------------------------------------------------------------------------

describe("accruePayroll", () => {
  it("posts a balanced entry summing every active staff member's current wage", async () => {
    const run = await accrue({ periodKey: MORDAD, accrualDate: "2025-05-20" });
    // With no rates entered, gross is net, and nothing is withheld.
    expect(run.totalAmount).toBe("50000000");
    expect(run.netAmount).toBe("50000000");
    expect(run.commissionTotal).toBe("0");
    expect(run.payableAmount).toBe("50000000");
    expect(run.status).toBe("accrued");
    expect(run.lines.map((l) => l.amount).sort()).toEqual(["20000000", "30000000"]);
    for (const line of run.lines) {
      expect(line.netPayRial).toBe(line.grossRial);
      expect(line.employeeInsuranceRial).toBe("0");
      expect(line.incomeTaxRial).toBe("0");
    }

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
    const run = await accrue();
    await setWage({ businessId: biz.id, userId: staff.a, monthlyWage: 99_000_000, actorId: owner.id });

    const { runs } = await payrollService.listPayrollRuns(biz.id, { includeLines: true });
    const reloaded = runs.find((r) => r.id === run.id)!;
    expect(reloaded.totalAmount).toBe("50000000");
    expect(reloaded.lines!.find((l) => l.userId === staff.a)!.amount).toBe("30000000");
  });

  it("excludes staff with no wage set or a zero wage", async () => {
    await db.query(`UPDATE users SET monthly_wage = 0 WHERE id = $1`, [staff.b]);
    const run = await accrue();
    expect(run.totalAmount).toBe("30000000");
    expect(run.lines).toHaveLength(1);
  });

  it("excludes a deactivated member's wage", async () => {
    await db.query(`UPDATE users SET is_active = false WHERE id = $1`, [staff.b]);
    const run = await accrue();
    expect(run.totalAmount).toBe("30000000");
  });

  it("refuses to accrue when no staff has a wage set", async () => {
    await db.query(`UPDATE users SET monthly_wage = NULL WHERE business_id = $1`, [biz.id]);
    expect(await message(accrue())).toBe("no_wages_set");
  });

  // The period is a Jalali month from a selector (audit F11), not free text.
  it.each(["", "  ", "مرداد ۱۴۰۴", "1404-13", "1404-5", "1404-00", "1404/05", "1404"])("rejects the period %j", async (periodKey) => {
    expect(await message(accrue({ periodKey }))).toBe("invalid_period");
  });

  it("rejects a period that is not even text", async () => {
    for (const periodKey of [undefined, null, 140405, { year: 1404, month: 5 }, ["1404-05"], true]) {
      expect(await message(accrue({ periodKey })), JSON.stringify(periodKey)).toBe("invalid_period");
    }
    expect(await count("SELECT COUNT(*)::text AS n FROM payroll_runs WHERE business_id = $1")).toBe(0);
  });

  it("rejects a month that has not started yet", async () => {
    expect(await message(accrue({ periodKey: "1499-01" }))).toBe("period_in_future");
  });

  it("stores the month as a key and a label, and dates a closed month on its own last day", async () => {
    const run = await accrue({ periodKey: MORDAD });
    expect(run.periodKey).toBe("1404-05");
    expect(run.periodLabel).toBe("مرداد 1404");
    // 31 مرداد 1404 — the entry and the run share it.
    expect(run.accrualDate).toBe("2025-08-22");
    expect((await entriesFor(run.id))[0].entry_date).toBe("2025-08-22");
  });

  it("dates the month that is still running today, not on a day that has not come", async () => {
    const today = (await db.query<{ d: string }>(`SELECT CURRENT_DATE::text AS d`)).rows[0].d;
    const run = await accrue();
    expect(run.periodKey).toBe(CURRENT_PERIOD);
    // The business's today is Tehran's; the database's CURRENT_DATE may differ by a day around midnight.
    expect(Math.abs(Date.parse(run.accrualDate) - Date.parse(today))).toBeLessThanOrEqual(86_400_000);
  });

  it("reads one month in every spelling of its key as the same period", async () => {
    const variants = ["۱۴۰۴-۰۵", " 1404 - 05 ", "1404–05", "1404\u200f-05"];
    const first = await accrue({ periodKey: variants[0] });
    expect(first.periodKey).toBe("1404-05");
    for (const variant of variants.slice(1)) {
      expect(await message(accrue({ periodKey: variant })), variant).toBe("period_already_accrued");
    }
  });

  it("keeps reading a run recorded with a free-text period before audit F11", async () => {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO payroll_runs (business_id, period_label, total_amount, accrual_date)
       VALUES ($1, 'مرداد قدیمی', 30000000, '2025-05-20') RETURNING id`,
      [biz.id],
    );
    await db.query(`INSERT INTO payroll_run_lines (run_id, user_id, amount) VALUES ($1, $2, 30000000)`, [rows[0].id, staff.a]);
    const { runs } = await payrollService.listPayrollRuns(biz.id, { includeLines: true });
    expect(runs[0]).toMatchObject({
      periodKey: null,
      periodLabel: "مرداد قدیمی",
      totalAmount: "30000000",
      netAmount: "30000000",
      payableAmount: "30000000",
    });
    // A line from before gross-to-net has no breakdown: its whole amount was base pay, gross and net.
    expect(runs[0].lines![0]).toMatchObject({
      amount: "30000000",
      baseSalaryRial: "30000000",
      grossRial: "30000000",
      netPayRial: "30000000",
      employeeInsuranceRial: "0",
    });
  });

  /*
   * Both of these used to reach the entry's `COALESCE($3::date, CURRENT_DATE)`
   * and fail there as SQLSTATE 22007/22008, which no route maps — so the
   * caller saw a 500 and «خطای غیرمنتظره» rather than "that date is invalid".
   */
  it("rejects a malformed accrual date with a 400, not a date-cast 500", async () => {
    expect(await message(accrue({ accrualDate: "banana" }))).toBe("invalid_accrual_date");
  });

  it("rejects a well-shaped but non-existent accrual date", async () => {
    expect(await message(accrue({ accrualDate: "2025-02-31" }))).toBe("invalid_accrual_date");
  });

  it("treats a whitespace-only accrual date as absent (the month's default date) rather than crashing", async () => {
    const run = await accrue({ accrualDate: "   " });
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
    expect(await message(accrue({ accrualDate: "2025-02-31" }))).toBe("invalid_accrual_date");
    expect(await count("SELECT COUNT(*)::text AS n FROM payroll_runs WHERE business_id = $1")).toBe(0);
  });

  it("rejects accruing into a locked fiscal period, leaving no run, line or claim behind", async () => {
    await fiscalService.createFiscalYear(biz.id, 1404);
    const [year] = await fiscalService.listFiscalYears(biz.id);
    const [farvardin] = await fiscalService.listPeriods(biz.id, year.id);
    await fiscalService.setPeriodStatus(biz.id, farvardin.id, "soft_closed", owner.id);
    await fiscalService.setPeriodStatus(biz.id, farvardin.id, "locked", owner.id);

    expect(await message(accrue({ periodKey: "1404-01", accrualDate: farvardin.startsOn }))).toBe("fiscal_period_locked");
    expect(await count("SELECT COUNT(*)::text AS n FROM payroll_runs WHERE business_id = $1")).toBe(0);
    expect(
      await count(
        "SELECT COUNT(*)::text AS n FROM payroll_run_lines l JOIN payroll_runs r ON r.id = l.run_id WHERE r.business_id = $1",
      ),
    ).toBe(0);
    // …and the period is not burned: the same period can be booked on another date.
    const run = await accrue({ periodKey: "1404-01", accrualDate: "2030-01-01" });
    expect(run.periodKey).toBe("1404-01");
  });
});

// ---------------------------------------------------------------------------
// Business-wide model (issue #835 §1)
// ---------------------------------------------------------------------------

describe("business-wide payroll — attribution (issue #835 §1)", () => {
  let branchA = "";
  let branchB = "";

  beforeEach(async () => {
    branchA = await addBranch("Branch A");
    branchB = await addBranch("Branch B");
    // The two members work at different branches.
    await db.query(`UPDATE users SET location_id = $2 WHERE id = $1`, [staff.a, branchA]);
    await db.query(`UPDATE users SET location_id = $2 WHERE id = $1`, [staff.b, branchB]);
  });

  it("accrues every member of every branch, and attributes the run to no branch", async () => {
    const run = await accrue();
    expect(run.totalAmount).toBe("50000000"); // both branches' staff, in one run

    const { rows } = await db.query<{ location_id: string | null }>(`SELECT location_id FROM payroll_runs WHERE id = $1`, [run.id]);
    expect(rows[0].location_id).toBeNull();

    const entries = await entriesFor(run.id);
    expect(entries.map((e) => e.location_id)).toEqual([null]);
  });

  it("ignores any branch a caller tries to pass: the run is not attributed to it", async () => {
    // The old API took the caller's *active* branch. It is gone; an extra
    // property from a stale caller must not resurrect the behaviour.
    const run = await accrue({ locationId: branchA });
    const { rows } = await db.query<{ location_id: string | null }>(`SELECT location_id FROM payroll_runs WHERE id = $1`, [run.id]);
    expect(rows[0].location_id).toBeNull();
    expect((await entriesFor(run.id))[0].location_id).toBeNull();
  });

  it("pays with the run's (NULL) location whatever branch is passed", async () => {
    const run = await accrue();
    await pay(run.id, { locationId: branchB });
    const entries = await entriesFor(run.id);
    expect(entries.map((e) => [e.source_type, e.location_id])).toEqual([
      ["payroll_accrual", null],
      ["payroll_payment", null],
    ]);
  });

  it("voids with each original entry's own location (NULL stays NULL)", async () => {
    const run = await accrue();
    await pay(run.id);
    await voidRun(run.id, { locationId: branchA });
    const entries = await entriesFor(run.id);
    expect(entries).toHaveLength(4);
    for (const e of entries) expect(e.location_id).toBeNull();
    expect(await count(`SELECT COUNT(*)::text AS n FROM journal_entries WHERE business_id = $1 AND location_id IS NOT NULL`)).toBe(0);
  });

  /**
   * A run created before #835 was stored under whichever branch the accountant
   * had active. It is history now, but it can still be paid and voided — and
   * those must stay where the run was posted, not where the caller happens to be.
   */
  async function legacyRun(locationId: string, options: { paid?: boolean } = {}): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO payroll_runs (business_id, location_id, period_label, total_amount, accrual_date, created_by)
       VALUES ($1, $2, 'legacy', 50000000, '2025-05-20', $3) RETURNING id`,
      [biz.id, locationId, owner.id],
    );
    const runId = rows[0].id;
    await db.query(`INSERT INTO payroll_run_lines (run_id, user_id, amount) VALUES ($1, $2, 30000000), ($1, $3, 20000000)`, [
      runId,
      staff.a,
      staff.b,
    ]);
    const post = async (sourceType: string, debit: string, credit: string, date: string) => {
      const entry = await db.query<{ id: string }>(
        `INSERT INTO journal_entries (business_id, location_id, entry_date, memo, source_type, source_id)
         VALUES ($1, $2, $3, 'legacy', $4, $5) RETURNING id`,
        [biz.id, locationId, date, sourceType, runId],
      );
      await db.query(`INSERT INTO journal_lines (entry_id, account_id, debit, credit) VALUES ($1, $2, 50000000, 0), ($1, $3, 0, 50000000)`, [
        entry.rows[0].id,
        debit,
        credit,
      ]);
    };
    await post("payroll_accrual", acct.salariesExpense, acct.salariesPayable, "2025-05-20");
    if (options.paid) {
      await post("payroll_payment", acct.salariesPayable, acct.cash, "2025-05-25");
      await db.query(`UPDATE payroll_runs SET status = 'paid', paid_date = '2025-05-25' WHERE id = $1`, [runId]);
    }
    return runId;
  }

  it("pays a legacy run under the run's own branch, never the caller's active one", async () => {
    const runId = await legacyRun(branchA);
    await pay(runId, { locationId: branchB, paidDate: "2025-05-25" });
    const payment = (await entriesFor(runId)).find((e) => e.source_type === "payroll_payment")!;
    expect(payment.location_id).toBe(branchA);
    expect(payment.location_id).not.toBe(branchB);
  });

  it("voids a legacy run's accrual and payment each under the branch they were posted to", async () => {
    const runId = await legacyRun(branchA, { paid: true });
    await voidRun(runId, { locationId: branchB });
    const entries = await entriesFor(runId);
    const mirrors = entries.filter((e) => e.source_type.endsWith("_void"));
    expect(mirrors.map((e) => e.source_type).sort()).toEqual(["payroll_accrual_void", "payroll_payment_void"]);
    for (const mirror of mirrors) expect(mirror.location_id).toBe(branchA);
    // Nothing leaked to the caller's branch, and the books net to zero per branch.
    expect(await count(`SELECT COUNT(*)::text AS n FROM journal_entries WHERE business_id = $1 AND location_id = $2`, [biz.id, branchB])).toBe(0);
    const { rows } = await db.query<{ net: string }>(
      `SELECT (SUM(jl.debit) - SUM(jl.credit))::text AS net FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.entry_id WHERE je.business_id = $1 AND je.location_id = $2 GROUP BY jl.account_id`,
      [biz.id, branchA],
    );
    for (const r of rows) expect(r.net).toBe("0");
  });

  it("voids a mixed run (accrual under a branch, payment under none) each in its own scope", async () => {
    const runId = await legacyRun(branchA, { paid: true });
    // Move the payment entry to business-wide, the way a hand-fixed ledger might be.
    await db.query(`UPDATE journal_entries SET location_id = NULL WHERE source_id = $1 AND source_type = 'payroll_payment'`, [runId]);
    await voidRun(runId, { locationId: branchB });
    const byType = Object.fromEntries((await entriesFor(runId)).map((e) => [e.source_type, e.location_id]));
    expect(byType.payroll_accrual_void).toBe(branchA);
    expect(byType.payroll_payment_void).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Duplicate protection and idempotency (issue #835 §4, §13)
// ---------------------------------------------------------------------------

describe("period identity and duplicate protection (issue #835 §4, §13)", () => {
  it("refuses a second standing run for the same period, naming the run", async () => {
    const first = await accrue({ periodKey: MORDAD });
    await expect(accrue({ periodKey: MORDAD })).rejects.toMatchObject({
      message: "period_already_accrued",
      status: 409,
      details: { run: { id: first.id, periodLabel: "مرداد 1404", status: "accrued" } },
    });
    expect(await count("SELECT COUNT(*)::text AS n FROM payroll_runs WHERE business_id = $1")).toBe(1);
    expect(await count("SELECT COUNT(*)::text AS n FROM journal_entries WHERE business_id = $1")).toBe(1);
  });

  it.each([
    ["Persian digits", "۱۴۰۴-۰۵"],
    ["Arabic-Indic digits", "١٤٠٤-٠٥"],
    ["padding around the dash", " 1404 - 05 "],
    ["a no-break space", "\u00a01404-05\u00a0"],
    ["a right-to-left mark", "1404\u200f-05"],
    ["an en dash", "1404–05"],
    ["a minus sign", "1404−05"],
  ])("treats %s as the same period", async (_name, variant) => {
    await accrue({ periodKey: MORDAD });
    expect(await message(accrue({ periodKey: variant }))).toBe("period_already_accrued");
  });

  it("allows different months", async () => {
    await accrue({ periodKey: MORDAD });
    const next = await accrue({ periodKey: "1404-06" });
    expect(next.periodKey).toBe("1404-06");
    const previousYear = await accrue({ periodKey: "1403-05" });
    expect(previousYear.periodKey).toBe("1403-05");
  });

  it("releases the period when its run is voided, so a mistaken run can be redone", async () => {
    const first = await accrue({ periodKey: MORDAD });
    await voidRun(first.id);
    const redo = await accrue({ periodKey: MORDAD });
    expect(redo.id).not.toBe(first.id);
    expect(redo.status).toBe("accrued");
    // The voided run stays in the history; the redo now stands.
    expect(await message(accrue({ periodKey: MORDAD }))).toBe("period_already_accrued");
  });

  it("does not release the period when the run is only paid", async () => {
    const first = await accrue({ periodKey: MORDAD });
    await pay(first.id);
    expect(await message(accrue({ periodKey: MORDAD }))).toBe("period_already_accrued");
  });

  it("is a database guarantee, not only a service check: a second standing row is refused by the index", async () => {
    const first = await accrue({ periodKey: MORDAD });
    await expect(
      db.query(
        `INSERT INTO payroll_runs (business_id, period_label, period_key, total_amount, accrual_date)
         VALUES ($1, 'مرداد ۱۴۰۴', $2, 1, CURRENT_DATE)`,
        [biz.id, first.periodKey],
      ),
    ).rejects.toMatchObject({ code: "23505", constraint: "uq_payroll_runs_period" });
    // A voided duplicate is allowed (that is the redo path).
    await db.query(
      `INSERT INTO payroll_runs (business_id, period_label, period_key, total_amount, accrual_date, status)
       VALUES ($1, 'مرداد ۱۴۰۴', $2, 1, CURRENT_DATE, 'voided')`,
      [biz.id, first.periodKey],
    );
  });

  it("does not let one business's period block another's", async () => {
    await accrue({ periodKey: MORDAD });
    const other = await db.query<{ id: string }>(
      "INSERT INTO businesses (name, slug) VALUES ('Other', $1) RETURNING id",
      [`other-${randomUUID().slice(0, 8)}`],
    );
    await db.query(`INSERT INTO users (business_id, role, full_name, pin_hash, monthly_wage) VALUES ($1, 'cashier', 'X', 'x', 10)`, [
      other.rows[0].id,
    ]);
    await db.query(
      `INSERT INTO accounts (business_id, code, name, type) VALUES ($1, '5200', 'e', 'expense'), ($1, '2300', 'p', 'liability')`,
      [other.rows[0].id],
    );
    const run = await payrollService.accruePayroll({ businessId: other.rows[0].id, createdBy: null, periodKey: MORDAD });
    expect(run.status).toBe("accrued");
  });

  it("blocks a period already booked under the old rules (a legacy run has a label but no key)", async () => {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO payroll_runs (business_id, period_label, total_amount, accrual_date)
       VALUES ($1, 'مرداد  ۱۴۰۴', 50000000, '2025-08-01') RETURNING id`,
      [biz.id],
    );
    await expect(accrue({ periodKey: MORDAD })).rejects.toMatchObject({
      message: "period_already_accrued",
      details: { run: { id: rows[0].id } },
    });
    expect(await message(accrue({ periodKey: "۱۴۰۴-۰۵" }))).toBe("period_already_accrued");
    // …but a *voided* legacy run does not block.
    await db.query(`UPDATE payroll_runs SET status = 'voided' WHERE id = $1`, [rows[0].id]);
    expect((await accrue({ periodKey: MORDAD })).status).toBe("accrued");
  });

  it("books a period exactly once when many requests race", async () => {
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => accrue({ periodKey: MORDAD })));
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(7);
    for (const r of rejected) expect((r.reason as Error).message).toBe("period_already_accrued");

    expect(await count("SELECT COUNT(*)::text AS n FROM payroll_runs WHERE business_id = $1")).toBe(1);
    expect(await count("SELECT COUNT(*)::text AS n FROM journal_entries WHERE business_id = $1 AND source_type = 'payroll_accrual'")).toBe(1);
    // The liability was raised once, not eight times.
    expect(await payableBalance()).toBe("50000000");
  });

  it("books a period exactly once when racing requests spell it differently", async () => {
    const spellings = ["1404-05", "۱۴۰۴-۰۵", "١٤٠٤-٠٥", " 1404 - 05 ", "1404–05", "1404\u200f-05"];
    const results = await Promise.allSettled(spellings.map((periodKey) => accrue({ periodKey })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await count("SELECT COUNT(*)::text AS n FROM payroll_runs WHERE business_id = $1")).toBe(1);
    expect(await payableBalance()).toBe("50000000");
  });

  it("books different periods concurrently without interference", async () => {
    const results = await Promise.all(
      [1, 2, 3, 4].map((month) => accrue({ periodKey: `1404-0${month}` })),
    );
    expect(new Set(results.map((r) => r.id)).size).toBe(4);
    expect(await payableBalance()).toBe("200000000");
  });
});

describe("idempotent retry (issue #835 §4)", () => {
  const KEY = "retry-key-0001";

  it("returns the run it created instead of a second one", async () => {
    const first = await accrue({ periodKey: MORDAD, idempotencyKey: KEY });
    expect(first.idempotentReplay).toBe(false);
    const retry = await accrue({ periodKey: MORDAD, idempotencyKey: KEY });
    expect(retry.idempotentReplay).toBe(true);
    expect(retry.id).toBe(first.id);
    expect(retry.totalAmount).toBe(first.totalAmount);
    expect(await count("SELECT COUNT(*)::text AS n FROM payroll_runs WHERE business_id = $1")).toBe(1);
    expect(await payableBalance()).toBe("50000000");
  });

  it("replays after the run has since been paid or voided, reporting its current state", async () => {
    const first = await accrue({ periodKey: MORDAD, idempotencyKey: KEY });
    await pay(first.id);
    expect((await accrue({ periodKey: MORDAD, idempotencyKey: KEY })).status).toBe("paid");
    await voidRun(first.id);
    const replay = await accrue({ periodKey: MORDAD, idempotencyKey: KEY });
    expect(replay.status).toBe("voided");
    expect(replay.id).toBe(first.id);
    expect(await count("SELECT COUNT(*)::text AS n FROM payroll_runs WHERE business_id = $1")).toBe(1);
  });

  it("matches a retry that spells the period differently", async () => {
    const first = await accrue({ periodKey: "۱۴۰۴-۰۵", idempotencyKey: KEY });
    expect((await accrue({ periodKey: "1404-05", idempotencyKey: KEY })).id).toBe(first.id);
  });

  it("refuses the same key for a different period", async () => {
    await accrue({ periodKey: MORDAD, idempotencyKey: KEY });
    await expect(accrue({ periodKey: "1404-06", idempotencyKey: KEY })).rejects.toMatchObject({
      message: "idempotency_key_conflict",
      status: 409,
    });
    expect(await count("SELECT COUNT(*)::text AS n FROM payroll_runs WHERE business_id = $1")).toBe(1);
  });

  it("refuses the same key with a different accrual date when one is stated", async () => {
    await accrue({ periodKey: MORDAD, idempotencyKey: KEY, accrualDate: "2025-08-01" });
    expect(await message(accrue({ periodKey: MORDAD, idempotencyKey: KEY, accrualDate: "2025-08-05" }))).toBe(
      "idempotency_key_conflict",
    );
    // Omitting the date on the retry is the ordinary network-retry shape.
    expect((await accrue({ periodKey: MORDAD, idempotencyKey: KEY })).idempotentReplay).toBe(true);
  });

  it("is not a way around the period rule: a new key for a booked period is still a duplicate", async () => {
    await accrue({ periodKey: MORDAD, idempotencyKey: KEY });
    expect(await message(accrue({ periodKey: MORDAD, idempotencyKey: "another-key-0002" }))).toBe(
      "period_already_accrued",
    );
  });

  it("scopes keys to the business", async () => {
    await accrue({ periodKey: MORDAD, idempotencyKey: KEY });
    const other = await db.query<{ id: string }>(
      "INSERT INTO businesses (name, slug) VALUES ('Other', $1) RETURNING id",
      [`other-${randomUUID().slice(0, 8)}`],
    );
    await db.query(`INSERT INTO users (business_id, role, full_name, pin_hash, monthly_wage) VALUES ($1, 'cashier', 'X', 'x', 10)`, [
      other.rows[0].id,
    ]);
    await db.query(
      `INSERT INTO accounts (business_id, code, name, type) VALUES ($1, '5200', 'e', 'expense'), ($1, '2300', 'p', 'liability')`,
      [other.rows[0].id],
    );
    const theirs = await payrollService.accruePayroll({
      businessId: other.rows[0].id,
      createdBy: null,
      periodKey: MORDAD,
      idempotencyKey: KEY,
    });
    expect(theirs.idempotentReplay).toBe(false);
  });

  it("returns one run, replayed, when the same request races itself", async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, () => accrue({ periodKey: MORDAD, idempotencyKey: KEY })),
    );
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
    expect(results.filter((r) => r.idempotentReplay)).toHaveLength(5);
    expect(await payableBalance()).toBe("50000000");
  });

  it("rejects a malformed key and a non-string one, and treats a blank one as absent", async () => {
    expect(await message(accrue({ idempotencyKey: "short" }))).toBe("idempotency_key_invalid");
    expect(await message(accrue({ idempotencyKey: "has a space inside it" }))).toBe("idempotency_key_invalid");
    expect(await message(accrue({ idempotencyKey: "x".repeat(129) }))).toBe("idempotency_key_invalid");
    expect(await message(accrue({ idempotencyKey: 12345678 }))).toBe("idempotency_key_invalid");
    expect((await accrue({ idempotencyKey: "   " })).idempotentReplay).toBe(false);
  });

  it("is enforced by the database too: one key, one run", async () => {
    await accrue({ periodKey: MORDAD, idempotencyKey: KEY });
    await expect(
      db.query(
        `INSERT INTO payroll_runs (business_id, period_label, period_key, idempotency_key, total_amount, accrual_date)
         VALUES ($1, 'x', '1404-06', $2, 1, CURRENT_DATE)`,
        [biz.id, KEY],
      ),
    ).rejects.toMatchObject({ code: "23505", constraint: "uq_payroll_runs_idempotency" });
  });
});

// ---------------------------------------------------------------------------
// Employee identity (issue #835 §5)
// ---------------------------------------------------------------------------

describe("employee identity on a run (issue #835 §5)", () => {
  async function lineFor(runId: string, userId: string) {
    const run = await payrollService.getPayrollRun(biz.id, runId);
    return run!.lines.find((l) => l.userId === userId)!;
  }

  it("snapshots name, personnel code and role at accrual time", async () => {
    await db.query(`INSERT INTO employees (id, business_id, employee_code) VALUES ($1, $2, 'P-001')`, [staff.a, biz.id]);
    const run = await accrue();
    const line = await lineFor(run.id, staff.a);
    expect(line).toMatchObject({ fullName: "Staff A", employeeCode: "P-001", role: "cashier", amount: "30000000" });
    const other = await lineFor(run.id, staff.b);
    expect(other).toMatchObject({ fullName: "Staff B", employeeCode: null, role: "waiter" });
  });

  it("does not rewrite a past run when the employee is renamed, re-roled or re-coded", async () => {
    await db.query(`INSERT INTO employees (id, business_id, employee_code) VALUES ($1, $2, 'P-001')`, [staff.a, biz.id]);
    const run = await accrue();

    await db.query(`UPDATE users SET full_name = 'علی رضایی', role = 'manager' WHERE id = $1`, [staff.a]);
    await db.query(`UPDATE employees SET employee_code = 'P-999' WHERE id = $1`, [staff.a]);

    const line = await lineFor(run.id, staff.a);
    expect(line).toMatchObject({ fullName: "Staff A", employeeCode: "P-001", role: "cashier", userId: staff.a });

    // A new run after the rename shows the new identity — each run is its own snapshot.
    await voidRun(run.id);
    const next = await accrue();
    expect(await lineFor(next.id, staff.a)).toMatchObject({ fullName: "علی رضایی", employeeCode: "P-999", role: "manager" });
  });

  it("keeps a historical line's identity when the member is deleted (user_id becomes null, the name stays)", async () => {
    const run = await accrue();
    await db.query(`DELETE FROM users WHERE id = $1`, [staff.a]);

    const reloaded = await payrollService.getPayrollRun(biz.id, run.id);
    const orphan = reloaded!.lines.find((l) => l.userId === null)!;
    expect(orphan).toMatchObject({ fullName: "Staff A", role: "cashier", amount: "30000000", payableAmount: "30000000" });
    expect(reloaded!.lines).toHaveLength(2);
    expect(reloaded!.totalAmount).toBe("50000000");

    // The same through the history reader the assistant uses.
    const { runs } = await payrollService.listPayrollRuns(biz.id, { includeLines: true });
    expect(runs[0].lines!.map((l) => l.fullName).sort()).toEqual(["Staff A", "Staff B"]);
  });

  it("makes a line immutable: only the referential user_id → NULL may touch it", async () => {
    const run = await accrue();
    for (const sql of [
      `UPDATE payroll_run_lines SET employee_name_snapshot = 'forged' WHERE run_id = $1`,
      `UPDATE payroll_run_lines SET employee_code_snapshot = 'forged' WHERE run_id = $1`,
      `UPDATE payroll_run_lines SET employee_role_snapshot = 'owner' WHERE run_id = $1`,
      `UPDATE payroll_run_lines SET amount = amount + 1 WHERE run_id = $1`,
      `UPDATE payroll_run_lines SET commission_amount = 5 WHERE run_id = $1`,
    ]) {
      await expect(db.query(sql, [run.id]), sql).rejects.toThrow(/immutable/);
    }
    // Re-pointing a line at a *different* member is also a rewrite of identity.
    await expect(db.query(`UPDATE payroll_run_lines SET user_id = $2 WHERE run_id = $1`, [run.id, owner.id])).rejects.toThrow(/immutable/);
    const line = await lineFor(run.id, staff.a);
    expect(line.fullName).toBe("Staff A");
  });

  it("backfills a legacy line (written before snapshots) from the live member until it is gone", async () => {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO payroll_runs (business_id, period_label, total_amount, accrual_date) VALUES ($1, 'legacy', 30000000, '2025-05-20') RETURNING id`,
      [biz.id],
    );
    await db.query(`INSERT INTO payroll_run_lines (run_id, user_id, amount) VALUES ($1, $2, 30000000)`, [rows[0].id, staff.a]);
    expect((await lineFor(rows[0].id, staff.a)).fullName).toBe("Staff A"); // live fallback
    await db.query(`DELETE FROM users WHERE id = $1`, [staff.a]);
    const reloaded = await payrollService.getPayrollRun(biz.id, rows[0].id);
    expect(reloaded!.lines[0]).toMatchObject({ userId: null, fullName: null }); // unrecoverable → the screen's «عضو حذف‌شده»
  });
});

// ---------------------------------------------------------------------------
// Payment
// ---------------------------------------------------------------------------

describe("payPayroll", () => {
  it("posts the payment half and marks the run paid", async () => {
    const run = await accrue();
    const paid = await pay(run.id);
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
    expect(await payableBalance()).toBe("0");
  });

  it("404s paying a run that doesn't exist", async () => {
    expect(await message(pay(randomUUID()))).toBe("run_not_found");
  });

  it("404s (not 500) paying a run id that isn't a uuid", async () => {
    expect(await message(pay("nope"))).toBe("run_not_found");
  });

  it("rejects a malformed paid date with a 400, not a date-cast 500", async () => {
    const run = await accrue();
    expect(await message(pay(run.id, { paidDate: "2025-02-31" }))).toBe("invalid_paid_date");

    // And the run is still payable — a refused date must not half-pay it.
    const reloaded = await payrollService.getPayrollRun(biz.id, run.id);
    expect(reloaded!.status).toBe("accrued");
  });

  it("rejects an unknown method rather than paying out of cash", async () => {
    const run = await accrue();
    expect(await message(pay(run.id, { method: "crypto" }))).toBe("invalid_method");
    expect((await payrollService.getPayrollRun(biz.id, run.id))!.status).toBe("accrued");
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
    const run = await accrue();

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

    const inFlight = pay(run.id)
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
    expect(await count(`SELECT COUNT(*)::text AS n FROM journal_entries WHERE business_id = $1 AND source_type = 'payroll_payment'`)).toBe(0);

    const { rows: cash } = await db.query<{ credit: string }>(
      `SELECT COALESCE(SUM(jl.credit), 0)::text AS credit FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.entry_id
        WHERE je.business_id = $1 AND jl.account_id = $2`,
      [biz.id, acct.cash],
    );
    expect(cash[0].credit).toBe("0");
  });

  it("posts exactly one payment when real payments race (a double-click)", async () => {
    const run = await accrue();
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => pay(run.id)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results.filter((r): r is PromiseRejectedResult => r.status === "rejected")) {
      expect((r.reason as Error).message).toBe("already_paid");
    }
    expect(await count(`SELECT COUNT(*)::text AS n FROM journal_entries WHERE business_id = $1 AND source_type = 'payroll_payment'`)).toBe(1);
    expect(await payableBalance()).toBe("0");
  });

  it("refuses to pay an already-paid run", async () => {
    const run = await accrue();
    await pay(run.id);
    expect(await message(pay(run.id))).toBe("already_paid");
  });

  it("treats an empty-string paidDate as today rather than crashing on a date cast", async () => {
    const run = await accrue();
    const paid = await pay(run.id, { paidDate: "   " });
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

describe("payment date (issue #835 §8)", () => {
  it("carries the chosen date to both the journal entry and the run", async () => {
    const run = await accrue({ accrualDate: "2025-05-20" });
    const paid = await pay(run.id, { paidDate: "2025-05-27" });
    expect(paid.paidDate).toBe("2025-05-27");
    const payment = (await entriesFor(run.id)).find((e) => e.source_type === "payroll_payment")!;
    expect(payment.entry_date).toBe("2025-05-27");
  });

  it("allows paying on the accrual date itself", async () => {
    const run = await accrue({ accrualDate: "2025-05-20" });
    expect((await pay(run.id, { paidDate: "2025-05-20" })).paidDate).toBe("2025-05-20");
  });

  it("refuses a payment dated before the accrual, and leaves the run payable", async () => {
    const run = await accrue({ accrualDate: "2025-05-20" });
    expect(await message(pay(run.id, { paidDate: "2025-05-19" }))).toBe("paid_date_before_accrual");
    expect(await count(`SELECT COUNT(*)::text AS n FROM journal_entries WHERE business_id = $1 AND source_type = 'payroll_payment'`)).toBe(0);
    expect((await payrollService.getPayrollRun(biz.id, run.id))!.status).toBe("accrued");
    // The refusal is about the date alone: a valid one still pays it.
    expect((await pay(run.id, { paidDate: "2025-05-21" })).status).toBe("paid");
  });

  it("applies the same rule to the default (today) when the accrual is dated in the future", async () => {
    const run = await accrue({ accrualDate: "2999-01-01" });
    expect(await message(pay(run.id))).toBe("paid_date_before_accrual");
    expect((await pay(run.id, { paidDate: "2999-01-02" })).status).toBe("paid");
  });

  it("still applies the fiscal-period lock to the payment date", async () => {
    const run = await accrue({ accrualDate: "2025-03-25" });
    await fiscalService.createFiscalYear(biz.id, 1404);
    const [year] = await fiscalService.listFiscalYears(biz.id);
    const periods = await fiscalService.listPeriods(biz.id, year.id);
    const farvardin = periods[0]; // 1404-01-01 … 1404-01-31 = 2025-03-21 … 2025-04-20
    await fiscalService.setPeriodStatus(biz.id, farvardin.id, "soft_closed", owner.id);
    await fiscalService.setPeriodStatus(biz.id, farvardin.id, "locked", owner.id);
    expect(await message(pay(run.id, { paidDate: "2025-04-01" }))).toBe("fiscal_period_locked");
    expect((await payrollService.getPayrollRun(biz.id, run.id))!.status).toBe("accrued");
  });
});

describe("payment account (issue #835 §14)", () => {
  async function creditedAccount(runId: string): Promise<string> {
    const { rows } = await db.query<{ account_id: string }>(
      `SELECT jl.account_id FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
        WHERE je.business_id = $1 AND je.source_id = $2 AND je.source_type = 'payroll_payment' AND jl.credit > 0`,
      [biz.id, runId],
    );
    expect(rows).toHaveLength(1);
    return rows[0].account_id;
  }

  it("credits the business's own bank account (1110) for a bank payment — not card money in transit", async () => {
    const run = await accrue();
    await pay(run.id, { method: "bank" });
    const credited = await creditedAccount(run.id);
    expect(credited).toBe(acct.bank);
    expect(credited).not.toBe(acct.bankClearing);
    // Not the till either: the whole point of the method switch.
    expect(credited).not.toBe(acct.cash);
  });

  it("credits a chosen bank account opened under بانک", async () => {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO accounts (business_id, parent_id, code, name, type) VALUES ($1, $2, '11101', 'Bank Melli', 'asset') RETURNING id`,
      [biz.id, acct.bank],
    );
    const run = await accrue();
    await pay(run.id, { paymentAccountId: rows[0].id });
    expect(await creditedAccount(run.id)).toBe(rows[0].id);
  });

  it("credits a chosen petty-cash account, and an explicit account wins over the method", async () => {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO accounts (business_id, code, name, type) VALUES ($1, '1130', 'Petty cash', 'asset') RETURNING id`,
      [biz.id],
    );
    const run = await accrue();
    await pay(run.id, { method: "bank", paymentAccountId: rows[0].id });
    expect(await creditedAccount(run.id)).toBe(rows[0].id);
  });

  it("refuses to pay from card money in transit, a receivable, a liability or an expense", async () => {
    const run = await accrue();
    for (const accountId of [acct.bankClearing, acct.receivable, acct.salariesPayable, acct.salariesExpense]) {
      expect(await message(pay(run.id, { paymentAccountId: accountId })), accountId).toBe("invalid_payment_account");
    }
    expect((await payrollService.getPayrollRun(biz.id, run.id))!.status).toBe("accrued");
  });

  it("refuses an account of another business, an archived one, a heading, an unknown one and a non-uuid", async () => {
    const other = await db.query<{ id: string }>(
      "INSERT INTO businesses (name, slug) VALUES ('Other', $1) RETURNING id",
      [`other-${randomUUID().slice(0, 8)}`],
    );
    const foreign = await db.query<{ id: string }>(
      `INSERT INTO accounts (business_id, code, name, type) VALUES ($1, '1100', 'Their cash', 'asset') RETURNING id`,
      [other.rows[0].id],
    );
    const archived = await db.query<{ id: string }>(
      `INSERT INTO accounts (business_id, code, name, type, is_active) VALUES ($1, '1105', 'Old cash', 'asset', false) RETURNING id`,
      [biz.id],
    );
    // 1110 becomes a heading once it has a child.
    await db.query(`INSERT INTO accounts (business_id, parent_id, code, name, type) VALUES ($1, $2, '11101', 'Sub', 'asset')`, [biz.id, acct.bank]);

    const run = await accrue();
    for (const paymentAccountId of [foreign.rows[0].id, archived.rows[0].id, acct.bank, randomUUID(), "not-a-uuid"]) {
      expect(await message(pay(run.id, { paymentAccountId })), paymentAccountId).toBe("invalid_payment_account");
    }
    // The plain `bank` method still posts to the well-known account, headings included.
    await pay(run.id, { method: "bank" });
    expect(await creditedAccount(run.id)).toBe(acct.bank);
  });

  it("lists exactly the accounts a payment may leave", async () => {
    await db.query(`INSERT INTO accounts (business_id, parent_id, code, name, type) VALUES ($1, $2, '11101', 'Bank Melli', 'asset')`, [biz.id, acct.bank]);
    const listed = await payrollAccounts.listPaymentAccounts(biz.id);
    expect(listed.map((a) => [a.code, a.role])).toEqual([
      ["1100", "cash"],
      ["11101", "bank"],
    ]);
  });

  it("answers a missing system account as a controlled error, not a crash", async () => {
    await db.query(`DELETE FROM accounts WHERE business_id = $1 AND code = '1110'`, [biz.id]);
    const run = await accrue();
    await expect(pay(run.id, { method: "bank" })).rejects.toMatchObject({ code: "1110" });
  });
});

// ---------------------------------------------------------------------------
// Void
// ---------------------------------------------------------------------------

describe("voidPayrollRun", () => {
  it("reverses an accrued (unpaid) run with a single mirror entry and marks it voided", async () => {
    const run = await accrue({ accrualDate: "2025-05-20" });

    const voided = await voidRun(run.id);
    expect(voided.status).toBe("voided");
    expect(voided.voidedDate).not.toBeNull();
    // An ISO instant the screen can format — a raw `timestamptz::text` is not
    // guaranteed to parse, and an unparseable date renders as a dash.
    expect(voided.voidedDate).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(Number.isNaN(Date.parse(voided.voidedDate!))).toBe(false);

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
    for (const r of net) expect(r.net).toBe("0");
  });

  it("reverses both the accrual and the payment of a paid run", async () => {
    const run = await accrue();
    await pay(run.id);

    const voided = await voidRun(run.id);
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
    for (const r of net) expect(r.net).toBe("0");
  });

  it("refuses to void an already-voided run", async () => {
    const run = await accrue();
    await voidRun(run.id);
    expect(await message(voidRun(run.id))).toBe("already_voided");
  });

  // A void posts its mirrors dated *today*, never backdated, so a closed period
  // is not reopened to fix a mistake: while today's period is locked the void is
  // refused, and refused whole — the run, its claims and the ledger are as they were.
  it("refuses to void while today's fiscal period is locked, leaving everything as it was", async () => {
    const run = await accrue({ accrualDate: "2025-05-20" });
    await pay(run.id, { paidDate: "2025-05-21" });

    const today = (await db.query<{ d: string }>(`SELECT CURRENT_DATE::text AS d`)).rows[0].d;
    const [gy, gm, gd] = today.split("-").map(Number);
    await fiscalService.createFiscalYear(biz.id, toJalali(gy, gm, gd).jy);
    const [year] = await fiscalService.listFiscalYears(biz.id);
    const period = (await fiscalService.listPeriods(biz.id, year.id)).find((p) => p.startsOn <= today && today <= p.endsOn);
    expect(period).toBeDefined();
    await fiscalService.setPeriodStatus(biz.id, period!.id, "soft_closed", owner.id);
    await fiscalService.setPeriodStatus(biz.id, period!.id, "locked", owner.id);

    const balanceBefore = await payableBalance();
    expect(await message(voidRun(run.id))).toBe("fiscal_period_locked");

    expect((await payrollService.getPayrollRun(biz.id, run.id))!.status).toBe("paid");
    expect(await count("SELECT COUNT(*)::text AS n FROM journal_entries WHERE business_id = $1 AND reverses_entry_id IS NOT NULL")).toBe(0);
    expect(await payableBalance()).toBe(balanceBefore);

    // Reopening the period lets the same void through — it was the lock, not the run.
    await fiscalService.setPeriodStatus(biz.id, period!.id, "open", owner.id);
    expect((await voidRun(run.id)).status).toBe("voided");
  });

  it("404s voiding a run that doesn't exist", async () => {
    expect(await message(voidRun(randomUUID()))).toBe("run_not_found");
  });

  it("404s (not 500) voiding a run id that isn't a uuid", async () => {
    expect(await message(voidRun("nope"))).toBe("run_not_found");
  });

  // Same race as paying: two «ابطال» clicks both read `accrued` on an unlocked
  // check and both mirrored the run's entries, double-reversing it. Forced the
  // same way — see the payment race for why allSettled alone proves nothing.
  it("voids only once when two voids race", async () => {
    const run = await accrue();

    const competitor = new Client({ connectionString: urlFor(databaseName) });
    await competitor.connect();
    await competitor.query("SELECT set_config('app.rls_bypass', 'on', true)");
    await competitor.query("BEGIN");
    await competitor.query("SELECT id FROM payroll_runs WHERE id = $1 FOR UPDATE", [run.id]);

    const inFlight = voidRun(run.id)
      .then(() => "voided" as const)
      .catch((e: unknown) => (e instanceof Error ? e.message : String(e)));

    await new Promise((resolve) => setTimeout(resolve, 250));
    await competitor.query("UPDATE payroll_runs SET status = 'voided', voided_at = now() WHERE id = $1", [run.id]);
    await competitor.query("COMMIT");
    await competitor.end();

    expect(await inFlight).toBe("already_voided");

    // No reversal was mirrored, so the accrual stands exactly once.
    expect(await count(`SELECT COUNT(*)::text AS n FROM journal_entries WHERE business_id = $1 AND source_type = 'payroll_accrual_void'`)).toBe(0);
  });

  it("mirrors exactly once when real voids race", async () => {
    const run = await accrue();
    await pay(run.id);
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => voidRun(run.id)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await count(`SELECT COUNT(*)::text AS n FROM journal_entries WHERE business_id = $1 AND source_type LIKE 'payroll%_void'`)).toBe(2);
    expect(await payableBalance()).toBe("0");
  });

  it("refuses to pay a voided run", async () => {
    const run = await accrue();
    await voidRun(run.id);
    expect(await message(pay(run.id))).toBe("run_voided");
  });
});

// ---------------------------------------------------------------------------
// History (issue #835 §9)
// ---------------------------------------------------------------------------

describe("payroll history (issue #835 §9)", () => {
  /** Seven runs over assorted dates, two of them sharing one — so ties must be broken stably. */
  async function seedHistory(): Promise<string[]> {
    const dates = ["2025-03-01", "2025-04-10", "2025-04-10", "2025-05-20", "2025-02-01", "2025-06-15", "2025-01-05"];
    const ids: string[] = [];
    for (let i = 0; i < dates.length; i++) {
      const run = await accrue({ periodKey: `1404-${String(i + 1).padStart(2, "0")}`, accrualDate: dates[i] });
      ids.push(run.id);
    }
    return ids;
  }

  async function expectedOrder(): Promise<string[]> {
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM payroll_runs WHERE business_id = $1 ORDER BY accrual_date DESC, created_at DESC, id DESC`,
      [biz.id],
    );
    return rows.map((r) => r.id);
  }

  async function pageAll(options: Record<string, unknown>): Promise<string[]> {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 50; guard++) {
      const page: Awaited<ReturnType<typeof payrollService.listPayrollRuns>> = await payrollService.listPayrollRuns(biz.id, {
        ...options,
        cursor,
      });
      seen.push(...page.runs.map((r) => r.id));
      if (!page.nextCursor) return seen;
      cursor = page.nextCursor;
    }
    throw new Error("pagination did not terminate");
  }

  it("lists newest first by accrual date, then creation, then id", async () => {
    await seedHistory();
    const { runs, nextCursor } = await payrollService.listPayrollRuns(biz.id);
    expect(runs.map((r) => r.id)).toEqual(await expectedOrder());
    expect(nextCursor).toBeNull();
    expect(runs.map((r) => r.accrualDate)).toEqual([...runs.map((r) => r.accrualDate)].sort().reverse());
  });

  it("pages through every run exactly once, in the same order, for any page size", async () => {
    await seedHistory();
    const expected = await expectedOrder();
    for (const limit of [1, 2, 3, 5, 7, 50]) {
      const seen = await pageAll({ limit });
      expect(seen, `limit ${limit}`).toEqual(expected);
      expect(new Set(seen).size).toBe(seen.length);
    }
  });

  it("is stable when a run is created while somebody is paging", async () => {
    await seedHistory();
    const expected = await expectedOrder();
    const first = await payrollService.listPayrollRuns(biz.id, { limit: 3 });
    expect(first.runs.map((r) => r.id)).toEqual(expected.slice(0, 3));

    // The newest run appears (and an old one, behind the cursor, too).
    await accrue({ periodKey: "1404-12", accrualDate: "2025-09-01" });
    await accrue({ periodKey: "1403-01", accrualDate: "2024-01-01" });

    const second = await payrollService.listPayrollRuns(biz.id, { limit: 3, cursor: first.nextCursor });
    // No row repeats, none is skipped, and the new *newest* run does not shift the page.
    expect(second.runs.map((r) => r.id)).toEqual(expected.slice(3, 6));
  });

  it("returns summaries without lines, and attaches them only on request", async () => {
    await accrue();
    const { runs } = await payrollService.listPayrollRuns(biz.id);
    expect(runs[0]).not.toHaveProperty("lines");
    expect(runs[0].lineCount).toBe(2);
    const withLines = await payrollService.listPayrollRuns(biz.id, { includeLines: true });
    expect(withLines.runs[0].lines).toHaveLength(2);
    const detail = await payrollService.getPayrollRun(biz.id, runs[0].id);
    expect(detail!.lines).toHaveLength(2);
    expect(await payrollService.getPayrollRun(biz.id, randomUUID())).toBeNull();
    expect(await payrollService.getPayrollRun(biz.id, "nope")).toBeNull();
  });

  it("filters by status", async () => {
    const [a, b, c] = [
      await accrue({ periodKey: "1404-01", accrualDate: "2025-04-01" }),
      await accrue({ periodKey: "1404-02", accrualDate: "2025-05-01" }),
      await accrue({ periodKey: "1404-03", accrualDate: "2025-06-01" }),
    ];
    await pay(b.id);
    await voidRun(c.id);
    const ids = async (status: "accrued" | "paid" | "voided" | null) =>
      (await payrollService.listPayrollRuns(biz.id, { status })).runs.map((r) => r.id);
    expect(await ids("accrued")).toEqual([a.id]);
    expect(await ids("paid")).toEqual([b.id]);
    expect(await ids("voided")).toEqual([c.id]);
    expect(await ids(null)).toEqual([c.id, b.id, a.id]);
  });

  it("filters by accrual-date range, inclusively, combined with paging", async () => {
    await seedHistory();
    const inRange = async (from: string | null, to: string | null) =>
      (await payrollService.listPayrollRuns(biz.id, { from, to })).runs.map((r) => r.accrualDate);
    expect(await inRange("2025-04-10", "2025-04-10")).toEqual(["2025-04-10", "2025-04-10"]);
    expect(await inRange("2025-05-01", null)).toEqual(["2025-06-15", "2025-05-20"]);
    expect(await inRange(null, "2025-02-01")).toEqual(["2025-02-01", "2025-01-05"]);
    expect(await inRange("2026-01-01", null)).toEqual([]);
    expect((await pageAll({ from: "2025-03-01", to: "2025-05-31", limit: 2 })).length).toBe(4);
  });

  it("filters by period identity, however the period is spelled", async () => {
    await accrue({ periodKey: MORDAD });
    await accrue({ periodKey: "1404-06" });
    for (const spelling of ["1404-05", "۱۴۰۴-۰۵", "مرداد 1404", "  مرداد  ۱۴۰۴", "1404/05"]) {
      const { runs } = await payrollService.listPayrollRuns(biz.id, { period: spelling });
      expect(runs.map((r) => r.periodLabel), spelling).toEqual(["مرداد 1404"]);
    }
    expect(await message(payrollService.listPayrollRuns(biz.id, { period: "پاداش عید" }))).toBe("invalid_period");
    expect((await payrollService.listPayrollRuns(biz.id, { period: "مهر 1404" })).runs).toEqual([]);
  });

  it("bounds the page size: a default, a ceiling, and a refusal of nonsense", async () => {
    await db.query(
      `INSERT INTO payroll_runs (business_id, period_label, total_amount, accrual_date)
       SELECT $1, 'run ' || g, 1, DATE '2024-01-01' + g FROM generate_series(1, 130) g`,
      [biz.id],
    );
    const byDefault = await payrollService.listPayrollRuns(biz.id);
    expect(byDefault.runs).toHaveLength(20);
    expect(byDefault.nextCursor).not.toBeNull();
    const huge = await payrollService.listPayrollRuns(biz.id, { limit: 100000 });
    expect(huge.runs).toHaveLength(100);
    expect(huge.nextCursor).not.toBeNull();
    expect(await message(payrollService.listPayrollRuns(biz.id, { limit: 0 }))).toBe("invalid_limit");
    expect(await message(payrollService.listPayrollRuns(biz.id, { limit: -5 }))).toBe("invalid_limit");
    expect(await message(payrollService.listPayrollRuns(biz.id, { limit: 2.5 }))).toBe("invalid_limit");
    // Every one of the 130 is still reachable (history is not truncated).
    expect((await pageAll({ limit: 100 })).length).toBe(130);
  });

  it("refuses a forged cursor as a controlled error", async () => {
    await accrue();
    expect(await message(payrollService.listPayrollRuns(biz.id, { cursor: "garbage" }))).toBe("invalid_cursor");
    const forged = Buffer.from(JSON.stringify({ d: "2025-01-01", c: "x'; DROP TABLE payroll_runs;--", i: randomUUID() })).toString("base64url");
    expect(await message(payrollService.listPayrollRuns(biz.id, { cursor: forged }))).toBe("invalid_cursor");
    expect(await count("SELECT COUNT(*)::text AS n FROM payroll_runs WHERE business_id = $1")).toBe(1);
  });

  it("never shows another business's runs", async () => {
    await accrue();
    const other = await db.query<{ id: string }>(
      "INSERT INTO businesses (name, slug) VALUES ('Other', $1) RETURNING id",
      [`other-${randomUUID().slice(0, 8)}`],
    );
    expect((await payrollService.listPayrollRuns(other.rows[0].id)).runs).toEqual([]);
    const mine = (await payrollService.listPayrollRuns(biz.id)).runs[0];
    expect(await payrollService.getPayrollRun(other.rows[0].id, mine.id)).toBeNull();
  });

  it("keeps the history reachable for the assistant's bounded read", async () => {
    await seedHistory();
    const { runs } = await payrollService.listPayrollRuns(biz.id, { limit: 6, includeLines: true });
    expect(runs).toHaveLength(6);
    expect(runs.every((r) => r.lines!.length === 2)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Exact money (issue #835 §10)
// ---------------------------------------------------------------------------

describe("exact money (issue #835 §10)", () => {
  const NEAR_MAX_SAFE = "9007199254740991"; // 2^53 − 1: the largest wage a JSON number can carry
  const put = (userId: string, monthlyWage: string) =>
    setWage({ businessId: biz.id, userId, monthlyWage, actorId: owner.id });

  it("keeps a total exact when valid wages sum past Number.MAX_SAFE_INTEGER", async () => {
    const third = await db.query<{ id: string }>(
      `INSERT INTO users (business_id, role, full_name, pin_hash) VALUES ($1, 'cashier', 'Staff C', 'x') RETURNING id`,
      [biz.id],
    );
    for (const id of [staff.a, staff.b, third.rows[0].id]) await put(id, NEAR_MAX_SAFE);
    const exact = (BigInt(NEAR_MAX_SAFE) * 3n).toString(); // 27021597764222973
    // The naive floating-point sum is off — the bug this exists to prevent.
    expect(String(Number(NEAR_MAX_SAFE) * 3)).not.toBe(exact);

    const run = await accrue();
    expect(run.totalAmount).toBe(exact);
    expect(run.netAmount).toBe(exact);
    expect(run.lines.map((l) => l.amount)).toEqual([NEAR_MAX_SAFE, NEAR_MAX_SAFE, NEAR_MAX_SAFE]);

    // The journal carries the exact figure on both sides.
    const { rows } = await db.query<{ debit: string; credit: string }>(
      `SELECT jl.debit::text AS debit, jl.credit::text AS credit FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.entry_id WHERE je.business_id = $1 ORDER BY jl.debit DESC`,
      [biz.id],
    );
    expect(rows).toEqual([
      { debit: exact, credit: "0" },
      { debit: "0", credit: exact },
    ]);
    expect(await payableBalance()).toBe(exact);

    // Pay and void keep it exact, and the liability tie-out agrees to the Rial.
    const liability = await payrollService.getPayrollLiability(biz.id);
    expect(liability).toMatchObject({ ledgerBalance: exact, awaitingPayment: exact, difference: "0" });
    await pay(run.id);
    expect(await payableBalance()).toBe("0");
    await voidRun(run.id);
    expect(await payableBalance()).toBe("0");
  });

  it("carries wages beyond 2^53 through storage, listing, the run and the journal without rounding", async () => {
    const big = "900719925474099312"; // ~9.0e17: not representable as a JS number
    expect(String(Number(big))).not.toBe(big);
    await put(staff.a, big);
    await db.query(`UPDATE users SET monthly_wage = NULL WHERE id = $1`, [staff.b]);

    expect((await payrollService.listStaffWages(biz.id)).find((s) => s.id === staff.a)!.monthlyWage).toBe(big);
    const run = await accrue();
    expect(run.totalAmount).toBe(big);
    expect(run.lines[0].amount).toBe(big);
    const { changes } = await payrollService.listPayTermChanges(biz.id, staff.a);
    expect(changes[0].newAmount).toBe(big);
    const paid = await pay(run.id);
    expect(paid.totalAmount).toBe(big);
    expect(await payableBalance()).toBe("0");
  });

  it("posts a gross-to-net accrual past 2^53 exactly, every side of the journal to the Rial", async () => {
    // The merged path end to end: the calculator, the stored breakdown and a four-sided entry.
    await db.query(
      `INSERT INTO accounts (business_id, code, name, type)
       VALUES ($1, '5220', 'Employer insurance', 'expense'), ($1, '2460', 'Insurance payable', 'liability')`,
      [biz.id],
    );
    await payrollService.savePayrollSettings(biz.id, { employeeInsurancePercent: 7, employerInsurancePercent: 20 });
    const big = 900719925474099312n; // ~9.0e17 — not representable as a JS number
    await put(staff.a, big.toString());
    await db.query(`UPDATE users SET monthly_wage = NULL WHERE id = $1`, [staff.b]);

    const employee = (big * 700n + 5000n) / 10_000n; // 7%, rounded half-up
    const employer = (big * 2000n + 5000n) / 10_000n; // 20%
    const run = await accrue();
    expect(run.totalAmount).toBe(big.toString());
    expect(run.netAmount).toBe((big - employee).toString());
    expect(run.lines[0]).toMatchObject({
      grossRial: big.toString(),
      employeeInsuranceRial: employee.toString(),
      employerInsuranceRial: employer.toString(),
      netPayRial: (big - employee).toString(),
      employerCostRial: (big + employer).toString(),
    });

    const { rows } = await db.query<{ code: string; debit: string; credit: string }>(
      `SELECT a.code, SUM(jl.debit)::text AS debit, SUM(jl.credit)::text AS credit
         FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id JOIN accounts a ON a.id = jl.account_id
        WHERE je.business_id = $1 AND je.source_type = 'payroll_accrual' GROUP BY a.code ORDER BY a.code`,
      [biz.id],
    );
    expect(rows).toEqual([
      { code: "2300", debit: "0", credit: (big - employee).toString() },
      { code: "2460", debit: "0", credit: (employee + employer).toString() },
      { code: "5200", debit: big.toString(), credit: "0" },
      { code: "5220", debit: employer.toString(), credit: "0" },
    ]);
    // Balanced to the Rial: the sum a Number would have rounded.
    expect(big + employer).toBe(big - employee + employee + employer);

    // Paying moves the net only; the run's payable and the tie-out agree.
    expect((await pay(run.id)).payableAmount).toBe((big - employee).toString());
    expect(await payableBalance()).toBe("0");
  });

  it("refuses a total the ledger columns cannot hold, as a controlled error that leaves nothing behind", async () => {
    await put(staff.a, "9223372036854775807");
    await put(staff.b, "9223372036854775807");
    expect(await message(accrue())).toBe("amount_out_of_range");
    expect(await count("SELECT COUNT(*)::text AS n FROM payroll_runs WHERE business_id = $1")).toBe(0);
    expect(await count("SELECT COUNT(*)::text AS n FROM journal_entries WHERE business_id = $1")).toBe(0);
  });

  it("refuses one member whose employer cost the columns cannot hold, naming the member", async () => {
    await payrollService.savePayrollSettings(biz.id, { employerInsurancePercent: 20 });
    await put(staff.a, "9223372036854775807");
    await expect(accrue()).rejects.toMatchObject({ message: "amount_too_large", details: { field: staff.a } });
    expect(await count("SELECT COUNT(*)::text AS n FROM payroll_runs WHERE business_id = $1")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Commission (issue #835 §11)
// ---------------------------------------------------------------------------

describe("commission is settled with payroll (issue #835 §11)", () => {
  let branch = "";

  beforeEach(async () => {
    branch = await addBranch("Counter");
  });

  async function withClient<T>(fn: (client: import("pg").PoolClient) => Promise<T>): Promise<T> {
    const client = await dbLib.getPool().connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  /** A real sale line's commission, through the service the POS uses: Debit 5210 / Credit 2300 at the selling branch. */
  async function earn(employeeId: string, net: number): Promise<string> {
    const result = await withClient((client) =>
      commissionService.accrueCommissionForLine(client, {
        businessId: biz.id,
        locationId: branch,
        employeeId,
        sourceType: "order_item",
        sourceId: randomUUID(),
        line: { net, cost: 0, itemId: randomUUID() },
      }),
    );
    expect(result.entryId).not.toBeNull();
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM commission_accruals WHERE business_id = $1 AND entry_id = $2`,
      [biz.id, result.entryId],
    );
    return rows[0].id;
  }

  /** What a voided invoice does: a negative accrual and the mirror of its posting. */
  async function reverse(accrualId: string): Promise<void> {
    const { rows } = await db.query<{ employee_id: string; amount: string; entry_id: string }>(
      `SELECT employee_id, amount::text AS amount, entry_id FROM commission_accruals WHERE id = $1`,
      [accrualId],
    );
    const original = rows[0];
    const entry = await db.query<{ id: string }>(
      `INSERT INTO journal_entries (business_id, location_id, entry_date, memo, source_type, source_id, reverses_entry_id)
       VALUES ($1, $2, CURRENT_DATE, 'reversal', 'order_amendment', $3, $4) RETURNING id`,
      [biz.id, branch, randomUUID(), original.entry_id],
    );
    await db.query(
      `INSERT INTO journal_lines (entry_id, account_id, debit, credit) VALUES ($1, $2, $4, 0), ($1, $3, 0, $4)`,
      [entry.rows[0].id, acct.salariesPayable, acct.commissionExpense, original.amount],
    );
    await db.query(
      `INSERT INTO commission_accruals (business_id, employee_id, source_type, source_id, amount, basis_amount, entry_id)
       VALUES ($1, $2, 'order_amendment', $3, $4, 0, $5)`,
      [biz.id, original.employee_id, randomUUID(), `-${original.amount}`, entry.rows[0].id],
    );
  }

  beforeEach(async () => {
    for (const employeeId of [staff.a, staff.b]) {
      await commissionService.upsertCommissionRule(biz.id, { employeeId, kind: "percent", basis: "net", value: 10 });
    }
  });

  const claimed = async (runId: string): Promise<number> =>
    count(`SELECT COUNT(*)::text AS n FROM commission_accruals WHERE business_id = $1 AND payroll_run_id = $2`, [biz.id, runId]);

  /**
   * A run for `periodKey` dated today. A closed month defaults to its own last
   * day, which is *before* the commission these tests earn today — correctly
   * out of its cut-off — so a test that wants it settled dates the run today.
   */
  const accrueToday = async (periodKey: string, extra: Record<string, unknown> = {}) =>
    accrue({
      periodKey,
      accrualDate: (await db.query<{ d: string }>(`SELECT CURRENT_DATE::text AS d`)).rows[0].d,
      ...extra,
    });

  it("settles commission in the same run: wage accrues, commission is claimed, one payment clears both", async () => {
    await earn(staff.a, 50_000_000); // → 5,000,000
    await earn(staff.a, 20_000_000); // → 2,000,000
    await earn(staff.b, 10_000_000); // → 1,000,000
    expect(await payableBalance()).toBe("8000000"); // commission is already a liability

    const preview = await payrollService.previewCommission(biz.id);
    expect(preview.total).toBe("8000000");
    expect(preview.lines.map((l) => [l.fullName, l.amount])).toEqual([
      ["Staff A", "7000000"],
      ["Staff B", "1000000"],
    ]);

    const run = await accrue();
    expect(run).toMatchObject({ totalAmount: "50000000", netAmount: "50000000", commissionTotal: "8000000", payableAmount: "58000000" });
    const lineA = run.lines.find((l) => l.userId === staff.a)!;
    const lineB = run.lines.find((l) => l.userId === staff.b)!;
    expect(lineA).toMatchObject({ amount: "30000000", commissionAmount: "7000000", payableAmount: "37000000" });
    expect(lineB).toMatchObject({ amount: "20000000", commissionAmount: "1000000", payableAmount: "21000000" });
    expect(await claimed(run.id)).toBe(3);

    // The accrual entry posts the WAGE bill only — commission is already in 2300, not credited a second time.
    const accrual = (await entriesFor(run.id)).find((e) => e.source_type === "payroll_accrual")!;
    const { rows: accrualLines } = await db.query<{ code: string; debit: string; credit: string }>(
      `SELECT a.code, jl.debit::text AS debit, jl.credit::text AS credit FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id WHERE jl.entry_id = $1 ORDER BY a.code`,
      [accrual.id],
    );
    expect(accrualLines).toEqual([
      { code: "2300", debit: "0", credit: "50000000" },
      { code: "5200", debit: "50000000", credit: "0" },
    ]);
    // 2300 now holds wages + commission, all of it owed under this run.
    expect(await payableBalance()).toBe("58000000");
    expect(await payrollService.getPayrollLiability(biz.id)).toEqual({
      ledgerBalance: "58000000",
      awaitingPayment: "58000000",
      unsettledCommission: "0",
      difference: "0",
    });

    // The payment settles wage + commission together; 2300 ties out to zero.
    const paid = await pay(run.id);
    expect(paid.status).toBe("paid");
    const { rows: paymentLines } = await db.query<{ debit: string; credit: string; account_id: string }>(
      `SELECT jl.debit::text AS debit, jl.credit::text AS credit, jl.account_id FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.entry_id WHERE je.source_id = $1 AND je.source_type = 'payroll_payment' ORDER BY jl.debit DESC`,
      [run.id],
    );
    expect(paymentLines).toEqual([
      { debit: "58000000", credit: "0", account_id: acct.salariesPayable },
      { debit: "0", credit: "58000000", account_id: acct.cash },
    ]);
    expect(await payableBalance()).toBe("0");
    expect(await payrollService.getPayrollLiability(biz.id)).toEqual({
      ledgerBalance: "0",
      awaitingPayment: "0",
      unsettledCommission: "0",
      difference: "0",
    });
  });

  it("settles each commission accrual once: a later run does not pay it again", async () => {
    await earn(staff.a, 50_000_000);
    const first = await accrueToday(MORDAD);
    await pay(first.id);
    const second = await accrueToday("1404-06");
    expect(second.commissionTotal).toBe("0");
    expect(second.lines.every((l) => l.commissionAmount === "0")).toBe(true);
    expect(await claimed(first.id)).toBe(1);
    expect(await claimed(second.id)).toBe(0);
  });

  it("does not let two runs built at once claim the same commission", async () => {
    for (let i = 0; i < 6; i++) await earn(staff.a, 10_000_000); // 6 accruals of 1,000,000
    const results = await Promise.all(
      [1, 2, 3].map((month) => accrueToday(`1404-0${month}`)),
    );
    const total = results.reduce((sum, r) => sum + BigInt(r.commissionTotal), 0n);
    expect(total).toBe(6_000_000n);
    expect(results.filter((r) => r.commissionTotal !== "0")).toHaveLength(1);
    expect(await count(`SELECT COUNT(*)::text AS n FROM commission_accruals WHERE business_id = $1 AND payroll_run_id IS NOT NULL`)).toBe(6);
    // Whatever order they interleaved in, the books agree: wages + commission, once.
    expect(await payableBalance()).toBe((3n * 50_000_000n + 6_000_000n).toString());
    const liability = await payrollService.getPayrollLiability(biz.id);
    expect(liability.difference).toBe("0");
  });

  it("shows a paid run does not imply all compensation is settled: commission earned afterwards stays visible", async () => {
    await earn(staff.a, 50_000_000);
    const run = await accrue();
    await pay(run.id);
    expect((await payrollService.getPayrollRun(biz.id, run.id))!.status).toBe("paid");

    await earn(staff.b, 30_000_000); // 3,000,000 earned after the run
    const liability = await payrollService.getPayrollLiability(biz.id);
    expect(liability).toEqual({
      ledgerBalance: "3000000",
      awaitingPayment: "0",
      unsettledCommission: "3000000",
      difference: "0",
    });
    // The next run picks it up.
    const next = await accrueToday("1404-06");
    expect(next.commissionTotal).toBe("3000000");
    await pay(next.id);
    expect((await payrollService.getPayrollLiability(biz.id)).ledgerBalance).toBe("0");
  });

  it("releases the claim when the run is voided, so the next run can settle it", async () => {
    await earn(staff.a, 50_000_000);
    const first = await accrueToday(MORDAD);
    await pay(first.id);
    await voidRun(first.id);
    expect(await claimed(first.id)).toBe(0);
    expect(await payableBalance()).toBe("5000000"); // wages reversed; commission is owed again
    expect((await payrollService.getPayrollLiability(biz.id)).unsettledCommission).toBe("5000000");

    const redo = await accrueToday(MORDAD);
    expect(redo.commissionTotal).toBe("5000000");
    await pay(redo.id);
    expect(await payableBalance()).toBe("0");
    // The voided run keeps its snapshot as history.
    const voided = await payrollService.getPayrollRun(biz.id, first.id);
    expect(voided!.commissionTotal).toBe("5000000");
  });

  it("releases the claim when an accrued (unpaid) run is voided", async () => {
    await earn(staff.a, 50_000_000);
    const run = await accrue();
    expect(await claimed(run.id)).toBe(1);
    await voidRun(run.id);
    expect(await claimed(run.id)).toBe(0);
    expect(await count(`SELECT COUNT(*)::text AS n FROM commission_accruals WHERE business_id = $1 AND payroll_run_id IS NULL`)).toBe(1);
    expect((await payrollService.getPayrollLiability(biz.id)).difference).toBe("0");
  });

  it("nets a return against the commission it reverses, and leaves a net-zero member out", async () => {
    const sale = await earn(staff.a, 50_000_000); // +5,000,000
    await reverse(sale); //                          −5,000,000 (the invoice was voided)
    await earn(staff.b, 30_000_000); //              +3,000,000
    expect(await payableBalance()).toBe("3000000");

    const run = await accrue();
    expect(run.commissionTotal).toBe("3000000");
    expect(run.lines.find((l) => l.userId === staff.a)!.commissionAmount).toBe("0");
    // Staff A's two cancelling rows were not claimed; they wait, still netting to zero.
    expect(await claimed(run.id)).toBe(1);
    await pay(run.id);
    expect(await payableBalance()).toBe("0");
    expect((await payrollService.getPayrollLiability(biz.id)).difference).toBe("0");
  });

  it("nets a partial return against a member's other commission in the same run", async () => {
    const big = await earn(staff.a, 50_000_000); // +5,000,000
    await earn(staff.a, 10_000_000); //             +1,000,000
    await reverse(big); //                           −5,000,000 → net 1,000,000
    const run = await accrue();
    expect(run.lines.find((l) => l.userId === staff.a)!.commissionAmount).toBe("1000000");
    expect(await claimed(run.id)).toBe(3); // both sales and the return are settled together
    await pay(run.id);
    expect(await payableBalance()).toBe("0");
  });

  it("carries a negative net forward instead of paying a negative amount", async () => {
    const sale = await earn(staff.a, 50_000_000);
    const first = await accrueToday(MORDAD);
    await pay(first.id); // settled 5,000,000
    await reverse(sale); //  the invoice is voided afterwards: −5,000,000
    const second = await accrue({ periodKey: "1404-06" });
    expect(second.commissionTotal).toBe("0");
    expect(await claimed(second.id)).toBe(0);
    // The member was overpaid by 5,000,000; 2300 shows it as a debit balance, and the tie-out explains it.
    await pay(second.id);
    const liability = await payrollService.getPayrollLiability(biz.id);
    expect(liability.unsettledCommission).toBe("-5000000");
    expect(liability.ledgerBalance).toBe("-5000000");
    expect(liability.difference).toBe("0");
  });

  it("settles a commission-only run when no member has a wage, posting no accrual", async () => {
    await db.query(`UPDATE users SET monthly_wage = NULL WHERE business_id = $1`, [biz.id]);
    await earn(staff.a, 50_000_000);
    const run = await accrue();
    expect(run).toMatchObject({ totalAmount: "0", netAmount: "0", commissionTotal: "5000000", payableAmount: "5000000" });
    expect(await count(`SELECT COUNT(*)::text AS n FROM journal_entries WHERE business_id = $1 AND source_type = 'payroll_accrual'`)).toBe(0);
    expect(await payableBalance()).toBe("5000000");
    await pay(run.id);
    expect(await payableBalance()).toBe("0");
    // Voiding it mirrors only the payment.
    await voidRun(run.id);
    expect(await count(`SELECT COUNT(*)::text AS n FROM journal_entries WHERE business_id = $1 AND source_type = 'payroll_payment_void'`)).toBe(1);
    expect(await count(`SELECT COUNT(*)::text AS n FROM journal_entries WHERE business_id = $1 AND source_type = 'payroll_accrual_void'`)).toBe(0);
    expect(await payableBalance()).toBe("5000000");
  });

  it("still refuses a run with neither wages nor commission", async () => {
    await db.query(`UPDATE users SET monthly_wage = NULL WHERE business_id = $1`, [biz.id]);
    expect(await message(accrue())).toBe("no_wages_set");
  });

  it("leaves commission alone when asked for a wage-only run", async () => {
    await earn(staff.a, 50_000_000);
    const preview = await payrollService.previewCommission(biz.id, { includeCommission: false });
    expect(preview).toMatchObject({ total: "0", lines: [] });
    const run = await accrue({ includeCommission: false });
    expect(run).toMatchObject({ totalAmount: "50000000", commissionTotal: "0" });
    expect(await claimed(run.id)).toBe(0);
    await pay(run.id);
    // Wages are settled; the commission is still owed — and the tie-out says so.
    expect(await payrollService.getPayrollLiability(biz.id)).toMatchObject({
      ledgerBalance: "5000000",
      unsettledCommission: "5000000",
      difference: "0",
    });
  });

  it("settles commission owed to a member who has since left", async () => {
    await earn(staff.b, 30_000_000); // 3,000,000
    await db.query(`UPDATE users SET is_active = false, monthly_wage = NULL WHERE id = $1`, [staff.b]);
    const run = await accrue();
    const line = run.lines.find((l) => l.userId === staff.b)!;
    expect(line).toMatchObject({ fullName: "Staff B", amount: "0", commissionAmount: "3000000", payableAmount: "3000000" });
    await pay(run.id);
    expect(await payableBalance()).toBe("0");
  });

  it("does not swallow commission dated after a back-dated run's accrual date", async () => {
    await earn(staff.a, 50_000_000); // posted today
    const run = await accrue({ accrualDate: "2020-01-01" });
    expect(run.commissionTotal).toBe("0");
    expect(await claimed(run.id)).toBe(0);
    expect((await payrollService.getPayrollLiability(biz.id)).unsettledCommission).toBe("5000000");
  });

  it("records the settled commission on the line as an immutable snapshot", async () => {
    await earn(staff.a, 50_000_000);
    const run = await accrue();
    await expect(db.query(`UPDATE payroll_run_lines SET commission_amount = 0 WHERE run_id = $1`, [run.id])).rejects.toThrow(/immutable/);
    await db.query(`UPDATE commission_accruals SET amount = amount WHERE payroll_run_id = $1`, [run.id]); // the accrual row itself is untouched by the guard
  });

  it("is named in the memo and journal so a payment of commission is recognisable", async () => {
    await earn(staff.a, 50_000_000);
    const run = await accrue();
    await pay(run.id);
    const { rows } = await db.query<{ memo: string }>(
      `SELECT memo FROM journal_entries WHERE source_id = $1 AND source_type = 'payroll_payment'`,
      [run.id],
    );
    expect(rows[0].memo).toContain("پورسانت");
  });

  it("explains a manual posting on 2300 as the tie-out's difference instead of hiding it", async () => {
    await earn(staff.a, 50_000_000);
    const run = await accrue();
    await pay(run.id);
    const entry = await db.query<{ id: string }>(
      `INSERT INTO journal_entries (business_id, entry_date, memo, source_type) VALUES ($1, CURRENT_DATE, 'manual', 'manual') RETURNING id`,
      [biz.id],
    );
    await db.query(`INSERT INTO journal_lines (entry_id, account_id, debit, credit) VALUES ($1, $2, 0, 900), ($1, $3, 900, 0)`, [
      entry.rows[0].id,
      acct.salariesPayable,
      acct.cash,
    ]);
    expect(await payrollService.getPayrollLiability(biz.id)).toMatchObject({ ledgerBalance: "900", difference: "900" });
  });
});

// ---------------------------------------------------------------------------
// Gross to net, salary advances (audit F11) — under the #835 rules
// ---------------------------------------------------------------------------

describe("gross-to-net payroll and advances (audit F11, under issue #835)", () => {
  /** Rates a business might enter — fixtures, not statutory figures the code assumes. */
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
  // A business with the template's full chart (1260, 2460, 2470, 2490, 5220 …) and three members.
  const full = { id: "", a: "", b: "", owner: "" };

  async function linesByCode(sourceType: string): Promise<Record<string, { debit: bigint; credit: bigint }>> {
    const { rows } = await db.query<{ code: string; debit: string; credit: string }>(
      `SELECT a.code, SUM(jl.debit)::text AS debit, SUM(jl.credit)::text AS credit
         FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.entry_id
         JOIN accounts a ON a.id = jl.account_id
        WHERE je.business_id = $1 AND je.source_type = $2
        GROUP BY a.code ORDER BY a.code`,
      [full.id, sourceType],
    );
    return Object.fromEntries(rows.map((r) => [r.code, { debit: BigInt(r.debit), credit: BigInt(r.credit) }]));
  }

  async function outstanding(userId: string): Promise<string> {
    return (await payrollService.listStaffWages(full.id)).find((s) => s.id === userId)!.advanceOutstanding;
  }

  const accrueFull = (overrides: Record<string, unknown> = {}) =>
    payrollService.accruePayroll({ businessId: full.id, createdBy: full.owner, periodKey: MORDAD, ...overrides } as Parameters<
      typeof payrollService.accruePayroll
    >[0]);
  const payFull = (runId: string, overrides: Record<string, unknown> = {}) =>
    payrollService.payPayroll({ businessId: full.id, runId, method: "cash", actorId: full.owner, ...overrides } as Parameters<
      typeof payrollService.payPayroll
    >[0]);
  const advance = (overrides: Record<string, unknown>) =>
    advancesService.recordAdvance({ businessId: full.id, createdBy: full.owner, method: "cash", ...overrides } as Parameters<
      typeof advancesService.recordAdvance
    >[0]);

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
    const run = await accrueFull();
    expect(run).toMatchObject({ totalAmount: "320000000", netAmount: "320000000", payableAmount: "320000000" });
    for (const line of run.lines) {
      expect(line.netPayRial).toBe(line.grossRial);
      expect(BigInt(line.employeeInsuranceRial) + BigInt(line.employerInsuranceRial) + BigInt(line.incomeTaxRial)).toBe(0n);
    }
    expect(await linesByCode("payroll_accrual")).toEqual({
      "2300": { debit: 0n, credit: 320_000_000n },
      "5200": { debit: 320_000_000n, credit: 0n },
    });
    // The settings the run was computed with are kept on it, even when empty.
    const { rows } = await db.query<{ settings_snapshot: unknown }>(`SELECT settings_snapshot FROM payroll_runs WHERE id = $1`, [run.id]);
    expect(rows[0].settings_snapshot).toMatchObject({ taxBrackets: [], employeeInsurancePercent: null });
  });

  it("saves the settings, computes every line and posts a balanced accrual to the Rial", async () => {
    await payrollService.savePayrollSettings(full.id, SETTINGS);
    expect(await payrollService.getPayrollSettings(full.id)).toEqual(SETTINGS);
    await payrollService.setStaffPayTerms({
      businessId: full.id,
      userId: full.a,
      patch: { taxableAllowance: 30_000_000, nonTaxableAllowance: 15_000_000, fixedDeduction: 2_000_000 },
      actorId: full.owner,
    });
    const paid = await advance({ userId: full.a, amount: 5_000_000, advanceDate: "2025-08-01" });
    expect(paid.status).toBe("active");
    expect(await linesByCode("payroll_advance")).toEqual({
      "1100": { debit: 0n, credit: 5_000_000n },
      "1260": { debit: 5_000_000n, credit: 0n },
    });
    expect(await outstanding(full.a)).toBe("5000000");

    const run = await accrueFull({ overtime: { [full.a]: 10_000_000 } });

    expect(run.lines.find((l) => l.userId === full.a)).toMatchObject({
      grossRial: "255000000",
      insuranceBaseRial: "240000000",
      employeeInsuranceRial: "16800000",
      employerInsuranceRial: "48000000",
      unemploymentInsuranceRial: "7200000",
      taxableIncomeRial: "223200000",
      incomeTaxRial: "16480000",
      otherDeductionsRial: "2000000",
      advanceRecoveryRial: "5000000",
      netPayRial: "214720000",
    });
    expect(run.lines.find((l) => l.userId === full.b)).toMatchObject({
      grossRial: "120000000",
      employeeInsuranceRial: "8400000",
      employerInsuranceRial: "24000000",
      unemploymentInsuranceRial: "3600000",
      incomeTaxRial: "1160000",
      netPayRial: "110440000",
    });
    expect(run).toMatchObject({ totalAmount: "375000000", netAmount: "325160000", payableAmount: "325160000" });

    const accrual = await linesByCode("payroll_accrual");
    expect(accrual).toEqual({
      "1260": { debit: 0n, credit: 5_000_000n },
      "2300": { debit: 0n, credit: 325_160_000n },
      "2460": { debit: 0n, credit: 108_000_000n },
      "2470": { debit: 0n, credit: 17_640_000n },
      "2490": { debit: 0n, credit: 2_000_000n },
      "5200": { debit: 375_000_000n, credit: 0n },
      "5220": { debit: 82_800_000n, credit: 0n },
    });
    const debits = Object.values(accrual).reduce((sum, l) => sum + l.debit, 0n);
    const credits = Object.values(accrual).reduce((sum, l) => sum + l.credit, 0n);
    expect(debits).toBe(credits);

    // The advance is recovered: nothing is owed any more, and it cannot be voided.
    expect(await outstanding(full.a)).toBe("0");
    expect(
      await message(advancesService.voidAdvance({ businessId: full.id, advanceId: paid.id, actorId: full.owner })),
    ).toBe("advance_already_recovered");

    // Paying the run moves the net only; the withholdings stay in their payables.
    await payFull(run.id);
    expect(await linesByCode("payroll_payment")).toEqual({
      "1100": { debit: 0n, credit: 325_160_000n },
      "2300": { debit: 325_160_000n, credit: 0n },
    });

    // Voiding the run gives the recovery back.
    await voidRunFull(run.id);
    expect(await outstanding(full.a)).toBe("5000000");
  });

  const voidRunFull = (runId: string) =>
    payrollService.voidPayrollRun({ businessId: full.id, runId, actorId: full.owner });

  it("keeps a past run's lines when the rates change afterwards (the run is its own audit)", async () => {
    await payrollService.savePayrollSettings(full.id, SETTINGS);
    const run = await accrueFull();
    const before = (await payrollService.getPayrollRun(full.id, run.id))!.lines.map((l) => l.employeeInsuranceRial);
    await payrollService.savePayrollSettings(full.id, { ...SETTINGS, employeeInsurancePercent: 9 });
    expect((await payrollService.getPayrollRun(full.id, run.id))!.lines.map((l) => l.employeeInsuranceRial)).toEqual(before);
    const { rows } = await db.query<{ settings_snapshot: { employeeInsurancePercent: number } }>(
      `SELECT settings_snapshot FROM payroll_runs WHERE id = $1`,
      [run.id],
    );
    expect(rows[0].settings_snapshot.employeeInsurancePercent).toBe(7);
  });

  it("caps the insurance base at the ceiling the business entered", async () => {
    await payrollService.savePayrollSettings(full.id, { ...SETTINGS, insuranceCeilingRial: 150_000_000 });
    const run = await accrueFull();
    const a = run.lines.find((l) => l.userId === full.a)!;
    expect(a.insuranceBaseRial).toBe("150000000");
    expect(a.employeeInsuranceRial).toBe("10500000");
  });

  it("recovers an advance larger than the month's pay in part and carries the rest", async () => {
    await advance({ userId: full.b, amount: 150_000_000 });
    const run = await accrueFull();
    const b = run.lines.find((l) => l.userId === full.b)!;
    expect(b.advanceRecoveryRial).toBe("120000000");
    expect(b.netPayRial).toBe("0");
    expect(await outstanding(full.b)).toBe("30000000");
  });

  it("refuses a month whose fixed deductions exceed gross, naming the member and leaving nothing behind", async () => {
    await payrollService.setStaffPayTerms({ businessId: full.id, userId: full.b, patch: { fixedDeduction: 120_000_001 }, actorId: null });
    await expect(accrueFull()).rejects.toMatchObject({ message: "deductions_exceed_gross", details: { field: full.b } });
    expect(await count("SELECT COUNT(*)::text AS n FROM payroll_runs WHERE business_id = $1", [full.id])).toBe(0);
    expect(await count("SELECT COUNT(*)::text AS n FROM journal_entries WHERE business_id = $1", [full.id])).toBe(0);
  });

  it("pays a run whose whole pay was recovered against advances without posting a zero payment", async () => {
    await advance({ userId: full.a, amount: 200_000_000 });
    await advance({ userId: full.b, amount: 120_000_000 });
    const run = await accrueFull();
    expect(run).toMatchObject({ totalAmount: "320000000", netAmount: "0", payableAmount: "0" });
    const paid = await payFull(run.id);
    expect(paid.status).toBe("paid");
    expect(await linesByCode("payroll_payment")).toEqual({});
    // The accrual credited 1260 for the recovery and 2300 for nothing; the books tie out.
    expect((await payrollService.getPayrollLiability(full.id)).difference).toBe("0");
    expect(await message(payFull(run.id))).toBe("already_paid");
  });

  it("voids an advance that has not been recovered, mirroring its entry", async () => {
    const recorded = await advance({ userId: full.a, amount: 4_000_000 });
    const voided = await advancesService.voidAdvance({ businessId: full.id, advanceId: recorded.id, actorId: full.owner });
    expect(voided.status).toBe("voided");
    const { rows } = await db.query<{ net: string }>(
      `SELECT (SUM(jl.debit) - SUM(jl.credit))::text AS net
         FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
        WHERE je.business_id = $1 GROUP BY jl.account_id`,
      [full.id],
    );
    for (const r of rows) expect(r.net).toBe("0");
    expect(await outstanding(full.a)).toBe("0");
    expect(await message(advancesService.voidAdvance({ businessId: full.id, advanceId: recorded.id, actorId: full.owner }))).toBe(
      "already_voided",
    );
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

  it("refuses overtime for someone who is not on the run, or that is not an amount", async () => {
    await expect(accrueFull({ overtime: { [full.owner]: 1_000 } })).rejects.toMatchObject({
      message: "invalid_overtime",
      details: { field: full.owner },
    });
    for (const overtime of [{ [full.a]: -1 }, { [full.a]: 1.5 }, { [full.a]: "abc" }, { [full.a]: true }, { "not-a-uuid": 5 }]) {
      expect(await message(accrueFull({ overtime })), JSON.stringify(overtime)).toBe("invalid_overtime");
    }
    expect(await count("SELECT COUNT(*)::text AS n FROM payroll_runs WHERE business_id = $1", [full.id])).toBe(0);
    // Zero and absent are the same thing.
    expect((await accrueFull({ overtime: { [full.a]: 0, [full.b]: null } })).totalAmount).toBe("320000000");
  });

  // --- the payout account of an advance is the same canonical choice a run's payment offers -------------

  it("credits the business's own bank account (1110) for a bank advance — not card money in transit", async () => {
    await advance({ userId: full.a, amount: 1_000_000, method: "bank" });
    expect(await linesByCode("payroll_advance")).toEqual({
      "1110": { debit: 0n, credit: 1_000_000n },
      "1260": { debit: 1_000_000n, credit: 0n },
    });
  });

  it("credits a chosen account that a payment may leave, and refuses one it may not", async () => {
    const accounts = await payrollAccounts.listPaymentAccounts(full.id);
    const bank = accounts.find((a) => a.code === "1110")!;
    const recorded = await advance({ userId: full.a, amount: 2_000_000, method: "cash", paymentAccountId: bank.id });
    // An explicit account wins over the method, and the record says which kind it left.
    expect(recorded.method).toBe("bank");
    expect((await linesByCode("payroll_advance"))["1110"]).toEqual({ debit: 0n, credit: 2_000_000n });

    const { rows } = await db.query<{ id: string; code: string }>(
      `SELECT id, code FROM accounts WHERE business_id = $1 AND code IN ('1120', '5200', '2300')`,
      [full.id],
    );
    for (const account of rows) {
      expect(await message(advance({ userId: full.a, amount: 1, paymentAccountId: account.id })), account.code).toBe(
        "invalid_payment_account",
      );
    }
    expect(await message(advance({ userId: full.a, amount: 1, paymentAccountId: "nope" }))).toBe("invalid_payment_account");
    expect(await message(advance({ userId: full.a, amount: 1, paymentAccountId: randomUUID() }))).toBe("invalid_payment_account");
  });

  it("is business-wide: an advance carries no branch, and a legacy one is mirrored under its own", async () => {
    const recorded = await advance({ userId: full.a, amount: 3_000_000 });
    const { rows: entry } = await db.query<{ location_id: string | null }>(
      `SELECT location_id FROM journal_entries WHERE source_type = 'payroll_advance' AND source_id = $1`,
      [recorded.id],
    );
    expect(entry[0].location_id).toBeNull();
    const { rows: row } = await db.query<{ location_id: string | null }>(`SELECT location_id FROM payroll_advances WHERE id = $1`, [recorded.id]);
    expect(row[0].location_id).toBeNull();

    // An advance recorded before #835 was stamped with the caller's branch; voiding it must not move it.
    const branch = (await db.query<{ id: string }>(`INSERT INTO locations (business_id, name) VALUES ($1, 'Old branch') RETURNING id`, [full.id])).rows[0].id;
    const legacy = await db.query<{ id: string }>(
      `INSERT INTO payroll_advances (business_id, location_id, user_id, amount, method, created_by)
       VALUES ($1, $2, $3, 1000000, 'cash', $4) RETURNING id`,
      [full.id, branch, full.b, full.owner],
    );
    const legacyEntry = await db.query<{ id: string }>(
      `INSERT INTO journal_entries (business_id, location_id, entry_date, memo, source_type, source_id)
       VALUES ($1, $2, CURRENT_DATE, 'legacy', 'payroll_advance', $3) RETURNING id`,
      [full.id, branch, legacy.rows[0].id],
    );
    const codes = await db.query<{ id: string; code: string }>(`SELECT id, code FROM accounts WHERE business_id = $1 AND code IN ('1260', '1100')`, [full.id]);
    const byCode = Object.fromEntries(codes.rows.map((r) => [r.code, r.id]));
    await db.query(`INSERT INTO journal_lines (entry_id, account_id, debit, credit) VALUES ($1, $2, 1000000, 0), ($1, $3, 0, 1000000)`, [
      legacyEntry.rows[0].id,
      byCode["1260"],
      byCode["1100"],
    ]);
    await advancesService.voidAdvance({ businessId: full.id, advanceId: legacy.rows[0].id, actorId: full.owner });
    const { rows: mirror } = await db.query<{ location_id: string | null }>(
      `SELECT location_id FROM journal_entries WHERE source_type = 'payroll_advance_void' AND source_id = $1`,
      [legacy.rows[0].id],
    );
    expect(mirror).toEqual([{ location_id: branch }]);
  });

  it("refuses an advance that is not a positive amount, for someone who is not an active member, or with a bad date or note", async () => {
    for (const amount of [0, -5, 1.5, "abc", null, true, undefined]) {
      expect(await message(advance({ userId: full.a, amount })), String(amount)).toBe("invalid_amount");
    }
    expect(await message(advance({ userId: full.a, amount: "9223372036854775808" }))).toBe("amount_out_of_range");
    expect(await message(advance({ userId: full.a, amount: 5, method: "crypto" }))).toBe("invalid_method");
    expect(await message(advance({ userId: full.a, amount: 5, advanceDate: "banana" }))).toBe("invalid_advance_date");
    expect(await message(advance({ userId: full.a, amount: 5, note: "x".repeat(201) }))).toBe("note_too_long");
    expect(await message(advance({ userId: randomUUID(), amount: 5 }))).toBe("user_not_found");
    expect(await message(advance({ userId: "not-a-uuid", amount: 5 }))).toBe("user_not_found");
    await db.query(`UPDATE users SET is_active = false WHERE id = $1`, [full.b]);
    expect(await message(advance({ userId: full.b, amount: 5 }))).toBe("user_not_found");
    expect(await count("SELECT COUNT(*)::text AS n FROM payroll_advances WHERE business_id = $1", [full.id])).toBe(0);
    expect(await count("SELECT COUNT(*)::text AS n FROM journal_entries WHERE business_id = $1", [full.id])).toBe(0);
  });

  it("applies the fiscal-period lock to an advance's date, leaving no advance behind", async () => {
    await fiscalService.createFiscalYear(full.id, 1404);
    const [year] = await fiscalService.listFiscalYears(full.id);
    const [farvardin] = await fiscalService.listPeriods(full.id, year.id);
    await fiscalService.setPeriodStatus(full.id, farvardin.id, "soft_closed", full.owner);
    await fiscalService.setPeriodStatus(full.id, farvardin.id, "locked", full.owner);
    expect(await message(advance({ userId: full.a, amount: 5, advanceDate: farvardin.startsOn }))).toBe("fiscal_period_locked");
    expect(await count("SELECT COUNT(*)::text AS n FROM payroll_advances WHERE business_id = $1", [full.id])).toBe(0);
  });

  it("404s voiding an advance that does not exist or is not an id", async () => {
    expect(await message(advancesService.voidAdvance({ businessId: full.id, advanceId: randomUUID(), actorId: null }))).toBe("advance_not_found");
    expect(await message(advancesService.voidAdvance({ businessId: full.id, advanceId: "nope", actorId: null }))).toBe("advance_not_found");
  });

  it("lists the most recent advances, newest first, and never another business's", async () => {
    await advance({ userId: full.a, amount: 1_000, advanceDate: "2025-08-01" });
    await advance({ userId: full.a, amount: 2_000, advanceDate: "2025-08-05" });
    const listed = await advancesService.listAdvances(full.id);
    expect(listed.map((a) => a.amount)).toEqual(["2000", "1000"]);
    expect(listed[0]).toMatchObject({ fullName: "A", method: "cash", status: "active", createdByName: "Owner" });
    expect(await advancesService.listAdvances(biz.id)).toEqual([]);
  });

  // --- gross-to-net together with commission and the 2300 tie-out ---------------------------------------------

  it("pays net wages and commission together, and 2300 ties out with deductions in play", async () => {
    await payrollService.savePayrollSettings(full.id, SETTINGS);
    await commissionService.upsertCommissionRule(full.id, { employeeId: full.b, kind: "percent", basis: "net", value: 10 });
    const branch = (await db.query<{ id: string }>(`INSERT INTO locations (business_id, name) VALUES ($1, 'Counter') RETURNING id`, [full.id])).rows[0].id;
    const client = await dbLib.getPool().connect();
    try {
      await client.query("BEGIN");
      await commissionService.accrueCommissionForLine(client, {
        businessId: full.id,
        locationId: branch,
        employeeId: full.b,
        sourceType: "order_item",
        sourceId: randomUUID(),
        line: { net: 30_000_000, cost: 0, itemId: randomUUID() },
      });
      await client.query("COMMIT");
    } finally {
      client.release();
    }

    const today = (await db.query<{ d: string }>(`SELECT CURRENT_DATE::text AS d`)).rows[0].d;
    const run = await accrueFull({ accrualDate: today });
    // B: gross 120M, insurance 8.4M, tax 1.16M → net 110.44M; A: net below. Commission 3M settles untaxed.
    expect(run.lines.find((l) => l.userId === full.b)).toMatchObject({
      netPayRial: "110440000",
      commissionAmount: "3000000",
      payableAmount: "113440000",
    });
    expect(run.commissionTotal).toBe("3000000");
    expect(BigInt(run.payableAmount)).toBe(BigInt(run.netAmount) + 3_000_000n);

    // 2300 holds net wages + commission; the withholdings sit elsewhere.
    expect(await payrollService.getPayrollLiability(full.id)).toMatchObject({
      awaitingPayment: run.payableAmount,
      ledgerBalance: run.payableAmount,
      unsettledCommission: "0",
      difference: "0",
    });

    const paid = await payFull(run.id);
    expect(paid.status).toBe("paid");
    expect((await linesByCode("payroll_payment"))["2300"].debit).toBe(BigInt(run.payableAmount));
    expect(await payrollService.getPayrollLiability(full.id)).toMatchObject({ ledgerBalance: "0", difference: "0" });
  });

  it("pays a run from before gross-to-net (no net amount) exactly what it accrued", async () => {
    const legacy = await db.query<{ id: string }>(
      `INSERT INTO payroll_runs (business_id, period_label, total_amount, accrual_date) VALUES ($1, 'legacy', 40000000, '2025-05-20') RETURNING id`,
      [full.id],
    );
    await db.query(`INSERT INTO payroll_run_lines (run_id, user_id, amount) VALUES ($1, $2, 40000000)`, [legacy.rows[0].id, full.a]);
    const entry = await db.query<{ id: string }>(
      `INSERT INTO journal_entries (business_id, entry_date, memo, source_type, source_id)
       VALUES ($1, '2025-05-20', 'legacy', 'payroll_accrual', $2) RETURNING id`,
      [full.id, legacy.rows[0].id],
    );
    const codes = await db.query<{ id: string; code: string }>(`SELECT id, code FROM accounts WHERE business_id = $1 AND code IN ('5200', '2300')`, [full.id]);
    const byCode = Object.fromEntries(codes.rows.map((r) => [r.code, r.id]));
    await db.query(`INSERT INTO journal_lines (entry_id, account_id, debit, credit) VALUES ($1, $2, 40000000, 0), ($1, $3, 0, 40000000)`, [
      entry.rows[0].id,
      byCode["5200"],
      byCode["2300"],
    ]);
    expect((await payrollService.getPayrollLiability(full.id)).awaitingPayment).toBe("40000000");
    const paid = await payFull(legacy.rows[0].id, { paidDate: "2025-05-25" });
    expect(paid).toMatchObject({ status: "paid", netAmount: "40000000", payableAmount: "40000000" });
    expect((await linesByCode("payroll_payment"))["2300"].debit).toBe(40_000_000n);
  });

  it("hands the routes plain JSON from every call they serialise — a bigint leaking out would be a 500 that no mocked route test can see", async () => {
    // The routes return these values as they are, and JSON.stringify throws on a
    // bigint; every figure is meant to travel as text.
    const plain = (label: string, value: unknown): string => {
      let json = "";
      expect(() => {
        json = JSON.stringify(value);
      }, label).not.toThrow();
      return json;
    };

    plain("saved settings", await payrollService.savePayrollSettings(full.id, SETTINGS));
    plain("settings", await payrollService.getPayrollSettings(full.id));
    plain(
      "pay-term patch",
      await payrollService.setStaffPayTerms({ businessId: full.id, userId: full.a, patch: { taxableAllowance: 1_000_000 }, actorId: full.owner, reason: "x" }),
    );
    plain("pay-term history", await payrollService.listPayTermChanges(full.id, full.a));
    const recorded = await advance({ userId: full.a, amount: 5_000_000 });
    plain("advance", recorded);
    plain("advances", await advancesService.listAdvances(full.id));
    plain("staff", await payrollService.listStaffWages(full.id));
    plain("commission preview", await payrollService.previewCommission(full.id, { periodKey: MORDAD }));
    plain("liability", await payrollService.getPayrollLiability(full.id));
    plain("payment accounts", await payrollAccounts.listPaymentAccounts(full.id));

    const run = await accrueFull({ overtime: { [full.a]: "1000000" } });
    const accruedJson = plain("accrued run", run);
    // Text, not numbers: a figure that is a JSON number could have been rounded on the way.
    expect(accruedJson).toContain(`"netAmount":"${run.netAmount}"`);
    expect(accruedJson).toMatch(/"netPayRial":"\d+"/);
    plain("run with lines", await payrollService.getPayrollRun(full.id, run.id));
    plain("history", await payrollService.listPayrollRuns(full.id, { includeLines: true }));
    plain("paid run", await payFull(run.id));
    plain("voided run", await payrollService.voidPayrollRun({ businessId: full.id, runId: run.id, actorId: full.owner }));
    plain("voided advance", await advancesService.voidAdvance({ businessId: full.id, advanceId: recorded.id, actorId: full.owner }));
  });
});

// ---------------------------------------------------------------------------
// Schema guards
// ---------------------------------------------------------------------------

describe("run and line constraints", () => {
  it("refuses a run that pays nothing, and a negative component", async () => {
    for (const [wage, commission] of [
      [0, 0],
      [-1, 5],
      [5, -1],
    ]) {
      await expect(
        db.query(
          `INSERT INTO payroll_runs (business_id, period_label, total_amount, commission_total) VALUES ($1, 'x', $2, $3)`,
          [biz.id, wage, commission],
        ),
      ).rejects.toThrow(/payroll_runs_amounts_check/);
    }
    // A commission-only run is allowed.
    await db.query(`INSERT INTO payroll_runs (business_id, period_label, total_amount, commission_total) VALUES ($1, 'x', 0, 5)`, [biz.id]);
  });

  it("keeps legacy runs (no period key) out of the unique index, so they can coexist", async () => {
    for (let i = 0; i < 2; i++) {
      await db.query(`INSERT INTO payroll_runs (business_id, period_label, total_amount) VALUES ($1, 'duplicate', 1)`, [biz.id]);
    }
    expect(await count("SELECT COUNT(*)::text AS n FROM payroll_runs WHERE business_id = $1")).toBe(2);
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
  async function seedBusiness(industry: Industry): Promise<string> {
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
    return businessId;
  }

  it.each(["jewelry", "watch", "accessories", "cosmetics"] as const)(
    "accrues against the %s template's own chart",
    async (industry) => {
      const businessId = await seedBusiness(industry);
      const run = await payrollService.accruePayroll({ businessId, createdBy: null, periodKey: MORDAD });
      expect(run.totalAmount).toBe("25000000");

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
      expect(rows.find((r) => r.code === "5200")!.debit).toBe("25000000");
      expect(rows.find((r) => r.code === "2300")!.credit).toBe("25000000");
    },
  );

  it.each(["jewelry", "watch", "accessories", "cosmetics"] as const)(
    "pays the %s template's chart from cash, and from its own bank account (1110) by bank",
    async (industry) => {
      const businessId = await seedBusiness(industry);
      const run = await payrollService.accruePayroll({ businessId, createdBy: null, periodKey: MORDAD });
      const byBank = await payrollService.payPayroll({ businessId, runId: run.id, method: "bank", actorId: null });
      expect(byBank.status).toBe("paid");
      const { rows } = await db.query<{ code: string }>(
        `SELECT a.code FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id JOIN accounts a ON a.id = jl.account_id
          WHERE je.business_id = $1 AND je.source_type = 'payroll_payment' AND jl.credit > 0`,
        [businessId],
      );
      expect(rows.map((r) => r.code)).toEqual(["1110"]);

      const accounts = await payrollAccounts.listPaymentAccounts(businessId);
      expect(accounts.map((a) => a.code)).toEqual(expect.arrayContaining(["1100", "1110"]));
      expect(accounts.map((a) => a.code)).not.toContain("1120");
    },
  );
});
