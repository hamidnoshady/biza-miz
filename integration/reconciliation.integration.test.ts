/**
 * Phase 16 scope: "Bank & cash reconciliation — ... match against cash /
 * bankClearing postings, carry unreconciled items, lock a reconciled
 * period." Proves the core mechanics against real posted entries: a
 * reconciliation's candidate lines are whatever hasn't been claimed by an
 * earlier *completed* reconciliation, completing one requires the cleared
 * total (plus the running opening balance) to exactly match the statement,
 * and completed lines can never be reused.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { MAX_RECONCILIATION_LINE_BATCH } from "../src/lib/bank-reconciliation";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let reconciliationService: typeof import("../src/lib/reconciliation-service");

const biz = { id: "" };
const acct = { cash: "", bank: "", bankClearing: "", revenue: "" };
const user = { id: "" };

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
  databaseName = `pos_reconcile_${randomUUID().replaceAll("-", "")}`;

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
  reconciliationService = await import("../src/lib/reconciliation-service");

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
  await db.query("DELETE FROM bank_reconciliation_lines");
  await db.query("DELETE FROM bank_reconciliations");
  await db.query("DELETE FROM journal_lines");
  await db.query("DELETE FROM journal_entries");
  await db.query("DELETE FROM businesses");

  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ('Reconcile Co', $1) RETURNING id",
    [`reconcile-${randomUUID().slice(0, 8)}`],
  );
  biz.id = bizRow.rows[0].id;

  const userRow = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, pin_hash) VALUES ($1, 'owner', 'Owner', 'x') RETURNING id`,
    [biz.id],
  );
  user.id = userRow.rows[0].id;

  const accounts = await db.query<{ id: string; code: string }>(
    `INSERT INTO accounts (business_id, code, name, type)
     VALUES ($1, '1100', 'Cash', 'asset'), ($1, '1110', 'Bank', 'asset'),
            ($1, '1120', 'Card clearing', 'asset'), ($1, '4300', 'Sales', 'revenue')
     RETURNING id, code`,
    [biz.id],
  );
  for (const r of accounts.rows) {
    if (r.code === "1100") acct.cash = r.id;
    if (r.code === "1110") acct.bank = r.id;
    if (r.code === "1120") acct.bankClearing = r.id;
    if (r.code === "4300") acct.revenue = r.id;
  }
});

/** Posts a balanced two-line entry directly, mirroring an order cash sale. */
async function postCashEntry(entryDate: string, amount: number): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO journal_entries (business_id, entry_date, memo, source_type)
     VALUES ($1, $2, 'Order payment', 'order') RETURNING id`,
    [biz.id, entryDate],
  );
  const { rows: lineRows } = await db.query<{ id: string }>(
    `INSERT INTO journal_lines (entry_id, account_id, debit, credit) VALUES ($1, $2, $3, 0) RETURNING id`,
    [rows[0].id, acct.cash, amount],
  );
  await db.query(`INSERT INTO journal_lines (entry_id, account_id, debit, credit) VALUES ($1, $2, 0, $3)`, [
    rows[0].id,
    acct.revenue,
    amount,
  ]);
  return lineRows[0].id;
}

describe("createReconciliation", () => {
  it("rejects a second in-progress reconciliation for the same account", async () => {
    await reconciliationService.createReconciliation({
      businessId: biz.id,
      accountCode: "cash",
      statementDate: "2025-04-30",
      statementBalance: 100_000,
      createdBy: user.id,
    });
    await expect(
      reconciliationService.createReconciliation({
        businessId: biz.id,
        accountCode: "cash",
        statementDate: "2025-05-31",
        statementBalance: 200_000,
        createdBy: user.id,
      }),
    ).rejects.toThrow("reconciliation_in_progress");
  });

  it("allows concurrent in-progress reconciliations for different accounts", async () => {
    await reconciliationService.createReconciliation({
      businessId: biz.id,
      accountCode: "cash",
      statementDate: "2025-04-30",
      statementBalance: 100_000,
      createdBy: user.id,
    });
    await expect(
      reconciliationService.createReconciliation({
        businessId: biz.id,
        accountCode: "bankClearing",
        statementDate: "2025-04-30",
        statementBalance: 50_000,
        createdBy: user.id,
      }),
    ).resolves.toBeTruthy();
  });
});

describe("getReconciliation", () => {
  it("lists cash-account lines as uncleared candidates, excluding other accounts and later dates", async () => {
    const cashLineId = await postCashEntry("2025-04-10", 100_000);
    // A bank-clearing line and a later-dated cash line should not show up.
    await db.query(
      `INSERT INTO journal_lines (entry_id, account_id, debit, credit)
       SELECT id, $2, 50000, 0 FROM journal_entries WHERE business_id = $1 LIMIT 1`,
      [biz.id, acct.bankClearing],
    );
    await postCashEntry("2025-05-01", 999_000);

    const reconciliation = await reconciliationService.createReconciliation({
      businessId: biz.id,
      accountCode: "cash",
      statementDate: "2025-04-30",
      statementBalance: 100_000,
      createdBy: user.id,
    });
    const detail = await reconciliationService.getReconciliation(biz.id, reconciliation.id);
    expect(detail.lines.map((l) => l.journalLineId)).toEqual([cashLineId]);
    expect(detail.lines[0].cleared).toBe(false);
    expect(detail.openingBalance).toBe(0);
  });
});

describe("setLineCleared and completeReconciliation", () => {
  it("requires the cleared total to exactly match the statement balance", async () => {
    const lineId = await postCashEntry("2025-04-10", 100_000);
    const reconciliation = await reconciliationService.createReconciliation({
      businessId: biz.id,
      accountCode: "cash",
      statementDate: "2025-04-30",
      statementBalance: 100_000,
      createdBy: user.id,
    });

    await expect(
      reconciliationService.completeReconciliation({ businessId: biz.id, reconciliationId: reconciliation.id, actorId: user.id }),
    ).rejects.toThrow("balance_mismatch");

    await reconciliationService.setLineCleared({
      businessId: biz.id,
      reconciliationId: reconciliation.id,
      journalLineId: lineId,
      cleared: true,
    });
    const completed = await reconciliationService.completeReconciliation({
      businessId: biz.id,
      reconciliationId: reconciliation.id,
      actorId: user.id,
    });
    expect(completed.status).toBe("completed");
    expect(completed.difference).toBe(0);
  });

  it("un-clearing a line removes it from the cleared total", async () => {
    const lineId = await postCashEntry("2025-04-10", 100_000);
    const reconciliation = await reconciliationService.createReconciliation({
      businessId: biz.id,
      accountCode: "cash",
      statementDate: "2025-04-30",
      statementBalance: 0,
      createdBy: user.id,
    });
    await reconciliationService.setLineCleared({
      businessId: biz.id,
      reconciliationId: reconciliation.id,
      journalLineId: lineId,
      cleared: true,
    });
    await reconciliationService.setLineCleared({
      businessId: biz.id,
      reconciliationId: reconciliation.id,
      journalLineId: lineId,
      cleared: false,
    });
    const detail = await reconciliationService.getReconciliation(biz.id, reconciliation.id);
    expect(detail.clearedTotal).toBe(0);
    expect(detail.lines[0].cleared).toBe(false);
  });

  it("rejects clearing a line once the reconciliation is completed", async () => {
    const lineId = await postCashEntry("2025-04-10", 100_000);
    const reconciliation = await reconciliationService.createReconciliation({
      businessId: biz.id,
      accountCode: "cash",
      statementDate: "2025-04-30",
      statementBalance: 100_000,
      createdBy: user.id,
    });
    await reconciliationService.setLineCleared({
      businessId: biz.id,
      reconciliationId: reconciliation.id,
      journalLineId: lineId,
      cleared: true,
    });
    await reconciliationService.completeReconciliation({ businessId: biz.id, reconciliationId: reconciliation.id, actorId: user.id });

    await expect(
      reconciliationService.setLineCleared({
        businessId: biz.id,
        reconciliationId: reconciliation.id,
        journalLineId: lineId,
        cleared: false,
      }),
    ).rejects.toThrow("reconciliation_completed");
  });

  it("carries the completed statement balance forward as the next reconciliation's opening balance, excluding claimed lines", async () => {
    const line1 = await postCashEntry("2025-04-10", 100_000);
    const first = await reconciliationService.createReconciliation({
      businessId: biz.id,
      accountCode: "cash",
      statementDate: "2025-04-30",
      statementBalance: 100_000,
      createdBy: user.id,
    });
    await reconciliationService.setLineCleared({ businessId: biz.id, reconciliationId: first.id, journalLineId: line1, cleared: true });
    await reconciliationService.completeReconciliation({ businessId: biz.id, reconciliationId: first.id, actorId: user.id });

    const line2 = await postCashEntry("2025-05-10", 40_000);
    const second = await reconciliationService.createReconciliation({
      businessId: biz.id,
      accountCode: "cash",
      statementDate: "2025-05-31",
      statementBalance: 140_000,
      createdBy: user.id,
    });
    const detail = await reconciliationService.getReconciliation(biz.id, second.id);
    expect(detail.openingBalance).toBe(100_000);
    expect(detail.lines.map((l) => l.journalLineId)).toEqual([line2]);

    await reconciliationService.setLineCleared({ businessId: biz.id, reconciliationId: second.id, journalLineId: line2, cleared: true });
    const completed = await reconciliationService.completeReconciliation({
      businessId: biz.id,
      reconciliationId: second.id,
      actorId: user.id,
    });
    expect(completed.difference).toBe(0);
  });
});

/**
 * The bugs this screen shipped with, each pinned by the case that exposed it.
 * Every one of these was reproducible against a running instance before the
 * fix: three returned a 500 and «خطای غیرمنتظره», three quietly corrupted the
 * reconciliation chain.
 */
describe("input that used to crash instead of answering", () => {
  it("answers a malformed statement date rather than letting the date column raise", async () => {
    // Was: `invalid input syntax for type date` → 500.
    await expect(
      reconciliationService.createReconciliation({
        businessId: biz.id,
        accountCode: "cash",
        statementDate: "not-a-date",
        statementBalance: 100_000,
        createdBy: user.id,
      }),
    ).rejects.toThrow("invalid_statement_date");
  });

  it("refuses a Jalali year that reached the Gregorian wire field", async () => {
    // Was: accepted as Gregorian year 1404 — a statement six centuries back
    // that no posting could ever match, and an un-completable reconciliation
    // blocking the account.
    await expect(
      reconciliationService.createReconciliation({
        businessId: biz.id,
        accountCode: "cash",
        statementDate: "1404-04-09",
        statementBalance: 100_000,
        createdBy: user.id,
      }),
    ).rejects.toThrow("invalid_statement_date");
  });

  it("answers a non-uuid reconciliation id with not-found, not a 500", async () => {
    await expect(reconciliationService.getReconciliation(biz.id, "not-a-uuid")).rejects.toThrow(
      "reconciliation_not_found",
    );
    await expect(
      reconciliationService.setLineCleared({
        businessId: biz.id,
        reconciliationId: "not-a-uuid",
        journalLineId: "1",
        cleared: true,
      }),
    ).rejects.toThrow("reconciliation_not_found");
  });

  it("answers a non-numeric journal line id with not-found, not a 500", async () => {
    const reconciliation = await reconciliationService.createReconciliation({
      businessId: biz.id,
      accountCode: "cash",
      statementDate: "2025-04-30",
      statementBalance: 0,
      createdBy: user.id,
    });
    await expect(
      reconciliationService.setLineCleared({
        businessId: biz.id,
        reconciliationId: reconciliation.id,
        journalLineId: "abc",
        cleared: true,
      }),
    ).rejects.toThrow("journal_line_not_found");
  });
});

describe("the reconciliation chain cannot be corrupted", () => {
  it("refuses to clear a line posted after the statement date", async () => {
    // Was: accepted. The line was locked to a reconciliation that then never
    // displayed it (candidateLines stops at the statement date), and no later
    // reconciliation could claim it either — money silently left the
    // reconcilable set.
    const lateLine = await postCashEntry("2025-05-10", 40_000);
    const reconciliation = await reconciliationService.createReconciliation({
      businessId: biz.id,
      accountCode: "cash",
      statementDate: "2025-04-30",
      statementBalance: 0,
      createdBy: user.id,
    });

    await expect(
      reconciliationService.setLineCleared({
        businessId: biz.id,
        reconciliationId: reconciliation.id,
        journalLineId: lateLine,
        cleared: true,
      }),
    ).rejects.toThrow("journal_line_not_found");

    const detail = await reconciliationService.getReconciliation(biz.id, reconciliation.id);
    expect(detail.clearedTotal).toBe(0);
  });

  it("says so when a line is already locked by another reconciliation, instead of reporting success", async () => {
    // Was: `ON CONFLICT DO NOTHING` swallowed it — the caller got «ok», the
    // tick appeared to take, and it vanished on the next read.
    const line = await postCashEntry("2025-04-10", 100_000);
    const first = await reconciliationService.createReconciliation({
      businessId: biz.id,
      accountCode: "cash",
      statementDate: "2025-04-30",
      statementBalance: 100_000,
      createdBy: user.id,
    });
    await reconciliationService.setLineCleared({
      businessId: biz.id,
      reconciliationId: first.id,
      journalLineId: line,
      cleared: true,
    });
    await reconciliationService.completeReconciliation({
      businessId: biz.id,
      reconciliationId: first.id,
      actorId: user.id,
    });

    const second = await reconciliationService.createReconciliation({
      businessId: biz.id,
      accountCode: "cash",
      statementDate: "2025-05-31",
      statementBalance: 100_000,
      createdBy: user.id,
    });
    await expect(
      reconciliationService.setLineCleared({
        businessId: biz.id,
        reconciliationId: second.id,
        journalLineId: line,
        cleared: true,
      }),
    ).rejects.toThrow("journal_line_already_reconciled");
  });

  it("re-clearing a line this reconciliation already holds stays a no-op", async () => {
    const line = await postCashEntry("2025-04-10", 100_000);
    const reconciliation = await reconciliationService.createReconciliation({
      businessId: biz.id,
      accountCode: "cash",
      statementDate: "2025-04-30",
      statementBalance: 100_000,
      createdBy: user.id,
    });
    const clear = () =>
      reconciliationService.setLineCleared({
        businessId: biz.id,
        reconciliationId: reconciliation.id,
        journalLineId: line,
        cleared: true,
      });
    await clear();
    // A double-click or an offline retry must not become an error.
    await expect(clear()).resolves.toBeUndefined();
    const detail = await reconciliationService.getReconciliation(biz.id, reconciliation.id);
    expect(detail.clearedTotal).toBe(100_000);
  });

  it("refuses a statement dated into an already-locked period", async () => {
    // Was: accepted, and opened from the *later* reconciliation's closing
    // balance — a period opening from its own future, permanently unclosable,
    // and blocking every new reconciliation on the account.
    const line = await postCashEntry("2025-05-10", 100_000);
    const july = await reconciliationService.createReconciliation({
      businessId: biz.id,
      accountCode: "cash",
      statementDate: "2025-05-31",
      statementBalance: 100_000,
      createdBy: user.id,
    });
    await reconciliationService.setLineCleared({
      businessId: biz.id,
      reconciliationId: july.id,
      journalLineId: line,
      cleared: true,
    });
    await reconciliationService.completeReconciliation({
      businessId: biz.id,
      reconciliationId: july.id,
      actorId: user.id,
    });

    await expect(
      reconciliationService.createReconciliation({
        businessId: biz.id,
        accountCode: "cash",
        statementDate: "2025-04-30",
        statementBalance: 999,
        createdBy: user.id,
      }),
    ).rejects.toThrow("statement_date_already_reconciled");
  });

  it("only one of two concurrent completions wins, so the audit trail is not overwritten", async () => {
    // Was: both passed the read-then-write guard and both UPDATEd, so
    // completed_at/completed_by named whoever finished second.
    const line = await postCashEntry("2025-04-10", 100_000);
    const reconciliation = await reconciliationService.createReconciliation({
      businessId: biz.id,
      accountCode: "cash",
      statementDate: "2025-04-30",
      statementBalance: 100_000,
      createdBy: user.id,
    });
    await reconciliationService.setLineCleared({
      businessId: biz.id,
      reconciliationId: reconciliation.id,
      journalLineId: line,
      cleared: true,
    });

    const results = await Promise.allSettled([
      reconciliationService.completeReconciliation({
        businessId: biz.id,
        reconciliationId: reconciliation.id,
        actorId: user.id,
      }),
      reconciliationService.completeReconciliation({
        businessId: biz.id,
        reconciliationId: reconciliation.id,
        actorId: user.id,
      }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  });
});

describe("opening balance follows the statement date, not merely the newest lock", () => {
  it("opens a backdated-but-allowed account from 0 when every completed reconciliation is later", async () => {
    // `openingBalance` is bounded by `statement_date <= $4`. Proven on a second
    // account, where a later completed reconciliation exists but belongs to a
    // different account and must not leak into this one's opening balance.
    const cashLine = await postCashEntry("2025-04-10", 100_000);
    const cash = await reconciliationService.createReconciliation({
      businessId: biz.id,
      accountCode: "cash",
      statementDate: "2025-04-30",
      statementBalance: 100_000,
      createdBy: user.id,
    });
    await reconciliationService.setLineCleared({
      businessId: biz.id,
      reconciliationId: cash.id,
      journalLineId: cashLine,
      cleared: true,
    });
    await reconciliationService.completeReconciliation({
      businessId: biz.id,
      reconciliationId: cash.id,
      actorId: user.id,
    });

    const clearing = await reconciliationService.createReconciliation({
      businessId: biz.id,
      accountCode: "bankClearing",
      statementDate: "2025-03-31",
      statementBalance: 0,
      createdBy: user.id,
    });
    const detail = await reconciliationService.getReconciliation(biz.id, clearing.id);
    expect(detail.openingBalance).toBe(0);
  });
});

describe("discarding an in-progress reconciliation", () => {
  it("releases its claimed lines and frees the account, so a typo is recoverable", async () => {
    // Was: impossible. One reconciliation per account, no way to edit the
    // statement balance, and a difference that can never reach zero cannot be
    // completed — a mistyped closing balance wedged the account permanently.
    const line = await postCashEntry("2025-04-10", 100_000);
    const typo = await reconciliationService.createReconciliation({
      businessId: biz.id,
      accountCode: "cash",
      statementDate: "2025-04-30",
      statementBalance: 999_999_999,
      createdBy: user.id,
    });
    await reconciliationService.setLineCleared({
      businessId: biz.id,
      reconciliationId: typo.id,
      journalLineId: line,
      cleared: true,
    });

    await reconciliationService.discardReconciliation({
      businessId: biz.id,
      reconciliationId: typo.id,
    });
    await expect(reconciliationService.getReconciliation(biz.id, typo.id)).rejects.toThrow(
      "reconciliation_not_found",
    );

    // The account is free again and the line is back in the candidate pool.
    const retry = await reconciliationService.createReconciliation({
      businessId: biz.id,
      accountCode: "cash",
      statementDate: "2025-04-30",
      statementBalance: 100_000,
      createdBy: user.id,
    });
    const detail = await reconciliationService.getReconciliation(biz.id, retry.id);
    expect(detail.lines.map((l) => l.journalLineId)).toEqual([line]);
    expect(detail.lines[0].cleared).toBe(false);
  });

  it("refuses to discard a completed reconciliation, which is the next period's opening balance", async () => {
    const line = await postCashEntry("2025-04-10", 100_000);
    const done = await reconciliationService.createReconciliation({
      businessId: biz.id,
      accountCode: "cash",
      statementDate: "2025-04-30",
      statementBalance: 100_000,
      createdBy: user.id,
    });
    await reconciliationService.setLineCleared({
      businessId: biz.id,
      reconciliationId: done.id,
      journalLineId: line,
      cleared: true,
    });
    await reconciliationService.completeReconciliation({
      businessId: biz.id,
      reconciliationId: done.id,
      actorId: user.id,
    });

    await expect(
      reconciliationService.discardReconciliation({ businessId: biz.id, reconciliationId: done.id }),
    ).rejects.toThrow("reconciliation_completed");
  });

  it("answers a non-uuid id with not-found rather than raising", async () => {
    await expect(
      reconciliationService.discardReconciliation({
        businessId: biz.id,
        reconciliationId: "not-a-uuid",
      }),
    ).rejects.toThrow("reconciliation_not_found");
  });
});

describe("a negative closing balance is judged per account", () => {
  it("refuses a negative balance for the till, which cannot hold less than nothing", async () => {
    // A minus here is a typo or a sign flip (the period's movement entered
    // instead of its closing balance). It used to be accepted, and then never
    // reconciled.
    await expect(
      reconciliationService.createReconciliation({
        businessId: biz.id,
        accountCode: "cash",
        statementDate: "2025-04-30",
        statementBalance: -100_000,
        createdBy: user.id,
      }),
    ).rejects.toThrow("negative_statement_balance");
  });

  it("refuses a negative balance for the card-reader float, for the same reason", async () => {
    await expect(
      reconciliationService.createReconciliation({
        businessId: biz.id,
        accountCode: "bankClearing",
        statementDate: "2025-04-30",
        statementBalance: -1,
        createdBy: user.id,
      }),
    ).rejects.toThrow("negative_statement_balance");
  });

  it("allows a negative balance for the bank account, which can genuinely be overdrawn", async () => {
    const overdrawn = await reconciliationService.createReconciliation({
      businessId: biz.id,
      accountCode: "bank",
      statementDate: "2025-04-30",
      statementBalance: -250_000,
      createdBy: user.id,
    });
    expect(overdrawn.statementBalance).toBe(-250_000);
  });
});

/**
 * «انتخاب همه» over a month of card settlements is hundreds of lines. It used
 * to be hundreds of PATCHes; `setLinesCleared` does it in one transaction
 * without loosening any of the per-line rules.
 */
describe("setLinesCleared (bulk)", () => {
  it("clears a whole selection in one call and reports what changed", async () => {
    const lines = [
      await postCashEntry("2025-06-05", 1000),
      await postCashEntry("2025-06-06", 2000),
      await postCashEntry("2025-06-07", 3000),
    ];
    const rec = await reconciliationService.createReconciliation({
      businessId: biz.id,
      accountCode: "cash",
      statementDate: "2025-06-30",
      statementBalance: 6000,
      createdBy: user.id,
    });

    const { changed } = await reconciliationService.setLinesCleared({
      businessId: biz.id,
      reconciliationId: rec.id,
      journalLineIds: lines,
      cleared: true,
    });
    expect(changed).toBe(3);

    const detail = await reconciliationService.getReconciliation(biz.id, rec.id);
    expect(detail.clearedTotal).toBe(6000);
    expect(detail.difference).toBe(0);
  });

  it("re-clearing an already-cleared line is a no-op, not an error", async () => {
    const line = await postCashEntry("2025-06-05", 1000);
    const rec = await reconciliationService.createReconciliation({
      businessId: biz.id,
      accountCode: "cash",
      statementDate: "2025-06-30",
      statementBalance: 1000,
      createdBy: user.id,
    });
    await reconciliationService.setLinesCleared({
      businessId: biz.id,
      reconciliationId: rec.id,
      journalLineIds: [line],
      cleared: true,
    });
    const { changed } = await reconciliationService.setLinesCleared({
      businessId: biz.id,
      reconciliationId: rec.id,
      journalLineIds: [line],
      cleared: true,
    });
    expect(changed).toBe(0);
  });

  it("un-clears a selection", async () => {
    const lines = [await postCashEntry("2025-06-05", 1000), await postCashEntry("2025-06-06", 2000)];
    const rec = await reconciliationService.createReconciliation({
      businessId: biz.id,
      accountCode: "cash",
      statementDate: "2025-06-30",
      statementBalance: 3000,
      createdBy: user.id,
    });
    await reconciliationService.setLinesCleared({
      businessId: biz.id,
      reconciliationId: rec.id,
      journalLineIds: lines,
      cleared: true,
    });
    const { changed } = await reconciliationService.setLinesCleared({
      businessId: biz.id,
      reconciliationId: rec.id,
      journalLineIds: lines,
      cleared: false,
    });
    expect(changed).toBe(2);
    expect((await reconciliationService.getReconciliation(biz.id, rec.id)).clearedTotal).toBe(0);
  });

  it("refuses the whole batch when one line is past the statement date", async () => {
    // The batch must not be a way around the window check a single PATCH makes.
    const inWindow = await postCashEntry("2025-06-05", 1000);
    const outOfWindow = await postCashEntry("2025-07-05", 2000);
    const rec = await reconciliationService.createReconciliation({
      businessId: biz.id,
      accountCode: "cash",
      statementDate: "2025-06-30",
      statementBalance: 1000,
      createdBy: user.id,
    });

    await expect(
      reconciliationService.setLinesCleared({
        businessId: biz.id,
        reconciliationId: rec.id,
        journalLineIds: [inWindow, outOfWindow],
        cleared: true,
      }),
    ).rejects.toMatchObject({ message: "journal_line_not_found", status: 404 });

    // Rolled back whole: the in-window line was not quietly claimed.
    expect((await reconciliationService.getReconciliation(biz.id, rec.id)).clearedTotal).toBe(0);
  });

  it("refuses a batch containing a line another completed reconciliation owns", async () => {
    const line1 = await postCashEntry("2025-06-05", 1000);
    const first = await reconciliationService.createReconciliation({
      businessId: biz.id,
      accountCode: "cash",
      statementDate: "2025-06-10",
      statementBalance: 1000,
      createdBy: user.id,
    });
    await reconciliationService.setLinesCleared({
      businessId: biz.id,
      reconciliationId: first.id,
      journalLineIds: [line1],
      cleared: true,
    });
    await reconciliationService.completeReconciliation({
      businessId: biz.id,
      reconciliationId: first.id,
      actorId: user.id,
    });

    const line2 = await postCashEntry("2025-06-20", 2000);
    const second = await reconciliationService.createReconciliation({
      businessId: biz.id,
      accountCode: "cash",
      statementDate: "2025-06-30",
      statementBalance: 3000,
      createdBy: user.id,
    });
    await expect(
      reconciliationService.setLinesCleared({
        businessId: biz.id,
        reconciliationId: second.id,
        journalLineIds: [line1, line2],
        cleared: true,
      }),
    ).rejects.toMatchObject({ message: "journal_line_already_reconciled", status: 409 });
  });

  it("refuses to touch a completed reconciliation", async () => {
    const line = await postCashEntry("2025-06-05", 1000);
    const rec = await reconciliationService.createReconciliation({
      businessId: biz.id,
      accountCode: "cash",
      statementDate: "2025-06-30",
      statementBalance: 1000,
      createdBy: user.id,
    });
    await reconciliationService.setLinesCleared({
      businessId: biz.id,
      reconciliationId: rec.id,
      journalLineIds: [line],
      cleared: true,
    });
    await reconciliationService.completeReconciliation({
      businessId: biz.id,
      reconciliationId: rec.id,
      actorId: user.id,
    });

    await expect(
      reconciliationService.setLinesCleared({
        businessId: biz.id,
        reconciliationId: rec.id,
        journalLineIds: [line],
        cleared: false,
      }),
    ).rejects.toMatchObject({ message: "reconciliation_completed", status: 409 });
  });

  it("answers a malformed id with a 404 rather than a Postgres error", async () => {
    const rec = await reconciliationService.createReconciliation({
      businessId: biz.id,
      accountCode: "cash",
      statementDate: "2025-06-30",
      statementBalance: 0,
      createdBy: user.id,
    });
    await expect(
      reconciliationService.setLinesCleared({
        businessId: biz.id,
        reconciliationId: rec.id,
        journalLineIds: ["not-a-bigint"],
        cleared: true,
      }),
    ).rejects.toMatchObject({ message: "journal_line_not_found", status: 404 });
    await expect(
      reconciliationService.setLinesCleared({
        businessId: biz.id,
        reconciliationId: "not-a-uuid",
        journalLineIds: ["1"],
        cleared: true,
      }),
    ).rejects.toMatchObject({ message: "reconciliation_not_found", status: 404 });
  });

  it("rejects an empty selection and one over the batch cap", async () => {
    const rec = await reconciliationService.createReconciliation({
      businessId: biz.id,
      accountCode: "cash",
      statementDate: "2025-06-30",
      statementBalance: 0,
      createdBy: user.id,
    });
    await expect(
      reconciliationService.setLinesCleared({
        businessId: biz.id,
        reconciliationId: rec.id,
        journalLineIds: [],
        cleared: true,
      }),
    ).rejects.toMatchObject({ message: "journal_line_required" });

    const tooMany = Array.from({ length: MAX_RECONCILIATION_LINE_BATCH + 1 }, (_, i) => String(i + 1));
    await expect(
      reconciliationService.setLinesCleared({
        businessId: biz.id,
        reconciliationId: rec.id,
        journalLineIds: tooMany,
        cleared: true,
      }),
    ).rejects.toMatchObject({ message: "too_many_lines" });
  });
});

/**
 * Issue #830 — the races, the guards and the audit trail the audit asked for.
 *
 * Completion used to read the lines on one connection, verify «مغایرت», and
 * then write `status = 'completed'` on another. A tick landing in that window
 * changed the lines without changing the verdict, so a reconciliation could be
 * locked at a balance its own line set did not produce. Every case below is the
 * same shape: run the two operations concurrently and assert the invariant that
 * must survive whichever order the database picks.
 */
describe("completion and line mutation cannot interleave", () => {
  it("complete vs clear: exactly one wins, and a completed reconciliation always balances", async () => {
    const balancing = await postCashEntry("2025-04-10", 100_000);
    const extra = await postCashEntry("2025-04-11", 25_000);
    const rec = await reconciliationService.createReconciliation({
      businessId: biz.id,
      accountCode: "cash",
      statementDate: "2025-04-30",
      statementBalance: 100_000,
      createdBy: user.id,
    });
    await reconciliationService.setLineCleared({
      businessId: biz.id,
      reconciliationId: rec.id,
      journalLineId: balancing,
      cleared: true,
    });

    const results = await Promise.allSettled([
      reconciliationService.completeReconciliation({
        businessId: biz.id,
        reconciliationId: rec.id,
        actorId: user.id,
      }),
      reconciliationService.setLineCleared({
        businessId: biz.id,
        reconciliationId: rec.id,
        journalLineId: extra,
        cleared: true,
      }),
    ]);

    // Either the completion got there first (and the tick was refused) or the
    // tick did (and the completion found a difference). Never both.
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);

    const detail = await reconciliationService.getReconciliation(biz.id, rec.id);
    if (detail.status === "completed") {
      expect(results[1].status).toBe("rejected");
      expect(detail.difference).toBe(0);
      expect(detail.lines.find((l) => l.journalLineId === extra)?.cleared).toBe(false);
    } else {
      expect(results[0].status).toBe("rejected");
      expect((results[0] as PromiseRejectedResult).reason.message).toBe("balance_mismatch");
      expect(detail.difference).not.toBe(0);
    }
  });

  it("complete vs un-clear: a locked period cannot have a line taken back out of it", async () => {
    const line = await postCashEntry("2025-04-10", 100_000);
    const rec = await reconciliationService.createReconciliation({
      businessId: biz.id,
      accountCode: "cash",
      statementDate: "2025-04-30",
      statementBalance: 100_000,
      createdBy: user.id,
    });
    await reconciliationService.setLineCleared({
      businessId: biz.id,
      reconciliationId: rec.id,
      journalLineId: line,
      cleared: true,
    });

    const results = await Promise.allSettled([
      reconciliationService.completeReconciliation({
        businessId: biz.id,
        reconciliationId: rec.id,
        actorId: user.id,
      }),
      reconciliationService.setLineCleared({
        businessId: biz.id,
        reconciliationId: rec.id,
        journalLineId: line,
        cleared: false,
      }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);

    const detail = await reconciliationService.getReconciliation(biz.id, rec.id);
    if (detail.status === "completed") {
      // The untick lost the race, and the locked period still holds its line.
      expect(detail.clearedTotal).toBe(100_000);
      expect(detail.difference).toBe(0);
    } else {
      expect((results[0] as PromiseRejectedResult).reason.message).toBe("balance_mismatch");
      expect(detail.clearedTotal).toBe(0);
    }
  });

  it("complete vs bulk mutation: «انتخاب همه» cannot land inside a completion", async () => {
    const balancing = await postCashEntry("2025-04-10", 100_000);
    const extras = [await postCashEntry("2025-04-11", 25_000), await postCashEntry("2025-04-12", 75_000)];
    const rec = await reconciliationService.createReconciliation({
      businessId: biz.id,
      accountCode: "cash",
      statementDate: "2025-04-30",
      statementBalance: 100_000,
      createdBy: user.id,
    });
    await reconciliationService.setLineCleared({
      businessId: biz.id,
      reconciliationId: rec.id,
      journalLineId: balancing,
      cleared: true,
    });

    const results = await Promise.allSettled([
      reconciliationService.completeReconciliation({
        businessId: biz.id,
        reconciliationId: rec.id,
        actorId: user.id,
      }),
      reconciliationService.setLinesCleared({
        businessId: biz.id,
        reconciliationId: rec.id,
        journalLineIds: extras,
        cleared: true,
      }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);

    const detail = await reconciliationService.getReconciliation(biz.id, rec.id);
    if (detail.status === "completed") {
      expect(detail.difference).toBe(0);
      expect(detail.clearedCount).toBe(1);
    } else {
      expect((results[0] as PromiseRejectedResult).reason.message).toBe("balance_mismatch");
      expect(detail.clearedTotal).toBe(200_000);
    }
  });

  it("two simultaneous starts produce one reconciliation and a domain 409, never a raw unique violation", async () => {
    // The pre-check locks rows that may not exist yet, so on its own it locked
    // nothing: both requests passed it and the loser surfaced Postgres' 23505.
    const results = await Promise.allSettled([
      reconciliationService.createReconciliation({
        businessId: biz.id,
        accountCode: "cash",
        statementDate: "2025-04-30",
        statementBalance: 100_000,
        createdBy: user.id,
      }),
      reconciliationService.createReconciliation({
        businessId: biz.id,
        accountCode: "cash",
        statementDate: "2025-04-30",
        statementBalance: 100_000,
        createdBy: user.id,
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason.message).toBe("reconciliation_in_progress");
    expect(rejected[0].reason.status).toBe(409);
    expect(rejected[0].reason.message).not.toContain("duplicate key");

    const { rows } = await db.query(
      "SELECT count(*)::int AS n FROM bank_reconciliations WHERE business_id = $1",
      [biz.id],
    );
    expect(rows[0].n).toBe(1);
  });
});

describe("a statement dated in the future", () => {
  it("is refused, because it would block every real statement after it", async () => {
    // Completions chain by statement_date and a statement dated into an
    // already-locked period is refused — so one future row wedges the account.
    await expect(
      reconciliationService.createReconciliation({
        businessId: biz.id,
        accountCode: "cash",
        statementDate: "2099-01-01",
        statementBalance: 100_000,
        createdBy: user.id,
      }),
    ).rejects.toMatchObject({ message: "statement_date_in_future", status: 400 });
  });

  it("still accepts a period that has already closed", async () => {
    await expect(
      reconciliationService.createReconciliation({
        businessId: biz.id,
        accountCode: "cash",
        statementDate: "2025-04-30",
        statementBalance: 0,
        createdBy: user.id,
      }),
    ).resolves.toBeTruthy();
  });
});

describe("a completed reconciliation is a readable record", () => {
  it("keeps the exact line set, who locked it and when", async () => {
    const first = await postCashEntry("2025-04-10", 60_000);
    const second = await postCashEntry("2025-04-11", 40_000);
    const rec = await reconciliationService.createReconciliation({
      businessId: biz.id,
      accountCode: "cash",
      statementDate: "2025-04-30",
      statementBalance: 100_000,
      createdBy: user.id,
    });
    await reconciliationService.setLinesCleared({
      businessId: biz.id,
      reconciliationId: rec.id,
      journalLineIds: [first, second],
      cleared: true,
    });
    await reconciliationService.completeReconciliation({
      businessId: biz.id,
      reconciliationId: rec.id,
      actorId: user.id,
    });

    const detail = await reconciliationService.getReconciliation(biz.id, rec.id);
    expect(detail.status).toBe("completed");
    expect(detail.completedAt).toBeTruthy();
    expect(detail.completedByName).toBe("Owner");
    expect(detail.createdByName).toBe("Owner");
    expect(detail.openingBalance).toBe(0);
    expect(detail.clearedTotal).toBe(100_000);
    expect(detail.clearedCount).toBe(2);
    expect(detail.difference).toBe(0);
    expect(detail.lines.map((l) => l.journalLineId).sort()).toEqual([first, second].sort());
    expect(detail.lines.every((l) => l.cleared)).toBe(true);

    // The list the history panel reads carries the same audit fields.
    const history = await reconciliationService.listReconciliations(biz.id, "cash");
    expect(history).toHaveLength(1);
    expect(history[0].status).toBe("completed");
    expect(history[0].completedByName).toBe("Owner");
    expect(history[0].completedAt).toBeTruthy();

    // Immutable: a second read is byte-for-byte the same line set.
    const again = await reconciliationService.getReconciliation(biz.id, rec.id);
    expect(again.lines.map((l) => l.journalLineId)).toEqual(detail.lines.map((l) => l.journalLineId));
  });

  it("shows the document reference a matcher needs, where the posting has one", async () => {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO journal_entries (business_id, entry_date, memo, source_type, source_id)
       VALUES ($1, '2025-04-10', 'دریافت چک', 'cheque', gen_random_uuid()) RETURNING id`,
      [biz.id],
    );
    const entryId = rows[0].id;
    const { rows: cheque } = await db.query<{ id: string }>(
      `INSERT INTO cheques
         (business_id, direction, status, serial_number, bank_name, counterparty_name, amount, issue_date, due_date)
       SELECT $1, 'receivable', 'cleared', '556677', 'بانک ملت', 'شرکت نمونه', 100000, '2025-03-01', '2025-04-05'
       RETURNING id`,
      [biz.id],
    );
    await db.query(`UPDATE journal_entries SET source_id = $2 WHERE id = $1`, [entryId, cheque[0].id]);
    const { rows: lineRows } = await db.query<{ id: string }>(
      `INSERT INTO journal_lines (entry_id, account_id, debit, credit) VALUES ($1, $2, 100000, 0) RETURNING id`,
      [entryId, acct.cash],
    );

    const rec = await reconciliationService.createReconciliation({
      businessId: biz.id,
      accountCode: "cash",
      statementDate: "2025-04-30",
      statementBalance: 0,
      createdBy: user.id,
    });
    const detail = await reconciliationService.getReconciliation(biz.id, rec.id);
    const line = detail.lines.find((l) => l.journalLineId === lineRows[0].id);
    expect(line?.reference).toBe("556677");
    expect(line?.entryId).toBe(entryId);
    expect(line?.sourceType).toBe("cheque");
    expect(line?.sourceId).toBe(cheque[0].id);

    // …and it is searchable, which is the point of carrying it.
    const found = await reconciliationService.getReconciliation(biz.id, rec.id, { search: "556677" });
    expect(found.lines.map((l) => l.journalLineId)).toEqual([lineRows[0].id]);
  });
});

describe("a candidate list that does not grow without bound", () => {
  async function postMany(count: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 1; i <= count; i += 1) ids.push(await postCashEntry(`2025-04-${String(i).padStart(2, "0")}`, i * 1000));
    return ids;
  }

  it("pages through every line exactly once, in one order", async () => {
    const ids = await postMany(5);
    const rec = await reconciliationService.createReconciliation({
      businessId: biz.id,
      accountCode: "cash",
      statementDate: "2025-04-30",
      statementBalance: 15_000,
      createdBy: user.id,
    });

    const first = await reconciliationService.getReconciliation(biz.id, rec.id, { limit: 2 });
    expect(first.lines).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBeTruthy();
    expect(first.candidateCount).toBe(5);
    expect(first.matchedCount).toBe(5);

    const seen = first.lines.map((l) => l.journalLineId);
    let cursor = first.nextCursor;
    while (cursor) {
      const page = await reconciliationService.getReconciliation(biz.id, rec.id, { limit: 2, cursor });
      seen.push(...page.lines.map((l) => l.journalLineId));
      cursor = page.nextCursor;
    }

    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    expect([...seen].sort()).toEqual([...ids].sort());
  });

  it("computes «مغایرت» over every line, not over the page being shown", async () => {
    const ids = await postMany(3);
    const rec = await reconciliationService.createReconciliation({
      businessId: biz.id,
      accountCode: "cash",
      statementDate: "2025-04-30",
      statementBalance: 6_000,
      createdBy: user.id,
    });
    await reconciliationService.setLinesCleared({
      businessId: biz.id,
      reconciliationId: rec.id,
      journalLineIds: ids,
      cleared: true,
    });

    // One line on screen, three in the total: a difference derived from the
    // page would have said 5٬000 and let an unbalanced period be locked.
    const page = await reconciliationService.getReconciliation(biz.id, rec.id, { limit: 1 });
    expect(page.lines).toHaveLength(1);
    expect(page.clearedTotal).toBe(6_000);
    expect(page.clearedCount).toBe(3);
    expect(page.difference).toBe(0);
  });

  it("filters by search and by ticked, and counts the match separately from the total", async () => {
    await postMany(3);
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO journal_entries (business_id, entry_date, memo, source_type)
       VALUES ($1, '2025-04-20', 'واریز پایانهٔ کارتخوان', 'manual') RETURNING id`,
      [biz.id],
    );
    const { rows: lineRows } = await db.query<{ id: string }>(
      `INSERT INTO journal_lines (entry_id, account_id, debit, credit) VALUES ($1, $2, 5000, 0) RETURNING id`,
      [rows[0].id, acct.cash],
    );
    const rec = await reconciliationService.createReconciliation({
      businessId: biz.id,
      accountCode: "cash",
      statementDate: "2025-04-30",
      statementBalance: 0,
      createdBy: user.id,
    });
    await reconciliationService.setLineCleared({
      businessId: biz.id,
      reconciliationId: rec.id,
      journalLineId: lineRows[0].id,
      cleared: true,
    });

    const byMemo = await reconciliationService.getReconciliation(biz.id, rec.id, { search: "پایانه" });
    expect(byMemo.lines.map((l) => l.journalLineId)).toEqual([lineRows[0].id]);
    expect(byMemo.matchedCount).toBe(1);
    // The header counts are the reconciliation's, not the filter's.
    expect(byMemo.candidateCount).toBe(4);
    expect(byMemo.clearedCount).toBe(1);

    const byId = await reconciliationService.getReconciliation(biz.id, rec.id, {
      search: lineRows[0].id,
    });
    expect(byId.lines).toHaveLength(1);

    const ticked = await reconciliationService.getReconciliation(biz.id, rec.id, { clearedOnly: true });
    expect(ticked.lines.map((l) => l.journalLineId)).toEqual([lineRows[0].id]);
    expect(ticked.matchedCount).toBe(1);

    const none = await reconciliationService.getReconciliation(biz.id, rec.id, { search: "چیزی که نیست" });
    expect(none.lines).toHaveLength(0);
    expect(none.matchedCount).toBe(0);
    expect(none.clearedTotal).toBe(5_000);
  });

  it("answers a malformed cursor rather than raising on the cast", async () => {
    const rec = await reconciliationService.createReconciliation({
      businessId: biz.id,
      accountCode: "cash",
      statementDate: "2025-04-30",
      statementBalance: 0,
      createdBy: user.id,
    });
    await expect(
      reconciliationService.getReconciliation(biz.id, rec.id, { cursor: "not|a|cursor" }),
    ).rejects.toMatchObject({ message: "invalid_cursor", status: 400 });
  });

  it("orders lines that share a date and a posting instant deterministically", async () => {
    // Three postings on one day, recorded at the same instant: the order used
    // to be whatever the planner returned, so the same screen could list the
    // same lines differently between two refreshes — and a paged list whose
    // order is not total can drop or repeat a row across a boundary.
    const posted: { entryId: string; lineId: string }[] = [];
    for (const memo of ["یک", "دو", "سه"]) {
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO journal_entries (business_id, entry_date, memo, posted_at)
         VALUES ($1, '2025-04-10', $2, '2025-04-10 08:00:00+00') RETURNING id`,
        [biz.id, memo],
      );
      const { rows: lineRows } = await db.query<{ id: string }>(
        `INSERT INTO journal_lines (entry_id, account_id, debit, credit) VALUES ($1, $2, 1000, 0) RETURNING id`,
        [rows[0].id, acct.cash],
      );
      posted.push({ entryId: rows[0].id, lineId: lineRows[0].id });
    }
    const rec = await reconciliationService.createReconciliation({
      businessId: biz.id,
      accountCode: "cash",
      statementDate: "2025-04-30",
      statementBalance: 0,
      createdBy: user.id,
    });

    const reads = await Promise.all([
      reconciliationService.getReconciliation(biz.id, rec.id),
      reconciliationService.getReconciliation(biz.id, rec.id),
      reconciliationService.getReconciliation(biz.id, rec.id),
    ]);
    const orders = reads.map((detail) => detail.lines.map((l) => l.journalLineId).join(","));
    expect(new Set(orders).size).toBe(1);
    // And the order is the sort key's own: entry id, then line id — a total
    // order, so no page boundary can be ambiguous.
    const expected = [...posted]
      .sort((a, b) => a.entryId.localeCompare(b.entryId) || Number(a.lineId) - Number(b.lineId))
      .map((row) => row.lineId);
    expect(orders[0].split(",")).toEqual(expected);
  });
});

/**
 * The invariants the service enforces, restated where an import, a maintenance
 * script or a hand-run statement cannot get past them (migration 0211).
 */
describe("the database refuses a claim the service would refuse", () => {
  it("rejects a claim on a line that is not a posting on the reconciled account", async () => {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO journal_entries (business_id, entry_date, memo) VALUES ($1, '2025-04-10', 'bank') RETURNING id`,
      [biz.id],
    );
    const { rows: lineRows } = await db.query<{ id: string }>(
      `INSERT INTO journal_lines (entry_id, account_id, debit, credit) VALUES ($1, $2, 1000, 0) RETURNING id`,
      [rows[0].id, acct.bank],
    );
    const rec = await reconciliationService.createReconciliation({
      businessId: biz.id,
      accountCode: "cash",
      statementDate: "2025-04-30",
      statementBalance: 0,
      createdBy: user.id,
    });

    await expect(
      db.query(`INSERT INTO bank_reconciliation_lines (reconciliation_id, journal_line_id) VALUES ($1, $2)`, [
        rec.id,
        lineRows[0].id,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("rejects a claim on a line from another business", async () => {
    const other = await db.query<{ id: string }>(
      "INSERT INTO businesses (name, slug) VALUES ('Other Co', $1) RETURNING id",
      [`other-${randomUUID().slice(0, 8)}`],
    );
    const otherAccount = await db.query<{ id: string }>(
      `INSERT INTO accounts (business_id, code, name, type) VALUES ($1, '1100', 'Cash', 'asset') RETURNING id`,
      [other.rows[0].id],
    );
    const otherEntry = await db.query<{ id: string }>(
      `INSERT INTO journal_entries (business_id, entry_date, memo) VALUES ($1, '2025-04-10', 'other') RETURNING id`,
      [other.rows[0].id],
    );
    const otherLine = await db.query<{ id: string }>(
      `INSERT INTO journal_lines (entry_id, account_id, debit, credit) VALUES ($1, $2, 1000, 0) RETURNING id`,
      [otherEntry.rows[0].id, otherAccount.rows[0].id],
    );

    const rec = await reconciliationService.createReconciliation({
      businessId: biz.id,
      accountCode: "cash",
      statementDate: "2025-04-30",
      statementBalance: 0,
      createdBy: user.id,
    });
    await expect(
      db.query(`INSERT INTO bank_reconciliation_lines (reconciliation_id, journal_line_id) VALUES ($1, $2)`, [
        rec.id,
        otherLine.rows[0].id,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("rejects a reconciliation pointed at another business's account", async () => {
    const other = await db.query<{ id: string }>(
      "INSERT INTO businesses (name, slug) VALUES ('Other Co', $1) RETURNING id",
      [`other-${randomUUID().slice(0, 8)}`],
    );
    const otherAccount = await db.query<{ id: string }>(
      `INSERT INTO accounts (business_id, code, name, type) VALUES ($1, '1100', 'Cash', 'asset') RETURNING id`,
      [other.rows[0].id],
    );

    await expect(
      db.query(
        `INSERT INTO bank_reconciliations (business_id, account_id, statement_date, statement_balance)
         VALUES ($1, $2, '2025-04-30', 0)`,
        [biz.id, otherAccount.rows[0].id],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
