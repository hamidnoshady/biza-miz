/**
 * #1446 — repair of legacy orders that carry a checkout key without the
 * request fingerprint the pairing constraint expects.
 *
 * Migration 0233 added `orders_client_request_pairing` as `NOT VALID` so the
 * rows already in production would not block the deploy. PostgreSQL still
 * enforces such a constraint on UPDATE, so every later write to one of those
 * legacy orders (`order.state.synced` replay, payment, void) fails with 23514.
 * This test builds that exact shape, proves the write fails, then applies
 * 0321 and proves the same row can be updated again without losing the key.
 */
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

const migrationsDirectory = join(process.cwd(), "migrations");
const REPAIR_MIGRATION = "0321_orders_client_request_pairing_repair.sql";
const PAIRING_CONSTRAINT = "orders_client_request_pairing";

let databaseName: string;
let db: Client;
let migrationsDir: string;
let locationId: string;
let legacyOrderId: string;
let pairedOrderId: string;
let orphanFingerprintOrderId: string;

const legacyKey = randomUUID();
const pairedKey = randomUUID();
const pairedFingerprint = "a".repeat(64);

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

async function copyMigrations(includeRepair: boolean): Promise<void> {
  const files = readdirSync(migrationsDirectory)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .filter((name) => includeRepair || name !== REPAIR_MIGRATION)
    .sort();
  for (const name of files) {
    await copyFile(join(migrationsDirectory, name), join(migrationsDir, name));
  }
}

async function insertOrder(
  orderNumber: number,
  values: { clientRequestId?: string | null; requestFingerprint?: string | null },
): Promise<string> {
  const id = randomUUID();
  await db.query(
    `INSERT INTO orders
       (id, location_id, order_number, client_request_id, request_fingerprint)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, locationId, orderNumber, values.clientRequestId ?? null, values.requestFingerprint ?? null],
  );
  return id;
}

async function pairingValidated(): Promise<boolean> {
  const { rows } = await db.query<{ convalidated: boolean }>(
    `SELECT convalidated FROM pg_constraint
      WHERE conrelid = 'orders'::regclass AND conname = $1`,
    [PAIRING_CONSTRAINT],
  );
  return rows[0]?.convalidated === true;
}

beforeAll(async () => {
  databaseName = `pos_orders_pairing_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  migrationsDir = await mkdtemp(join(tmpdir(), "pos-orders-pairing-"));
  await copyMigrations(false);
  await runMigrations({ databaseUrl: urlFor(databaseName), migrationsDir, quiet: true });

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();

  const businessId = randomUUID();
  await db.query(`INSERT INTO businesses (id, name, slug) VALUES ($1, $2, $3)`, [
    businessId,
    "کسب‌وکار آزمون",
    `pairing-${businessId.slice(0, 8)}`,
  ]);
  locationId = randomUUID();
  await db.query(`INSERT INTO locations (id, business_id, name) VALUES ($1, $2, $3)`, [
    locationId,
    businessId,
    "شعبه آزمون",
  ]);

  // Reproduce the pre-0233 rows: drop the (unvalidated) constraint, write the
  // legacy shapes, then restore it `NOT VALID` exactly as the deploy left it.
  await db.query(`ALTER TABLE orders DROP CONSTRAINT ${PAIRING_CONSTRAINT}`);
  legacyOrderId = await insertOrder(1, { clientRequestId: legacyKey });
  pairedOrderId = await insertOrder(2, {
    clientRequestId: pairedKey,
    requestFingerprint: pairedFingerprint,
  });
  orphanFingerprintOrderId = await insertOrder(3, { requestFingerprint: pairedFingerprint });
  await db.query(
    `ALTER TABLE orders ADD CONSTRAINT ${PAIRING_CONSTRAINT}
       CHECK ((client_request_id IS NULL) = (request_fingerprint IS NULL)) NOT VALID`,
  );

  // The defect: the legacy row cannot be written to at all.
  await expect(db.query(`UPDATE orders SET total = 1 WHERE id = $1`, [legacyOrderId])).rejects
    .toMatchObject({ code: "23514" });

  await copyMigrations(true);
  await runMigrations({ databaseUrl: urlFor(databaseName), migrationsDir, quiet: true });
}, 180_000);

afterAll(async () => {
  await db?.end();
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
  await rm(migrationsDir, { recursive: true, force: true });
});

describe("0321 orders client-request pairing repair", () => {
  it("keeps the legacy key and gives it a deterministic placeholder fingerprint", async () => {
    const { rows } = await db.query<{
      client_request_id: string | null;
      request_fingerprint: string | null;
    }>(
      `SELECT client_request_id, request_fingerprint FROM orders WHERE id = $1`,
      [legacyOrderId],
    );
    expect(rows[0]?.client_request_id).toBe(legacyKey);
    expect(rows[0]?.request_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]?.request_fingerprint).not.toBe(pairedFingerprint);
  });

  it("clears an orphan fingerprint that has no key", async () => {
    const { rows } = await db.query<{
      client_request_id: string | null;
      request_fingerprint: string | null;
    }>(
      `SELECT client_request_id, request_fingerprint FROM orders WHERE id = $1`,
      [orphanFingerprintOrderId],
    );
    expect(rows[0]?.client_request_id).toBeNull();
    expect(rows[0]?.request_fingerprint).toBeNull();
  });

  it("leaves a properly paired order untouched", async () => {
    const { rows } = await db.query<{
      client_request_id: string | null;
      request_fingerprint: string | null;
    }>(
      `SELECT client_request_id, request_fingerprint FROM orders WHERE id = $1`,
      [pairedOrderId],
    );
    expect(rows[0]?.client_request_id).toBe(pairedKey);
    expect(rows[0]?.request_fingerprint).toBe(pairedFingerprint);
  });

  it("lets the previously blocked order be updated again", async () => {
    await expect(
      db.query(`UPDATE orders SET total = 1 WHERE id = $1`, [legacyOrderId]),
    ).resolves.toBeDefined();
  });

  it("validates the constraint and stays idempotent when the repair runs twice", async () => {
    expect(await pairingValidated()).toBe(true);

    const sql = readFileSync(join(migrationsDirectory, REPAIR_MIGRATION), "utf8");
    await db.query(sql);

    const { rows } = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM orders
        WHERE (client_request_id IS NULL) <> (request_fingerprint IS NULL)`,
    );
    expect(rows[0]?.count).toBe("0");
    expect(await pairingValidated()).toBe(true);
  });
});
