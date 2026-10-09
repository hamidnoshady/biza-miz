/**
 * Upgrading a tenant that already has duplicate cheques — issue #828 (7).
 *
 * Migration 0217 introduced canonical instrument identity, but could only make
 * the index UNIQUE when the existing rows happened to allow it; a tenant that
 * had typed the same cheque twice got a plain index and, with it, no identity
 * rule at all, forever. 0218 is the forward migration that fixes that, and
 * \"does it actually work on dirty data\" is not a question a fresh schema can
 * answer — so this file builds the dirty data on 0217's schema and then runs
 * 0218 over it, exactly as a real upgrade would.
 */
import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

const UPGRADE_MIGRATION = "0218_cheque_identity_collisions_and_fingerprints.sql";

let databaseName: string;
let db: Client;
let work: string;
let partial: string;
let businessId: string;
let locationId: string;

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

/** A cheque written straight into the table, the way a legacy row got there. */
async function insertRaw(serial: string, bank: string, createdAt: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO cheques (business_id, location_id, direction, status, serial_number, bank_name,
                          amount, issue_date, due_date, counterparty_name, created_at)
     VALUES ($1, $2, 'receivable', 'on_hand', $3, $4, 1000000, '2026-01-01', '2026-03-01', 'مشتری', $5)
     RETURNING id`,
    [businessId, locationId, serial, bank, createdAt],
  );
  return rows[0].id;
}

beforeAll(async () => {
  databaseName = `pos_cheque_upgrade_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  // A migrations directory frozen just before the upgrade under test.
  work = await mkdtemp(join(tmpdir(), "cheque-upgrade-"));
  partial = join(work, "migrations");
  await cp(join(process.cwd(), "migrations"), partial, { recursive: true });
  const present = await readdir(partial);
  expect(present).toContain(UPGRADE_MIGRATION);
  await rm(join(partial, UPGRADE_MIGRATION));

  await runMigrations({ databaseUrl: urlFor(databaseName), migrationsDir: partial, quiet: true });

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();

  const business = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ('کسب‌وکار قدیمی', $1) RETURNING id",
    [`legacy-${randomUUID().slice(0, 8)}`],
  );
  businessId = business.rows[0].id;
  // Reproduce the state 0217 leaves a dirty tenant in: it only creates the
  // UNIQUE index when the data allows it, and falls back to a plain index
  // otherwise. A fresh database has no duplicates, so the fallback has to be
  // re-created here before the duplicates can exist at all.
  await db.query("DROP INDEX uq_cheques_canonical_serial");
  await db.query(
    `CREATE INDEX uq_cheques_canonical_serial
       ON cheques (business_id, bank_name_canonical, serial_number_canonical)`,
  );

  const location = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'شعبه') RETURNING id",
    [businessId],
  );
  locationId = location.rows[0].id;
}, 180_000);

afterAll(async () => {
  await db?.end();
  await rm(work, { recursive: true, force: true });
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

describe("a tenant that already typed the same cheque twice", () => {
  it("upgrades: the legacy pair is kept and classified, and new duplicates are refused", async () => {
    // Three spellings of one instrument, plus an unrelated cheque. On 0217's
    // schema these all coexist, which is what made the index non-unique.
    const first = await insertRaw("123456", "ملت", "2025-01-01T08:00:00Z");
    const second = await insertRaw("۱۲۳-۴۵۶", "بانک ملت", "2025-02-01T08:00:00Z");
    const third = await insertRaw("123 456", "بانك ملت", "2025-03-01T08:00:00Z");
    const unrelated = await insertRaw("999999", "صادرات", "2025-04-01T08:00:00Z");

    const before = await db.query<{ indisunique: boolean }>(
      "SELECT indisunique FROM pg_index WHERE indexrelid = 'uq_cheques_canonical_serial'::regclass",
    );
    expect(before.rows[0].indisunique).toBe(false);

    await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });

    // Nothing was deleted or rewritten: all four financial records survive.
    const kept = await db.query<{ count: string }>("SELECT count(*)::text AS count FROM cheques");
    expect(kept.rows[0].count).toBe("4");

    // The earliest row is the canonical one; the later two say which row they
    // duplicate, so the collision is recorded rather than merely tolerated.
    const classified = await db.query<{ id: string; canonical_duplicate_of: string | null }>(
      "SELECT id, canonical_duplicate_of FROM cheques ORDER BY created_at",
    );
    expect(classified.rows).toEqual([
      { id: first, canonical_duplicate_of: null },
      { id: second, canonical_duplicate_of: first },
      { id: third, canonical_duplicate_of: first },
      { id: unrelated, canonical_duplicate_of: null },
    ]);

    const after = await db.query<{ indisunique: boolean }>(
      "SELECT indisunique FROM pg_index WHERE indexrelid = 'uq_cheques_canonical_serial'::regclass",
    );
    expect(after.rows[0].indisunique).toBe(true);

    // And the point of the whole exercise: a *new* write of that same
    // instrument is refused, even though the tenant's history contains it
    // three times.
    await expect(insertRaw("۱۲۳-۴۵۶", "ملت ", "2026-01-01T08:00:00Z")).rejects.toMatchObject({
      code: "23505",
    });

    // A different instrument is unaffected.
    await expect(insertRaw("777777", "ملت", "2026-01-02T08:00:00Z")).resolves.toBeTruthy();
  }, 180_000);

  it("keeps the classification out of the application's reach", async () => {
    const { rows } = await db.query<{ id: string }>(
      "SELECT id FROM cheques WHERE canonical_duplicate_of IS NULL LIMIT 1",
    );
    await expect(
      db.query(
        `INSERT INTO cheques (business_id, location_id, direction, status, serial_number, bank_name,
                              amount, issue_date, due_date, counterparty_name, canonical_duplicate_of)
         VALUES ($1, $2, 'receivable', 'on_hand', 'NEW-1', 'ملت', 1000, '2026-01-01', '2026-02-01', 'مشتری', $3)`,
        [businessId, locationId, rows[0].id],
      ),
    ).rejects.toThrow(/legacy canonical duplicate/);
  });
});
