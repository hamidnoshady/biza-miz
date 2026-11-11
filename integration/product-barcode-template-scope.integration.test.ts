import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootUrl = process.env.DATABASE_URL;
if (!rootUrl) throw new Error("DATABASE_URL is required for database integration tests");
let databaseName: string;
let client: Client;
let db: typeof import("../src/lib/db");
let service: typeof import("../src/lib/weight-barcode-templates-service");
let businessId: string;
let branchA: string;
let branchB: string;

function databaseUrl(database: string): string {
  const url = new URL(rootUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

beforeAll(async () => {
  databaseName = `pos_barcode_scope_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: databaseUrl("postgres") });
  await maintenance.connect();
  try { await maintenance.query(`CREATE DATABASE "${databaseName}"`); } finally { await maintenance.end(); }
  await runMigrations({ databaseUrl: databaseUrl(databaseName), quiet: true });
  process.env.DATABASE_URL = databaseUrl(databaseName);
  db = await import("../src/lib/db");
  service = await import("../src/lib/weight-barcode-templates-service");
  client = new Client({ connectionString: databaseUrl(databaseName) });
  await client.connect();
  businessId = (await client.query("INSERT INTO businesses (name, slug) VALUES ('Scope', $1) RETURNING id", [`scope-${randomUUID()}`])).rows[0].id;
  const locations = await client.query("INSERT INTO locations (business_id, name) VALUES ($1, 'A'), ($1, 'B') RETURNING id", [businessId]);
  [branchA, branchB] = locations.rows.map((row) => row.id);
}, 120_000);

afterAll(async () => {
  await client?.end();
  await db?.getPool().end().catch(() => {});
  process.env.DATABASE_URL = rootUrl;
  const maintenance = new Client({ connectionString: databaseUrl("postgres") });
  await maintenance.connect();
  try { await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`); } finally { await maintenance.end(); }
});

it("cannot delete a different branch's weight template within the same tenant", async () => {
  await db.withTenant(businessId, async () => {
    const { template } = await service.createWeightBarcodeTemplate({ locationId: branchB, prefix: "20", weightUnit: "grams" });
    expect(template).toBeDefined();
    expect(await service.deleteWeightBarcodeTemplate(template!.id, branchA)).toBe(false);
    expect(await service.listWeightBarcodeTemplates(branchB)).toHaveLength(1);
    expect(await service.deleteWeightBarcodeTemplate(template!.id, branchB)).toBe(true);
    expect(await service.listWeightBarcodeTemplates(branchB)).toHaveLength(0);
  });
});
