/**
 * §A's agency sales pipeline against a real database (issue #1128).
 *
 * `crm-agency-pipeline.test.ts` pins the preset itself — its invariants, its
 * ordering, its probabilities, the fact that it carries no legacy key and that
 * only `advertising_agency` receives it. None of that can catch what actually
 * matters here, which is the interaction with the pipeline the tenant already
 * has: that the agency's track lands *beside* the universal default rather than
 * replacing it, that creating it twice does not duplicate its stages, that it
 * never steals `is_default`, and that it leaves no deactivated copies of the
 * default's stages behind.
 *
 * That last one is the reason this file exists at all. The obvious
 * implementation — `createPipeline` followed by `savePipelineStages` — type-checks
 * and passes every unit test, and would leave six deactivated rows in the
 * configurator, because `createPipeline` copies the source pipeline's stages and
 * `savePipelineStages` deactivates rather than deletes the ones it is not given.
 * Only a real database shows the mess.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { AGENCY_PIPELINE_NAME, AGENCY_PIPELINE_STAGES } from "../src/lib/crm-agency-pipeline";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let provisioning: typeof import("../src/lib/business-provisioning");
let pipelines: typeof import("../src/lib/crm-pipeline-service");

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

function maintenanceUrl(): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = "/postgres";
  return url.toString();
}

beforeAll(async () => {
  databaseName = `crm_agency_pipeline_${randomUUID().replaceAll("-", "")}`;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });

  // Imported only after the environment points at the throwaway database, so every
  // module below binds its pool to it rather than to the runner's default.
  process.env.DATABASE_URL = urlFor(databaseName);
  dbLib = await import("../src/lib/db");
  provisioning = await import("../src/lib/business-provisioning");
  pipelines = await import("../src/lib/crm-pipeline-service");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
}, 180_000);

afterAll(async () => {
  await db?.end();
  await dbLib?.getPool().end().catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

/* ------------------------------------------------------------------ fixtures */

let seq = 0;

type Tenant = { businessId: string; industry: string };

/** A real tenant, provisioned through the product's own path. */
async function provisionTenant(industry: "advertising_agency" | "jewelry"): Promise<Tenant> {
  seq += 1;
  const result = await provisioning.provisionBusiness({
    businessName: `کسب‌وکار آزمایشی ${seq}`,
    ownerName: "مالک",
    email: `crm-pipeline-${seq}@example.test`,
    password: "correct-horse",
    subdomain: `crmpipe${seq}`,
    industry,
    seedChartOfAccounts: true,
  });
  return { businessId: result.businessId, industry };
}

/** The six stages every trade's default pipeline is seeded with. */
const SEEDED_DEFAULT_NAMES = ["سرنخ", "واجد شرایط", "پیشنهاد", "مذاکره", "برنده", "بازنده"];

describe("the agency sales pipeline against a real database (issue #1128 §A)", () => {
  it("creates the agency's track beside the universal default", async () => {
    const tenant = await provisionTenant("advertising_agency");
    const before = await pipelines.defaultPipeline(tenant.businessId);
    expect(before, "the universal default must exist first").not.toBeNull();

    const agency = await pipelines.ensureAgencySalesPipeline(tenant.businessId);
    expect(agency).not.toBeNull();
    expect(agency!.name).toBe(AGENCY_PIPELINE_NAME);
    expect(agency!.isDefault).toBe(false);
    expect(agency!.id).not.toBe(before!.id);

    // Every stage of the preset, in the preset's order, with the preset's
    // probabilities and outcomes — nothing invented on the way to the database.
    expect(agency!.stages.map((stage) => stage.name)).toEqual(
      AGENCY_PIPELINE_STAGES.map((stage) => stage.name),
    );
    expect(agency!.stages.map((stage) => stage.displayOrder)).toEqual(
      AGENCY_PIPELINE_STAGES.map((stage) => stage.displayOrder),
    );
    for (const [index, stage] of agency!.stages.entries()) {
      expect(stage.defaultProbability, stage.name).toBe(
        AGENCY_PIPELINE_STAGES[index].defaultProbability,
      );
      expect(stage.outcome, stage.name).toBe(AGENCY_PIPELINE_STAGES[index].outcome);
      expect(stage.requirementNote, stage.name).toBe(AGENCY_PIPELINE_STAGES[index].requirementNote);
      expect(stage.isActive, stage.name).toBe(true);
    }
  });

  it("creates the same pipeline twice and writes it once", async () => {
    const tenant = await provisionTenant("advertising_agency");
    await pipelines.defaultPipeline(tenant.businessId);

    const first = await pipelines.ensureAgencySalesPipeline(tenant.businessId);
    const second = await pipelines.ensureAgencySalesPipeline(tenant.businessId);
    expect(first).not.toBeNull();
    expect(second!.id).toBe(first!.id);
    expect(second!.stages).toHaveLength(AGENCY_PIPELINE_STAGES.length);

    // The read path is what the UI calls, so the database is the only witness
    // that a second visit did not append a second copy of every stage.
    const { rows } = await db.query(
      `SELECT count(*)::int AS n FROM crm_pipelines WHERE business_id = $1 AND name = $2`,
      [tenant.businessId, AGENCY_PIPELINE_NAME],
    );
    expect(rows[0].n).toBe(1);

    const stages = await db.query(
      `SELECT count(*)::int AS n FROM crm_pipeline_stages WHERE pipeline_id = $1`,
      [first!.id],
    );
    expect(stages.rows[0].n).toBe(AGENCY_PIPELINE_STAGES.length);
  });

  it("survives two simultaneous first visits", async () => {
    const tenant = await provisionTenant("advertising_agency");
    await pipelines.defaultPipeline(tenant.businessId);

    // `(business_id, name)` is unique and the insert is ON CONFLICT DO NOTHING,
    // which is the same trick defaultPipeline relies on: two first-loads produce
    // one pipeline, and the loser of the race reads what the winner wrote.
    const [a, b] = await Promise.all([
      pipelines.ensureAgencySalesPipeline(tenant.businessId),
      pipelines.ensureAgencySalesPipeline(tenant.businessId),
    ]);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.id).toBe(b!.id);

    const { rows } = await db.query(
      `SELECT count(*)::int AS n FROM crm_pipelines WHERE business_id = $1 AND name = $2`,
      [tenant.businessId, AGENCY_PIPELINE_NAME],
    );
    expect(rows[0].n).toBe(1);
  });

  it("never steals the default, and leaves the seeded six exactly as they were", async () => {
    const tenant = await provisionTenant("advertising_agency");
    const before = await pipelines.defaultPipeline(tenant.businessId);
    await pipelines.ensureAgencySalesPipeline(tenant.businessId);

    const after = await pipelines.defaultPipeline(tenant.businessId);
    expect(after!.id, "the default must still be the same pipeline").toBe(before!.id);
    expect(after!.isDefault).toBe(true);

    const { rows } = await db.query(
      `SELECT count(*)::int AS n FROM crm_pipelines WHERE business_id = $1 AND is_default`,
      [tenant.businessId],
    );
    expect(rows[0].n, "exactly one pipeline may be the default").toBe(1);

    // The universal default keeps its own six stages, by name and still active.
    expect(after!.stages.map((stage) => stage.name)).toEqual(SEEDED_DEFAULT_NAMES);
    expect(after!.stages.every((stage) => stage.isActive)).toBe(true);

    // And the composition route this deliberately avoids would have left these
    // behind: createPipeline copies the source stages, savePipelineStages
    // deactivates the ones it is not given, so six dead rows would sit in the
    // configurator next to the seven live ones.
    const dead = await db.query(
      `SELECT count(*)::int AS n FROM crm_pipeline_stages
        WHERE business_id = $1 AND is_active = false`,
      [tenant.businessId],
    );
    expect(dead.rows[0].n, "no stage anywhere should have been deactivated").toBe(0);
  });

  it("writes nothing at all for a trade that is not an agency", async () => {
    const tenant = await provisionTenant("jewelry");
    const before = await pipelines.defaultPipeline(tenant.businessId);

    const agency = await pipelines.ensureAgencySalesPipeline(tenant.businessId);
    expect(agency).toBeNull();

    const { rows } = await db.query(
      `SELECT count(*)::int AS n FROM crm_pipelines WHERE business_id = $1`,
      [tenant.businessId],
    );
    expect(rows[0].n, "only the universal default should exist").toBe(1);
    expect(before!.name).not.toBe(AGENCY_PIPELINE_NAME);
  });

  it("carries no legacy key, so legacy-vocabulary reports cannot mistake it for the seeded six", async () => {
    const tenant = await provisionTenant("advertising_agency");
    await pipelines.defaultPipeline(tenant.businessId);
    const agency = await pipelines.ensureAgencySalesPipeline(tenant.businessId);

    const { rows } = await db.query(
      `SELECT name, legacy_key FROM crm_pipeline_stages WHERE pipeline_id = $1 ORDER BY display_order`,
      [agency!.id],
    );
    expect(rows).toHaveLength(AGENCY_PIPELINE_STAGES.length);
    for (const row of rows) {
      expect(row.legacy_key, row.name).toBeNull();
    }

    // The default's stages keep theirs, which is what makes the two distinguishable.
    const seeded = await db.query(
      `SELECT legacy_key FROM crm_pipeline_stages s
         JOIN crm_pipelines p ON p.id = s.pipeline_id
        WHERE p.business_id = $1 AND p.is_default`,
      [tenant.businessId],
    );
    expect(seeded.rows.every((row) => row.legacy_key !== null)).toBe(true);
  });

  it("holds the two invariants the board depends on, as rows rather than as a promise", async () => {
    const tenant = await provisionTenant("advertising_agency");
    await pipelines.defaultPipeline(tenant.businessId);
    const agency = await pipelines.ensureAgencySalesPipeline(tenant.businessId);

    const { rows } = await db.query(
      `SELECT outcome, count(*)::int AS n FROM crm_pipeline_stages
        WHERE pipeline_id = $1 AND is_active GROUP BY outcome`,
      [agency!.id],
    );
    const byOutcome = Object.fromEntries(rows.map((row) => [row.outcome, row.n]));
    // Without an open stage no deal can be created; without a won stage the win
    // rate is structurally zero.
    expect(byOutcome.open).toBeGreaterThan(0);
    expect(byOutcome.won).toBe(1);
    expect(byOutcome.lost).toBe(1);

    // A forecast multiplies value by probability, so the open stages must rise.
    const open = agency!.stages.filter((stage) => stage.outcome === "open");
    for (let index = 1; index < open.length; index += 1) {
      expect(open[index].defaultProbability, open[index].name).toBeGreaterThan(
        open[index - 1].defaultProbability,
      );
    }
  });

  it("leaves a stage the agency renamed alone on the next visit", async () => {
    const tenant = await provisionTenant("advertising_agency");
    await pipelines.defaultPipeline(tenant.businessId);
    const agency = await pipelines.ensureAgencySalesPipeline(tenant.businessId);

    // A preset orders and labels; it never gates, and it must not undo an edit
    // either. The insert is ON CONFLICT DO NOTHING, so a renamed stage is simply
    // not matched and not rewritten — but the read path only seeds when the
    // pipeline has *no* stages, so this is the case that proves it.
    await db.query(`UPDATE crm_pipeline_stages SET name = 'ارزیابی اولیه' WHERE id = $1`, [
      agency!.stages[0].id,
    ]);

    const again = await pipelines.ensureAgencySalesPipeline(tenant.businessId);
    expect(again!.id).toBe(agency!.id);
    expect(again!.stages.map((stage) => stage.name)).toContain("ارزیابی اولیه");
    expect(again!.stages.map((stage) => stage.name)).not.toContain(AGENCY_PIPELINE_STAGES[0].name);
  });
});
