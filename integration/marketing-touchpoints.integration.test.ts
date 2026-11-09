import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
const root = process.env.DATABASE_URL;
if (!root) throw new Error("DATABASE_URL is required for database integration tests");
const database = `marketing_touch_${randomUUID().replaceAll("-", "")}`;
const urlFor = (name: string) => { const url = new URL(root!); url.pathname = `/${name}`; return url.toString(); };
let db: Client;
let dbLib: typeof import("../src/lib/db");
let touch: typeof import("../src/lib/marketing-touchpoints-service");
let a: { business: string; location: string; user: string; lead: string; party: string; assignment: string };
let b: typeof a;
async function business() {
  const business = (await db.query<{ id: string }>(`INSERT INTO businesses (name,slug,industry) VALUES ('Test',$1,'accessories') RETURNING id`, [randomUUID()])).rows[0].id;
  const location = (await db.query<{ id: string }>(`INSERT INTO locations (business_id,name) VALUES ($1,'Main') RETURNING id`,[business])).rows[0].id;
  const user = (await db.query<{ id: string }>(`INSERT INTO users (business_id,full_name,role,password_hash,location_id,location_scope) VALUES ($1,'Member','cashier','x',$2,'home') RETURNING id`,[business,location])).rows[0].id;
  const party = (await db.query<{ id: string }>(`INSERT INTO parties (business_id,name,role,roles,acquisition_source,last_source) VALUES ($1,'Customer','customer',ARRAY['customer']::text[],'instagram','instagram') RETURNING id`,[business])).rows[0].id;
  const lead = (await db.query<{ id: string }>(`INSERT INTO crm_leads (business_id,name,source) VALUES ($1,'Lead','instagram') RETURNING id`,[business])).rows[0].id;
  const agent = (await db.query<{ id: string }>(`INSERT INTO marketing_agents (business_id,location_id,user_id,display_name,kind) VALUES ($1,$2,$3,'Member','employee') RETURNING id`,[business,location,user])).rows[0].id;
  const target = (await db.query<{ id: string }>(`INSERT INTO marketing_targets (business_id,location_id,party_id,site_label) VALUES ($1,$2,$3,'Site') RETURNING id`,[business,location,party])).rows[0].id;
  const assignment = (await db.query<{ id: string }>(`INSERT INTO marketing_assignments (business_id,location_id,target_id,agent_id,title) VALUES ($1,$2,$3,$4,'Call') RETURNING id`,[business,location,target,agent])).rows[0].id;
  return { business, location, user, party, lead, assignment };
}
beforeAll(async () => {
  const c = new Client({ connectionString: urlFor("postgres") }); await c.connect(); await c.query(`CREATE DATABASE "${database}"`); await c.end();
  await runMigrations({ databaseUrl: urlFor(database), quiet: true }); process.env.DATABASE_URL = urlFor(database);
  dbLib = await import("../src/lib/db"); touch = await import("../src/lib/marketing-touchpoints-service");
  db = new Client({ connectionString: urlFor(database) }); await db.connect(); a = await business(); b = await business();
}, 120_000);
afterAll(async () => {
  await db?.end(); await dbLib?.getPool().end(); process.env.DATABASE_URL = root;
  const c = new Client({ connectionString: urlFor("postgres") }); await c.connect(); await c.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`); await c.end();
});

describe("marketer touches", () => {
  it("links an existing lead without rewriting CRM sources or consent and dedupes concurrent retries", async () => {
    const input = { assignmentId: a.assignment, leadId: a.lead, channel: "phone" as const, source: "phone" as const, idempotencyKey: randomUUID() };
    await dbLib.withTenant(a.business, async () => {
      expect(await touch.recordMarketingTouch(a.business, a.user, [], input)).toEqual({ kind: "not_found" });
      expect(await touch.recordMarketingTouch(a.business, a.user, [a.location], { ...input, leadId: b.lead })).toEqual({ kind: "not_found" });
      const outcomes = await Promise.all([touch.recordMarketingTouch(a.business, a.user, [a.location], input), touch.recordMarketingTouch(a.business, a.user, [a.location], input)]);
      expect(outcomes.map((x) => x.kind).sort()).toEqual(["created", "replayed"]);
      expect(outcomes[0]).toHaveProperty("id", (outcomes[1] as { id: string }).id);
      expect(await touch.recordMarketingTouch(a.business, a.user, [a.location], { ...input, source: "event" })).toEqual({ kind: "conflict" });
      expect(await touch.recordMarketingTouch(a.business, a.user, [], input)).toEqual({ kind: "conflict" });
      const visible = await touch.listMarketingTouches(a.business,[a.location],"",1,true);
      const redacted = await touch.listMarketingTouches(a.business,[a.location],"",1,false);
      expect(visible.touches).toHaveLength(1); expect(visible.touches[0].lead_id).toBe(a.lead); expect(visible.touches[0].lead_name).toBe("Lead");
      expect(redacted.touches[0].lead_id).toBeNull(); expect(redacted.touches[0].lead_name).toBeNull();
      expect((await touch.listMarketingTouches(a.business,[],"",1,true)).touches).toHaveLength(0);
      expect((await dbLib.query(`SELECT id FROM audit_log WHERE business_id=$1 AND action='growth.marketing_touch_recorded'`,[a.business])).rows).toHaveLength(1);
      expect((await dbLib.query(`SELECT id FROM crm_consent_events WHERE business_id=$1`,[a.business])).rows).toHaveLength(0);
      expect((await dbLib.query(`SELECT id FROM crm_activities WHERE business_id=$1 AND lead_id=$2`,[a.business,a.lead])).rows).toHaveLength(0);
      expect((await dbLib.query<{ source: string }>(`SELECT source FROM crm_leads WHERE business_id=$1 AND id=$2`,[a.business,a.lead])).rows[0].source).toBe("instagram");
      expect((await dbLib.query<{ acquisition_source: string; last_source: string }>(`SELECT acquisition_source,last_source FROM parties WHERE business_id=$1 AND id=$2`,[a.business,a.party])).rows[0]).toEqual({ acquisition_source: "instagram", last_source: "instagram" });
    });
    const row = (await db.query<{ id: string }>(`SELECT id FROM marketing_touchpoints WHERE business_id=$1`,[a.business])).rows[0];
    await expect(db.query(`UPDATE marketing_touchpoints SET channel='event' WHERE id=$1`,[row.id])).rejects.toMatchObject({ code: "55000" });
    await expect(db.query(`DELETE FROM marketing_touchpoints WHERE id=$1`,[row.id])).rejects.toMatchObject({ code: "55000" });
    await db.query(`BEGIN`);
    await db.query(`SELECT set_config('app.factory_reset','true',true)`);
    expect((await db.query(`DELETE FROM marketing_touchpoints WHERE id=$1`,[row.id])).rowCount).toBe(1);
    await db.query(`ROLLBACK`);
    await db.query(`UPDATE marketing_assignments SET status='canceled' WHERE id=$1`,[a.assignment]);
    await dbLib.withTenant(a.business, async () => {
      expect((await touch.recordMarketingTouch(a.business, a.user, [a.location], input)).kind).toBe("replayed");
      expect(await touch.recordMarketingTouch(a.business, a.user, [a.location], { ...input, idempotencyKey: randomUUID() })).toEqual({ kind: "not_found" });
    });
  });
  it("projects only this lead's touchpoints in active authorized branches and paginates stably", async () => {
    const own = await business(); const foreign = await business();
    const secondLead = (await db.query<{ id: string }>(`INSERT INTO crm_leads (business_id,name) VALUES ($1,'Other') RETURNING id`,[own.business])).rows[0].id;
    const otherBranch = (await db.query<{ id: string }>(`INSERT INTO locations (business_id,name) VALUES ($1,'Other') RETURNING id`,[own.business])).rows[0].id;
    const otherAgent = (await db.query<{ id: string }>(`INSERT INTO marketing_agents (business_id,location_id,display_name,kind) VALUES ($1,$2,'Other partner','affiliate') RETURNING id`,[own.business,otherBranch])).rows[0].id;
    const otherTarget = (await db.query<{ id: string }>(`INSERT INTO marketing_targets (business_id,location_id,site_label) VALUES ($1,$2,'Other site') RETURNING id`,[own.business,otherBranch])).rows[0].id;
    const otherTask = (await db.query<{ id: string }>(`INSERT INTO marketing_assignments (business_id,location_id,target_id,agent_id,title) VALUES ($1,$2,$3,$4,'Other task') RETURNING id`,[own.business,otherBranch,otherTarget,otherAgent])).rows[0].id;
    await db.query(`INSERT INTO marketing_touchpoints (business_id,location_id,assignment_id,lead_id,channel,source,idempotency_key,created_by,recorded_at)
      SELECT $1,$2,$3,$4,'phone','phone',gen_random_uuid(),$5, now() - n * interval '1 second' FROM generate_series(1,25) n`,[own.business,own.location,own.assignment,own.lead,own.user]);
    await db.query(`INSERT INTO marketing_touchpoints (business_id,location_id,assignment_id,lead_id,channel,source,idempotency_key,created_by) VALUES ($1,$2,$3,$4,'event','event',gen_random_uuid(),$5),($1,$6,$7,$8,'phone','phone',gen_random_uuid(),$5)`,[own.business,own.location,own.assignment,secondLead,own.user,otherBranch,otherTask,own.lead]);
    await dbLib.withTenant(own.business, async () => {
      const first = await touch.listMarketingTouchesForLead(own.business,[own.location],own.lead,1);
      const second = await touch.listMarketingTouchesForLead(own.business,[own.location],own.lead,2);
      expect(first.touches).toHaveLength(20); expect(first.hasMore).toBe(true);
      expect(second.touches).toHaveLength(5); expect(second.hasMore).toBe(false);
      expect(new Set([...first.touches, ...second.touches].map((x) => x.id)).size).toBe(25);
      expect(first.touches[0]).toMatchObject({ title: "Call", target: "Site", agent: "Member", location_name: "Main", channel: "phone", source: "phone" });
      expect(first.touches[0]).not.toHaveProperty("lead_id");
      expect((await touch.listMarketingTouchesForLead(own.business,[own.location],secondLead,1)).touches).toHaveLength(1);
      expect((await touch.listMarketingTouchesForLead(own.business,[otherBranch],own.lead,1)).touches).toHaveLength(1);
      expect((await touch.listMarketingTouchesForLead(own.business,[],own.lead,1)).touches).toHaveLength(0);
      expect((await touch.listMarketingTouchesForLead(own.business,[own.location],foreign.lead,1)).touches).toHaveLength(0);
      expect(await dbLib.withTenant(foreign.business, () => touch.listMarketingTouchesForLead(foreign.business,[foreign.location],own.lead,1))).toEqual({ touches: [], hasMore: false });
      await db.query(`UPDATE locations SET is_active=false WHERE id=$1`,[otherBranch]);
      expect((await touch.listMarketingTouchesForLead(own.business,[otherBranch],own.lead,1)).touches).toHaveLength(0);
      expect((await dbLib.query(`SELECT id FROM crm_activities WHERE business_id=$1 AND lead_id=$2`,[own.business,own.lead])).rows).toHaveLength(0);
    });
  });
  it("rejects a lead converted to a different party than the target and foreign-tenant references", async () => {
    const different = (await db.query<{ id: string }>(`INSERT INTO parties (business_id,name,role,roles) VALUES ($1,'Other','customer',ARRAY['customer']::text[]) RETURNING id`,[b.business])).rows[0].id;
    await db.query(`UPDATE crm_leads SET status='converted', converted_party_id=$1 WHERE id=$2`,[different,b.lead]);
    const input = { assignmentId: b.assignment, leadId: b.lead, channel: "in_person" as const, source: "event" as const, idempotencyKey: randomUUID() };
    await dbLib.withTenant(b.business, async () => expect(await touch.recordMarketingTouch(b.business,b.user,[b.location],input)).toEqual({ kind: "party_mismatch" }));
    await expect(db.query(`INSERT INTO marketing_touchpoints (business_id,location_id,assignment_id,lead_id,channel,source,idempotency_key,created_by) VALUES ($1,$2,$3,$4,'phone','phone',$5,$6)`,[b.business,b.location,b.assignment,a.lead,randomUUID(),b.user])).rejects.toMatchObject({ code: "23503" });
  });
  it("rolls back the touch when its audit record fails", async () => {
    await db.query(`UPDATE crm_leads SET converted_party_id=$1 WHERE id=$2`, [b.party, b.lead]);
    await db.query(`CREATE FUNCTION reject_touch_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'growth.marketing_touch_recorded' THEN RAISE EXCEPTION 'audit unavailable'; END IF; RETURN NEW; END $$`);
    await db.query(`CREATE TRIGGER reject_touch_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_touch_audit()`);
    const input = { assignmentId: b.assignment, leadId: b.lead, channel: "phone" as const, source: "phone" as const, idempotencyKey: randomUUID() };
    try {
      await dbLib.withTenant(b.business, async () => {
        await expect(touch.recordMarketingTouch(b.business, b.user, [b.location], input)).rejects.toThrow("audit unavailable");
        expect((await touch.listMarketingTouches(b.business, [b.location], "", 1, true)).touches).toHaveLength(0);
      });
    } finally {
      await db.query(`DROP TRIGGER reject_touch_audit ON audit_log`);
      await db.query(`DROP FUNCTION reject_touch_audit()`);
    }
  });
  it("shows only self-created reports on own authorized assignments with safe search and stable pages", async () => {
    const own = await business(); const foreign = await business();
    const peer = (await db.query<{id:string}>(`INSERT INTO users (business_id,full_name,role,password_hash,location_id,location_scope) VALUES ($1,'Peer','cashier','x',$2,'home') RETURNING id`,[own.business,own.location])).rows[0].id;
    const peerAgent = (await db.query<{id:string}>(`INSERT INTO marketing_agents (business_id,location_id,user_id,display_name,kind) VALUES ($1,$2,$3,'Peer','employee') RETURNING id`,[own.business,own.location,peer])).rows[0].id;
    const target = (await db.query<{id:string}>(`INSERT INTO marketing_targets (business_id,location_id,site_label) VALUES ($1,$2,'Peer site') RETURNING id`,[own.business,own.location])).rows[0].id;
    const peerAssignment = (await db.query<{id:string}>(`INSERT INTO marketing_assignments (business_id,location_id,target_id,agent_id,title) VALUES ($1,$2,$3,$4,'Peer task') RETURNING id`,[own.business,own.location,target,peerAgent])).rows[0].id;
    await db.query(`UPDATE marketing_assignments SET title='Call%match' WHERE id=$1`,[own.assignment]);
    await db.query(`INSERT INTO marketing_touchpoints (business_id,location_id,assignment_id,lead_id,channel,source,idempotency_key,created_by,recorded_at)
      SELECT $1,$2,$3,$4,'phone','phone',gen_random_uuid(),$5,now()-n*interval '1 second' FROM generate_series(1,25) n`,[own.business,own.location,own.assignment,own.lead,own.user]);
    // Manager report about own task and own report about another employee's task are both excluded.
    await db.query(`INSERT INTO marketing_touchpoints (business_id,location_id,assignment_id,lead_id,channel,source,idempotency_key,created_by) VALUES ($1,$2,$3,$4,'phone','phone',gen_random_uuid(),$5),($1,$2,$6,$4,'phone','phone',gen_random_uuid(),$7)`,[own.business,own.location,own.assignment,own.lead,peer,peerAssignment,own.user]);
    const list = (actor = own.user, locations = [own.location], term = "", page = 1) => dbLib.withTenant(own.business, () => touch.listOwnMarketingTouches(own.business,actor,locations,term,page));
    const first = await list(); const second = await list(own.user,[own.location],"",2);
    expect(first.touches).toHaveLength(20); expect(first.hasMore).toBe(true);
    expect(second.touches).toHaveLength(5); expect(second.hasMore).toBe(false);
    expect(new Set([...first.touches,...second.touches].map((r) => r.id)).size).toBe(25);
    expect(first.touches[0]).toMatchObject({title:"Call%match",target:"Site",lead_name:"Lead",location_name:"Main",channel:"phone"});
    expect(first.touches[0]).not.toHaveProperty("idempotency_key"); expect(first.touches[0]).not.toHaveProperty("lead_id");
    expect((await list(own.user,[own.location],"%" )).touches).toHaveLength(20);
    expect((await list(own.user,[own.location],"_")).touches).toHaveLength(0);
    expect((await list(own.user,[own.location],"Lead")).touches).toHaveLength(20);
    expect((await list(own.user,[])).touches).toHaveLength(0);
    expect((await list(peer)).touches).toHaveLength(0);
    expect((await list(foreign.user)).touches).toHaveLength(0);
    expect((await dbLib.withTenant(foreign.business, () => touch.listOwnMarketingTouches(foreign.business,own.user,[foreign.location],"",1))).touches).toHaveLength(0);
    await db.query(`UPDATE marketing_assignments SET status='canceled' WHERE id=$1`,[own.assignment]);
    await db.query(`UPDATE marketing_targets SET status='archived' WHERE id=(SELECT target_id FROM marketing_assignments WHERE id=$1)`,[own.assignment]);
    expect((await list()).touches).toHaveLength(20);
    await db.query(`UPDATE users SET location_scope='selected' WHERE id=$1`,[own.user]); expect((await list()).touches).toHaveLength(0);
    await db.query(`INSERT INTO user_locations (user_id,location_id) VALUES ($1,$2)`,[own.user,own.location]); expect((await list()).touches).toHaveLength(20);
    await db.query(`DELETE FROM user_locations WHERE user_id=$1`,[own.user]); expect((await list()).touches).toHaveLength(0);
    await db.query(`UPDATE users SET location_scope='home', membership_status='suspended' WHERE id=$1`,[own.user]); expect((await list()).touches).toHaveLength(0);
    await db.query(`UPDATE users SET membership_status='active', is_active=false WHERE id=$1`,[own.user]); expect((await list()).touches).toHaveLength(0);
    await db.query(`UPDATE users SET is_active=true WHERE id=$1`,[own.user]);
    await db.query(`UPDATE marketing_agents SET status='inactive' WHERE user_id=$1`,[own.user]); expect((await list()).touches).toHaveLength(0);
    await db.query(`UPDATE marketing_agents SET status='active' WHERE user_id=$1`,[own.user]);
    await db.query(`UPDATE locations SET is_active=false WHERE id=$1`,[own.location]); expect((await list()).touches).toHaveLength(0);
  });
  it("limits self-reporting and retries to the active assigned employee and authorized branch", async () => {
    const own = await business(); const other = await business();
    const peer = (await db.query<{ id: string }>(`INSERT INTO users (business_id,full_name,role,password_hash,location_id,location_scope) VALUES ($1,'Peer','cashier','x',$2,'home') RETURNING id`,[own.business,own.location])).rows[0].id;
    const input = { assignmentId: own.assignment, leadId: own.lead, channel: "phone" as const, source: "phone" as const, idempotencyKey: randomUUID() };
    const call = (actor = own.user, locations = [own.location], value = input) => dbLib.withTenant(own.business, () => touch.recordOwnMarketingTouch(own.business,actor,locations,value));
    expect(await call(peer)).toEqual({ kind: "not_found" });
    expect(await call(own.user,[])).toEqual({ kind: "not_found" });
    expect(await call(own.user,[own.location],{...input, assignmentId: other.assignment})).toEqual({ kind: "not_found" });
    expect(await call(own.user,[own.location],{...input, leadId: other.lead})).toEqual({ kind: "not_found" });
    const both = await Promise.all([call(),call()]);
    expect(both.map((r) => r.kind).sort()).toEqual(["created","replayed"]);
    expect(both[0]).toHaveProperty("id",(both[1] as {id: string}).id);
    expect(await call(own.user,[own.location],{...input,source:"event"})).toEqual({kind:"conflict"});
    await db.query(`UPDATE marketing_assignments SET status='canceled' WHERE id=$1`,[own.assignment]);
    await db.query(`UPDATE marketing_targets SET status='archived' WHERE id=(SELECT target_id FROM marketing_assignments WHERE id=$1)`,[own.assignment]);
    expect((await call()).kind).toBe("replayed");
    expect(await call(own.user,[own.location],{...input,idempotencyKey:randomUUID()})).toEqual({kind:"not_found"});
    await db.query(`UPDATE users SET is_active=false WHERE id=$1`,[own.user]); expect(await call()).toEqual({kind:"not_found"});
    await db.query(`UPDATE users SET is_active=true, membership_status='suspended' WHERE id=$1`,[own.user]); expect(await call()).toEqual({kind:"not_found"});
    await db.query(`UPDATE users SET membership_status='active', location_scope='none' WHERE id=$1`,[own.user]); expect(await call()).toEqual({kind:"not_found"});
    await db.query(`UPDATE users SET location_scope='selected' WHERE id=$1`,[own.user]); expect(await call()).toEqual({kind:"not_found"});
    await db.query(`INSERT INTO user_locations (user_id,location_id) VALUES ($1,$2)`,[own.user,own.location]); expect((await call()).kind).toBe("replayed");
    await db.query(`DELETE FROM user_locations WHERE user_id=$1`,[own.user]); expect(await call()).toEqual({kind:"not_found"});
    await db.query(`UPDATE users SET location_scope='home' WHERE id=$1`,[own.user]);
    await db.query(`UPDATE marketing_agents SET status='inactive' WHERE user_id=$1`,[own.user]); expect(await call()).toEqual({kind:"not_found"});
    await db.query(`UPDATE marketing_agents SET status='active' WHERE user_id=$1`,[own.user]);
    await db.query(`UPDATE locations SET is_active=false WHERE id=$1`,[own.location]); expect(await call()).toEqual({kind:"not_found"});
    expect((await db.query(`SELECT id FROM audit_log WHERE business_id=$1 AND action='growth.marketing_touch_recorded'`,[own.business])).rows).toHaveLength(1);
  });
  it("checks target status independently and serializes reporting with cancellation", async () => {
    const own = await business();
    const input = { assignmentId: own.assignment, leadId: own.lead, channel: "phone" as const, source: "phone" as const, idempotencyKey: randomUUID() };
    const call = () => dbLib.withTenant(own.business, () => touch.recordOwnMarketingTouch(own.business,own.user,[own.location],input));
    // An archived target rejects a new report even if the assignment is not canceled.
    await db.query(`UPDATE marketing_targets SET status='archived' WHERE id=(SELECT target_id FROM marketing_assignments WHERE id=$1)`,[own.assignment]);
    expect(await call()).toEqual({kind:"not_found"});
    await db.query(`UPDATE marketing_targets SET status='active' WHERE id=(SELECT target_id FROM marketing_assignments WHERE id=$1)`,[own.assignment]);
    // Hold the assignment row as a concurrent cancellation would; once committed,
    // the writer must re-evaluate rather than using the old visible status.
    await db.query(`BEGIN`);
    try {
      await db.query(`UPDATE marketing_assignments SET status='canceled' WHERE id=$1`,[own.assignment]);
      const reporting = call();
      await db.query(`COMMIT`);
      expect(await reporting).toEqual({kind:"not_found"});
    } catch (error) { await db.query(`ROLLBACK`); throw error; }
    expect((await db.query(`SELECT id FROM marketing_touchpoints WHERE business_id=$1`,[own.business])).rows).toHaveLength(0);
  });
  it("rechecks a selected-branch revocation after waiting on the membership lock", async () => {
    const own = await business();
    await db.query(`UPDATE users SET location_scope='selected' WHERE id=$1`,[own.user]);
    await db.query(`INSERT INTO user_locations (user_id,location_id) VALUES ($1,$2)`,[own.user,own.location]);
    const input = { assignmentId: own.assignment, leadId: own.lead, channel: "phone" as const, source: "phone" as const, idempotencyKey: randomUUID() };
    const observer = new Client({ connectionString: urlFor(database) }); await observer.connect();
    let committed = false;
    await db.query(`BEGIN`);
    try {
      // Membership writers lock/update users before changing user_locations.
      await db.query(`UPDATE users SET membership_revision=membership_revision+1 WHERE id=$1`,[own.user]);
      await db.query(`DELETE FROM user_locations WHERE user_id=$1`,[own.user]);
      const pending = dbLib.withTenant(own.business, () => touch.recordOwnMarketingTouch(own.business,own.user,[own.location],input));
      let waiting = false;
      for (let attempt=0; attempt<100 && !waiting; attempt++) {
        const result = await observer.query(`SELECT 1 FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock' AND query LIKE '%SELECT x.location_id FROM marketing_assignments x%'`,[database]);
        waiting = !!result.rowCount;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve,20));
      }
      await db.query(`COMMIT`); committed = true;
      expect(waiting).toBe(true);
      expect(await pending).toEqual({kind:"not_found"});
      expect((await observer.query(`SELECT id FROM marketing_touchpoints WHERE business_id=$1`,[own.business])).rows).toHaveLength(0);
    } finally { if (!committed) await db.query(`ROLLBACK`); await observer.end(); }
  }, 20_000);
  it("self-reporting preserves converted-party validation and rolls back on audit failure", async () => {
    const own = await business();
    const otherParty = (await db.query<{id:string}>(`INSERT INTO parties (business_id,name,role,roles) VALUES ($1,'Other','customer',ARRAY['customer']::text[]) RETURNING id`,[own.business])).rows[0].id;
    await db.query(`UPDATE crm_leads SET status='converted', converted_party_id=$1 WHERE id=$2`,[otherParty,own.lead]);
    const input = { assignmentId: own.assignment, leadId: own.lead, channel: "phone" as const, source: "phone" as const, idempotencyKey: randomUUID() };
    const call = () => dbLib.withTenant(own.business, () => touch.recordOwnMarketingTouch(own.business,own.user,[own.location],input));
    expect(await call()).toEqual({kind:"party_mismatch"});
    await db.query(`UPDATE crm_leads SET converted_party_id=$1 WHERE id=$2`,[own.party,own.lead]);
    await db.query(`CREATE FUNCTION reject_self_touch_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'growth.marketing_touch_recorded' THEN RAISE EXCEPTION 'audit unavailable'; END IF; RETURN NEW; END $$`);
    await db.query(`CREATE TRIGGER reject_self_touch_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_self_touch_audit()`);
    try { await expect(call()).rejects.toThrow("audit unavailable"); expect((await db.query(`SELECT id FROM marketing_touchpoints WHERE business_id=$1`,[own.business])).rows).toHaveLength(0); }
    finally { await db.query(`DROP TRIGGER reject_self_touch_audit ON audit_log`); await db.query(`DROP FUNCTION reject_self_touch_audit()`); }
  });
  it("requires same-tenant actors even on direct database inserts", async () => {
    await expect(db.query(`INSERT INTO marketing_touchpoints (business_id,location_id,assignment_id,lead_id,channel,source,idempotency_key,created_by) VALUES ($1,$2,$3,$4,'phone','phone',$5,$6)`, [b.business,b.location,b.assignment,b.lead,randomUUID(),a.user])).rejects.toMatchObject({ code: "23503" });
    await expect(db.query(`INSERT INTO marketing_touchpoints (business_id,location_id,assignment_id,lead_id,channel,source,idempotency_key) VALUES ($1,$2,$3,$4,'phone','phone',$5)`, [b.business,b.location,b.assignment,b.lead,randomUUID()])).rejects.toMatchObject({ code: "23514" });
  });
  it("enforces tenant RLS and blocks cross-tenant writes with a non-bypass role", async () => {
    const role = `marketing_touch_${randomUUID().replaceAll("-", "")}`;
    await db.query(`CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    try {
      await db.query(`GRANT SELECT, INSERT ON marketing_touchpoints TO "${role}"`);
      await db.query(`SET ROLE "${role}"`); await db.query(`SELECT set_config('app.business_id',$1,false)`,[b.business]);
      expect((await db.query(`SELECT id FROM marketing_touchpoints`)).rows).toHaveLength(0);
      await expect(db.query(`INSERT INTO marketing_touchpoints (business_id,location_id,assignment_id,lead_id,channel,source,idempotency_key,created_by) VALUES ($1,$2,$3,$4,'phone','phone',$5,$6)`,[a.business,a.location,a.assignment,a.lead,randomUUID(),a.user])).rejects.toMatchObject({ code: "42501" });
    } finally { await db.query(`RESET ROLE`); await db.query(`DROP OWNED BY "${role}"`); await db.query(`DROP ROLE "${role}"`); }
  });
});
