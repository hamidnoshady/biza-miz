/** #1037: schema hardening must not make a fresh backup fail restore checks. */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { validateRestoredDb } from "../src/lib/restore-engine";

const rootUrl = process.env.DATABASE_URL;
if (!rootUrl) throw new Error("DATABASE_URL is required for database integration tests");
const database = `pos_restore_connections_${randomUUID().replaceAll("-", "")}`;
function urlFor(name: string) {
  const url = new URL(rootUrl!);
  url.pathname = `/${name}`;
  return url.toString();
}
const databaseUrl = urlFor(database);
let db: Client;
const constraint = "integration_connections_location_business_fk";
const correction = () => readFileSync("migrations/0234_validate_connection_location_business_fk.sql", "utf8");

async function recreateLegacyConstraint() {
  await db.query(`ALTER TABLE integration_connections DROP CONSTRAINT ${constraint}`);
  await db.query(`ALTER TABLE integration_connections ADD CONSTRAINT ${constraint}
    FOREIGN KEY (location_id, business_id) REFERENCES locations(id, business_id)
    ON DELETE NO ACTION NOT VALID`);
}

beforeAll(async () => {
  const admin = new Client({ connectionString: urlFor("postgres") });
  await admin.connect();
  try { await admin.query(`CREATE DATABASE "${database}"`); }
  finally { await admin.end(); }
  await runMigrations({ databaseUrl, quiet: true });
  db = new Client({ connectionString: databaseUrl });
  await db.connect();
}, 120_000);

afterAll(async () => {
  await db?.end();
  const admin = new Client({ connectionString: urlFor("postgres") });
  await admin.connect();
  try { await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`); }
  finally { await admin.end(); }
});

it("leaves every foreign key validated and passes the actual packaged-restore validator", async () => {
  const { rows } = await db.query("SELECT conname FROM pg_constraint WHERE contype = 'f' AND NOT convalidated");
  expect(rows).toEqual([]);
  await expect(validateRestoredDb(databaseUrl, "fresh-migrated-schema")).resolves.toMatchObject({
    integrity: { encoding: "UTF8" },
  });
});

it("reproduces the 0233 restore rejection, then upgrades without changing the restore safety gate", async () => {
  await recreateLegacyConstraint();
  await expect(validateRestoredDb(databaseUrl, "0233-schema")).rejects.toThrow("restore_contains_unvalidated_foreign_keys");
  await db.query(correction());
  await expect(validateRestoredDb(databaseUrl, "0234-schema")).resolves.toMatchObject({
    integrity: { encoding: "UTF8" },
  });
});

it("refuses inconsistent historical assignments without deleting connections or their audit history", async () => {
  const business = (await db.query("INSERT INTO businesses (name, slug) VALUES ('Restore fixture', $1) RETURNING id", [`restore-${randomUUID()}`])).rows[0].id;
  const other = (await db.query("INSERT INTO businesses (name, slug) VALUES ('Other fixture', $1) RETURNING id", [`other-${randomUUID()}`])).rows[0].id;
  const location = (await db.query("INSERT INTO locations (business_id, name) VALUES ($1, 'Other branch') RETURNING id", [other])).rows[0].id;
  await db.query(`ALTER TABLE integration_connections DROP CONSTRAINT ${constraint}`);
  const connection = (await db.query(`INSERT INTO integration_connections
    (business_id, location_id, name, provider, currency_unit)
    VALUES ($1, $2, 'Historical connection', 'holoo', 'rial') RETURNING id`, [business, location])).rows[0].id;
  await db.query("INSERT INTO integration_audit_log (business_id, connection_id, action) VALUES ($1, $2, 'historical')", [business, connection]);
  await db.query(`ALTER TABLE integration_connections ADD CONSTRAINT ${constraint}
    FOREIGN KEY (location_id, business_id) REFERENCES locations(id, business_id) ON DELETE NO ACTION NOT VALID`);
  await expect(db.query(correction())).rejects.toMatchObject({ code: "23503" });
  expect((await db.query("SELECT location_id FROM integration_connections WHERE id = $1", [connection])).rows[0].location_id).toBe(location);
  expect((await db.query("SELECT action FROM integration_audit_log WHERE connection_id = $1", [connection])).rows).toEqual([{ action: "historical" }]);
  // An operator must repair historical data deliberately; validation never
  // silently moves it, clears its branch or purges its parent/audit records.
  await db.query("DELETE FROM businesses WHERE id = $1", [business]);
  await db.query(correction());
});
