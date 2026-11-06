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
