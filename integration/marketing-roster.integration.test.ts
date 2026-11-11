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
let ops: typeof import("../src/lib/marketing-operations-service");
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
  dbLib = await import("../src/lib/db"); roster = await import("../src/lib/marketing-roster-service"); ops = await import("../src/lib/marketing-operations-service"); team = await import("../src/lib/team-service");
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
  it("manages operational status without changing staff identity or stranding work", async () => {
    const own = await business();
    const otherBranch = (await db.query<{ id: string }>(`INSERT INTO locations (business_id,name) VALUES ($1,'Other') RETURNING id`, [own.id])).rows[0].id;
    await dbLib.withTenant(own.id, async () => {
      const employee = (await roster.createMarketer(own.id,own.user,[own.branch],{ locationId: own.branch, kind: "employee", userId: own.user, name: null }))!;
      const external = (await roster.createMarketer(own.id,own.user,[own.branch],{ locationId: own.branch, kind: "affiliate", userId: null, name: "Partner" }))!;
      expect(await roster.changeMarketer(own.id,own.user,[],external.id,{ action: "deactivate", expectedRevision: 0 })).toBe("not_found");
      expect(await roster.changeMarketer(own.id,own.user,[otherBranch],external.id,{ action: "deactivate", expectedRevision: 0 })).toBe("not_found");
      expect(await dbLib.withTenant(b.id, () => roster.changeMarketer(b.id,b.user,[b.branch],external.id,{ action: "deactivate", expectedRevision: 0 }))).toBe("not_found");
      expect(await roster.changeMarketer(own.id,own.user,[own.branch],employee.id,{ action: "rename", expectedRevision: 0, name: "Fake" })).toBe("conflict");
      const rename = { action: "rename", expectedRevision: 0, name: "New Partner" } as const;
      expect((await Promise.all([roster.changeMarketer(own.id,own.user,[own.branch],external.id,rename), roster.changeMarketer(own.id,own.user,[own.branch],external.id,rename)])).sort()).toEqual(["conflict","updated"]);
      const target = (await ops.createTarget(own.id,own.user,[own.branch],{ locationId: own.branch, partyId: null, siteLabel: "Site", city: "", neighborhood: "" }))!;
      const input = { locationId: own.branch, targetId: target.id, agentId: employee.id, title: "Task", dueDate: null };
      const task = (await ops.createAssignment(own.id,own.user,[own.branch],input))!;
      expect(await roster.changeMarketer(own.id,own.user,[own.branch],employee.id,{ action: "deactivate", expectedRevision: 0 })).toBe("open_assignments");
      expect(await ops.transitionAssignment(own.id,own.user,[own.branch],task.id,"planned","in_progress")).toBe("updated");
      expect(await roster.changeMarketer(own.id,own.user,[own.branch],employee.id,{ action: "deactivate", expectedRevision: 0 })).toBe("open_assignments");
      expect(await ops.transitionAssignment(own.id,own.user,[own.branch],task.id,"in_progress","completed")).toBe("updated");
      expect(await roster.changeMarketer(own.id,own.user,[own.branch],employee.id,{ action: "deactivate", expectedRevision: 0 })).toBe("updated");
      expect(await ops.createAssignment(own.id,own.user,[own.branch],input)).toBeNull();
      expect(await roster.changeMarketer(own.id,own.user,[own.branch],employee.id,{ action: "reactivate", expectedRevision: 0 })).toBe("conflict");
      await db.query(`UPDATE users SET is_active=false WHERE id=$1`,[own.user]);
      expect(await roster.changeMarketer(own.id,own.user,[own.branch],employee.id,{ action: "reactivate", expectedRevision: 1 })).toBe("ineligible_user");
      await db.query(`UPDATE users SET is_active=true,location_scope='none' WHERE id=$1`,[own.user]);
      expect(await roster.changeMarketer(own.id,own.user,[own.branch],employee.id,{ action: "reactivate", expectedRevision: 1 })).toBe("ineligible_user");
      await db.query(`UPDATE users SET location_scope='home' WHERE id=$1`,[own.user]);
      await db.query(`UPDATE locations SET is_active=false WHERE id=$1`,[own.branch]);
      expect(await roster.changeMarketer(own.id,own.user,[own.branch],employee.id,{ action: "reactivate", expectedRevision: 1 })).toBe("not_found");
      await db.query(`UPDATE locations SET is_active=true WHERE id=$1`,[own.branch]);
      expect(await roster.changeMarketer(own.id,own.user,[own.branch],employee.id,{ action: "reactivate", expectedRevision: 1 })).toBe("updated");
      expect(await ops.createAssignment(own.id,own.user,[own.branch],input)).not.toBeNull();
      const employeeState = (await db.query(`SELECT user_id,location_id,kind,status,revision FROM marketing_agents WHERE id=$1`,[employee.id])).rows[0];
      expect(employeeState).toEqual({ user_id: own.user, location_id: own.branch, kind: "employee", status: "active", revision: 2 });
      expect((await roster.listMarketers(own.id,[own.branch],"New Partner",1)).marketers).toHaveLength(1);
      expect((await dbLib.query(`SELECT id FROM audit_log WHERE business_id=$1 AND action='growth.marketer_changed'`,[own.id])).rows).toHaveLength(3);
    });
  });
  it("serializes deactivation with new assignments and rolls back if audit fails", async () => {
    const own = await business();
    await dbLib.withTenant(own.id, async () => {
      const target = (await ops.createTarget(own.id,own.user,[own.branch],{ locationId: own.branch, partyId: null, siteLabel: "Race", city: "", neighborhood: "" }))!;
      for (let i = 0; i < 5; i++) {
        const agent = (await roster.createMarketer(own.id,own.user,[own.branch],{ locationId: own.branch, kind: "affiliate", userId: null, name: `Partner ${i}` }))!;
        const [deactivation, task] = await Promise.all([
          roster.changeMarketer(own.id,own.user,[own.branch],agent.id,{ action: "deactivate", expectedRevision: 0 }),
          ops.createAssignment(own.id,own.user,[own.branch],{ locationId: own.branch, targetId: target.id, agentId: agent.id, title: "Race", dueDate: null }),
        ]);
        if (deactivation === "updated") expect(task).toBeNull();
        else { expect(deactivation).toBe("open_assignments"); expect(task).not.toBeNull(); }
        const state = (await db.query(`SELECT a.status,count(x.id)::int AS open FROM marketing_agents a LEFT JOIN marketing_assignments x ON x.agent_id=a.id AND x.status IN ('planned','in_progress') WHERE a.id=$1 GROUP BY a.id`,[agent.id])).rows[0];
        expect(state.status === "inactive" && state.open > 0).toBe(false);
      }
      const agent = (await roster.createMarketer(own.id,own.user,[own.branch],{ locationId: own.branch, kind: "contractor", userId: null, name: "Rollback" }))!;
      await db.query(`CREATE FUNCTION reject_roster_change_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='growth.marketer_changed' THEN RAISE EXCEPTION 'audit unavailable'; END IF; RETURN NEW; END $$`);
      await db.query(`CREATE TRIGGER reject_roster_change_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_roster_change_audit()`);
      try {
        await expect(roster.changeMarketer(own.id,own.user,[own.branch],agent.id,{ action: "deactivate", expectedRevision: 0 })).rejects.toThrow("audit unavailable");
        expect((await db.query(`SELECT status,revision FROM marketing_agents WHERE id=$1`,[agent.id])).rows[0]).toEqual({ status: "active", revision: 0 });
      } finally { await db.query(`DROP TRIGGER reject_roster_change_audit ON audit_log`); await db.query(`DROP FUNCTION reject_roster_change_audit()`); }
    });
  });
  it("maintains audited branch-scoped supervisor links without cycles or privilege grants", async () => {
    const own = await business(); const other = await business();
    const employee = async (name: string, branch = own.branch) => {
      const user = (await db.query<{id:string}>(`INSERT INTO users (business_id,full_name,role,password_hash,location_id,location_scope) VALUES ($1,$2,'cashier','x',$3,'home') RETURNING id`,[own.id,name,branch])).rows[0].id;
      const agent = (await db.query<{id:string}>(`INSERT INTO marketing_agents (business_id,location_id,user_id,display_name,kind) VALUES ($1,$2,$3,$4,'employee') RETURNING id`,[own.id,branch,user,name])).rows[0].id;
      return {user,agent};
    };
    const first = await employee("First"); const second = await employee("Second"); const third = await employee("Third");
    const branch2 = (await db.query<{id:string}>(`INSERT INTO locations (business_id,name) VALUES ($1,'Other') RETURNING id`,[own.id])).rows[0].id;
    const otherBranch = await employee("Other branch",branch2);
    const external = (await db.query<{id:string}>(`INSERT INTO marketing_agents (business_id,location_id,display_name,kind) VALUES ($1,$2,'External','affiliate') RETURNING id`,[own.id,own.branch])).rows[0].id;
    const foreign = (await db.query<{id:string}>(`INSERT INTO marketing_agents (business_id,location_id,user_id,display_name,kind) VALUES ($1,$2,$3,'Foreign','employee') RETURNING id`,[other.id,other.branch,other.user])).rows[0].id;
    const change = (id: string, supervisorId: string | null, revision = 0, locations = [own.branch]) => dbLib.withTenant(own.id, () => roster.changeMarketer(own.id,own.user,locations,id,{action:"supervisor",supervisorId,expectedRevision:revision}));
    expect(await change(first.agent,first.agent)).toBe("invalid_supervisor");
    expect(await change(first.agent,external)).toBe("invalid_supervisor");
    expect(await change(first.agent,otherBranch.agent)).toBe("invalid_supervisor");
    expect(await change(first.agent,foreign)).toBe("invalid_supervisor");
    expect(await change(first.agent,second.agent,0,[])).toBe("not_found");
    expect((await dbLib.withTenant(own.id, () => roster.listSupervisorCandidates(own.id,[],own.branch,"",1))).supervisors).toHaveLength(0);
    expect((await dbLib.withTenant(own.id, () => roster.listSupervisorCandidates(own.id,[own.branch],branch2,"",1))).supervisors).toHaveLength(0);
    expect((await dbLib.withTenant(own.id, () => roster.listSupervisorCandidates(own.id,[own.branch],own.branch,"%",1))).supervisors).toHaveLength(0);
    expect((await dbLib.withTenant(own.id, () => roster.listSupervisorCandidates(own.id,[own.branch],own.branch,"Sec",1))).supervisors).toEqual([{id:second.agent,name:"Second"}]);
    await db.query(`UPDATE users SET is_active=false WHERE id=$1`,[first.user]);
    expect(await change(first.agent,second.agent)).toBe("ineligible_user");
    await db.query(`UPDATE users SET is_active=true, location_scope='none' WHERE id=$1`,[first.user]);
    expect(await change(first.agent,second.agent)).toBe("ineligible_user");
    await db.query(`UPDATE users SET location_scope='home' WHERE id=$1`,[first.user]);
    await db.query(`UPDATE users SET location_scope='none' WHERE id=$1`,[second.user]);
    expect(await change(first.agent,second.agent)).toBe("invalid_supervisor");
    await db.query(`UPDATE users SET location_scope='home' WHERE id=$1`,[second.user]);
    expect(await change(first.agent,second.agent)).toBe("updated");
    expect(await change(second.agent,third.agent)).toBe("updated");
    expect(await change(third.agent,first.agent)).toBe("supervisor_cycle");
    expect(await change(first.agent,third.agent,0)).toBe("conflict");
    expect(await dbLib.withTenant(own.id, () => roster.changeMarketer(own.id,own.user,[own.branch],second.agent,{action:"deactivate",expectedRevision:1}))).toBe("supervisor_has_reports");
    const listed = await dbLib.withTenant(own.id, () => roster.listMarketers(own.id,[own.branch],"First",1));
    expect(listed.marketers[0]).toMatchObject({supervisor_id:second.agent,supervisor_name:"Second",supervisor_eligible:true});
    await db.query(`UPDATE users SET is_active=false WHERE id=$1`,[second.user]);
    const stale = await dbLib.withTenant(own.id, () => roster.listMarketers(own.id,[own.branch],"First",1));
    expect(stale.marketers[0].supervisor_eligible).toBe(false);
    await db.query(`UPDATE users SET is_active=true WHERE id=$1`,[second.user]);
    expect(await change(first.agent,null,1)).toBe("updated");
    expect(await dbLib.withTenant(own.id, () => roster.changeMarketer(own.id,own.user,[own.branch],second.agent,{action:"deactivate",expectedRevision:1}))).toBe("updated");
    expect(await change(first.agent,second.agent,2)).toBe("invalid_supervisor");
    await expect(db.query(`UPDATE marketing_agents SET supervisor_agent_id=$2 WHERE id=$1`,[first.agent,otherBranch.agent])).rejects.toMatchObject({code:"23503"});
    await expect(db.query(`UPDATE marketing_agents SET supervisor_agent_id=id WHERE id=$1`,[first.agent])).rejects.toMatchObject({code:"23514"});
    const audits = (await db.query(`SELECT payload FROM audit_log WHERE business_id=$1 AND action='growth.marketer_supervisor_changed'`,[own.id])).rows;
    expect(audits).toHaveLength(3);
    expect(audits.map((r) => r.payload)).toContainEqual({from:null,to:second.agent,revision:1});
    // Whole-tenant reset/hard-delete removes all roster rows in one statement.
    await db.query(`BEGIN`);
    try { expect((await db.query(`DELETE FROM marketing_agents WHERE business_id=$1`,[own.id])).rowCount).toBe(5); }
    finally { await db.query(`ROLLBACK`); }
  });
  it("paginates eligible supervisors and filters literal search characters", async () => {
    const own = await business();
    await db.query(`WITH inserted AS (
      INSERT INTO users (business_id,full_name,role,password_hash,location_id,location_scope)
      SELECT $1,'Supervisor ' || lpad(n::text,2,'0'),'cashier','x',$2,'home' FROM generate_series(1,25) n
      RETURNING id,full_name)
      INSERT INTO marketing_agents (business_id,location_id,user_id,display_name,kind)
      SELECT $1,$2,id,full_name,'employee' FROM inserted`,[own.id,own.branch]);
    const list = (term: string, page: number) => dbLib.withTenant(own.id, () => roster.listSupervisorCandidates(own.id,[own.branch],own.branch,term,page));
    const first = await list("Supervisor",1); const second = await list("Supervisor",2);
    expect(first.supervisors).toHaveLength(20); expect(first.hasMore).toBe(true);
    expect(second.supervisors).toHaveLength(5); expect(second.hasMore).toBe(false);
    expect(new Set([...first.supervisors,...second.supervisors].map((item) => item.id)).size).toBe(25);
    expect((await list("%",1)).supervisors).toHaveLength(0);
    expect((await list("_",1)).supervisors).toHaveLength(0);
    await db.query(`UPDATE locations SET is_active=false WHERE id=$1`,[own.branch]);
    expect((await list("Supervisor",1)).supervisors).toHaveLength(0);
  });
  it("serializes competing hierarchy changes and rolls back when auditing fails", async () => {
    const own = await business();
    const agent = async (n: string) => {
      const user = (await db.query<{id:string}>(`INSERT INTO users (business_id,full_name,role,password_hash,location_id,location_scope) VALUES ($1,$2,'cashier','x',$3,'home') RETURNING id`,[own.id,n,own.branch])).rows[0].id;
      return (await db.query<{id:string}>(`INSERT INTO marketing_agents (business_id,location_id,user_id,display_name,kind) VALUES ($1,$2,$3,$4,'employee') RETURNING id`,[own.id,own.branch,user,n])).rows[0].id;
    };
    const first = await agent("First race"); const second = await agent("Second race");
    const change = (id: string, supervisorId: string) => dbLib.withTenant(own.id, () => roster.changeMarketer(own.id,own.user,[own.branch],id,{action:"supervisor",supervisorId,expectedRevision:0}));
    const results = await Promise.all([change(first,second),change(second,first)]);
    expect(results.sort()).toEqual(["supervisor_cycle","updated"]);
    const rows = (await db.query<{id:string;supervisor_agent_id:string|null}>(`SELECT id,supervisor_agent_id FROM marketing_agents WHERE business_id=$1`,[own.id])).rows;
    expect(rows.filter((row) => row.supervisor_agent_id)).toHaveLength(1);
    const third = await agent("Rollback"); const fourth = await agent("Supervisor race");
    const [linked, deactivated] = await Promise.all([
      change(third,fourth),
      dbLib.withTenant(own.id, () => roster.changeMarketer(own.id,own.user,[own.branch],fourth,{action:"deactivate",expectedRevision:0})),
    ]);
    expect([linked,deactivated]).toSatisfy((pair: string[]) => (pair[0] === "updated" && pair[1] === "supervisor_has_reports") || (pair[0] === "invalid_supervisor" && pair[1] === "updated"));
    if (linked === "updated") expect(await dbLib.withTenant(own.id, () => roster.changeMarketer(own.id,own.user,[own.branch],third,{action:"supervisor",supervisorId:null,expectedRevision:1}))).toBe("updated");
    const rollbackAgent = await agent("Audit rollback");
    await db.query(`CREATE FUNCTION reject_supervisor_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='growth.marketer_supervisor_changed' THEN RAISE EXCEPTION 'audit unavailable'; END IF; RETURN NEW; END $$`);
    await db.query(`CREATE TRIGGER reject_supervisor_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_supervisor_audit()`);
    try {
      await expect(change(rollbackAgent,second)).rejects.toThrow("audit unavailable");
      expect((await db.query(`SELECT supervisor_agent_id,revision FROM marketing_agents WHERE id=$1`,[rollbackAgent])).rows[0]).toEqual({supervisor_agent_id:null,revision:0});
    } finally { await db.query(`DROP TRIGGER reject_supervisor_audit ON audit_log`); await db.query(`DROP FUNCTION reject_supervisor_audit()`); }
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
