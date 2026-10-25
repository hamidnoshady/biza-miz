/**
 * Issue #916 follow-up — 0238_floor_table_management_audit.sql failed the
 * deploy on any database holding a circular table:
 *
 *   check constraint "dining_tables_shape_check" of relation "dining_tables"
 *   is violated by some row
 *
 * Since 0004 the constraint allowed only ('rect', 'circle') and every writer
 * stored 'circle'; 0238 narrowed it to ('rect', 'round', 'square', 'booth')
 * without converting rows. 0238_dining_table_shape_normalise.sql sorts before
 * it and does the conversion. This replays the production state — the legacy
 * constraint, circle rows — and runs both files in the runner's order.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) throw new Error("DATABASE_URL is required for database integration tests");
const ROOT_DATABASE_URL: string = rootDatabaseUrl;

let databaseName: string;
let db: Client;

function urlFor(dbName: string): string {
  const url = new URL(ROOT_DATABASE_URL);
  url.pathname = `/${dbName}`;
  return url.toString();
}

function migration(filename: string): string {
  return readFileSync(join(__dirname, "..", "migrations", filename), "utf8");
}

const NORMALISE = "0238_dining_table_shape_normalise.sql";
const FLOOR_AUDIT = "0238_floor_table_management_audit.sql";

async function constraintDef(): Promise<string> {
  const { rows } = await db.query<{ def: string }>(
    "SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'dining_tables_shape_check'",
  );
  return rows[0].def;
}

async function shapes(): Promise<Record<string, string>> {
  const { rows } = await db.query<{ name: string; shape: string }>(
    "SELECT name, shape FROM dining_tables ORDER BY name",
  );
  return Object.fromEntries(rows.map((r) => [r.name, r.shape]));
}

beforeAll(async () => {
  databaseName = `pos_table_shape_${randomUUID().replaceAll("-", "")}`;
  const maintenanceUrl = new URL(ROOT_DATABASE_URL);
  maintenanceUrl.pathname = "/postgres";
  const maintenance = new Client({ connectionString: maintenanceUrl.toString() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }
  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });
  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
}, 120_000);

afterAll(async () => {
  await db?.end();
  const maintenanceUrl = new URL(ROOT_DATABASE_URL);
  maintenanceUrl.pathname = "/postgres";
  const maintenance = new Client({ connectionString: maintenanceUrl.toString() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

describe("dining_tables.shape normalisation (0238)", () => {
  it("converts legacy 'circle' rows so the narrowed constraint can be added", async () => {
    const biz = await db.query<{ id: string }>(
      "INSERT INTO businesses (name, slug) VALUES ('Shape', 'shape-biz') RETURNING id",
    );
    const loc = await db.query<{ id: string }>(
      "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
      [biz.rows[0].id],
    );

    // Production before 0238: the 0004 constraint and circular tables.
    await db.query("ALTER TABLE dining_tables DROP CONSTRAINT dining_tables_shape_check");
    await db.query(
      "ALTER TABLE dining_tables ADD CONSTRAINT dining_tables_shape_check CHECK (shape IN ('rect', 'circle'))",
    );
    await db.query(
      `INSERT INTO dining_tables (location_id, name, shape) VALUES
         ($1, 'A-round', 'circle'), ($1, 'B-rect', 'rect'), ($1, 'C-round', 'circle')`,
      [loc.rows[0].id],
    );

    // Without the normalising file the original statement is the reported failure.
    await expect(db.query(migration(FLOOR_AUDIT))).rejects.toThrow(/dining_tables_shape_check/);

    await db.query(migration(NORMALISE));
    await db.query(migration(FLOOR_AUDIT));

    expect(await shapes()).toEqual({ "A-round": "round", "B-rect": "rect", "C-round": "round" });
    expect(await constraintDef()).toMatch(/rect.*round.*square.*booth/);
  });

  it("is a harmless re-run on a database that already has the narrowed constraint", async () => {
    const before = await shapes();
    await db.query(migration(NORMALISE));
    expect(await shapes()).toEqual(before);
    expect(await constraintDef()).toMatch(/rect.*round.*square.*booth/);
    await expect(
      db.query("UPDATE dining_tables SET shape = 'circle' WHERE name = 'B-rect'"),
    ).rejects.toThrow(/dining_tables_shape_check/);
  });
});
