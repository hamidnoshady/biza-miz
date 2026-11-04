import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootUrl = process.env.DATABASE_URL;
if (!rootUrl) throw new Error("DATABASE_URL is required for database integration tests");
const database = `marketing_${randomUUID().replaceAll("-", "")}`;
const urlFor = (name: string) => { const url = new URL(rootUrl!); url.pathname = `/${name}`; return url.toString(); };
let db: Client;
let dbLib: typeof import("../src/lib/db");
let roster: typeof import("../src/lib/marketing-roster-service");
let team: typeof import("../src/lib/team-service");
let a: { id: string; branch: string; user: string };
let b: typeof a;

async function business() {
  const id = (await db.query<{ id: string }>(`INSERT INTO businesses (name, slug, industry) VALUES ('Test', $1, 'accessories') RETURNING id`, [randomUUID()])).rows[0].id;
  const branch = (await db.query<{ id: string }>(`INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id`, [id])).rows[0].id;
  const user = (await db.query<{ id: string }>(`INSERT INTO users (business_id, full_name, role, password_hash, location_id, location_scope) VALUES ($1, 'Member', 'cashier', 'x', $2, 'home') RETURNING id`, [id, branch])).rows[0].id;
  return { id, branch, user };
}

beforeAll(async () => {
  const maintenance = new Client({ connectionString: urlFor("postgres") });
  await maintenance.connect(); await maintenance.query(`CREATE DATABASE "${database}"`); await maintenance.end();
  await runMigrations({ databaseUrl: urlFor(database), quiet: true });
  process.env.DATABASE_URL = urlFor(database);
  dbLib = await import("../src/lib/db"); roster = await import("../src/lib/marketing-roster-service"); team = await import("../src/lib/team-service");
  db = new Client({ connectionString: urlFor(database) }); await db.connect();
  a = await business(); b = await business();
}, 120_000);
afterAll(async () => {
  await db?.end(); await dbLib?.getPool().end(); process.env.DATABASE_URL = rootUrl;
  const maintenance = new Client({ connectionString: urlFor("postgres") });
  await maintenance.connect(); await maintenance.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`); await maintenance.end();
});

describe("marketing roster persistence", () => {
  it("checks branch and staff affinity, scopes lists, prevents duplicates and audits atomically", async () => {
    await dbLib.withTenant(a.id, async () => {
      expect(await roster.createMarketer(a.id, a.user, [a.branch], { locationId: b.branch, kind: "affiliate", name: "x", userId: null })).toBeNull();
      expect(await roster.createMarketer(a.id, a.user, [a.branch], { locationId: a.branch, kind: "employee", name: null, userId: b.user })).toBeNull();
      const created = await roster.createMarketer(a.id, a.user, [a.branch], { locationId: a.branch, kind: "employee", name: null, userId: a.user });
      expect(created?.id).toBeTruthy();
      expect((await team.memberHistoryFlags(a.id, a.user)).records).toBe(true);
      await expect(roster.createMarketer(a.id, a.user, [a.branch], { locationId: a.branch, kind: "employee", name: null, userId: a.user })).rejects.toMatchObject({ code: "23505" });
      expect((await roster.listMarketers(a.id, [], "", 1)).marketers).toHaveLength(0);
      expect((await roster.listMarketers(a.id, [a.branch], "Member", 1)).marketers).toHaveLength(1);
      expect((await roster.listMarketers(a.id, [a.branch], "%", 1)).marketers).toHaveLength(0);
      expect((await dbLib.query(`SELECT id FROM audit_log WHERE business_id = $1 AND action = 'growth.marketer_created'`, [a.id])).rows).toHaveLength(1);
    });
    await dbLib.withTenant(b.id, async () => expect((await roster.listMarketers(b.id, [b.branch], "", 1)).marketers).toHaveLength(0));
    await expect(db.query(`INSERT INTO marketing_agents (business_id, location_id, display_name, kind) VALUES ($1, $2, 'bad', 'affiliate')`, [a.id, b.branch])).rejects.toMatchObject({ code: "23503" });
    await expect(db.query(`INSERT INTO marketing_agents (business_id, location_id, user_id, display_name, kind) VALUES ($1, $2, $3, 'bad', 'employee')`, [a.id, a.branch, b.user])).rejects.toMatchObject({ code: "23503" });
  });
  it("only offers eligible active staff and never accepts a sibling branch", async () => {
    const second = (await db.query<{ id: string }>(`INSERT INTO locations (business_id, name) VALUES ($1, 'Second') RETURNING id`, [a.id])).rows[0].id;
    const member = (await db.query<{ id: string }>(`INSERT INTO users (business_id, full_name, role, password_hash, location_id, location_scope) VALUES ($1, 'Branch member', 'cashier', 'x', $2, 'home') RETURNING id`, [a.id, second])).rows[0].id;
    await dbLib.withTenant(a.id, async () => {
      const picker = await roster.listRosterCandidates(a.id, [a.branch]);
      expect(picker.users.some((u) => u.id === member)).toBe(false);
      expect(await roster.createMarketer(a.id, a.user, [a.branch], { locationId: a.branch, kind: "employee", userId: member, name: null })).toBeNull();
      expect(await roster.createMarketer(a.id, a.user, [a.branch], { locationId: second, kind: "employee", userId: member, name: null })).toBeNull();
      expect((await roster.listRosterCandidates(a.id, [second])).users.some((u) => u.id === member)).toBe(true);
    });
    await db.query(`UPDATE users SET is_active = false WHERE id = $1`, [member]);
    await dbLib.withTenant(a.id, async () => {
      expect(await roster.createMarketer(a.id, a.user, [second], { locationId: second, kind: "employee", userId: member, name: null })).toBeNull();
    });
  });
  it("enforces forced tenant RLS for a non-bypass role", async () => {
    const role = `marketing_test_${randomUUID().replaceAll("-", "")}`;
    await db.query(`CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    try {
      await db.query(`GRANT SELECT, INSERT ON marketing_agents TO "${role}"`);
      await db.query(`SET ROLE "${role}"`);
      await db.query(`SELECT set_config('app.business_id', $1, false)`, [b.id]);
      expect((await db.query(`SELECT id FROM marketing_agents`)).rows).toHaveLength(0);
      await expect(db.query(`INSERT INTO marketing_agents (business_id, location_id, display_name, kind) VALUES ($1, $2, 'bad', 'affiliate')`, [a.id, a.branch])).rejects.toMatchObject({ code: "42501" });
    } finally {
      await db.query(`RESET ROLE`); await db.query(`DROP OWNED BY "${role}"`); await db.query(`DROP ROLE "${role}"`);
    }
  });
});
