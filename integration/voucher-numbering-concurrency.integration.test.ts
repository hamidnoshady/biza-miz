/**
 * Issue #867 — voucher numbering under concurrency, deterministically.
 *
 * The sequence is allocated from `voucher_sequences` per (business, fiscal
 * year, book). Two writers must never draw the same number, and the one
 * window where that used to be possible is the **backfill**: it numbered
 * legacy entries from a counter it had read without a lock, so a posting
 * that committed in between took a number the backfill also reserved — a
 * unique violation surfacing as a 500 on the register.
 *
 * The fix makes each backfill group *reserve its whole range in one
 * upsert* (`last_number += size`), and this file pins both lock orders with
 * real row locks rather than wall-clock luck:
 *
 *   - the posting holds the counter, the reservation waits, and the
 *     backfill's range starts after the posting's number;
 *   - the reservation holds the counter, the posting waits, and the entry
 *     commits after the reserved range;
 *   - N concurrent postings draw the gapless run 1..N.
 *
 * A backend "waiting on the lock" is detected from `pg_locks`/
 * `pg_stat_activity` — the wait itself is guaranteed by the lock, so the
 * interleaving is exact and the assertions are invariants, not guesses.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import type { PoolClient } from "pg";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
/** Owner connection: seeds fixtures and inspects lock state. */
let db: Client;
let dbLib: typeof import("../src/lib/db");
let ledgerService: typeof import("../src/lib/ledger-service");

const biz = { id: "", locationId: "" };
const user = { id: "" };
const acct: Record<string, string> = {};

/** One day inside Jalali year 1404 (2025-03-21 .. 2026-03-20). */
const JOURNAL_DATE = "2025-07-15";

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
  databaseName = `pos_voucher_conc_${randomUUID().replaceAll("-", "")}`;

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
  for (const table of [
    "voucher_renumber_log",
    "voucher_sequences",
    "summary_voucher_sources",
    "summary_vouchers",
    "journal_lines",
    "journal_entries",
    "accounts",
    "users",
    "locations",
    "businesses",
  ]) {
    await db.query(`DELETE FROM ${table}`);
  }

  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ('Concurrent Co', $1) RETURNING id",
    [`concurrent-${randomUUID().slice(0, 8)}`],
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
            ($1, '5100', 'Rent', 'expense')
     RETURNING id, code`,
    [biz.id],
  );
  for (const r of accounts.rows) acct[r.code] = r.id;
});

// ---------------------------------------------------------------------------
// Lock-state helpers
// ---------------------------------------------------------------------------

/**
 * Resolves once some backend is *waiting* (an ungranted lock request) for a
 * query matching `fingerprint`. The wait is guaranteed by the test's
 * interleaving — this only observes it, so a timeout means the interleaving
 * never happened, i.e. a failure, not flakiness.
 */
async function waitForBlockedBackend(fingerprint: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM pg_locks l
         JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE l.granted = false
          AND a.query ILIKE $1`,
      [`%${fingerprint}%`],
    );
    if (Number(rows[0]?.n ?? 0) > 0) return;
    if (Date.now() >= deadline) {
      throw new Error(`no backend blocked on "${fingerprint}" within ${timeoutMs}ms — the interleaving never happened`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function counterLast(): Promise<bigint> {
  const { rows } = await db.query<{ last_number: string }>(
    `SELECT last_number::text AS last_number FROM voucher_sequences
      WHERE business_id = $1 AND fiscal_year_label = '1404' AND document_type = 'journal'`,
    [biz.id],
  );
  return BigInt(rows[0]?.last_number ?? "0");
}

async function voucherOf(client: Client | PoolClient, entryId: string): Promise<string | null> {
  const { rows } = await client.query<{ voucher_number: string | null }>(
    "SELECT voucher_number FROM journal_entries WHERE id = $1",
    [entryId],
  );
  return rows[0]?.voucher_number ?? null;
}

/**
 * The backfill's atomic range reservation, run in an open transaction so the
 * test can hold it across the interleaving. Returns the range start (`lo`).
 */
async function reserveRange(t1: PoolClient, size: number): Promise<bigint> {
  const { rows } = await t1.query<{ lo: string }>(
    `WITH s AS (
       INSERT INTO voucher_sequences (business_id, fiscal_year_id, fiscal_year_label, document_type, last_number)
       VALUES ($1, NULL, '1404', 'journal', $2)
       ON CONFLICT (business_id, fiscal_year_label, document_type)
       DO UPDATE SET last_number = voucher_sequences.last_number + $2,
                     updated_at = now()
       RETURNING last_number - $2 AS lo
     )
     SELECT lo::text AS lo FROM s`,
    [biz.id, size],
  );
  return BigInt(rows[0].lo);
}

async function numberLegacyFrom(t1: PoolClient, entryIds: string[], start: bigint): Promise<void> {
  const values = entryIds
    .map((id, i) => `('${id}'::uuid, $${i * 2 + 2}::text, $${i * 2 + 3}::int8)`)
    .join(", ");
  const params: unknown[] = [biz.id];
  entryIds.forEach((_id, i) => {
    const seq = Number(start + BigInt(i) + 1n);
    params.push(`RJ-1404-${String(seq).padStart(6, "0")}`, seq);
  });
  await t1.query(
    `UPDATE journal_entries je
        SET voucher_number = v.number,
            voucher_sequence_no = v.seq,
            voucher_assigned_at = now()
      FROM (VALUES ${values}) AS v(id, number, seq)
     WHERE je.id = v.id AND je.business_id = $1 AND je.voucher_number IS NULL`,
    params,
  );
}

/** A legacy row: posted before numbering existed, straight into the journal book. */
async function rawLegacyEntry(): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO journal_entries (business_id, location_id, entry_date, memo, source_type, source_id, created_by)
     VALUES ($1, $2, $3, 'سند قدیمی', 'purchase', NULL, $4) RETURNING id`,
    [biz.id, biz.locationId, JOURNAL_DATE, user.id],
  );
  await db.query(
    `INSERT INTO journal_lines (entry_id, account_id, debit, credit) VALUES ($1, $2, 10_000, 0), ($1, $3, 0, 10_000)`,
    [rows[0].id, acct["5100"], acct["1100"]],
  );
  return rows[0].id;
}

async function postConcurrently(): Promise<string> {
  const client = await dbLib.getPool().connect();
  try {
    await client.query("BEGIN");
    const entryId = await ledgerService.postJournalEntry(client, {
      businessId: biz.id,
      locationId: biz.locationId,
      entryDate: JOURNAL_DATE,
      memo: "سند همزمان",
      sourceType: "purchase",
      sourceId: null,
      createdBy: user.id,
      lines: [
        { accountId: acct["5100"], debit: 10_000, credit: 0 },
        { accountId: acct["1100"], debit: 0, credit: 10_000 },
      ],
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

// ---------------------------------------------------------------------------
// The interleavings
// ---------------------------------------------------------------------------

describe("voucher sequence allocation under concurrency", () => {
  it("N concurrent postings draw the gapless unique run 1..N and the counter follows", async () => {
    const n = 12;
    const ids = await Promise.all(Array.from({ length: n }, () => postConcurrently()));
    const numbers = (await Promise.all(ids.map((id) => voucherOf(db, id)))).filter(Boolean) as string[];

    expect(numbers).toHaveLength(n);
    expect(new Set(numbers).size).toBe(n);
    for (let i = 1; i <= n; i++) {
      expect(numbers).toContain(`RJ-1404-${String(i).padStart(6, "0")}`);
    }
    expect(await counterLast()).toBe(BigInt(n));
  });

  it("a backfill reserving while a posting holds the counter starts after the posting's number", async () => {
    const legacy = [await rawLegacyEntry(), await rawLegacyEntry(), await rawLegacyEntry()];

    // The posting, on a client we control: it inserts its entry, allocates
    // sequence 1 and *holds* the counter row lock across the uncommitted
    // transaction.
    const posting = await dbLib.getPool().connect();
    await posting.query("BEGIN");
    const postingEntryId = (await ledgerService.postJournalEntry(posting, {
      businessId: biz.id,
      locationId: biz.locationId,
      entryDate: JOURNAL_DATE,
      memo: "سند همزمان",
      sourceType: "purchase",
      sourceId: null,
      createdBy: user.id,
      lines: [
        { accountId: acct["5100"], debit: 10_000, credit: 0 },
        { accountId: acct["1100"], debit: 0, credit: 10_000 },
      ],
    })) as string;

    // The backfill's reservation now asks for the same counter — and must
    // wait for the posting's lock.
    const t1 = await dbLib.getPool().connect();
    await t1.query("BEGIN");
    const reservation = reserveRange(t1, 3);
    await waitForBlockedBackend("voucher_sequences");
    await posting.query("COMMIT");
    expect(await reservation).toBe(1n); // the range starts after the posting's 1

    await numberLegacyFrom(t1, legacy, 1n);
    await t1.query("COMMIT");
    posting.release();
    t1.release();

    expect(await voucherOf(db, postingEntryId)).toBe("RJ-1404-000001");
    expect(await voucherOf(db, legacy[0])).toBe("RJ-1404-000002");
    expect(await voucherOf(db, legacy[1])).toBe("RJ-1404-000003");
    expect(await voucherOf(db, legacy[2])).toBe("RJ-1404-000004");
    expect(await counterLast()).toBe(4n);
  });

  it("a posting issued while a backfill holds the reserved range commits after it", async () => {
    const legacy = [await rawLegacyEntry(), await rawLegacyEntry(), await rawLegacyEntry()];

    // The backfill holds the counter lock with its reservation committed to
    // neither the database nor the entries.
    const t1 = await dbLib.getPool().connect();
    await t1.query("BEGIN");
    expect(await reserveRange(t1, 3)).toBe(0n); // empty counter: the range is 1..3

    const posted = postConcurrently(); // blocks on the counter row
    await waitForBlockedBackend("voucher_sequences");
    await numberLegacyFrom(t1, legacy, 0n);
    await t1.query("COMMIT");
    t1.release();

    const entryId = await posted;
    expect(await voucherOf(db, entryId)).toBe("RJ-1404-000004");
    expect(await voucherOf(db, legacy[0])).toBe("RJ-1404-000001");
    expect(await voucherOf(db, legacy[1])).toBe("RJ-1404-000002");
    expect(await voucherOf(db, legacy[2])).toBe("RJ-1404-000003");
    expect(await counterLast()).toBe(4n);
  });

  it("two racing backfills never number an entry twice", async () => {
    const legacy = [await rawLegacyEntry(), await rawLegacyEntry(), await rawLegacyEntry(), await rawLegacyEntry()];

    const voucherService = await import("../src/lib/voucher-numbering-service");
    const results = await Promise.all([
      voucherService.backfillVoucherNumbers(biz.id),
      voucherService.backfillVoucherNumbers(biz.id),
    ]);

    // One of the two does the work; the loser's range becomes named gaps.
    // What must hold is that every entry has exactly one number and the two
    // agree on nothing conflicting.
    const unnumbered = (
      await db.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM journal_entries WHERE business_id = $1 AND voucher_number IS NULL",
        [biz.id],
      )
    ).rows[0].n;
    expect(unnumbered).toBe("0");

    const numbers = (
      await db.query<{ voucher_number: string }>(
        "SELECT voucher_number FROM journal_entries WHERE business_id = $1",
        [biz.id],
      )
    ).rows.map((r) => r.voucher_number);
    expect(new Set(numbers).size).toBe(4);
    for (const entryId of legacy) {
      expect(await voucherOf(db, entryId)).not.toBeNull();
    }
    // The counter covers everything that was numbered — no hand-out can ever
    // collide with it again.
    const maxInUse = Math.max(...numbers.map((v) => Number(v.slice(-6))));
    expect(await counterLast()).toBeGreaterThanOrEqual(BigInt(maxInUse));
    expect(results.every((r) => typeof r.backfilled === "number")).toBe(true);
  });

  it("the register's lazy backfill and live postings run together without a 500", async () => {
    const voucherService = await import("../src/lib/voucher-numbering-service");
    for (let i = 0; i < 8; i++) await rawLegacyEntry();

    // Three register reads (each triggering the lazy backfill) racing with
    // five live postings into the same book and year.
    const outcomes = await Promise.allSettled([
      ...Array.from({ length: 3 }, () => voucherService.listVoucherRegister(biz.id)),
      ...Array.from({ length: 5 }, () => postConcurrently()),
    ]);
    const failures = outcomes.filter((o) => o.status === "rejected");
    expect(failures.map((f) => (f as { reason: unknown }).reason)).toEqual([]);

    const unnumbered = (
      await db.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM journal_entries WHERE business_id = $1 AND voucher_number IS NULL",
        [biz.id],
      )
    ).rows[0].n;
    expect(unnumbered).toBe("0");

    const numbers = (
      await db.query<{ voucher_number: string }>(
        "SELECT voucher_number FROM journal_entries WHERE business_id = $1",
        [biz.id],
      )
    ).rows.map((r) => r.voucher_number);
    expect(new Set(numbers).size).toBe(13);
  });
});
