/** Backfill and zero-clock contract for migration 0232 (issue #925). */
import { randomUUID } from "node:crypto";
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) throw new Error("DATABASE_URL is required for database integration tests");
const migrationFile = "0232_product_attribute_master_sync.sql";
let databaseName: string;
let beforeMigrationDir: string;
let finalMigrationDir: string;
let exactDefinitionId: string;

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

async function maintenance<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = "/postgres";
  const client = new Client({ connectionString: url.toString() });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

beforeAll(async () => {
  databaseName = `pos_attr_mig_${randomUUID().replaceAll("-", "")}`;
  beforeMigrationDir = mkdtempSync(join(tmpdir(), "biza-miz-migrations-before-0232-"));
  finalMigrationDir = mkdtempSync(join(tmpdir(), "biza-miz-migration-0232-"));
  const files = readdirSync(join(process.cwd(), "migrations")).filter((file) => /^\d{4}_.+\.sql$/.test(file)).sort();
  for (const file of files.filter((entry) => entry < migrationFile)) {
    copyFileSync(join(process.cwd(), "migrations", file), join(beforeMigrationDir, file));
  }
  copyFileSync(join(process.cwd(), "migrations", migrationFile), join(finalMigrationDir, migrationFile));

  await maintenance((client) => client.query(`CREATE DATABASE "${databaseName}"`));
  await runMigrations({ databaseUrl: urlFor(databaseName), migrationsDir: beforeMigrationDir, quiet: true });

  const client = new Client({ connectionString: urlFor(databaseName) });
  await client.connect();
  try {
    await client.query("SELECT set_config('app.rls_bypass', 'on', false)");
    const business = await client.query<{ id: string }>(
      "INSERT INTO businesses (name, slug) VALUES ('Attribute backfill', $1) RETURNING id",
      [`attr-backfill-${randomUUID().slice(0, 8)}`],
    );
    const location = await client.query<{ id: string }>(
      "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
      [business.rows[0].id],
    );
    exactDefinitionId = randomUUID();
    const definitionDiacriticId = randomUUID();
    await client.query(
      "INSERT INTO item_attribute_definitions (id, location_id, name, options) VALUES ($1, $2, 'رنگ', ARRAY['قرمز']), ($3, $2, 'رَنگ', ARRAY['آبی'])",
      [exactDefinitionId, location.rows[0].id, definitionDiacriticId],
    );
    const parentId = randomUUID();
    const childOneId = randomUUID();
    const childTwoId = randomUUID();
    await client.query(
      "INSERT INTO items (id, location_id, name, kind) VALUES ($1, $2, 'پوشاک', 'variant_parent')",
      [parentId, location.rows[0].id],
    );
    await client.query(
      "INSERT INTO items (id, location_id, parent_item_id, name, kind) VALUES ($1, $3, $4, 'قرمز', 'variant_child'), ($2, $3, $4, 'قدیمی', 'variant_child')",
      [childOneId, childTwoId, location.rows[0].id, parentId],
    );
    await client.query(
      "INSERT INTO item_variant_attributes (item_id, name, value) VALUES ($1, 'رنگ', 'قرمز'), ($2, ' رنگ ', 'قدیمی')",
      [childOneId, childTwoId],
    );
  } finally {
    await client.end();
  }

  // Apply only the new forward migration after legacy, unlinked rows exist.
  await runMigrations({ databaseUrl: urlFor(databaseName), migrationsDir: finalMigrationDir, quiet: true });
}, 240_000);

afterAll(async () => {
  if (databaseName) {
    await maintenance((client) => client.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`));
  }
  if (beforeMigrationDir) rmSync(beforeMigrationDir, { recursive: true, force: true });
  if (finalMigrationDir) rmSync(finalMigrationDir, { recursive: true, force: true });
});

describe("migration 0232 product-attribute backfill", () => {
  it("links only an exact same-branch definition and gives legacy rows zero-clock feed positions", async () => {
    const client = new Client({ connectionString: urlFor(databaseName) });
    await client.connect();
    try {
      const rows = await client.query<{
        name: string;
        value: string;
        attribute_definition_id: string | null;
        row_id: string;
        row_hlc: string;
        table_name: string;
      }>(
        `SELECT a.name, a.value, a.attribute_definition_id::text,
                c.row_id, c.row_hlc, c.table_name
           FROM item_variant_attributes a
           JOIN items i ON i.id = a.item_id
           JOIN sync_row_clocks c ON c.business_id = (SELECT business_id FROM locations WHERE id = i.location_id)
                                  AND c.table_name = 'item_variant_attributes'
                                  AND c.row_id = a.id::text
          ORDER BY a.value`,
      );
      expect(rows.rows).toHaveLength(2);
      expect(rows.rows.find((row) => row.value === "قرمز")?.attribute_definition_id).toBe(exactDefinitionId);
      expect(rows.rows.find((row) => row.value === "قدیمی")?.attribute_definition_id).toBeNull();
      expect(rows.rows.every((row) => row.row_hlc === "000000000000000.000000000000000.")).toBe(true);

      const definitionClocks = await client.query<{ row_id: string; row_hlc: string }>(
        `SELECT c.row_id, c.row_hlc
           FROM sync_row_clocks c
          WHERE c.table_name = 'item_attribute_definitions'
            AND c.row_id IN (SELECT id::text FROM item_attribute_definitions)` ,
      );
      expect(definitionClocks.rows).toHaveLength(2);
      expect(definitionClocks.rows.every((row) => row.row_hlc === "000000000000000.000000000000000.")).toBe(true);
      const version = await client.query<{ version: number }>("SELECT min(version)::int AS version FROM item_attribute_definitions");
      expect(version.rows[0].version).toBe(1);
    } finally {
      await client.end();
    }
  });
});
