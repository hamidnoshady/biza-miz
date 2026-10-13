/**
 * Restricted-role RLS coverage for issue #868 tables.
 *
 * The other dimension integration suites run as the database owner, which
 * BYPASSRLSes: every assertion would pass vacuously. This suite connects as a
 * purpose-created unprivileged role (mirroring tenant-isolation) and proves
 * that RLS on accounting_dimension_settings/values truly isolates businesses.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { createAppRole } from "../scripts/create-app-role";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) throw new Error("DATABASE_URL required");

const APP_ROLE = "pos_dim_rls_role";
const APP_PASSWORD = "dim-rls-password";

let databaseName: string;
let owner: Client;
let app: Client;

function urlFor(db: string, user?: { name: string; password: string }): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${db}`;
  if (user) { url.username = user.name; url.password = user.password; }
  return url.toString();
}
function maintenanceUrl(): string {
  const url = new URL(rootDatabaseUrl!); url.pathname = "/postgres"; return url.toString();
}

async function makeBusiness(name: string): Promise<{ id: string }> {
  const biz = await owner.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ($1,$2) RETURNING id",
    [name, `biz-${randomUUID().slice(0, 8)}`],
  );
  return { id: biz.rows[0].id };
}

async function asTenant<T>(client: Client, businessId: string, fn: () => Promise<T>): Promise<T> {
  await client.query("BEGIN");
  try {
    await client.query(`SET LOCAL app.business_id = '${businessId}'`);
    const r = await fn();
    await client.query("COMMIT");
    return r;
  } catch (e) { await client.query("ROLLBACK").catch(() => {}); throw e; }
}

beforeAll(async () => {
  databaseName = `pos_dim_rls_${randomUUID().replaceAll("-", "")}`;
  const m = new Client({ connectionString: maintenanceUrl() });
  await m.connect();
  try { await m.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`); await m.query(`CREATE DATABASE "${databaseName}"`); }
  finally { await m.end(); }
  await runMigrations({ databaseUrl: urlFor(databaseName) });
  owner = new Client({ connectionString: urlFor(databaseName) });
  await owner.connect();
  await createAppRole({ databaseUrl: urlFor(databaseName), roleName: APP_ROLE, password: APP_PASSWORD });
  app = new Client({ connectionString: urlFor(databaseName, { name: APP_ROLE, password: APP_PASSWORD }) });
  await app.connect();
}, 120_000);

afterAll(async () => {
  await app?.end(); await owner?.end();
  const m = new Client({ connectionString: maintenanceUrl() });
  await m.connect();
  try { await m.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`); await m.query(`DROP ROLE IF EXISTS ${APP_ROLE}`); }
  finally { await m.end(); }
});

beforeEach(async () => {
  await owner.query("DELETE FROM accounting_dimension_values");
  await owner.query("DELETE FROM accounting_dimension_settings");
  await owner.query("DELETE FROM businesses");
});

describe("accounting_dimension_settings RLS under the unprivileged role", () => {
  it("sees only its own business's settings", async () => {
    const a = await makeBusiness("Alpha"); const b = await makeBusiness("Beta");
    await owner.query(
      "INSERT INTO accounting_dimension_settings (business_id, kind, is_enabled) VALUES ($1,'cost_center',true),($2,'cost_center',true)",
      [a.id, b.id],
    );
    const rows = await asTenant(app, a.id, async () => {
      const { rows } = await app.query<{ business_id: string }>(
        "SELECT business_id FROM accounting_dimension_settings WHERE kind='cost_center'",
      );
      return rows;
    });
    expect(rows).toHaveLength(1); expect(rows[0].business_id).toBe(a.id);
  });
  it("blocks INSERT into another business", async () => {
    const a = await makeBusiness("Alpha"); const b = await makeBusiness("Beta");
    await expect(asTenant(app, a.id, () =>
      app.query("INSERT INTO accounting_dimension_settings (business_id, kind, is_enabled) VALUES ($1,'cost_center',true)",[b.id]).then(()=>true),
    )).rejects.toThrow();
  });
});

describe("accounting_dimension_values RLS under the unprivileged role", () => {
  it("reads only its own values", async () => {
    const a = await makeBusiness("Alpha"); const b = await makeBusiness("Beta");
    await owner.query(
      "INSERT INTO accounting_dimension_settings (business_id, kind, is_enabled) VALUES ($1,'cost_center',true),($2,'cost_center',true)",
      [a.id, b.id],
    );
    const aCc = await owner.query<{ id: string }>(
      "INSERT INTO accounting_dimension_values (business_id, kind, code, name) VALUES ($1,'cost_center','CC-A','A') RETURNING id",
      [a.id],
    );
    await owner.query(
      "INSERT INTO accounting_dimension_values (business_id, kind, code, name) VALUES ($1,'cost_center','CC-B','B')",[b.id],
    );
    const rows = await asTenant(app, a.id, async () => {
      const { rows } = await app.query<{ id: string }>("SELECT id FROM accounting_dimension_values WHERE kind='cost_center'");
      return rows;
    });
    expect(rows.map(r => r.id)).toEqual([aCc.rows[0].id]);
  });
  it("cross-business UPDATE hits zero rows", async () => {
    const a = await makeBusiness("Alpha"); const b = await makeBusiness("Beta");
    await owner.query(
      "INSERT INTO accounting_dimension_settings (business_id, kind, is_enabled) VALUES ($1,'cost_center',true),($2,'cost_center',true)",
      [a.id, b.id],
    );
    const bCc = await owner.query<{ id: string }>(
      "INSERT INTO accounting_dimension_values (business_id, kind, code, name) VALUES ($1,'cost_center','CC-B','B') RETURNING id",[b.id],
    );
    const tag = await asTenant(app, a.id, async () => {
      const res = await app.query("UPDATE accounting_dimension_values SET name='stolen' WHERE id=$1",[bCc.rows[0].id]);
      return res.rowCount;
    });
    expect(tag).toBe(0);
    const { rows } = await owner.query<{ name: string }>("SELECT name FROM accounting_dimension_values WHERE id=$1",[bCc.rows[0].id]);
    expect(rows[0].name).toBe("B");
  });
});
