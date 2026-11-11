/** The reviewed identity endpoint, real staging and FORCE-RLS PostgreSQL. */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { NextRequest, NextResponse } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { createAppRole, dropAppRole } from "../scripts/create-app-role";

const scope = vi.hoisted(() => ({ businessId: "", locationId: "", actorId: "", forbidden: false }));
vi.mock("@/lib/auth", () => ({
  withTenantScope: (handler: unknown) => handler,
  requirePermissions: () => scope.forbidden
    ? { error: NextResponse.json({ error: "forbidden" }, { status: 403 }) }
    : { session: { businessId: scope.businessId, sub: scope.actorId }, error: null },
}));
vi.mock("@/app/api/data/guard", async () => {
  const { PERMISSIONS } = await import("@/lib/permissions");
  return { PERMISSIONS,
    dataOwner: () => ({ owner: { session: { businessId: scope.businessId, sub: scope.actorId, fullName: "Owner" } }, error: null }),
    entityAccess: () => ({ entity: {}, error: null }) };
});
vi.mock("@/lib/setup-state", () => ({ resolveActiveLocation: () => ({ id: scope.locationId }) }));
vi.mock("@/lib/app-availability-service", () => ({ isAppAvailable: () => true }));
vi.mock("@/lib/industry-guard", () => ({ isModuleEnabled: () => true }));
vi.mock("@/lib/features", () => ({ isFeatureEnabled: () => true }));
vi.mock("@/lib/service-activation/app-gate-service", () => ({ serviceActivationState: () => null }));

const root = process.env.DATABASE_URL;
if (!root) throw new Error("DATABASE_URL is required");
const role = "historical_invoice_api_test_role";
let database: string;
let owner: Client;
let db: typeof import("../src/lib/db");
let post: typeof import("../src/app/api/data/historical-invoices/route").POST;
let stage: typeof import("../src/lib/data-transfer/historical-invoice-staging").stageHistoricalInvoiceFile;
let partyId: string;
let otherBranch: string;
let otherBusiness: string;
let otherBusinessBranch: string;
function url(name: string, app = false) {
  const u = new URL(root!); u.pathname = `/${name}`;
  if (app) { u.username = role; u.password = "historical-api-test"; }
  return u.toString();
}
function request(value: unknown) { return new NextRequest("http://localhost/api/data/historical-invoices", { method: "POST", body: JSON.stringify(value) }); }

beforeAll(async () => {
  database = `pos_hist_api_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: url("postgres") }); await maintenance.connect();
  await maintenance.query(`CREATE DATABASE "${database}"`); await maintenance.end();
  await runMigrations({ databaseUrl: url(database), quiet: true });
  await createAppRole({ databaseUrl: url(database), roleName: role, password: "historical-api-test", quiet: true });
  owner = new Client({ connectionString: url(database) }); await owner.connect();
  scope.businessId = (await owner.query(`INSERT INTO businesses (name, slug) VALUES ('API', $1) RETURNING id`, [`hist-api-${randomUUID()}`])).rows[0].id;
  scope.locationId = (await owner.query(`INSERT INTO locations (business_id, name) VALUES ($1, 'first') RETURNING id`, [scope.businessId])).rows[0].id;
  otherBranch = (await owner.query(`INSERT INTO locations (business_id, name) VALUES ($1, 'second') RETURNING id`, [scope.businessId])).rows[0].id;
  otherBusiness = (await owner.query(`INSERT INTO businesses (name, slug) VALUES ('Other', $1) RETURNING id`, [`hist-api-other-${randomUUID()}`])).rows[0].id;
  otherBusinessBranch = (await owner.query(`INSERT INTO locations (business_id, name) VALUES ($1, 'other') RETURNING id`, [otherBusiness])).rows[0].id;
  scope.actorId = (await owner.query(`INSERT INTO users (business_id, role, full_name, password_hash) VALUES ($1, 'owner', 'owner', 'test') RETURNING id`, [scope.businessId])).rows[0].id;
  partyId = (await owner.query(`INSERT INTO parties (business_id, name, role) VALUES ($1, 'existing', 'customer') RETURNING id`, [scope.businessId])).rows[0].id;
  process.env.DATABASE_URL = url(database, true);
  db = await import("../src/lib/db");
  stage = (await import("../src/lib/data-transfer/historical-invoice-staging")).stageHistoricalInvoiceFile;
  post = (await import("../src/app/api/data/historical-invoices/route")).POST;
}, 240_000);

afterAll(async () => {
  await owner?.end(); await db?.closeDatabasePool();
  const maintenance = new Client({ connectionString: url("postgres") }); await maintenance.connect();
  await maintenance.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
  await dropAppRole(maintenance, role); await maintenance.end();
});

describe("historical customer review endpoint", () => {
  it("reviews and links an existing customer without importing an invoice or touching live books", async () => {
    const source = "externalInvoiceId,invoiceDate,externalCustomerCode,total,sourceCustomerName\nold-1,1403/01/01,C1,100,Original\n";
    const staged = await stage({ businessId: scope.businessId, locationId: scope.locationId,
      actor: { userId: scope.actorId, name: "Owner" }, fileName: "source.csv", format: "csv", buffer: new TextEncoder().encode(source).buffer,
      sourceKey: "legacy", provider: "generic", currency: "rial", calendar: "jalali" });
    const options = { jobId: staged.jobId, sourceKey: "legacy", provider: "generic", currency: "rial", calendar: "jalali",
      mapping: { columns: staged.columns.map((field, column) => ({ field, column })) } };
    const initial = await post(request({ action: "preview", ...options }));
    expect(await initial.json()).toMatchObject({ executionAvailable: false, preview: { reviewNeeded: 1, crossSourceChecked: false } });
    scope.locationId = otherBranch;
    expect((await post(request({ action: "preview", ...options }))).status).toBe(404);
    const originalBusiness = scope.businessId;
    scope.businessId = otherBusiness; scope.locationId = otherBusinessBranch;
    expect((await post(request({ action: "preview", ...options }))).status).toBe(404);
    scope.businessId = originalBusiness;
    scope.locationId = (await owner.query(`SELECT location_id FROM data_import_jobs WHERE id=$1`, [staged.jobId])).rows[0].location_id;
    scope.forbidden = true;
    expect((await post(request({ action: "preview", ...options }))).status).toBe(403);
    scope.forbidden = false;
    const review = await post(request({ action: "review-customer", ...options, externalCustomerCode: "C1", partyId }));
    expect(review.status).toBe(200);
    const data = await review.json();
    expect(data.review).toMatchObject({ sourceNames: ["Original"], targetCustomer: { partyId, name: "existing" } });
    await owner.query(`UPDATE data_import_rows SET raw=jsonb_set(raw, '{sourceCustomerName}', '"Changed"') WHERE job_id=$1`, [staged.jobId]);
    const body = { action: "confirm-customer", ...options, externalCustomerCode: "C1", partyId, reviewToken: data.review.reviewToken, confirmed: true };
    expect((await post(request(body))).status).toBe(409);
    const rereview = await (await post(request({ action: "review-customer", ...options, externalCustomerCode: "C1", partyId }))).json();
    const confirmed = await post(request({ ...body, reviewToken: rereview.review.reviewToken }));
    expect(await confirmed.json()).toEqual({ result: "created" });
    const final = await (await post(request({ action: "preview", ...options }))).json();
    expect(final).toMatchObject({ executionAvailable: false, preview: { matchedCustomers: 1, toCreate: 1 } });
    for (const table of ["historical_sales_invoices", "orders", "payments", "journal_entries", "stock_movements"]) {
      expect((await owner.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n).toBe(0);
    }
    expect((await owner.query(`SELECT count(*)::int AS n FROM parties WHERE business_id = $1`, [scope.businessId])).rows[0].n).toBe(1);
  });
});
