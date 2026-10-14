/**
 * Issue #830 — the deterministic accounting audit must count unreconciled
 * movements on every account «تطبیق بانکی و صندوق» can actually reconcile.
 *
 * The check has drifted twice: first it read ('1110', '1120') — which counted
 * the till as unreconcilable while missing the account the cash reconciliation
 * does clear — then it was corrected to صندوق + کارت‌خوان with a comment
 * insisting the bank account could never be reconciled. That stopped being true
 * in Phase 30, when a cheque began clearing *into* بانک ۱۱۱۰: a business taking
 * cheques accumulated unclaimed movements there while the audit reported the
 * books as clean. The query is built from `RECONCILABLE_ACCOUNT_CODES` now; this
 * is the test that fails if somebody types a list again.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { RECONCILABLE_ACCOUNTS, RECONCILABLE_ACCOUNT_CODES } from "../src/lib/bank-reconciliation";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let reviewService: typeof import("../src/lib/accounting-review-service");
let reconciliationService: typeof import("../src/lib/reconciliation-service");

const biz = { id: "" };
const user = { id: "" };
const accountByCode: Record<string, string> = {};

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
  databaseName = `pos_review_${randomUUID().replaceAll("-", "")}`;

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
  reviewService = await import("../src/lib/accounting-review-service");
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
  for (const key of Object.keys(accountByCode)) delete accountByCode[key];

  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ('Review Co', $1) RETURNING id",
    [`review-${randomUUID().slice(0, 8)}`],
  );
  biz.id = bizRow.rows[0].id;

  const userRow = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, pin_hash) VALUES ($1, 'owner', 'Owner', 'x') RETURNING id`,
    [biz.id],
  );
  user.id = userRow.rows[0].id;

  // Every reconcilable account, at its well-known code, plus the revenue side
  // of the entry so each posting is balanced.
  const rows = [
    ...RECONCILABLE_ACCOUNTS.map((key) => [RECONCILABLE_ACCOUNT_CODES[key], "asset"] as const),
    ["4300", "revenue"] as const,
  ];
  for (const [code, type] of rows) {
    const inserted = await db.query<{ id: string }>(
      `INSERT INTO accounts (business_id, code, name, type) VALUES ($1, $2, $2, $3) RETURNING id`,
      [biz.id, code, type],
    );
    accountByCode[code] = inserted.rows[0].id;
  }
});

/** One balanced posting: a debit on `code`, the credit on revenue. */
async function post(code: string, entryDate: string, amount: number): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO journal_entries (business_id, entry_date, memo, source_type)
     VALUES ($1, $2, 'posting', 'manual') RETURNING id`,
    [biz.id, entryDate],
  );
  const { rows: lineRows } = await db.query<{ id: string }>(
    `INSERT INTO journal_lines (entry_id, account_id, debit, credit) VALUES ($1, $2, $3, 0) RETURNING id`,
    [rows[0].id, accountByCode[code], amount],
  );
  await db.query(`INSERT INTO journal_lines (entry_id, account_id, debit, credit) VALUES ($1, $2, 0, $3)`, [
    rows[0].id,
    accountByCode["4300"],
    amount,
  ]);
  return lineRows[0].id;
}

describe("the unreconciled-lines check", () => {
  it("counts صندوق, بانک and کارت‌خوان — including ۱۱۱۰, where cheques clear", async () => {
    await post(RECONCILABLE_ACCOUNT_CODES.cash, "2026-09-01", 10_000);
    await post(RECONCILABLE_ACCOUNT_CODES.bank, "2026-09-02", 20_000);
    await post(RECONCILABLE_ACCOUNT_CODES.bankClearing, "2026-09-03", 30_000);

    const { snapshot, unavailableChecks } = await reviewService.collectAccountingSnapshot(biz.id, {
      asOfDate: "2026-09-30",
    });
    expect(unavailableChecks).toEqual([]);
    expect(snapshot.unreconciledBankLines.count).toBe(3);
    expect(snapshot.unreconciledBankLines.amountRial).toBe(60_000);
  });

  it("stops counting a bank line once a reconciliation has claimed it", async () => {
    const cashLine = await post(RECONCILABLE_ACCOUNT_CODES.cash, "2026-09-01", 10_000);
    const bankLine = await post(RECONCILABLE_ACCOUNT_CODES.bank, "2026-09-02", 20_000);

    const rec = await reconciliationService.createReconciliation({
      businessId: biz.id,
      accountCode: "bank",
      statementDate: "2026-09-30",
      statementBalance: 20_000,
      createdBy: user.id,
    });
    await reconciliationService.setLineCleared({
      businessId: biz.id,
      reconciliationId: rec.id,
      journalLineId: bankLine,
      cleared: true,
    });
    await reconciliationService.completeReconciliation({
      businessId: biz.id,
      reconciliationId: rec.id,
      actorId: user.id,
    });

    const { snapshot } = await reviewService.collectAccountingSnapshot(biz.id, { asOfDate: "2026-09-30" });
    expect(snapshot.unreconciledBankLines.count).toBe(1);
    expect(snapshot.unreconciledBankLines.amountRial).toBe(10_000);
    expect(cashLine).toBeTruthy();
  });

  it("finds nothing on books whose settlement accounts are all reconciled", async () => {
    const line = await post(RECONCILABLE_ACCOUNT_CODES.bank, "2026-09-02", 20_000);
    const rec = await reconciliationService.createReconciliation({
      businessId: biz.id,
      accountCode: "bank",
      statementDate: "2026-09-30",
      statementBalance: 20_000,
      createdBy: user.id,
    });
    await reconciliationService.setLineCleared({
      businessId: biz.id,
      reconciliationId: rec.id,
      journalLineId: line,
      cleared: true,
    });
    await reconciliationService.completeReconciliation({
      businessId: biz.id,
      reconciliationId: rec.id,
      actorId: user.id,
    });

    const { snapshot } = await reviewService.collectAccountingSnapshot(biz.id, { asOfDate: "2026-09-30" });
    expect(snapshot.unreconciledBankLines.count).toBe(0);
  });
});
