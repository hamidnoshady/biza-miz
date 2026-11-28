/**
 * GH #1567 Phase 6A — tailoring. The privacy and schema cases are blockers:
 * measurements are ciphertext at rest, versioned, minimal (no photo/free-text
 * column), every access is logged append-only, erase and retention remove the
 * values, and another tenant sees nothing. The workflow runs intake → pickup
 * with the sale linked through an ordinary order.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) throw new Error("DATABASE_URL is required for database integration tests");

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let tailoring: typeof import("../src/lib/tailoring-service");
const previousKey = process.env.POS_MASTER_KEY;

const urlFor = (database: string) => { const url = new URL(rootDatabaseUrl!); url.pathname = `/${database}`; return url.toString(); };

const A = { id: "", locationId: "", otherLocationId: "", partyId: "", otherPartyId: "" };
const B = { id: "", locationId: "", partyId: "" };
const actorA = () => ({ businessId: A.id, userId: null, name: "خیاط آزمون" });
const actorB = () => ({ businessId: B.id, userId: null, name: "دیگری" });

async function seed(label: string) {
  const { rows: [biz] } = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug, industry) VALUES ($1, $2, 'fashion_apparel') RETURNING id", [label, `t-${randomUUID().slice(0, 8)}`]);
  const { rows: [loc] } = await db.query<{ id: string }>("INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id", [biz.id]);
  const { rows: [party] } = await db.query<{ id: string }>(
    "INSERT INTO parties (business_id, name, role) VALUES ($1, 'مشتری آزمون', 'customer') RETURNING id", [biz.id]);
  return { id: biz.id, locationId: loc.id, partyId: party.id };
}

beforeAll(async () => {
  process.env.POS_MASTER_KEY = randomBytes(32).toString("base64");
  databaseName = `pos_tailoring_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: urlFor("postgres") });
  await maintenance.connect();
  try { await maintenance.query(`CREATE DATABASE "${databaseName}"`); } finally { await maintenance.end(); }
  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });
  process.env.DATABASE_URL = urlFor(databaseName);
  dbLib = await import("../src/lib/db");
  tailoring = await import("../src/lib/tailoring-service");
  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
  Object.assign(A, await seed("Tailor A"));
  A.otherLocationId = (await db.query<{ id: string }>("INSERT INTO locations (business_id, name) VALUES ($1, 'Second') RETURNING id", [A.id])).rows[0].id;
  A.otherPartyId = (await db.query<{ id: string }>("INSERT INTO parties (business_id, name, role) VALUES ($1, 'دیگر', 'customer') RETURNING id", [A.id])).rows[0].id;
  Object.assign(B, await seed("Tailor B"));
}, 120_000);

afterAll(async () => {
  if (previousKey === undefined) delete process.env.POS_MASTER_KEY; else process.env.POS_MASTER_KEY = previousKey;
  await db?.end();
  await dbLib?.getPool().end().catch(() => {});
  const maintenance = new Client({ connectionString: urlFor("postgres") });
  await maintenance.connect();
  try { await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`); } finally { await maintenance.end(); }
});

const TABLES = ["tailoring_settings", "tailoring_measurement_profiles", "tailoring_measurement_access_log", "tailoring_jobs", "tailoring_job_events"];

describe("schema (blocker)", () => {
  it("every tailoring table has forced RLS with the tenant policy", async () => {
    const { rows } = await db.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean; policies: string }>(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
              (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation')::text AS policies
         FROM pg_class c WHERE c.relname = ANY($1) ORDER BY c.relname`, [TABLES]);
    expect(rows).toHaveLength(TABLES.length);
    for (const row of rows) expect(row, row.relname).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true, policies: "1" });
  });

  it("has no photo / image / media / file column and no plaintext measurement column", async () => {
    const { rows } = await db.query<{ table_name: string; column_name: string; data_type: string }>(
      "SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema='public' AND table_name = ANY($1)", [TABLES]);
    expect(rows.filter(row => /(^|_)(photo|image|media|picture|file|attachment|scan)s?(_|$)/i.test(row.column_name))).toEqual([]);
    const profile = rows.filter(row => row.table_name === "tailoring_measurement_profiles").map(row => `${row.column_name}:${row.data_type}`).sort();
    expect(profile).toEqual(["business_id:uuid", "erased_at:timestamp with time zone", "erased_reason:text", "field_count:smallint", "id:uuid",
      "measurements_enc:bytea", "party_id:uuid", "recorded_at:timestamp with time zone", "recorded_by:uuid",
      "superseded_at:timestamp with time zone", "unit:text", "version:integer"]);
  });
});

describe("measurements privacy (blocker)", () => {
  it("stores only POSFLD1 ciphertext — no key name or value in the row — and versions instead of overwriting", async () => {
    const v1 = await tailoring.recordMeasurements(actorA(), A.partyId, { unit: "cm", values: { chest: 96.5, waist: 81 } });
    const v2 = await tailoring.recordMeasurements(actorA(), A.partyId, { unit: "cm", values: { chest: 97, waist: 82, hip: 101 } });
    expect([v1.version, v2.version]).toEqual([1, 2]);
    const { rows } = await db.query<{ version: number; enc: Buffer; superseded_at: Date | null; field_count: number }>(
      "SELECT version, measurements_enc AS enc, superseded_at, field_count FROM tailoring_measurement_profiles WHERE party_id=$1 ORDER BY version", [A.partyId]);
    expect(rows.map(row => [row.version, row.superseded_at !== null, row.field_count])).toEqual([[1, true, 2], [2, false, 3]]);
    for (const row of rows) {
      expect(row.enc.subarray(0, 7).toString("latin1")).toBe("POSFLD1");
      const text = row.enc.toString("latin1");
      expect(text).not.toMatch(/chest|waist|hip|96\.5|"cm"/);
    }
    await expect(tailoring.recordMeasurements(actorA(), A.partyId, { unit: "cm", values: { photo: 1 } })).rejects.toThrow("tailoring_measurements_invalid");
  });

  it("view decrypts only the current version, needs a purpose and is logged; export returns every version and is logged", async () => {
    const view = await tailoring.viewMeasurements(actorA(), A.partyId, "پرو دوم");
    expect(view.current).toMatchObject({ version: 2, measurements: { unit: "cm", values: { chest: 97, waist: 82, hip: 101 } } });
    expect(view.versions.map(v => v.version)).toEqual([2, 1]);
    expect(view.versions.every(v => !("measurements" in v) && !("enc" in v))).toBe(true);
    const exported = await tailoring.exportMeasurements(actorA(), A.partyId);
    expect(exported.versions.map(v => v.measurements?.values.chest)).toEqual([96.5, 97]);
    const log = await tailoring.measurementAccessLog(actorA(), A.partyId);
    expect(log.map(entry => entry.action)).toEqual(["export", "view", "record", "record"]);
    expect(log.find(entry => entry.action === "view")).toMatchObject({ purpose: "پرو دوم", actorName: "خیاط آزمون" });
  });

  it("the access log is append-only", async () => {
    await expect(db.query("UPDATE tailoring_measurement_access_log SET purpose = 'x'")).rejects.toThrow(/append-only/);
    await expect(db.query("DELETE FROM tailoring_measurement_access_log")).rejects.toThrow(/append-only/);
  });

  it("another tenant cannot read, record or erase this customer's measurements, and RLS hides the rows", async () => {
    await expect(tailoring.viewMeasurements(actorB(), A.partyId, "کنجکاوی")).rejects.toThrow("tailoring_party_not_found");
    await expect(tailoring.recordMeasurements(actorB(), A.partyId, { unit: "cm", values: { chest: 90 } })).rejects.toThrow("tailoring_party_not_found");
    await expect(tailoring.eraseMeasurements(actorB(), A.partyId, "حذف")).rejects.toThrow("tailoring_party_not_found");
    // RLS as a non-superuser application role would see it (superusers bypass RLS).
    const visibleTo = async (businessId: string) => {
      const role = `tailor_rls_${randomUUID().slice(0, 8)}`;
      await db.query("BEGIN");
      try {
        await db.query(`CREATE ROLE ${role} NOLOGIN`);
        await db.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
        await db.query(`GRANT SELECT ON tailoring_measurement_profiles, tailoring_measurement_access_log TO ${role}`);
        await db.query(`SET LOCAL ROLE ${role}`);
        await db.query("SELECT set_config('app.business_id', $1, true), set_config('app.rls_bypass', '', true)", [businessId]);
        const { rows: [row] } = await db.query<{ p: number; l: number }>(
          "SELECT (SELECT count(*) FROM tailoring_measurement_profiles)::int AS p, (SELECT count(*) FROM tailoring_measurement_access_log)::int AS l");
        return row;
      } finally {
        await db.query("ROLLBACK");
      }
    };
    expect(await visibleTo(B.id)).toEqual({ p: 0, l: 0 });
    expect((await visibleTo(A.id)).p).toBeGreaterThan(0);
  });

  it("erase removes every value but keeps the version history and the log", async () => {
    await tailoring.recordMeasurements(actorA(), A.otherPartyId, { unit: "in", values: { neck: 15.5 } });
    expect(await tailoring.eraseMeasurements(actorA(), A.otherPartyId, "درخواست مشتری")).toEqual({ erased: 1 });
    const { rows } = await db.query("SELECT measurements_enc, erased_at, erased_reason FROM tailoring_measurement_profiles WHERE party_id=$1", [A.otherPartyId]);
    expect(rows).toEqual([expect.objectContaining({ measurements_enc: null, erased_reason: "درخواست مشتری" })]);
    expect((await tailoring.viewMeasurements(actorA(), A.otherPartyId, "بررسی")).current).toBeNull();
    expect((await tailoring.exportMeasurements(actorA(), A.otherPartyId)).versions[0].measurements).toBeNull();
    expect((await tailoring.measurementAccessLog(actorA(), A.otherPartyId)).map(e => e.action)).toContain("erase");
  });

  it("retention: dry-run changes nothing; apply erases superseded versions past the cutoff and keeps the current one of an active customer", async () => {
    await tailoring.setRetentionDays(actorA(), 30);
    await db.query("UPDATE tailoring_measurement_profiles SET recorded_at = now() - interval '90 days' WHERE party_id=$1 AND version=1", [A.partyId]);
    const dry = await tailoring.purgeExpiredMeasurements(actorA(), { apply: false });
    expect(dry).toMatchObject({ retentionDays: 30, versions: 1, customers: 1, applied: false });
    expect((await db.query("SELECT count(*)::int AS n FROM tailoring_measurement_profiles WHERE erased_at IS NULL AND party_id=$1", [A.partyId])).rows[0].n).toBe(2);
    expect(await tailoring.purgeExpiredMeasurements(actorA(), { apply: true })).toMatchObject({ versions: 1, applied: true });
    const { rows } = await db.query<{ version: number; erased: boolean }>(
      "SELECT version, erased_at IS NOT NULL AS erased FROM tailoring_measurement_profiles WHERE party_id=$1 ORDER BY version", [A.partyId]);
    expect(rows).toEqual([{ version: 1, erased: true }, { version: 2, erased: false }]);
    expect((await tailoring.measurementAccessLog(actorA(), A.partyId)).filter(e => e.action === "purge")).toHaveLength(1);
    // An inactive customer (nothing since the cutoff, no open job) loses every version.
    await db.query("UPDATE tailoring_measurement_profiles SET recorded_at = now() - interval '90 days' WHERE party_id=$1", [A.partyId]);
    expect(await tailoring.purgeExpiredMeasurements(actorA(), { apply: true })).toMatchObject({ versions: 1 });
    await expect(tailoring.setRetentionDays(actorA(), 5)).rejects.toThrow("tailoring_retention_invalid");
  });
});

describe("workflow: intake → estimate → approval → fitting → QC → pickup through an ordinary order", () => {
  it("runs the job, reworks once, refuses pickup until the sale is linked, and logs every step", async () => {
    const profile = await tailoring.recordMeasurements(actorA(), A.partyId, { unit: "cm", values: { chest: 98 } });
    let job = await tailoring.createTailoringJob(actorA(), { locationId: A.locationId, partyId: A.partyId, kind: "made_to_measure",
      description: "کت و شلوار سفارشی", measurementProfileId: profile.id, dueDate: "2026-12-20" });
    expect(job).toMatchObject({ status: "intake", version: 1, partyName: "مشتری آزمون" });
    expect(Object.keys(job)).not.toContain("measurements");
    expect(JSON.stringify(job)).not.toMatch(/chest/);
    const step = async (input: Parameters<typeof tailoring.transitionTailoringJob>[2]) => (job = await tailoring.transitionTailoringJob(actorA(), job.id, input));
    await step({ to: "estimated", estimateRial: BigInt(12_000_000), expectedVersion: 1 });
    await expect(tailoring.transitionTailoringJob(actorA(), job.id, { to: "approved", expectedVersion: job.version }))
      .rejects.toThrow("tailoring_customer_approval_required");
    await expect(tailoring.transitionTailoringJob(actorA(), job.id, { to: "approved", customerApproved: true, expectedVersion: 1 }))
      .rejects.toThrow("tailoring_job_changed");
    await step({ to: "approved", customerApproved: true, expectedVersion: job.version });
    await expect(tailoring.transitionTailoringJob(actorA(), job.id, { to: "qc", expectedVersion: job.version })).rejects.toThrow("tailoring_fitting_required");
    await step({ to: "fitting", expectedVersion: job.version });
    await step({ to: "qc", expectedVersion: job.version });
    await step({ to: "fitting", qcPassed: false, note: "سرشانه تنگ", expectedVersion: job.version });
    await step({ to: "qc", expectedVersion: job.version });
    await step({ to: "ready", qcPassed: true, expectedVersion: job.version });
    expect(job).toMatchObject({ status: "ready", fittingCount: 2, reworkCount: 1, estimateRial: "12000000" });
    await expect(tailoring.transitionTailoringJob(actorA(), job.id, { to: "picked_up", expectedVersion: job.version })).rejects.toThrow("tailoring_order_required");

    const order = async (locationId: string, customerId: string | null) => (await db.query<{ id: string }>(
      `INSERT INTO orders (location_id, order_number, status, total, customer_id) VALUES ($1, $2, 'completed', 12000000, $3) RETURNING id`,
      [locationId, Math.floor(Math.random() * 1e9), customerId])).rows[0].id;
    await expect(tailoring.linkTailoringJobOrder(actorA(), job.id, await order(A.otherLocationId, A.partyId))).rejects.toThrow("tailoring_order_mismatch");
    await expect(tailoring.linkTailoringJobOrder(actorA(), job.id, await order(A.locationId, A.otherPartyId))).rejects.toThrow("tailoring_order_mismatch");
    await expect(tailoring.linkTailoringJobOrder(actorB(), job.id, await order(A.locationId, A.partyId))).rejects.toThrow("tailoring_job_not_found");
    job = await tailoring.linkTailoringJobOrder(actorA(), job.id, await order(A.locationId, A.partyId));
    await step({ to: "picked_up", expectedVersion: job.version });
    const { events } = await tailoring.getTailoringJob(actorA(), job.id);
    expect(events.map(e => e.toStatus)).toEqual(["intake", "estimated", "approved", "fitting", "qc", "fitting", "qc", "ready", "picked_up"]);
    expect(events[5]).toMatchObject({ fromStatus: "qc", note: "سرشانه تنگ" });
    // Picked up is terminal; another tenant sees no job.
    await expect(tailoring.transitionTailoringJob(actorA(), job.id, { to: "cancelled", expectedVersion: job.version })).rejects.toThrow("tailoring_transition_invalid");
    expect(await tailoring.listTailoringJobs(actorB(), A.locationId)).toEqual([]);
    expect((await tailoring.listTailoringJobs(actorA(), A.locationId, "picked_up")).map(j => j.id)).toEqual([job.id]);
  });

  it("an alteration may skip fitting and a free one is picked up without an order; a foreign or erased profile is refused", async () => {
    let job = await tailoring.createTailoringJob(actorA(), { locationId: A.locationId, partyId: A.partyId, kind: "alteration", description: "کوتاه کردن شلوار" });
    for (const input of [{ to: "estimated", estimateRial: BigInt(0) }, { to: "approved", customerApproved: true }, { to: "qc" },
      { to: "ready", qcPassed: true }, { to: "picked_up" }] as const) {
      job = await tailoring.transitionTailoringJob(actorA(), job.id, { ...input, expectedVersion: job.version });
    }
    expect(job.status).toBe("picked_up");
    const erased = (await db.query<{ id: string }>("SELECT id FROM tailoring_measurement_profiles WHERE party_id=$1", [A.otherPartyId])).rows[0].id;
    await expect(tailoring.createTailoringJob(actorA(), { locationId: A.locationId, partyId: A.otherPartyId, kind: "alteration",
      description: "x", measurementProfileId: erased })).rejects.toThrow("tailoring_profile_not_found");
    await expect(tailoring.createTailoringJob(actorB(), { locationId: B.locationId, partyId: A.partyId, kind: "alteration", description: "x" }))
      .rejects.toThrow("tailoring_party_not_found");
  });
});

describe("party merge never moves or strands live measurements (GH #1567 C2)", () => {
  async function customer(name: string): Promise<string> {
    return (await db.query<{ id: string }>("INSERT INTO parties (business_id, name, role) VALUES ($1, $2, 'customer') RETURNING id", [A.id, name])).rows[0].id;
  }

  it("refuses a merge while the archived side holds live measurements, then allows it once they are erased", async () => {
    const crm = await import("../src/lib/crm-service");
    const winner = await customer("سارا (پروندهٔ اصلی)");
    const loser = await customer("سارا (تکراری)");
    await tailoring.recordMeasurements(actorA(), winner, { unit: "cm", values: { chest: 90 } });
    const loserProfile = await tailoring.recordMeasurements(actorA(), loser, { unit: "cm", values: { chest: 91 } });
    const job = await tailoring.createTailoringJob(actorA(), { locationId: A.locationId, partyId: loser, kind: "made_to_measure",
      description: "مانتو", measurementProfileId: loserProfile.id, dueDate: "2026-12-20" });

    const preview = await crm.previewMerge(A.id, winner, loser);
    expect(preview?.blockers).toEqual([{ table: "tailoring_measurement_profiles", label: "اندازه‌های بدن (خیاطی)", count: 1 }]);
    const refused = await crm.mergeCustomers(A.id, winner, loser).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(crm.PartyMergeRefusedError);
    expect((refused as InstanceType<typeof crm.PartyMergeRefusedError>).code).toBe("party_merge_blocked");
    // Nothing moved: the job, the profile and the loser itself are untouched.
    const state = async () => (await db.query<{ job_party: string; merged: string | null; active: boolean }>(
      `SELECT (SELECT party_id FROM tailoring_jobs WHERE id = $1) AS job_party, merged_into_id AS merged, is_active AS active
         FROM parties WHERE id = $2`, [job.id, loser])).rows[0];
    expect(await state()).toEqual({ job_party: loser, merged: null, active: true });
    const versions = async (party: string) => (await db.query<{ version: number }>(
      "SELECT version FROM tailoring_measurement_profiles WHERE party_id = $1 ORDER BY version", [party])).rows.map((r) => r.version);
    expect(await versions(winner)).toEqual([1]);
    expect(await versions(loser)).toEqual([1]);

    // After an explicit, reasoned erase the merge goes through. The erased row
    // (no body data) and the access log stay with the archived record; the
    // winner's own history is not interleaved with it.
    await tailoring.eraseMeasurements(actorA(), loser, "ادغام پرونده‌های تکراری");
    expect((await crm.previewMerge(A.id, winner, loser))?.blockers).toEqual([]);
    expect(await crm.mergeCustomers(A.id, winner, loser)).toMatchObject({ winnerId: winner, loserId: loser });
    expect(await state()).toMatchObject({ job_party: winner, merged: winner });
    expect(await versions(winner)).toEqual([1]);
    expect(await versions(loser)).toEqual([1]);
    const log = await db.query<{ party_id: string }>("SELECT DISTINCT party_id FROM tailoring_measurement_access_log WHERE party_id = ANY($1)", [[winner, loser]]);
    expect(log.rows.map((r) => r.party_id).sort()).toEqual([winner, loser].sort());
  });

  it("a winner's own measurements never block (nothing of theirs moves)", async () => {
    const crm = await import("../src/lib/crm-service");
    const winner = await customer("مینا");
    const loser = await customer("مینا ۲");
    await tailoring.recordMeasurements(actorA(), winner, { unit: "cm", values: { waist: 70 } });
    expect((await crm.previewMerge(A.id, winner, loser))?.blockers).toEqual([]);
    expect(await crm.mergeCustomers(A.id, winner, loser)).toMatchObject({ winnerId: winner });
  });
});
