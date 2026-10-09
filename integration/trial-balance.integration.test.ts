/**
 * The trial balance, as an accountant means it (issue #820).
 *
 * The screen used to print `SUM(debit)` / `SUM(credit)` over an account's whole
 * lifetime and label those two columns «ماندهٔ بدهکار/بستانکار». For a till that
 * took 1,000 and later paid 400 it announced a debit balance of 1,000 and a
 * credit balance of 400 — two gross movements wearing the clothes of one net
 * balance. The report is period-scoped now, and answers three separate
 * questions per account: what it carried in, what moved, what it carries out.
 *
 * Pinned here, against a real Postgres:
 *
 * 1. **Closing columns are net balances on the account's normal side.** A
 *    debit-normal account that took 1,000 and paid 400 closes at debit 600 /
 *    credit 0 — not 1,000 / 400.
 * 2. **An abnormal balance is visible, not sign-flipped.** An asset in credit
 *    shows in the closing *credit* column; it never appears as a negative debit.
 * 3. **Opening / movement / closing reconcile**, and the boundaries are exact:
 *    a posting on `dateFrom` is movement, on `dateTo` is movement, after `dateTo`
 *    is neither movement nor closing.
 * 4. **Money stays BigInt-exact** from the BIGINT column to the API string; a
 *    balance above `Number.MAX_SAFE_INTEGER` arrives character-for-character.
 * 5. **Report balance and ledger health are different facts.** Two corrupt
 *    entries that cancel each other leave equal columns *and* an unhealthy book.
 * 6. **Archived history survives.** An archived account still reports the
 *    postings it received; an archived account with none is noise and is left out.
 * 7. **The drill-down behind a figure sums exactly to that figure.**
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { filterTrialBalanceRows } from "../src/lib/trial-balance";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let accountsService: typeof import("../src/lib/accounts-service");
let reports: typeof import("../src/lib/ledger-reports-service");
let drillDown: typeof import("../src/lib/reports-service");
let fiscalPeriods: typeof import("../src/lib/fiscal-periods-service");

const biz = { id: "" };
const user = { id: "" };
const acct: Record<string, string> = {};

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
  databaseName = `pos_trial_balance_${randomUUID().replaceAll("-", "")}`;

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
  accountsService = await import("../src/lib/accounts-service");
  reports = await import("../src/lib/ledger-reports-service");
  drillDown = await import("../src/lib/reports-service");
  fiscalPeriods = await import("../src/lib/fiscal-periods-service");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
}, 180_000);

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

beforeEach(async () => {
  await db.query("DELETE FROM journal_lines");
  await db.query("DELETE FROM journal_entries");
  await db.query("DELETE FROM accounts");
  await db.query("DELETE FROM businesses");

  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ('Trial Balance Co', $1) RETURNING id",
    [`tb-${randomUUID().slice(0, 8)}`],
  );
  biz.id = bizRow.rows[0].id;

  const userRow = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, pin_hash) VALUES ($1, 'owner', 'Owner', 'x') RETURNING id`,
    [biz.id],
  );
  user.id = userRow.rows[0].id;

  // A debit-normal pair (cash, rent) and a credit-normal pair (payable, sales),
  // plus the two accounts an abnormal-balance case needs.
  const accounts = await db.query<{ id: string; code: string }>(
    `INSERT INTO accounts (business_id, code, name, type, level)
     VALUES ($1, '1100', 'صندوق', 'asset', 'moein'),
            ($1, '1200', 'حساب‌های دریافتنی', 'asset', 'moein'),
            ($1, '2100', 'حساب‌های پرداختنی', 'liability', 'moein'),
            ($1, '4100', 'درآمد فروش', 'revenue', 'moein'),
            ($1, '5300', 'اجاره', 'expense', 'moein')
     RETURNING id, code`,
    [biz.id],
  );
  for (const row of accounts.rows) acct[row.code] = row.id;
});

/** A balanced document, on any date, from any amount (string keeps BIGINT safe). */
async function postEntry(
  entryDate: string,
  memo: string,
  lines: { accountId: string; debit?: string | number; credit?: string | number }[],
  sourceType = "manual",
): Promise<string> {
  const entry = await db.query<{ id: string }>(
    `INSERT INTO journal_entries (business_id, entry_date, memo, source_type, created_by)
     VALUES ($1, $2::date, $3, $4, $5) RETURNING id`,
    [biz.id, entryDate, memo, sourceType, user.id],
  );
  for (const line of lines) {
    await db.query(
      `INSERT INTO journal_lines (entry_id, account_id, debit, credit) VALUES ($1, $2, $3, $4)`,
      [entry.rows[0].id, line.accountId, String(line.debit ?? 0), String(line.credit ?? 0)],
    );
  }
  return entry.rows[0].id;
}

/** Cash in / sales out — the entry every period test builds on. */
function sale(amount: string | number, date: string, memo = "فروش") {
  return postEntry(date, memo, [
    { accountId: acct["1100"], debit: amount },
    { accountId: acct["4100"], credit: amount },
  ]);
}

const rowFor = (report: Awaited<ReturnType<typeof reports.getTrialBalance>>, code: string) =>
  report.accounts.find((row) => row.code === code)!;

/** An all-history scope: the report's own period semantics, minus the period. */
const ALL_HISTORY = { dateFrom: "0001-01-01", dateTo: "9999-12-31" } as const;

describe("closing columns are net balances, not lifetime turnover", () => {
  it("reports a till that took 1,000 and paid 400 as a 600 debit balance", async () => {
    await sale("1000", "2026-03-05");
    await postEntry("2026-03-20", "پرداخت اجاره", [
      { accountId: acct["5300"], debit: 400 },
      { accountId: acct["1100"], credit: 400 },
    ]);

    const report = await reports.getTrialBalance(biz.id, { asOf: "2026-03-31" });
    const cash = rowFor(report, "1100");
    // The old report said debit 1,000 / credit 400 here — gross movement
    // mislabelled as a balance. The net is what a trial balance means.
    expect(cash.closingDebit).toBe("600");
    expect(cash.closingCredit).toBe("0");
    // Cash 600 + rent 400 against sales 1,000: the two columns still meet.
    expect(report.totals.closingDebit).toBe("1000");
    expect(report.totals.closingCredit).toBe("1000");
    expect(report.trialBalanceBalanced).toBe(true);
  });

  it("keeps debit and credit movement separate from the closing balance", async () => {
    await sale("1000", "2026-03-05");
    await postEntry("2026-03-20", "پرداخت اجاره", [
      { accountId: acct["5300"], debit: 400 },
      { accountId: acct["1100"], credit: 400 },
    ]);

    const report = await reports.getTrialBalance(biz.id, {
      dateFrom: "2026-03-01",
      dateTo: "2026-03-31",
    });
    const cash = rowFor(report, "1100");
    expect(cash.periodDebit).toBe("1000");
    expect(cash.periodCredit).toBe("400");
    expect(cash.closingDebit).toBe("600");
    expect(cash.openingDebit).toBe("0");
    expect(cash.normalBalance).toBe("debit");
    expect(cash.isAbnormalBalance).toBe(false);
  });

  it("gives a credit-normal account its balance in the credit column", async () => {
    await sale("1000", "2026-03-05");
    await postEntry("2026-03-20", "برگشت از فروش", [
      { accountId: acct["4100"], debit: 300 },
      { accountId: acct["1100"], credit: 300 },
    ]);

    const report = await reports.getTrialBalance(biz.id, { asOf: "2026-03-31" });
    const sales = rowFor(report, "4100");
    expect(sales.normalBalance).toBe("credit");
    expect(sales.closingDebit).toBe("0");
    expect(sales.closingCredit).toBe("700");
    expect(sales.isAbnormalBalance).toBe(false);
  });
});

describe("abnormal balances are shown, never sign-flipped or hidden", () => {
  it("puts an asset in credit into the closing credit column", async () => {
    // An overdraft: the till paid out more than it ever took in.
    await postEntry("2026-03-10", "برداشت از صندوق", [
      { accountId: acct["5300"], debit: 900 },
      { accountId: acct["1100"], credit: 900 },
    ]);

    const report = await reports.getTrialBalance(biz.id, { asOf: "2026-03-31" });
    const cash = rowFor(report, "1100");
    expect(cash.normalBalance).toBe("debit");
    expect(cash.closingDebit).toBe("0");
    // Not "-900" in the debit column: the abnormal side is visible as its own.
    expect(cash.closingCredit).toBe("900");
    expect(cash.isAbnormalBalance).toBe(true);
  });

  it("puts a liability in debit into the closing debit column", async () => {
    await postEntry("2026-03-10", "پیش‌پرداخت به تأمین‌کننده", [
      { accountId: acct["2100"], debit: 500 },
      { accountId: acct["1100"], credit: 500 },
    ]);

    const report = await reports.getTrialBalance(biz.id, { asOf: "2026-03-31" });
    const payable = rowFor(report, "2100");
    expect(payable.normalBalance).toBe("credit");
    expect(payable.closingDebit).toBe("500");
    expect(payable.closingCredit).toBe("0");
    expect(payable.isAbnormalBalance).toBe(true);
  });

  it("treats a contra account's opposite side as its normal one", async () => {
    const { id } = await accountsService.createAccount({
      businessId: biz.id,
      code: "4400",
      name: "برگشت از فروش",
      type: "revenue",
      isContra: true,
    });
    await postEntry("2026-03-10", "برگشت کالا", [
      { accountId: id, debit: 250 },
      { accountId: acct["1100"], credit: 250 },
    ]);

    const report = await reports.getTrialBalance(biz.id, { asOf: "2026-03-31" });
    const returns = rowFor(report, "4400");
    // A revenue account is credit-normal; its contra moves the other way, so a
    // debit balance here is *normal*, not an anomaly to flag.
    expect(returns.normalBalance).toBe("debit");
    expect(returns.closingDebit).toBe("250");
    expect(returns.isAbnormalBalance).toBe(false);
  });
});

describe("the period is respected exactly", () => {
  it("carries everything before dateFrom into the opening balance", async () => {
    await sale("1000", "2026-02-10", "فروش اسفند");
    await sale("300", "2026-03-12", "فروش فروردین");

    const report = await reports.getTrialBalance(biz.id, {
      dateFrom: "2026-03-01",
      dateTo: "2026-03-31",
    });
    const cash = rowFor(report, "1100");
    expect(cash.openingDebit).toBe("1000");
    expect(cash.openingCredit).toBe("0");
    expect(cash.periodDebit).toBe("300");
    expect(cash.periodCredit).toBe("0");
    expect(cash.closingDebit).toBe("1300");
    expect(report.totals.openingDebit).toBe("1000");
    expect(report.totals.openingCredit).toBe("1000");
  });

  it("includes both boundary dates and excludes a posting after dateTo", async () => {
    await sale("100", "2026-03-01", "روز اول");
    await sale("200", "2026-03-31", "روز آخر");
    await sale("999", "2026-04-01", "بعد از بازه");

    const report = await reports.getTrialBalance(biz.id, {
      dateFrom: "2026-03-01",
      dateTo: "2026-03-31",
    });
    const cash = rowFor(report, "1100");
    // 100 + 200 — the 999 posted on the day after `dateTo` is in neither the
    // movement nor the closing balance, and never silently rolls into April.
    expect(cash.periodDebit).toBe("300");
    expect(cash.closingDebit).toBe("300");
    expect(report.activity.entryCount).toBe(2);
    // Integrity still describes the whole ledger, so the excluded entry is not
    // forgotten by the health check.
    expect(report.integrity.entryCount).toBe(3);
  });

  it("excludes an entry posted after dateTo but recorded earlier", async () => {
    await sale("500", "2026-05-20", "سند آینده");
    const report = await reports.getTrialBalance(biz.id, { asOf: "2026-03-31" });
    expect(report.totals.closingDebit).toBe("0");
    expect(report.totals.closingCredit).toBe("0");
    expect(report.activity.entryCount).toBe(0);
    expect(report.trialBalanceBalanced).toBe(false);
    // The posting exists; it is simply after this report's date, so integrity
    // still counts it while the report does not.
    expect(report.integrity.entryCount).toBe(1);
  });

  it("reports a single-day period with no opening balance", async () => {
    await sale("700", "2026-03-15");
    const report = await reports.getTrialBalance(biz.id, {
      dateFrom: "2026-03-15",
      dateTo: "2026-03-15",
    });
    const cash = rowFor(report, "1100");
    expect(cash.openingDebit).toBe("0");
    expect(cash.periodDebit).toBe("700");
    expect(cash.closingDebit).toBe("700");
  });

  it("refuses a period whose end precedes its start", async () => {
    await expect(
      reports.getTrialBalance(biz.id, { dateFrom: "2026-03-31", dateTo: "2026-03-01" }),
    ).rejects.toThrow("invalid_trial_balance_scope");
  });

  it("refuses a scope with no dates at all, so 'no filter' cannot mean 'all time'", async () => {
    await expect(reports.getTrialBalance(biz.id, {})).rejects.toThrow(
      "invalid_trial_balance_scope",
    );
    await expect(
      reports.getTrialBalance(biz.id, { asOf: "2026-13-01" }),
    ).rejects.toThrow("invalid_trial_balance_scope");
  });

  it("treats asOf as a closing-only report", async () => {
    await sale("400", "2026-03-10");
    const report = await reports.getTrialBalance(biz.id, { asOf: "2026-03-31" });
    expect(report.mode).toBe("closing");
    expect(report.periodFrom).toBeNull();
    expect(report.asOf).toBe("2026-03-31");
    const cash = rowFor(report, "1100");
    expect(cash.openingDebit).toBe("0");
    expect(cash.periodDebit).toBe("0");
    expect(cash.closingDebit).toBe("400");
  });
});

describe("fiscal periods", () => {
  it("reports an open fiscal period's movement and closing balance", async () => {
    const year = await fiscalPeriods.createFiscalYear(biz.id, 1405);
    const periods = await fiscalPeriods.listPeriods(biz.id, year.id);
    const farvardin = periods.find((period) => period.label.endsWith("-01"))!;
    expect(farvardin.status).toBe("open");

    await sale("1000", farvardin.startsOn, "فروش اول دوره");
    await sale("500", farvardin.endsOn, "فروش آخر دوره");

    const report = await reports.getTrialBalance(biz.id, {
      dateFrom: farvardin.startsOn,
      dateTo: farvardin.endsOn,
    });
    const cash = rowFor(report, "1100");
    expect(cash.periodDebit).toBe("1500");
    expect(cash.closingDebit).toBe("1500");
    expect(report.trialBalanceBalanced).toBe(true);
  });

  it("still reports a locked period's history for review", async () => {
    const year = await fiscalPeriods.createFiscalYear(biz.id, 1404);
    const periods = await fiscalPeriods.listPeriods(biz.id, year.id);
    const first = periods.find((period) => period.label.endsWith("-01"))!;

    await sale("800", first.startsOn);
    await fiscalPeriods.setPeriodStatus(biz.id, first.id, "soft_closed", user.id);
    const locked = await fiscalPeriods.setPeriodStatus(biz.id, first.id, "locked", user.id);
    expect(locked.status).toBe("locked");

    // A locked period rejects *new* postings; a report over its closed history
    // is exactly what closing a year is for.
    const report = await reports.getTrialBalance(biz.id, {
      dateFrom: first.startsOn,
      dateTo: first.endsOn,
    });
    expect(rowFor(report, "1100").closingDebit).toBe("800");
    expect(rowFor(report, "4100").closingCredit).toBe("800");
    expect(report.trialBalanceBalanced).toBe(true);
    expect(report.integrity.ledgerHealthy).toBe(true);
  });

  it("carries a closing year's balances into the next period's opening column", async () => {
    const year = await fiscalPeriods.createFiscalYear(biz.id, 1404);
    const periods = await fiscalPeriods.listPeriods(biz.id, year.id);
    const first = periods.find((period) => period.label.endsWith("-01"))!;
    const second = periods.find((period) => period.label.endsWith("-02"))!;

    await sale("2000", first.endsOn, "سند بستن دورهٔ قبل");

    const nextPeriod = await reports.getTrialBalance(biz.id, {
      dateFrom: second.startsOn,
      dateTo: second.endsOn,
    });
    const cash = rowFor(nextPeriod, "1100");
    expect(cash.openingDebit).toBe("2000");
    expect(cash.periodDebit).toBe("0");
    expect(cash.closingDebit).toBe("2000");
    // The year-end figure carried across, so the two periods add up.
    expect(nextPeriod.totals.openingDebit).toBe(nextPeriod.totals.openingCredit);
  });
});

describe("money stays exact above Number.MAX_SAFE_INTEGER", () => {
  it("returns a BIGINT balance as its own decimal string, digit for digit", async () => {
    // 9,007,199,254,740,993 Rial is 2^53 + 1 — one past the last integer a JS
    // number can hold exactly. Twice it is the balance under test, and a
    // `Number()` anywhere on this path would round a Rial away.
    const huge = "9007199254740993";
    await sale(huge, "2026-03-10", "فروش اول");
    await sale(huge, "2026-03-11", "فروش دوم");

    // A detailed period, so the movement column is exercised too — the as-of
    // view reports closings only and would leave it at zero by design.
    const report = await reports.getTrialBalance(biz.id, {
      dateFrom: "2026-03-01",
      dateTo: "2026-03-31",
    });
    const cash = rowFor(report, "1100");
    expect(cash.closingDebit).toBe("18014398509481986");
    expect(cash.periodDebit).toBe("18014398509481986");
    expect(rowFor(report, "4100").closingCredit).toBe("18014398509481986");
    expect(report.totals.closingDebit).toBe("18014398509481986");
    expect(report.totals.closingCredit).toBe("18014398509481986");
    expect(report.totals.closingDifference).toBe("0");
    // The proof that the string mattered: the same digits through Number() are
    // a different number.
    expect(Number(cash.closingDebit).toString()).not.toBe(cash.closingDebit);
  });

  it("keeps every report amount a string, so no caller can reach for Number()", async () => {
    await sale("1000", "2026-03-10");
    const report = await reports.getTrialBalance(biz.id, { asOf: "2026-03-31" });
    for (const row of report.accounts) {
      for (const key of [
        "openingDebit", "openingCredit", "periodDebit", "periodCredit", "closingDebit", "closingCredit",
      ] as const) {
        expect(typeof row[key]).toBe("string");
      }
    }
    for (const value of Object.values(report.totals)) expect(typeof value).toBe("string");
    expect(typeof report.integrity.balanceDifference).toBe("string");
  });
});

describe("an empty ledger", () => {
  it("is not reported as balanced", async () => {
    const report = await reports.getTrialBalance(biz.id, { asOf: "2026-03-31" });
    // The chart is still listed — every account at zero — because a zero row
    // is a real row of the trial balance. What must not happen is calling that
    // a balanced book: 0 = 0 over an empty ledger proves nothing.
    expect(report.accounts.length).toBeGreaterThan(0);
    expect(report.accounts.every((row) => row.closingDebit === "0" && row.closingCredit === "0")).toBe(true);
    expect(report.totals.closingDebit).toBe("0");
    expect(report.totals.closingCredit).toBe("0");
    // 0 = 0 is not a balanced book; there is no book.
    expect(report.trialBalanceBalanced).toBe(false);
    expect(report.integrity.ledgerHealthy).toBe(false);
    expect(report.integrity.entryCount).toBe(0);
  });
});

describe("corrupt books", () => {
  it("separates equal closing totals from an unhealthy ledger", async () => {
    await postEntry("2026-03-10", "سند خراب اول", [
      { accountId: acct["5300"], debit: 100 },
      { accountId: acct["1100"], credit: 90 },
    ]);
    await postEntry("2026-03-11", "سند خراب دوم", [
      { accountId: acct["5300"], debit: 90 },
      { accountId: acct["1100"], credit: 100 },
    ]);

    const report = await reports.getTrialBalance(biz.id, { asOf: "2026-03-31" });
    expect(report.totals.closingDebit).toBe("190");
    expect(report.totals.closingCredit).toBe("190");
    // The columns match, so the report is not "unbalanced" — but the ledger is
    // not healthy, and the UI can say exactly that instead of a green all-clear.
    expect(report.trialBalanceBalanced).toBe(true);
    expect(report.integrity.ledgerHealthy).toBe(false);
    expect(report.integrity.unbalancedEntryCount).toBe(2);
  });

  it("flags a journal header with fewer than two lines", async () => {
    const broken = await db.query<{ id: string }>(
      `INSERT INTO journal_entries (business_id, entry_date, memo, source_type, created_by)
       VALUES ($1, '2026-03-10', 'سند تک‌ردیفه', 'manual', $2) RETURNING id`,
      [biz.id, user.id],
    );
    await db.query(
      `INSERT INTO journal_lines (entry_id, account_id, debit, credit) VALUES ($1, $2, 500, 0)`,
      [broken.rows[0].id, acct["5300"]],
    );

    const report = await reports.getTrialBalance(biz.id, { asOf: "2026-03-31" });
    expect(report.integrity.invalidEntryCount).toBe(1);
    expect(report.integrity.ledgerHealthy).toBe(false);
    expect(report.totals.closingDebit).toBe("500");
    expect(report.totals.closingCredit).toBe("0");
    expect(report.trialBalanceBalanced).toBe(false);
  });

  it("reports an unbalanced book as unbalanced even when every entry is well formed", async () => {
    await sale("1000", "2026-03-05");
    await postEntry("2026-03-06", "سند ناقص", [
      { accountId: acct["5300"], debit: 200 },
      { accountId: acct["1100"], credit: 150 },
    ]);

    const report = await reports.getTrialBalance(biz.id, { asOf: "2026-03-31" });
    expect(report.integrity.balanceDifference).toBe("50");
    expect(report.totals.closingDifference).toBe("50");
    expect(report.trialBalanceBalanced).toBe(false);
  });
});

describe("archived accounts", () => {
  it("keeps an archived account's postings in the report", async () => {
    await sale("1000", "2026-03-05");
    await accountsService.setAccountActive(biz.id, acct["4100"], false, user.id);

    const report = await reports.getTrialBalance(biz.id, { asOf: "2026-03-31" });
    const sales = rowFor(report, "4100");
    expect(sales.isActive).toBe(false);
    expect(sales.closingCredit).toBe("1000");
    // Dropping the archived side would have made a correct book look broken.
    expect(report.totals.closingDebit).toBe(report.totals.closingCredit);
    expect(report.trialBalanceBalanced).toBe(true);
  });

  it("leaves an archived account with no postings out", async () => {
    const { id } = await accountsService.createAccount({
      businessId: biz.id,
      code: "5999",
      name: "حساب بی‌استفاده",
      type: "expense",
    });
    await accountsService.setAccountActive(biz.id, id, false, user.id);
    await sale("1000", "2026-03-05");

    const report = await reports.getTrialBalance(biz.id, { asOf: "2026-03-31" });
    expect(report.accounts.map((row) => row.code)).not.toContain("5999");
  });

  it("keeps an archived account that posted *before* the report's date", async () => {
    await sale("1000", "2026-02-10");
    await accountsService.setAccountActive(biz.id, acct["4100"], false, user.id);

    // April has no movement, but February's posting is this report's opening
    // balance — archiving the account must not delete a Rial of history.
    const report = await reports.getTrialBalance(biz.id, {
      dateFrom: "2026-04-01",
      dateTo: "2026-04-30",
    });
    const sales = rowFor(report, "4100");
    expect(sales.isActive).toBe(false);
    expect(sales.openingCredit).toBe("1000");
    expect(sales.periodCredit).toBe("0");
    expect(sales.closingCredit).toBe("1000");
    expect(report.totals.closingDebit).toBe(report.totals.closingCredit);
  });
});

describe("zero balances are a presentation choice", () => {
  it("keeps a zero row in the report and lets the screen hide it", async () => {
    await sale("1000", "2026-03-05");
    const report = await reports.getTrialBalance(biz.id, {
      dateFrom: "2026-04-01",
      dateTo: "2026-04-30",
    });
    // Rent is active but untouched: the service still returns it (it is part of
    // the chart), and the shared presentation filter is what decides whether a
    // zero row is noise.
    const rent = report.accounts.find((row) => row.code === "5300")!;
    expect(rent.closingDebit).toBe("0");
    expect(rent.closingCredit).toBe("0");

    const hidden = filterTrialBalanceRows(report.accounts, { presentation: "detailed" });
    expect(hidden.map((row) => row.code)).not.toContain("5300");
    expect(hidden.map((row) => row.code)).toContain("1100");

    const shown = filterTrialBalanceRows(report.accounts, {
      presentation: "detailed",
      includeZeroBalances: true,
    });
    expect(shown.map((row) => row.code)).toContain("5300");
  });
});

describe("account hierarchy", () => {
  it("exposes each row's level and parent so a group is not double counted", async () => {
    const group = await accountsService.createAccount({
      businessId: biz.id,
      code: "1000",
      name: "دارایی‌های جاری",
      type: "asset",
    });
    const child = await accountsService.createAccount({
      businessId: biz.id,
      code: "1101",
      name: "صندوق شعبه",
      type: "asset",
      parentId: group.id,
    });
    await postEntry("2026-03-10", "واریز", [
      { accountId: child.id, debit: 300 },
      { accountId: acct["4100"], credit: 300 },
    ]);

    const report = await reports.getTrialBalance(biz.id, { asOf: "2026-03-31" });
    const parent = rowFor(report, "1000");
    const detail = rowFor(report, "1101");
    expect(parent.level).toBe("group");
    expect(parent.hasChildren).toBe(true);
    expect(parent.closingDebit).toBe("0");
    expect(detail.parentCode).toBe("1000");
    expect(detail.level).toBe("kol");
    expect(detail.hasChildren).toBe(false);
    expect(detail.closingDebit).toBe("300");
    // A group carries no postings of its own, so the grand total is the detail
    // rows alone — the group subtotal is presentation, never a second Rial.
    expect(report.totals.closingDebit).toBe("300");
    expect(report.totals.closingCredit).toBe("300");
  });

  it("orders rows by account code", async () => {
    await sale("100", "2026-03-05");
    await postEntry("2026-03-06", "بدهی", [
      { accountId: acct["5300"], debit: 50 },
      { accountId: acct["2100"], credit: 50 },
    ]);
    const report = await reports.getTrialBalance(biz.id, { asOf: "2026-03-31" });
    const codes = report.accounts.map((row) => row.code);
    expect(codes).toEqual([...codes].sort());
  });
});

describe("healthy books", () => {
  it("balance on every realistic combination of entries", async () => {
    await sale("1000", "2026-03-01");
    await postEntry("2026-03-02", "فروش نسیه", [
      { accountId: acct["1200"], debit: 250 },
      { accountId: acct["4100"], credit: 250 },
    ]);
    await postEntry("2026-03-03", "خرید نسیه", [
      { accountId: acct["5300"], debit: 400 },
      { accountId: acct["2100"], credit: 400 },
    ]);
    await postEntry("2026-03-04", "وصول طلب", [
      { accountId: acct["1100"], debit: 250 },
      { accountId: acct["1200"], credit: 250 },
    ]);
    await postEntry("2026-03-05", "پرداخت بدهی", [
      { accountId: acct["2100"], debit: 100 },
      { accountId: acct["1100"], credit: 100 },
    ]);

    const report = await reports.getTrialBalance(biz.id, {
      dateFrom: "2026-03-01",
      dateTo: "2026-03-31",
    });
    expect(report.totals.closingDebit).toBe("1550");
    expect(report.totals.closingCredit).toBe("1550");
    expect(report.totals.closingDifference).toBe("0");
    expect(report.trialBalanceBalanced).toBe(true);
    expect(report.integrity.ledgerHealthy).toBe(true);
    expect(report.integrity.entryCount).toBe(5);
    expect(report.integrity.lineCount).toBe(10);
    // Every account sits on its own normal side: the receivable was raised and
    // then collected, the payable was partly settled, so none of them flipped.
    expect(report.accounts.every((row) => !row.isAbnormalBalance)).toBe(true);
    expect(rowFor(report, "1100").closingDebit).toBe("1150");
    expect(rowFor(report, "1200").closingDebit).toBe("0");
    expect(rowFor(report, "2100").closingCredit).toBe("300");
    expect(rowFor(report, "4100").closingCredit).toBe("1250");
    expect(rowFor(report, "5300").closingDebit).toBe("400");
  });
});

describe("the drill-down behind a trial-balance figure", () => {
  it("sums exactly to the closing balance the report displays", async () => {
    await sale("1000", "2026-03-01");
    await sale("250", "2026-03-15");
    await postEntry("2026-03-20", "پرداخت", [
      { accountId: acct["5300"], debit: 400 },
      { accountId: acct["1100"], credit: 400 },
    ]);
    await sale("999", "2026-04-10", "بعد از بازه");

    const report = await reports.getTrialBalance(biz.id, {
      dateFrom: "2026-03-01",
      dateTo: "2026-03-31",
    });
    const cash = rowFor(report, "1100");
    const page = await drillDown.getAccountDrillDown(biz.id, "1100", {
      dateFrom: "2026-03-01",
      dateTo: "2026-03-31",
    });

    expect(page.lines).toHaveLength(3);
    expect(page.hasMore).toBe(false);
    expect(page.totalLines).toBe(3);
    // Debit movement, credit movement and the net each reconcile to the row.
    expect(page.totals.debit).toBe(cash.periodDebit);
    expect(page.totals.credit).toBe(cash.periodCredit);
    expect(page.totals.signedBalance).toBe("850");
    expect(BigInt(page.totals.debit) - BigInt(page.totals.credit)).toBe(
      BigInt(cash.closingDebit) - BigInt(cash.closingCredit),
    );
    for (const line of page.lines) {
      expect(typeof line.debit).toBe("string");
      expect(typeof line.credit).toBe("string");
      expect(line.entryId).toBeTruthy();
      expect(line.lineId).toBeTruthy();
    }
  });

  it("pages a long history while the window totals stay complete", async () => {
    for (let day = 1; day <= 5; day += 1) {
      await sale(String(day * 100), `2026-03-0${day}`);
    }
    const page = await drillDown.getAccountDrillDown(biz.id, "1100", {
      dateFrom: "2026-03-01",
      dateTo: "2026-03-31",
      limit: 2,
    });
    expect(page.lines).toHaveLength(2);
    expect(page.hasMore).toBe(true);
    expect(page.nextOffset).toBe(2);
    // The totals cover all five postings, not the two on screen.
    expect(page.totalLines).toBe(5);
    expect(page.totals.debit).toBe("1500");

    const rest = await drillDown.getAccountDrillDown(biz.id, "1100", {
      dateFrom: "2026-03-01",
      dateTo: "2026-03-31",
      limit: 2,
      offset: page.nextOffset!,
    });
    expect(rest.lines).toHaveLength(2);
    expect(new Set([...page.lines, ...rest.lines].map((line) => line.lineId)).size).toBe(4);
  });
});

describe("the report names its own scope", () => {
  it("carries the business name, the period and the mode", async () => {
    await sale("100", "2026-03-10");
    const detailed = await reports.getTrialBalance(biz.id, {
      dateFrom: "2026-03-01",
      dateTo: "2026-03-31",
    });
    expect(detailed.businessName).toBe("Trial Balance Co");
    expect(detailed.mode).toBe("detailed");
    expect(detailed.periodFrom).toBe("2026-03-01");
    expect(detailed.periodTo).toBe("2026-03-31");
    expect(detailed.asOf).toBeNull();
  });
});

describe("tenant isolation", () => {
  it("never shows another business's ledger", async () => {
    const other = await db.query<{ id: string }>(
      "INSERT INTO businesses (name, slug) VALUES ('Other Co', $1) RETURNING id",
      [`other-${randomUUID().slice(0, 8)}`],
    );
    await sale("1000", "2026-03-10");

    const report = await reports.getTrialBalance(other.rows[0].id, { asOf: "2026-03-31" });
    expect(report.accounts).toHaveLength(0);
    expect(report.integrity.entryCount).toBe(0);
  });
});
