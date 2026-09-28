import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, type Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) throw new Error("DATABASE_URL is required for database integration tests");
let localDb: string;
let centralDb: string;
const globalForPg = globalThis as unknown as { pgPool?: Pool };

function urlFor(database: string): string { const url = new URL(rootDatabaseUrl!); url.pathname = `/${database}`; return url.toString(); }
function maintenanceUrl(): string { const url = new URL(rootDatabaseUrl!); url.pathname = "/postgres"; return url.toString(); }
async function createDatabase(name: string) {
  const client = new Client({ connectionString: maintenanceUrl() });
  await client.connect();
  try { await client.query(`CREATE DATABASE "${name}"`); } finally { await client.end(); }
  await runMigrations({ databaseUrl: urlFor(name), quiet: true });
}
async function dropDatabase(name: string) {
  const client = new Client({ connectionString: maintenanceUrl() });
  await client.connect();
  try { await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`); } finally { await client.end(); }
}

beforeAll(async () => {
  localDb = `pos_convert_local_${randomUUID().replaceAll("-", "")}`;
  centralDb = `pos_convert_cloud_${randomUUID().replaceAll("-", "")}`;
  await createDatabase(localDb);
  await createDatabase(centralDb);
  process.env.DATABASE_URL = urlFor(localDb);
}, 180_000);

afterAll(async () => {
  await globalForPg.pgPool?.end().catch(() => {});
  delete globalForPg.pgPool;
  process.env.DATABASE_URL = rootDatabaseUrl;
  await dropDatabase(localDb);
  await dropDatabase(centralDb);
}, 60_000);

describe("safe Local to Hybrid conversion", () => {
  it("bootstraps without activation, refuses merge, then activates only after credential verification", async () => {
    const { provisionBusiness } = await import("../src/lib/business-provisioning");
    const { withTenant, query } = await import("../src/lib/db");
    const { runLocalToHybridConversion } = await import("../scripts/convert-local-to-hybrid");
    const created = await provisionBusiness({
      businessName: "Local Conversion Cafe", ownerName: "Owner",
      email: `conversion-${randomUUID()}@example.com`, password: "correct-horse", seedChartOfAccounts: true,
    });
    await withTenant(created.businessId, () => query(
      `INSERT INTO orders(location_id,order_number,status,subtotal,total) VALUES($1,7001,'open',2500,2500)`,
      [created.locationId],
    ));
    const membership = await withTenant(created.businessId, () => query<{ id: string }>(
      "SELECT id FROM users WHERE business_id=$1 AND role='owner'",
      [created.businessId],
    ));
    const cloudSetup = new Client({ connectionString: urlFor(centralDb) });
    await cloudSetup.connect();
    const cloudIdentity = await cloudSetup.query<{ id: string }>(
      `INSERT INTO platform_users(email,password_hash,full_name)
       VALUES($1,'cloud-owned-test-hash','Cloud Owner') RETURNING id`,
      [`cloud-${randomUUID()}@example.com`],
    );
    await cloudSetup.end();
    const identityMapPath = join(tmpdir(), `local-to-hybrid-${randomUUID()}.json`);
    await writeFile(identityMapPath, JSON.stringify({ [membership.rows[0].id]: cloudIdentity.rows[0].id }));
    const args = {
      businessId: created.businessId, centralUrl: urlFor(centralDb), remoteUrl: "https://cloud.example.test",
      activate: false, yes: true, identityMapPath,
    };
    await runLocalToHybridConversion(args);

    const local = new Client({ connectionString: urlFor(localDb) });
    const central = new Client({ connectionString: urlFor(centralDb) });
    await Promise.all([local.connect(), central.connect()]);
    try {
      const profile = await local.query<{ profile: string }>(
        `SELECT COALESCE((SELECT value->>'profile' FROM settings WHERE business_id=$1 AND key='deployment.profile'),'local') profile`, [created.businessId],
      );
      expect(profile.rows[0].profile).toBe("local");
      const config = await local.query<{ value: { enabled: boolean } }>(
        "SELECT value FROM settings WHERE business_id=$1 AND key='server_sync.config'", [created.businessId],
      );
      expect(config.rows[0].value.enabled).toBe(false);
      expect((await central.query("SELECT 1 FROM businesses WHERE id=$1", [created.businessId])).rowCount).toBe(1);
      expect((await central.query("SELECT 1 FROM orders WHERE location_id=$1 AND order_number=7001", [created.locationId])).rowCount).toBe(1);
      expect((await central.query("SELECT 1 FROM site_sync_credentials WHERE business_id=$1", [created.businessId])).rowCount).toBe(1);
    } finally { await Promise.all([local.end(), central.end()]); }

    await expect(runLocalToHybridConversion(args)).rejects.toThrow("cloud_business_already_exists");
    await runLocalToHybridConversion({ ...args, activate: true });
    const verified = new Client({ connectionString: urlFor(localDb) });
    await verified.connect();
    try {
      const rows = await verified.query<{ profile: string; enabled: boolean }>(
        `SELECT max(CASE WHEN key='deployment.profile' THEN value->>'profile' END) profile,
                bool_or(CASE WHEN key='server_sync.config' THEN (value->>'enabled')::boolean ELSE false END) enabled
           FROM settings WHERE business_id=$1`, [created.businessId],
      );
      expect(rows.rows[0]).toEqual({ profile: "hybrid", enabled: true });
    } finally { await verified.end(); }
  }, 120_000);
});
