/**
 * GitHub #1580 — effective import access against the real tables.
 *
 * The pure matrix and the wiring are unit-tested; this suite proves the gate
 * reads the canonical rows the product actually writes:
 *
 *   - `settings.setup.selectedApps` (the gallery's draft),
 *   - `business_service_activations` (#1041's runtime state),
 *   - `business_complimentary_grants` (#1579's active grant).
 *
 * and that the Data Transfer engine refuses to *apply* without effective access
 * while still allowing staging — the distinction the issue exists for.
 *
 * A grant with no activation row is the interesting case: it must be enough
 * authority to import, because that is exactly what "free trial / indefinite
 * complimentary access" means for onboarding.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let importService: typeof import("../src/lib/data-transfer/import-service");
let entitiesModule: typeof import("../src/lib/data-transfer/entities");

const biz = { id: "", locationId: "" };

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

function asBusiness<T>(businessId: string, fn: () => Promise<T>): Promise<T> {
  return dbLib.withTenant(businessId, fn);
}

beforeAll(async () => {
  databaseName = `pos_importaccess_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }
  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });

  process.env.DATABASE_URL = urlFor(databaseName);
  dbLib = await import("../src/lib/db");
  importService = await import("../src/lib/data-transfer/import-service");
  entitiesModule = await import("../src/lib/data-transfer/entities");
  entitiesModule.ensureAdaptersRegistered();

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();

  const business = await db.query<{ id: string }>(
    `INSERT INTO businesses (name, slug, industry)
     VALUES ('رستوران آزمون دسترسی', $1, 'food_service') RETURNING id`,
    [`ia-${randomUUID().slice(0, 8)}`],
  );
  biz.id = business.rows[0].id;
  const location = await db.query<{ id: string }>(
    `INSERT INTO locations (business_id, name) VALUES ($1, 'شعبهٔ اصلی') RETURNING id`,
    [biz.id],
  );
  biz.locationId = location.rows[0].id;
}, 240_000);

afterAll(async () => {
  await db?.end();
  await dbLib?.closeDatabasePool();
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

beforeEach(async () => {
  await db.query(`DELETE FROM data_import_rows`);
  await db.query(`DELETE FROM data_import_jobs`);
  await db.query(`DELETE FROM settings WHERE business_id = $1 AND key = 'setup.selectedApps'`, [
    biz.id,
  ]);
  await db.query(`DELETE FROM business_complimentary_grants WHERE business_id = $1`, [biz.id]);
  await db.query(`DELETE FROM business_service_activations WHERE business_id = $1`, [biz.id]);
});

async function selectApps(apps: string[] | null): Promise<void> {
  if (apps === null) {
    await db.query(
      `DELETE FROM settings WHERE business_id = $1 AND location_id IS NULL AND key = 'setup.selectedApps'`,
      [biz.id],
    );
    return;
  }
  await db.query(
    `INSERT INTO settings (business_id, location_id, key, value)
     VALUES ($1, NULL, 'setup.selectedApps', $2::jsonb)
     ON CONFLICT (business_id, location_id, key) DO UPDATE SET value = EXCLUDED.value`,
    [biz.id, JSON.stringify({ apps })],
  );
}

async function setActivation(state: string): Promise<void> {
  await db.query(
    `INSERT INTO business_service_activations
       (business_id, service_kind, service_key, state)
     VALUES ($1, 'app', 'accounting', $2)
     ON CONFLICT (business_id, service_kind, service_key, runtime_instance_id)
     DO UPDATE SET state = EXCLUDED.state, updated_at = now()`,
    [biz.id, state],
  );
}

async function setGrant(input: {
  status: "active" | "expired" | "revoked";
  expiresAt: string | null;
}): Promise<void> {
  await db.query(
    `INSERT INTO business_complimentary_grants
       (business_id, service_kind, service_key, source, scope, status, starts_at,
        expires_at, revoked_at)
     VALUES ($1, 'app', 'accounting', 'manual', 'business', $2,
             now() - interval '1 day', $3::timestamptz,
             CASE WHEN $2 = 'revoked' THEN now() ELSE NULL END)`,
    [biz.id, input.status, input.expiresAt],
  );
}

async function upload(entityKey: string, csv: string) {
  return asBusiness(biz.id, () =>
    importService.createImportJob({
      businessId: biz.id,
      locationId: biz.locationId,
      entityKey,
      fileName: "test.csv",
      format: "csv",
      buffer: new TextEncoder().encode(csv).buffer as ArrayBuffer,
      actorUserId: null,
      actorName: "آزمون دسترسی",
    }),
  );
}

const MENU_CSV = "نام,دسته,قیمت\nاسپرسو,نوشیدنی گرم,85\nلاته,نوشیدنی گرم,95\n";

describe("effective import access against canonical rows (#1580)", () => {
  it("keeps a pre-gallery tenant's access (no selection, no activation)", async () => {
    await selectApps(null);
    const { job } = await upload("pos.products", MENU_CSV);
    const queued = await asBusiness(biz.id, () =>
      importService.queueImportJob(biz.id, job.id),
    );
    expect(queued.status).toBe("queued");
  });

  it("stages a selected-but-unactivated app but refuses to apply it", async () => {
    await selectApps(["accounting"]);
    const { job } = await upload("pos.products", MENU_CSV);

    // Staging exists: the file, mapping and preview are durable.
    expect(job.status).toBe("ready");

    await expect(
      asBusiness(biz.id, () => importService.queueImportJob(biz.id, job.id)),
    ).rejects.toThrow("service_not_activated");

    // The refusal changed nothing: the job is still staged, not queued.
    const after = await asBusiness(biz.id, () =>
      importService.getImportJob(biz.id, job.id),
    );
    expect(after?.status).toBe("ready");
  });

  it("applies with an active complimentary grant and no paid activation (#1579)", async () => {
    await selectApps(["accounting"]);
    await setGrant({ status: "active", expiresAt: null });

    const { job } = await upload("pos.products", MENU_CSV);
    const queued = await asBusiness(biz.id, () =>
      importService.queueImportJob(biz.id, job.id),
    );
    expect(queued.status).toBe("queued");
  });

  it("refuses an expired grant instead of treating it as active", async () => {
    await selectApps(["accounting"]);
    await setGrant({
      status: "expired",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });

    const { job } = await upload("pos.products", MENU_CSV);
    // The canonical grant read returns only *active* coverage, so an expired
    // grant leaves the selected app not activated — truthful, and the staged
    // job survives for a later activation.
    await expect(
      asBusiness(biz.id, () => importService.queueImportJob(biz.id, job.id)),
    ).rejects.toThrow("service_not_activated");
    const after = await asBusiness(biz.id, () =>
      importService.getImportJob(biz.id, job.id),
    );
    expect(after?.status).toBe("ready");
  });

  it("applies with an active paid activation", async () => {
    await selectApps(["accounting"]);
    await setActivation("active");

    const { job } = await upload("pos.products", MENU_CSV);
    const queued = await asBusiness(biz.id, () =>
      importService.queueImportJob(biz.id, job.id),
    );
    expect(queued.status).toBe("queued");
  });

  it("refuses a suspended service for applying but still permits staging", async () => {
    await selectApps(["accounting"]);
    await setActivation("suspended_insufficient_credit");

    const { job } = await upload("pos.products", MENU_CSV);
    await expect(
      asBusiness(biz.id, () => importService.queueImportJob(biz.id, job.id)),
    ).rejects.toThrow("service_suspended");
  });

  it("refuses a customer-disabled service for staging and applying", async () => {
    await selectApps(["accounting"]);
    await setActivation("disabled_retained");

    await expect(upload("pos.products", MENU_CSV)).rejects.toThrow("service_disabled");
  });

  it("refuses an app the owner did not select", async () => {
    await selectApps([]);
    await expect(upload("pos.products", MENU_CSV)).rejects.toThrow(
      "service_not_selected",
    );
  });

  it("refuses a Workspace import for a business type without My Workspace (#1110)", async () => {
    // A restaurant is not an eligible Workspace business, whatever it selects.
    await selectApps(["accounting"]);
    await expect(upload("workspace.projects", "نام\nپروژهٔ آزمون\n")).rejects.toThrow(
      "workspace_not_available",
    );
  });

  it("refuses a member's target when the permission axis is asked by the route", async () => {
    // This suite calls the engine directly (permission already enforced); the
    // route-level permission test lives in the API guard suite. Here we only
    // prove that a *service* denial is what stops the write.
    await selectApps(["accounting"]);
    await setActivation("platform_unavailable");
    const { job } = await upload("pos.products", MENU_CSV);
    await expect(
      asBusiness(biz.id, () => importService.queueImportJob(biz.id, job.id)),
    ).rejects.toThrow("service_suspended");
  });
});
