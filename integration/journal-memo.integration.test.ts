/**
 * Issue #1060 — searching the journal by the شرح the reader sees.
 *
 * The display rule is pure and unit-tested (`src/lib/journal-memo.test.ts`);
 * what only a real database can prove is the search bridge in
 * `journal-service`: the filter runs on the *stored* memo, so a Persian query
 * must find the historical documents persisted in English, an English query
 * must find the documents persisted in Persian after the fix, and a person's
 * own manual note must not be claimed by the translation of a system memo.
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
let journal: typeof import("../src/lib/journal-service");
let journalFilters: typeof import("../src/lib/journal-filters");
let vouchers: typeof import("../src/lib/voucher-numbering-service");

const biz = { id: "" };
const ids = { historical: "", manual: "", current: "", cogs: "" };

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
  databaseName = `pos_journal_memo_${randomUUID().replaceAll("-", "")}`;
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
  journal = await import("../src/lib/journal-service");
  journalFilters = await import("../src/lib/journal-filters");
  vouchers = await import("../src/lib/voucher-numbering-service");

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

async function post(memo: string, sourceType: string, cashId: string, revenueId: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO journal_entries (business_id, entry_date, memo, source_type)
     VALUES ($1, CURRENT_DATE, $2, $3) RETURNING id`,
    [biz.id, memo, sourceType],
  );
  const entryId = rows[0].id;
  await db.query(
    `INSERT INTO journal_lines (entry_id, account_id, debit, credit)
     VALUES ($1, $2, 1000, 0), ($1, $3, 0, 1000)`,
    [entryId, cashId, revenueId],
  );
  return entryId;
}

beforeEach(async () => {
  await db.query("DELETE FROM journal_lines");
  await db.query("DELETE FROM journal_entries");
  await db.query("DELETE FROM businesses");

  biz.id = (
    await db.query<{ id: string }>(
      "INSERT INTO businesses (name, slug) VALUES ('Memo Co', $1) RETURNING id",
      [`memo-${randomUUID().slice(0, 8)}`],
    )
  ).rows[0].id;
  const accounts = await db.query<{ id: string; code: string }>(
    `INSERT INTO accounts (business_id, code, name, type)
     VALUES ($1, '1100', 'Cash', 'asset'), ($1, '4100', 'Revenue', 'revenue')
     RETURNING id, code`,
    [biz.id],
  );
  const cash = accounts.rows.find((a) => a.code === "1100")!.id;
  const revenue = accounts.rows.find((a) => a.code === "4100")!.id;

  ids.historical = await post("Order payment", "order", cash, revenue);
  ids.cogs = await post("Cost of goods sold", "order", cash, revenue);
  ids.current = await post("پرداخت سفارش", "order", cash, revenue);
  // A person's own note that happens to spell the system string.
  ids.manual = await post("Order payment", "manual", cash, revenue);
});

async function search(q: string): Promise<string[]> {
  const result = journalFilters.parseJournalFilters(new URLSearchParams({ q }));
  if ("error" in result) throw new Error(result.error);
  const page = await journal.listJournalEntries(biz.id, result.filters);
  return page.entries.map((e) => e.id).sort();
}

describe("journal search across the memo spellings (issue #1060)", () => {
  it("finds the historical English document by the Persian شرح the journal shows for it", async () => {
    expect(await search("پرداخت سفارش")).toEqual([ids.current, ids.historical].sort());
    expect(await search("بهای تمام‌شده")).toEqual([ids.cogs]);
  });

  it("finds the Persian document by the English words its history used", async () => {
    expect(await search("Order payment")).toEqual([ids.current, ids.historical, ids.manual].sort());
  });

  it("never claims a manual note through the translation — only its author's own words match it", async () => {
    expect(await search("پرداخت سفارش")).not.toContain(ids.manual);
    // The raw-text arm still finds it, as it always did.
    expect(await search("Order payment")).toContain(ids.manual);
  });

  it("returns entries with the raw stored memo — localization stays in presentation", async () => {
    const result = journalFilters.parseJournalFilters(new URLSearchParams({ q: "پرداخت سفارش" }));
    if ("error" in result) throw new Error(result.error);
    const page = await journal.listJournalEntries(biz.id, result.filters);
    const historical = page.entries.find((e) => e.id === ids.historical)!;
    expect(historical.memo).toBe("Order payment");
    expect(historical.sourceType).toBe("order");
    expect(historical.totalDebit).toBe("1000");
  });

  it("an unrelated query matches nothing new", async () => {
    expect(await search("اجاره دفتر")).toEqual([]);
  });
});

describe("the voucher register searches by the same bridge (issue #1060)", () => {
  it("finds the historical document by its displayed Persian شرح, not the manual look-alike", async () => {
    const { rows } = await vouchers.listVoucherRegister(biz.id, { search: "پرداخت سفارش" });
    expect(rows.map((r) => r.id).sort()).toEqual([ids.current, ids.historical].sort());
  });
});
