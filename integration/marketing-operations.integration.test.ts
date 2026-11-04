import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
const root = process.env.DATABASE_URL;
if (!root) throw new Error("DATABASE_URL is required for database integration tests");
const database = `marketing_ops_${randomUUID().replaceAll("-", "")}`;
const urlFor = (name: string) => { const url = new URL(root!); url.pathname = `/${name}`; return url.toString(); };
let db: Client;
let dbLib: typeof import("../src/lib/db");
let ops: typeof import("../src/lib/marketing-operations-service");
let roster: typeof import("../src/lib/marketing-roster-service");
let a: { id: string; branch: string; user: string; party: string };
let b: typeof a;
async function business() {
  const id = (await db.query<{ id: string }>(`INSERT INTO businesses (name,slug,industry) VALUES ('Test',$1,'accessories') RETURNING id`, [randomUUID()])).rows[0].id;
  const branch = (await db.query<{ id: string }>(`INSERT INTO locations (business_id,name) VALUES ($1,'Main') RETURNING id`, [id])).rows[0].id;
  const user = (await db.query<{ id: string }>(`INSERT INTO users (business_id,full_name,role,password_hash,location_id,location_scope) VALUES ($1,'Member','cashier','x',$2,'home') RETURNING id`, [id,branch])).rows[0].id;
  const party = (await db.query<{ id: string }>(`INSERT INTO parties (business_id,name,role,roles) VALUES ($1,'Customer','customer',ARRAY['customer']::text[]) RETURNING id`, [id])).rows[0].id;
  return { id, branch, user, party };
}
beforeAll(async () => {
  const c = new Client({ connectionString: urlFor("postgres") }); await c.connect(); await c.query(`CREATE DATABASE "${database}"`); await c.end();
  await runMigrations({ databaseUrl: urlFor(database), quiet: true }); process.env.DATABASE_URL = urlFor(database);
  dbLib = await import("../src/lib/db"); ops = await import("../src/lib/marketing-operations-service"); roster = await import("../src/lib/marketing-roster-service");
  db = new Client({ connectionString: urlFor(database) }); await db.connect(); a = await business(); b = await business();
}, 120_000);
afterAll(async () => {
  await db?.end(); await dbLib?.getPool().end(); process.env.DATABASE_URL = root;
  const c = new Client({ connectionString: urlFor("postgres") }); await c.connect(); await c.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`); await c.end();
});

describe("marketing targets and assignments", () => {
  it("enforces party and branch affinity, audit, unique open work and atomic state transitions", async () => {
    const targetInput = { locationId: a.branch, partyId: a.party, siteLabel: "Site", city: "City", neighborhood: "" };
    await dbLib.withTenant(a.id, async () => {
      expect(await ops.createTarget(a.id, a.user, [], targetInput)).toBeNull();
      expect(await ops.createTarget(a.id, a.user, [a.branch], { ...targetInput, partyId: b.party })).toBeNull();
      const target = await ops.createTarget(a.id, a.user, [a.branch], targetInput);
      const agent = await roster.createMarketer(a.id, a.user, [a.branch], { locationId: a.branch, userId: a.user, name: null, kind: "employee" });
      expect(target).not.toBeNull(); expect(agent).not.toBeNull();
      const input = { locationId: a.branch, targetId: target!.id, agentId: agent!.id, title: "Call", dueDate: "2026-11-05" };
      expect(await ops.createAssignment(a.id, a.user, [], input)).toBeNull();
      expect(await ops.createAssignment(a.id, a.user, [a.branch], { ...input, locationId: b.branch })).toBeNull();
      const task = await ops.createAssignment(a.id, a.user, [a.branch], input);
      expect(task).not.toBeNull();
      await expect(ops.createAssignment(a.id, a.user, [a.branch], input)).rejects.toMatchObject({ code: "23505", constraint: "marketing_assignments_one_open" });
      expect((await ops.listTargets(a.id, [], "", 1)).targets).toHaveLength(0);
      expect((await ops.listAssignments(a.id, [a.branch], "%", 1)).assignments).toHaveLength(0);
      expect((await ops.assignmentOptions(a.id, [a.branch], b.branch)).agents).toHaveLength(0);
      expect((await ops.assignmentOptions(a.id, [a.branch], a.branch)).agents.map((x) => x.id)).toContain(agent!.id);
      await db.query(`UPDATE users SET location_scope='none' WHERE id=$1`, [a.user]);
      expect((await ops.assignmentOptions(a.id, [a.branch], a.branch)).agents).toHaveLength(0);
      expect(await ops.createAssignment(a.id, a.user, [a.branch], input)).toBeNull();
      await db.query(`UPDATE users SET location_scope='home' WHERE id=$1`, [a.user]);
      const results = await Promise.all([
        ops.transitionAssignment(a.id, a.user, [a.branch], task!.id, "planned", "completed"),
        ops.transitionAssignment(a.id, a.user, [a.branch], task!.id, "planned", "canceled"),
      ]);
      expect(results.sort()).toEqual(["conflict", "updated"]);
      expect(await ops.transitionAssignment(a.id, a.user, [a.branch], task!.id, "completed", "planned")).toBe("invalid");
      expect(await ops.transitionAssignment(a.id, a.user, [], task!.id, "planned", "completed")).toBe("not_found");
      expect((await dbLib.query(`SELECT action FROM audit_log WHERE business_id=$1 AND action LIKE 'growth.marketing_%'`,[a.id])).rows).toHaveLength(3);
      expect(await ops.createAssignment(a.id, a.user, [a.branch], input)).not.toBeNull();
    });
    await expect(db.query(`INSERT INTO marketing_targets (business_id,location_id,party_id,site_label) VALUES ($1,$2,$3,'Bad')`, [a.id,a.branch,b.party])).rejects.toMatchObject({ code: "23503" });
    const otherBranch = (await db.query<{ id: string }>(`INSERT INTO locations (business_id,name) VALUES ($1,'Other') RETURNING id`, [a.id])).rows[0].id;
    const target = (await db.query<{ id: string }>(`SELECT id FROM marketing_targets WHERE business_id=$1 LIMIT 1`,[a.id])).rows[0].id;
    const agent = (await db.query<{ id: string }>(`SELECT id FROM marketing_agents WHERE business_id=$1 LIMIT 1`,[a.id])).rows[0].id;
    await expect(db.query(`INSERT INTO marketing_assignments (business_id,location_id,target_id,agent_id,title,status) VALUES ($1,$2,$3,$4,'Bad','completed')`,[a.id,otherBranch,target,agent])).rejects.toMatchObject({ code: "23503" });
  });
  it("rolls the target back if its audit entry fails", async () => {
    await db.query(`CREATE FUNCTION reject_marketing_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'growth.marketing_target_created' THEN RAISE EXCEPTION 'audit unavailable'; END IF; RETURN NEW; END $$`);
    await db.query(`CREATE TRIGGER reject_marketing_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_marketing_audit()`);
    try {
      await dbLib.withTenant(a.id, async () => {
        await expect(ops.createTarget(a.id, a.user, [a.branch], { locationId: a.branch, partyId: null, siteLabel: "Rollback site", city: "", neighborhood: "" })).rejects.toThrow("audit unavailable");
        expect((await ops.listTargets(a.id, [a.branch], "Rollback site", 1)).targets).toHaveLength(0);
      });
    } finally {
      await db.query(`DROP TRIGGER reject_marketing_audit ON audit_log`);
      await db.query(`DROP FUNCTION reject_marketing_audit()`);
    }
  });
  it("forces tenant isolation on both new tables", async () => {
    const role = `marketing_ops_${randomUUID().replaceAll("-", "")}`;
    await db.query(`CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    try {
      await db.query(`GRANT SELECT, INSERT ON marketing_targets, marketing_assignments TO "${role}"`);
      await db.query(`SET ROLE "${role}"`); await db.query(`SELECT set_config('app.business_id',$1,false)`,[b.id]);
      expect((await db.query(`SELECT id FROM marketing_targets`)).rows).toHaveLength(0);
      expect((await db.query(`SELECT id FROM marketing_assignments`)).rows).toHaveLength(0);
      await expect(db.query(`INSERT INTO marketing_targets (business_id,location_id,site_label) VALUES ($1,$2,'Bad')`,[a.id,a.branch])).rejects.toMatchObject({ code: "42501" });
    } finally { await db.query(`RESET ROLE`); await db.query(`DROP OWNED BY "${role}"`); await db.query(`DROP ROLE "${role}"`); }
  });
});
