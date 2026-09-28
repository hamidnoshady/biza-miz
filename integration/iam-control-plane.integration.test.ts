import { randomUUID } from "node:crypto";
import { Client, type Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) throw new Error("DATABASE_URL is required for database integration tests");
const globalForPg = globalThis as unknown as { pgPool?: Pool };
let databaseName: string;

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
  databaseName = `pos_iam_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try { await maintenance.query(`CREATE DATABASE "${databaseName}"`); } finally { await maintenance.end(); }
  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });
  await globalForPg.pgPool?.end().catch(() => {});
  delete globalForPg.pgPool;
  process.env.DATABASE_URL = urlFor(databaseName);
}, 180_000);

afterAll(async () => {
  await globalForPg.pgPool?.end().catch(() => {});
  delete globalForPg.pgPool;
  process.env.DATABASE_URL = rootDatabaseUrl;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try { await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`); } finally { await maintenance.end(); }
});

async function appendConcurrentEvent(businessId: string, memberId: string, index: number): Promise<number> {
  const { getPool, withTenant } = await import("../src/lib/db");
  const { appendIamEvent } = await import("../src/lib/iam/service");
  return withTenant(businessId, async () => {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      const sequence = await appendIamEvent(client, {
        businessId,
        type: "membership.profile_updated",
        entityId: memberId,
        payload: { revision: index + 2, changes: { fullName: `Owner ${index}` } },
        actorUserId: memberId,
        origin: "cloud",
      });
      await client.query("COMMIT");
      return sequence;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally { client.release(); }
  });
}

describe("IAM control-plane database invariants", () => {
  it("allocates one contiguous per-business sequence under concurrent writers", async () => {
    const { provisionBusiness } = await import("../src/lib/business-provisioning");
    const { query, withoutTenantScope } = await import("../src/lib/db");
    const business = await provisionBusiness({
      businessName: "Concurrent IAM", ownerName: "Owner",
      email: `iam-${randomUUID()}@example.com`, password: "correct-horse", seedChartOfAccounts: false,
    });

    const allocated = await Promise.all(Array.from({ length: 12 }, (_, index) =>
      appendConcurrentEvent(business.businessId, business.userId, index),
    ));
    expect([...allocated].sort((a, b) => a - b)).toEqual(Array.from({ length: 12 }, (_, index) => index + 1));

    const persisted = await withoutTenantScope("iam integration setup", () => query<{ sequence: string }>(
      "SELECT sequence FROM iam_events WHERE business_id=$1 ORDER BY sequence",
      [business.businessId],
    ));
    expect(persisted.rows.map((row) => Number(row.sequence))).toEqual(Array.from({ length: 12 }, (_, index) => index + 1));
  });

  it("rejects a site overlay that mixes tenants", async () => {
    const { provisionBusiness } = await import("../src/lib/business-provisioning");
    const { query, withoutTenantScope } = await import("../src/lib/db");
    const alpha = await provisionBusiness({ businessName: "IAM Alpha", ownerName: "Alpha", email: `alpha-${randomUUID()}@example.com`, password: "correct-horse", seedChartOfAccounts: false });
    const beta = await provisionBusiness({ businessName: "IAM Beta", ownerName: "Beta", email: `beta-${randomUUID()}@example.com`, password: "correct-horse", seedChartOfAccounts: false });
    const siteId = randomUUID();
    await withoutTenantScope("iam integration setup", () => query(
      `INSERT INTO site_devices(id,business_id,location_id,public_id,display_name)
       VALUES($1,$2,$3,$4,'Alpha site')`,
      [siteId, alpha.businessId, alpha.locationId, randomUUID()],
    ));

    await expect(withoutTenantScope("iam integration setup", () => query(
      `INSERT INTO site_member_access(business_id,site_device_id,user_id)
       VALUES($1,$2,$3)`,
      [beta.businessId, siteId, beta.userId],
    ))).rejects.toMatchObject({ code: "23503" });
  });
});
