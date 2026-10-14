/**
 * Phase 16 exit criterion: "A full fiscal year can be closed: periods locked,
 * closing entries posted, statements produced, and the balance sheet
 * balances." This proves closeFiscalYear (closing-service.ts) end to end:
 * revenue/expense accounts roll into Retained Earnings, every period ends up
 * locked, and the year itself is marked closed — all in one transaction, and
 * only once every period is already reviewed (soft_closed).
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { runMigrations } from "../scripts/migrate";
import type { Role, SessionPayload } from "../src/lib/auth-edge";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let fiscalService: typeof import("../src/lib/fiscal-periods-service");
let closingService: typeof import("../src/lib/closing-service");
let authorization: typeof import("../src/lib/authorize");

const biz = { id: "" };
const acct = { cash: "", revenue: "", expense: "", retainedEarnings: "" };
const users: { owner: string; accountant: string; cashier: string } = { owner: "", accountant: "", cashier: "" };
const rolesByUser = new Map<string, Role>();

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
  databaseName = `pos_closing_${randomUUID().replaceAll("-", "")}`;

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
  fiscalService = await import("../src/lib/fiscal-periods-service");
  closingService = await import("../src/lib/closing-service");
  authorization = await import("../src/lib/authorize");

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
    await maintenance.query(
      `DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`,
    );
  } finally {
    await maintenance.end();
  }
});

beforeEach(async () => {
  // A confirmed fixture reset may clear even locked-period postings; normal
  // journal mutations remain guarded by migration 0216.
  await db.query("BEGIN");
  await db.query("SELECT set_config('app.factory_reset', 'true', true)");
  await db.query("DELETE FROM journal_lines");
  await db.query("DELETE FROM journal_entries");
  await db.query("DELETE FROM businesses");
  await db.query("COMMIT");
  rolesByUser.clear();

  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ('Closing Co', $1) RETURNING id",
    [`closing-${randomUUID().slice(0, 8)}`],
  );
  biz.id = bizRow.rows[0].id;

  for (const role of ["owner", "accountant", "cashier"] as const) {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO users (business_id, role, full_name, pin_hash) VALUES ($1, $2, 'Member', 'x') RETURNING id`,
      [biz.id, role],
    );
    users[role] = rows[0].id;
    rolesByUser.set(rows[0].id, role);
  }

  const accounts = await db.query<{ id: string; code: string }>(
    `INSERT INTO accounts (business_id, code, name, type)
     VALUES ($1, '1100', 'Cash', 'asset'), ($1, '4300', 'Sales', 'revenue'),
            ($1, '5900', 'Other expense', 'expense'), ($1, '3800', 'Retained earnings', 'equity')
     RETURNING id, code`,
    [biz.id],
  );
  for (const r of accounts.rows) {
    if (r.code === "1100") acct.cash = r.id;
    if (r.code === "4300") acct.revenue = r.id;
    if (r.code === "5900") acct.expense = r.id;
    if (r.code === "3800") acct.retainedEarnings = r.id;
  }
});

/** Posts a balanced two-line entry directly, mirroring what postJournalEntry does. */
async function postEntry(
  entryDate: string,
  debitAcct: string,
  creditAcct: string,
  amount: number | string,
  createdBy: string,
) {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO journal_entries (business_id, entry_date, memo, source_type, created_by)
     VALUES ($1, $2, 'test', 'manual', $3) RETURNING id`,
    [biz.id, entryDate, createdBy],
  );
  const entryId = rows[0].id;
  await db.query(
    `INSERT INTO journal_lines (entry_id, account_id, debit, credit) VALUES ($1, $2, $3, 0), ($1, $4, 0, $3)`,
    [entryId, debitAcct, amount, creditAcct],
  );
  return entryId;
}

async function accountBalance(accountId: string): Promise<number> {
  const { rows } = await db.query<{ debit: string; credit: string }>(
    `SELECT COALESCE(SUM(debit), 0) AS debit, COALESCE(SUM(credit), 0) AS credit
       FROM journal_lines WHERE account_id = $1`,
    [accountId],
  );
  return Number(rows[0].debit) - Number(rows[0].credit);
}

async function exactAccountBalance(accountId: string): Promise<string> {
  const { rows } = await db.query<{ balance: string }>(
    `SELECT (COALESCE(SUM(debit), 0) - COALESCE(SUM(credit), 0))::text AS balance
       FROM journal_lines WHERE account_id = $1`,
    [accountId],
  );
  return rows[0].balance;
}

function sessionFor(userId: string): SessionPayload {
  return {
    sub: userId,
    role: rolesByUser.get(userId) ?? "cashier",
    businessId: biz.id,
    locationId: null,
    fullName: "Member",
  };
}

async function withMember<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  return dbLib.withTenant(
    biz.id,
    () => authorization.withAuthorizationMemo(async () => {
      await authorization.authorize(sessionFor(userId), {});
      return fn();
    }),
    { userId },
  );
}

async function createYear(year: number, actorId = users.owner) {
  return withMember(actorId, () => fiscalService.createFiscalYear(biz.id, year, actorId));
}

async function listYears() {
  return dbLib.withTenant(biz.id, () => fiscalService.listFiscalYears(biz.id));
}

async function listPeriods(fiscalYearId: string) {
  return dbLib.withTenant(biz.id, () => fiscalService.listPeriods(biz.id, fiscalYearId));
}

async function setPeriodStatus(periodId: string, status: "open" | "soft_closed" | "locked", actorId = users.owner) {
  return withMember(actorId, () => fiscalService.setPeriodStatus(biz.id, periodId, status, actorId));
}

async function closeYear(fiscalYearId: string, actorId = users.owner) {
  return withMember(actorId, () => closingService.closeFiscalYear(biz.id, fiscalYearId, actorId));
}

async function softCloseAllPeriods(fiscalYearId: string) {
  const periods = await listPeriods(fiscalYearId);
  for (const p of periods) {
    await setPeriodStatus(p.id, "soft_closed", users.owner);
  }
  return periods;
}

describe("closeFiscalYear", () => {
  it("rolls net income into retained earnings and locks every period", async () => {
    await createYear(1404);
    const [year] = await listYears();

    await postEntry(
      "2025-04-05",
      acct.cash,
      acct.revenue,
      1_000_000,
      users.owner,
    );
    await postEntry(
      "2025-05-05",
      acct.expense,
      acct.cash,
      400_000,
      users.owner,
    );

    await softCloseAllPeriods(year.id);

    const result = await closeYear(year.id, users.owner);
    expect(result.closingEntryId).not.toBeNull();
    expect(result.netIncome).toBe("600000");

    expect(await accountBalance(acct.revenue)).toBe(0);
    expect(await accountBalance(acct.expense)).toBe(0);
    // accountBalance is debit-credit; retained earnings is equity, whose
    // normal balance is credit-debit, so a positive net income shows up here
    // as the negative of it (a credit balance).
    expect(await accountBalance(acct.retainedEarnings)).toBe(-600_000);

    const periods = await listPeriods(year.id);
    expect(periods.every((p) => p.status === "locked")).toBe(true);

    const [closedYear] = await listYears();
    expect(closedYear.closedAt).not.toBeNull();

    const { rows: audit } = await db.query<{ action: string; entity_id: string; user_id: string; payload: Record<string, unknown> }>(
      `SELECT action, entity_id, user_id, payload
         FROM audit_log
        WHERE business_id = $1 AND action IN ('fiscal_period.locked', 'fiscal_year.closed')`,
      [biz.id],
    );
    const periodAudit = audit.filter((row) => row.action === "fiscal_period.locked");
    const yearAudit = audit.find((row) => row.action === "fiscal_year.closed");
    expect(periodAudit).toHaveLength(12);
    for (const row of periodAudit) {
      expect(row.user_id).toBe(users.owner);
      expect(row.payload).toMatchObject({
        actorId: users.owner,
        closingEntryId: result.closingEntryId,
        netIncome: "600000",
        previousStatus: "soft_closed",
        newStatus: "locked",
      });
      expect(row.payload.startsOn).toBeTruthy();
      expect(row.payload.endsOn).toBeTruthy();
    }
    expect(yearAudit?.entity_id).toBe(year.id);
    expect(yearAudit?.user_id).toBe(users.owner);
    expect(yearAudit?.payload).toMatchObject({
      closingEntryId: result.closingEntryId,
      netIncome: "600000",
      actorId: users.owner,
      startsOn: "2025-03-21",
      endsOn: "2026-03-20",
    });
    await expect(
      db.query("UPDATE audit_log SET payload = '{}'::jsonb WHERE action = 'fiscal_year.closed' AND entity_id = $1", [year.id]),
    ).rejects.toThrow("fiscal_audit_append_only");
    await expect(
      db.query("DELETE FROM audit_log WHERE action = 'fiscal_year.closed' AND entity_id = $1", [year.id]),
    ).rejects.toThrow("fiscal_audit_append_only");
  });

  it("posts and returns a close above Number.MAX_SAFE_INTEGER exactly", async () => {
    await createYear(1404);
    const [year] = await listYears();
    const exactRevenue = "9007199254740993";
    await postEntry("2025-04-05", acct.cash, acct.revenue, exactRevenue, users.owner);
    await softCloseAllPeriods(year.id);

    const result = await closeYear(year.id, users.owner);
    expect(result.netIncome).toBe(exactRevenue);
    expect(await exactAccountBalance(acct.revenue)).toBe("0");
    expect(await exactAccountBalance(acct.retainedEarnings)).toBe(`-${exactRevenue}`);

    const { rows: lines } = await db.query<{
      account_id: string;
      debit: string;
      credit: string;
    }>(
      `SELECT account_id, debit::text AS debit, credit::text AS credit
         FROM journal_lines WHERE entry_id = $1`,
      [result.closingEntryId],
    );
    expect(Object.fromEntries(lines.map((line) => [line.account_id, { debit: line.debit, credit: line.credit }]))).toEqual({
      [acct.revenue]: { debit: exactRevenue, credit: "0" },
      [acct.retainedEarnings]: { debit: "0", credit: exactRevenue },
    });
  });

  it("debits retained earnings for a net loss", async () => {
    await createYear(1404);
    const [year] = await listYears();

    await postEntry(
      "2025-04-05",
      acct.cash,
      acct.revenue,
      200_000,
      users.owner,
    );
    await postEntry(
      "2025-05-05",
      acct.expense,
      acct.cash,
      900_000,
      users.owner,
    );

    await softCloseAllPeriods(year.id);
    const result = await closeYear(year.id, users.owner);

    expect(result.netIncome).toBe("-700000");
    // A loss debits retained earnings, so its debit-credit balance is positive.
    expect(await accountBalance(acct.retainedEarnings)).toBe(700_000);
  });

  it("posts no entry, but still locks every period, when there was no activity", async () => {
    await createYear(1404);
    const [year] = await listYears();

    await softCloseAllPeriods(year.id);
    const result = await closeYear(year.id, users.owner);

    expect(result.closingEntryId).toBeNull();
    expect(result.netIncome).toBe("0");
    const periods = await listPeriods(year.id);
    expect(periods.every((p) => p.status === "locked")).toBe(true);
  });

  it("refuses a partial fiscal year instead of producing a closing entry over incomplete books", async () => {
    await createYear(1404);
    const [year] = await listYears();
    await db.query(
      `DELETE FROM fiscal_periods
        WHERE id = (
          SELECT id FROM fiscal_periods
           WHERE business_id = $1 AND fiscal_year_id = $2
           ORDER BY starts_on DESC LIMIT 1
        )`,
      [biz.id, year.id],
    );
    await softCloseAllPeriods(year.id);

    await expect(
      closeYear(year.id, users.owner),
    ).rejects.toThrow("periods_incomplete");
  });

  it("rejects closing while any period is still open", async () => {
    await createYear(1404);
    const [year] = await listYears();
    const periods = await listPeriods(year.id);
    // Soft-close only the first period; the other eleven stay open.
    await setPeriodStatus(periods[0].id, "soft_closed", users.owner);

    await expect(
      closeYear(year.id, users.owner),
    ).rejects.toThrow("periods_not_ready");
  });

  it("serializes final close against an in-flight reopen without deadlocking", async () => {
    await createYear(1404);
    const [year] = await listYears();
    const periods = await softCloseAllPeriods(year.id);

    const results = await Promise.allSettled([
      closeYear(year.id, users.owner),
      setPeriodStatus(periods[0].id, "open", users.owner),
    ]);
    const failureCodes = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason instanceof Error ? result.reason.message : String(result.reason));
    // Whichever transaction acquired the year lock first wins. The other sees
    // a normal business-state conflict, never PostgreSQL's deadlock error.
    expect(failureCodes.every((code) => ["periods_not_ready", "fiscal_year_closed"].includes(code))).toBe(true);

    const [currentYear] = await listYears();
    const currentPeriods = await listPeriods(year.id);
    if (currentYear.closedAt) {
      expect(currentPeriods.every((period) => period.status === "locked")).toBe(true);
    } else {
      expect(currentPeriods[0].status).toBe("open");
      expect(currentPeriods.slice(1).every((period) => period.status === "soft_closed")).toBe(true);
    }
  });

  it("rejects closing an already-closed year", async () => {
    await createYear(1404);
    const [year] = await listYears();
    await softCloseAllPeriods(year.id);
    await closeYear(year.id, users.owner);

    await expect(
      closeYear(year.id, users.owner),
    ).rejects.toThrow("fiscal_year_already_closed");
  });

  it("rejects closing a fiscal year that doesn't exist", async () => {
    await expect(
      closeYear(randomUUID(), users.owner),
    ).rejects.toThrow("fiscal_year_not_found");
  });

  describe("exact journal-entry failure handling", () => {
    it("throws period_locked_for_closing if postExactJournalEntry throws a fiscal period lock error", async () => {
      await createYear(1404);
      const [year] = await listYears();
      await softCloseAllPeriods(year.id);

      const ledgerService = await import("../src/lib/ledger-service");
      const spy = vi
        .spyOn(ledgerService, "postExactJournalEntry")
        .mockRejectedValue(new Error("fiscal_period_locked"));

      await expect(
        closeYear(year.id, users.owner),
      ).rejects.toThrow("period_locked_for_closing");
      spy.mockRestore();
    });

    it("rethrows if postExactJournalEntry throws an unrelated error", async () => {
      await createYear(1404);
      const [year] = await listYears();
      await softCloseAllPeriods(year.id);

      const ledgerService = await import("../src/lib/ledger-service");
      const spy = vi
        .spyOn(ledgerService, "postExactJournalEntry")
        .mockRejectedValue(new Error("some_other_error"));

      await expect(
        closeYear(year.id, users.owner),
      ).rejects.toThrow("some_other_error");
      spy.mockRestore();
    });
  });
});

describe("reopening a period after its fiscal year is closed", () => {
  it("is rejected, to avoid an open period under an already-closed year", async () => {
    await createYear(1404);
    const [year] = await listYears();
    await softCloseAllPeriods(year.id);
    await closeYear(year.id, users.owner);

    const [farvardin] = await listPeriods(year.id);
    await expect(
      setPeriodStatus(farvardin.id, "open", users.owner),
    ).rejects.toThrow("fiscal_year_closed");
  });

  it("keeps the finalized-year rule in the database for direct writers too", async () => {
    await createYear(1404);
    const [year] = await listYears();
    await softCloseAllPeriods(year.id);
    await closeYear(year.id, users.owner);

    const [farvardin] = await listPeriods(year.id);
    await expect(
      db.query("UPDATE fiscal_periods SET status = 'open' WHERE id = $1", [farvardin.id]),
    ).rejects.toThrow("fiscal_year_closed");
    await expect(
      db.query("DELETE FROM fiscal_periods WHERE id = $1", [farvardin.id]),
    ).rejects.toThrow("fiscal_year_closed");
  });
});
