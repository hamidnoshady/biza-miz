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
  it("edits, archives and restores only scoped targets without stranding open work", async () => {
    const own = await business(); const otherBranch = (await db.query<{ id: string }>(`INSERT INTO locations (business_id,name) VALUES ($1,'Other') RETURNING id`, [own.id])).rows[0].id;
    await dbLib.withTenant(own.id, async () => {
      const target = (await ops.createTarget(own.id,own.user,[own.branch],{ locationId: own.branch, partyId: own.party, siteLabel: "Initial", city: "", neighborhood: "" }))!;
      const agent = (await roster.createMarketer(own.id,own.user,[own.branch],{ locationId: own.branch, userId: own.user, name: null, kind: "employee" }))!;
      const edit = { action: "edit", expectedRevision: 0, siteLabel: "New", city: "City", neighborhood: "Area" } as const;
      expect(await ops.changeTarget(own.id,own.user,[otherBranch],target.id,edit)).toBe("not_found");
      expect(await ops.changeTarget(own.id,own.user,[],target.id,edit)).toBe("not_found");
      expect(await dbLib.withTenant(b.id, () => ops.changeTarget(b.id,b.user,[b.branch],target.id,edit))).toBe("not_found");
      const concurrent = await Promise.all([ops.changeTarget(own.id,own.user,[own.branch],target.id,edit), ops.changeTarget(own.id,own.user,[own.branch],target.id,edit)]);
      expect(concurrent.sort()).toEqual(["conflict", "updated"]);
      const row = (await db.query(`SELECT party_id, location_id, site_label, revision FROM marketing_targets WHERE id=$1`, [target.id])).rows[0];
      expect(row).toMatchObject({ party_id: own.party, location_id: own.branch, site_label: "New", revision: 1 });
      const input = { locationId: own.branch, targetId: target.id, agentId: agent.id, title: "Work", dueDate: null };
      const task = (await ops.createAssignment(own.id,own.user,[own.branch],input))!;
      expect(await ops.changeTarget(own.id,own.user,[own.branch],target.id,{ action: "archive", expectedRevision: 1 })).toBe("open_assignments");
      expect(await ops.transitionAssignment(own.id,own.user,[own.branch],task.id,"planned","completed")).toBe("updated");
      expect(await ops.changeTarget(own.id,own.user,[own.branch],target.id,{ action: "archive", expectedRevision: 0 })).toBe("conflict");
      expect(await ops.changeTarget(own.id,own.user,[own.branch],target.id,{ action: "archive", expectedRevision: 1 })).toBe("updated");
      expect((await ops.listTargets(own.id,[own.branch],"New",1)).targets).toHaveLength(0);
      expect((await ops.listTargets(own.id,[own.branch],"New",1,"archived")).targets).toHaveLength(1);
      expect(await ops.createAssignment(own.id,own.user,[own.branch],input)).toBeNull();
      expect(await ops.changeTarget(own.id,own.user,[own.branch],target.id,{ action: "edit", expectedRevision: 2, siteLabel: "x", city: "", neighborhood: "" })).toBe("conflict");
      expect(await ops.changeTarget(own.id,own.user,[own.branch],target.id,{ action: "restore", expectedRevision: 2 })).toBe("updated");
      expect(await ops.createAssignment(own.id,own.user,[own.branch],input)).not.toBeNull();
      expect((await dbLib.query(`SELECT id FROM audit_log WHERE business_id=$1 AND action='growth.marketing_target_changed'`,[own.id])).rows).toHaveLength(3);
      await db.query(`UPDATE locations SET is_active=false WHERE id=$1`,[own.branch]);
      expect(await ops.changeTarget(own.id,own.user,[own.branch],target.id,{ action: "archive", expectedRevision: 3 })).toBe("not_found");
    });
  });
  it("serializes archive and assignment creation and rolls back on audit failure", async () => {
    const own = await business();
    await dbLib.withTenant(own.id, async () => {
      const agent = (await roster.createMarketer(own.id,own.user,[own.branch],{ locationId: own.branch, userId: own.user, name: null, kind: "employee" }))!;
      for (let n=0; n<5; n++) {
        const target = (await ops.createTarget(own.id,own.user,[own.branch],{ locationId: own.branch, partyId: null, siteLabel: `Race ${n}`, city: "", neighborhood: "" }))!;
        const input = { locationId: own.branch, targetId: target.id, agentId: agent.id, title: "Race", dueDate: null };
        const [archive, task] = await Promise.all([ops.changeTarget(own.id,own.user,[own.branch],target.id,{ action: "archive", expectedRevision: 0 }), ops.createAssignment(own.id,own.user,[own.branch],input)]);
        if (archive === "updated") expect(task).toBeNull();
        else { expect(archive).toBe("open_assignments"); expect(task).not.toBeNull(); }
        const state = (await db.query(`SELECT t.status, count(a.id)::int AS open FROM marketing_targets t LEFT JOIN marketing_assignments a ON a.target_id=t.id AND a.status IN ('planned','in_progress') WHERE t.id=$1 GROUP BY t.id`,[target.id])).rows[0];
        expect(state.status === "archived" && state.open > 0).toBe(false);
      }
      const target = (await ops.createTarget(own.id,own.user,[own.branch],{ locationId: own.branch, partyId: null, siteLabel: "Rollback", city: "", neighborhood: "" }))!;
      await db.query(`CREATE FUNCTION reject_target_change_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'growth.marketing_target_changed' THEN RAISE EXCEPTION 'audit unavailable'; END IF; RETURN NEW; END $$`);
      await db.query(`CREATE TRIGGER reject_target_change_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_target_change_audit()`);
      try {
        await expect(ops.changeTarget(own.id,own.user,[own.branch],target.id,{ action: "archive", expectedRevision: 0 })).rejects.toThrow("audit unavailable");
        expect((await db.query(`SELECT status, revision FROM marketing_targets WHERE id=$1`,[target.id])).rows[0]).toEqual({ status: "active", revision: 0 });
      } finally { await db.query(`DROP TRIGGER reject_target_change_audit ON audit_log`); await db.query(`DROP FUNCTION reject_target_change_audit()`); }
    });
  });
  it("paginates and searches active assignment options beyond the old 500-item limit", async () => {
    const own = await business();
    await db.query(`INSERT INTO marketing_targets (business_id,location_id,site_label) SELECT $1,$2,'Site ' || lpad(n::text,4,'0') FROM generate_series(1,505) n`,[own.id,own.branch]);
    await db.query(`INSERT INTO marketing_agents (business_id,location_id,display_name,kind) SELECT $1,$2,'Partner ' || lpad(n::text,4,'0'),'affiliate' FROM generate_series(1,505) n`,[own.id,own.branch]);
    await dbLib.withTenant(own.id, async () => {
      const first = await ops.assignmentOptions(own.id,[own.branch],own.branch);
      expect(first.targets).toHaveLength(20); expect(first.agents).toHaveLength(20);
      expect(first.targetHasMore).toBe(true); expect(first.agentHasMore).toBe(true);
      const last = await ops.assignmentOptions(own.id,[own.branch],own.branch,"",26,"",26);
      expect(last.targets).toHaveLength(5); expect(last.agents).toHaveLength(5);
      expect(last.targetHasMore).toBe(false); expect(last.agentHasMore).toBe(false);
      expect(last.targets.map((x) => x.site_label)).toContain("Site 0505");
      expect(last.agents.map((x) => x.name)).toContain("Partner 0505");
      const searched = await ops.assignmentOptions(own.id,[own.branch],own.branch,"0505",1,"0505",1);
      expect(searched.targets).toHaveLength(1); expect(searched.agents).toHaveLength(1);
      expect((await ops.assignmentOptions(own.id,[own.branch],own.branch,"%",1,"_",1)).targets).toHaveLength(0);
      expect((await ops.assignmentOptions(own.id,[own.branch],own.branch,"%",1,"_",1)).agents).toHaveLength(0);
      const forbidden = await ops.assignmentOptions(own.id,[],own.branch,"0505",1,"0505",1);
      expect(forbidden.targets).toHaveLength(0); expect(forbidden.agents).toHaveLength(0);
      const cross = await dbLib.withTenant(b.id, () => ops.assignmentOptions(b.id,[b.branch],own.branch,"0505",1,"0505",1));
      expect(cross.targets).toHaveLength(0); expect(cross.agents).toHaveLength(0);
      await db.query(`UPDATE marketing_targets SET status='archived' WHERE business_id=$1 AND site_label='Site 0505'`,[own.id]);
      await db.query(`UPDATE marketing_agents SET status='inactive' WHERE business_id=$1 AND display_name='Partner 0505'`,[own.id]);
      const inactive = await ops.assignmentOptions(own.id,[own.branch],own.branch,"0505",1,"0505",1);
      expect(inactive.targets).toHaveLength(0); expect(inactive.agents).toHaveLength(0);
    });
  });
  it("limits self-service to the active employee's own currently authorized branches", async () => {
    const own = await business();
    const second = (await db.query<{ id: string }>(`INSERT INTO users (business_id,full_name,role,password_hash,location_id,location_scope) VALUES ($1,'Other','cashier','x',$2,'home') RETURNING id`, [own.id,own.branch])).rows[0].id;
    const target = (await db.query<{ id: string }>(`INSERT INTO marketing_targets (business_id,location_id,site_label) VALUES ($1,$2,'Self site') RETURNING id`, [own.id,own.branch])).rows[0].id;
    const agents = (await db.query<{ id: string }>(`INSERT INTO marketing_agents (business_id,location_id,user_id,display_name,kind) VALUES ($1,$2,$3,'Own','employee'),($1,$2,$4,'Other','employee') RETURNING id`, [own.id,own.branch,own.user,second])).rows;
    const tasks = (await db.query<{ id: string }>(`INSERT INTO marketing_assignments (business_id,location_id,target_id,agent_id,title) VALUES ($1,$2,$3,$4,'Own work'),($1,$2,$3,$5,'Other work') RETURNING id`, [own.id,own.branch,target,agents[0].id,agents[1].id])).rows;
    await dbLib.withTenant(own.id, async () => {
      expect((await ops.listOwnAssignments(own.id,own.user,[own.branch],"",1)).assignments.map((r) => r.id)).toEqual([tasks[0].id]);
      expect((await ops.listOwnAssignments(own.id,own.user,[],"",1)).assignments).toHaveLength(0);
      expect((await ops.listOwnAssignments(own.id,own.user,[own.branch],"%",1)).assignments).toHaveLength(0);
      expect(await ops.transitionOwnAssignment(own.id,own.user,[own.branch],tasks[1].id,"planned","completed")).toBe("not_found");
      expect(await ops.transitionOwnAssignment(own.id,b.user,[own.branch],tasks[0].id,"planned","completed")).toBe("not_found");
      expect(await ops.transitionOwnAssignment(own.id,own.user,[],tasks[0].id,"planned","completed")).toBe("not_found");
      expect(await ops.transitionOwnAssignment(own.id,own.user,[own.branch],tasks[0].id,"planned","canceled")).toBe("invalid");
      await db.query(`UPDATE marketing_agents SET status='inactive' WHERE id=$1`, [agents[0].id]);
      expect((await ops.listOwnAssignments(own.id,own.user,[own.branch],"",1)).assignments).toHaveLength(0);
      expect(await ops.transitionOwnAssignment(own.id,own.user,[own.branch],tasks[0].id,"planned","completed")).toBe("not_found");
      await db.query(`UPDATE marketing_agents SET status='active' WHERE id=$1`, [agents[0].id]);
      await db.query(`UPDATE users SET location_scope='none' WHERE id=$1`, [own.user]);
      expect((await ops.listOwnAssignments(own.id,own.user,[own.branch],"",1)).assignments).toHaveLength(0);
      expect(await ops.transitionOwnAssignment(own.id,own.user,[own.branch],tasks[0].id,"planned","completed")).toBe("not_found");
      await db.query(`UPDATE users SET location_scope='selected' WHERE id=$1`, [own.user]);
      expect((await ops.listOwnAssignments(own.id,own.user,[own.branch],"",1)).assignments).toHaveLength(0);
      await db.query(`INSERT INTO user_locations (user_id,location_id) VALUES ($1,$2)`, [own.user,own.branch]);
      expect((await ops.listOwnAssignments(own.id,own.user,[own.branch],"",1)).assignments).toHaveLength(1);
      await db.query(`DELETE FROM user_locations WHERE user_id=$1`, [own.user]);
      expect(await ops.transitionOwnAssignment(own.id,own.user,[own.branch],tasks[0].id,"planned","completed")).toBe("not_found");
      await db.query(`UPDATE users SET location_scope='home' WHERE id=$1`, [own.user]);
      await db.query(`UPDATE locations SET is_active=false WHERE id=$1`, [own.branch]);
      expect((await ops.listOwnAssignments(own.id,own.user,[own.branch],"",1)).assignments).toHaveLength(0);
      expect(await ops.transitionOwnAssignment(own.id,own.user,[own.branch],tasks[0].id,"planned","completed")).toBe("not_found");
      await db.query(`UPDATE locations SET is_active=true WHERE id=$1`, [own.branch]);
      await db.query(`UPDATE users SET is_active=false WHERE id=$1`, [own.user]);
      expect(await ops.transitionOwnAssignment(own.id,own.user,[own.branch],tasks[0].id,"planned","completed")).toBe("not_found");
      await db.query(`UPDATE users SET is_active=true WHERE id=$1`, [own.user]);
      await db.query(`CREATE FUNCTION reject_self_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'growth.marketing_assignment_status_changed' THEN RAISE EXCEPTION 'audit unavailable'; END IF; RETURN NEW; END $$`);
      await db.query(`CREATE TRIGGER reject_self_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_self_audit()`);
      try {
        await expect(ops.transitionOwnAssignment(own.id,own.user,[own.branch],tasks[0].id,"planned","completed")).rejects.toThrow("audit unavailable");
        expect((await db.query(`SELECT status FROM marketing_assignments WHERE id=$1`,[tasks[0].id])).rows[0].status).toBe("planned");
      } finally {
        await db.query(`DROP TRIGGER reject_self_audit ON audit_log`);
        await db.query(`DROP FUNCTION reject_self_audit()`);
      }
      const results = await Promise.all([
        ops.transitionOwnAssignment(own.id,own.user,[own.branch],tasks[0].id,"planned","in_progress"),
        ops.transitionOwnAssignment(own.id,own.user,[own.branch],tasks[0].id,"planned","completed"),
      ]);
      expect(results.sort()).toEqual(["conflict","updated"]);
      expect((await dbLib.query(`SELECT id FROM audit_log WHERE business_id=$1 AND action='growth.marketing_assignment_status_changed'`, [own.id])).rows).toHaveLength(1);
    });
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
