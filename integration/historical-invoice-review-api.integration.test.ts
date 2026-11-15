/** The reviewed identity endpoint, real staging and FORCE-RLS PostgreSQL. */
import { createHash, randomUUID } from "node:crypto";
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
let genericImport: typeof import("../src/lib/data-transfer/import-service");
let partyId: string;
let otherBranch: string;
let otherBranchParty: string;
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
  otherBranchParty = (await owner.query(`INSERT INTO parties (business_id, location_id, name, role) VALUES ($1, $2, 'existing other branch', 'customer') RETURNING id`, [scope.businessId, otherBranch])).rows[0].id;
  await owner.query(`INSERT INTO parties (business_id, name, role) VALUES ($1, 'existing other tenant', 'customer')`, [otherBusiness]);
  process.env.DATABASE_URL = url(database, true);
  db = await import("../src/lib/db");
  genericImport = await import("../src/lib/data-transfer/import-service");
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
    const source = "\uFEFFexternalInvoiceId,invoiceDate,externalCustomerCode,total,sourceCustomerName\nold-1,1403/01/01,C1,100,Original\n";
    const uploadRequest = (payload: unknown) => new NextRequest("http://localhost/api/data/historical-invoices", { method: "POST",
      headers: { "content-type": "application/vnd.bizamiz.historical-invoice+json" }, body: JSON.stringify(payload) });
    const payload = { fileName: "source.csv", format: "csv", content: source,
      sourceKey: "legacy", provider: "generic", currency: "rial", calendar: "jalali" };
    scope.forbidden = true;
    expect((await post(uploadRequest(payload))).status).toBe(403);
    scope.forbidden = false;
    expect((await post(uploadRequest({ ...payload, format: "xlsx", fileName: "bad.xlsx" }))).status).toBe(400);
    expect((await post(uploadRequest({ ...payload, format: "json", fileName: "bad.json", content: '[{"id":"\\u0000"}]' }))).status).toBe(400);
    expect((await owner.query(`SELECT count(*)::int AS n FROM data_import_jobs`)).rows[0].n).toBe(0);
    const upload = await post(uploadRequest(payload));
    expect(upload.status).toBe(201);
    const { staged, executionAvailable } = await upload.json() as { staged: { jobId: string; columns: string[] }; executionAvailable: boolean };
    expect(executionAvailable).toBe(false);
    const stored = await owner.query(`SELECT options->'historicalInvoice'->>'fileSha256' AS hash FROM data_import_jobs WHERE id=$1`, [staged.jobId]);
    expect(stored.rows[0].hash).toBe(createHash("sha256").update(Buffer.from(source, "utf8")).digest("hex"));
    const history = await (await post(request({ action: "list" }))).json();
    expect(history).toMatchObject({ executionAvailable: false, jobs: [{ jobId: staged.jobId, fileName: "source.csv", sourceKey: "legacy" }] });
    const detail = await (await post(request({ action: "get", jobId: staged.jobId }))).json();
    expect(detail).toMatchObject({ job: { jobId: staged.jobId, columns: staged.columns, structure: "flat" }, executionAvailable: false });
    await db.withTenant(scope.businessId, async () => {
      expect(await genericImport.getImportJob(scope.businessId, staged.jobId)).toBeNull();
      expect(await genericImport.listImportJobs(scope.businessId)).toEqual([]);
      await expect(genericImport.queueImportJob(scope.businessId, staged.jobId)).rejects.toMatchObject({ code: "job_not_found" });
    });
    expect((await owner.query(`SELECT count(*)::int AS n FROM audit_log WHERE entity_id=$1 AND action='historical_invoice.staged'`, [staged.jobId])).rows[0].n).toBe(1);
    const options = { jobId: staged.jobId, sourceKey: "legacy", provider: "generic", currency: "rial", calendar: "jalali",
      mapping: { columns: staged.columns.map((field, column) => ({ field, column })) } };
    const customerSearch = await (await post(request({ action: "search-customer", term: "existing" }))).json();
    expect(customerSearch.customers).toEqual([{ id: partyId, name: "existing", phoneLast4: null }]);
    const initial = await post(request({ action: "preview", ...options }));
    expect(await initial.json()).toMatchObject({ executionAvailable: false, preview: { reviewNeeded: 1, crossSourceChecked: false } });
    scope.locationId = otherBranch;
    expect((await post(request({ action: "preview", ...options }))).status).toBe(404);
    expect((await post(request({ action: "get", jobId: staged.jobId }))).status).toBe(404);
    expect(await (await post(request({ action: "list" }))).json()).toMatchObject({ jobs: [] });
    const otherSearch = await (await post(request({ action: "search-customer", term: "existing" }))).json();
    expect(otherSearch.customers.map((item: { id: string }) => item.id).sort()).toEqual([partyId, otherBranchParty].sort());
    const originalBusiness = scope.businessId;
    scope.businessId = otherBusiness; scope.locationId = otherBusinessBranch;
    expect((await post(request({ action: "preview", ...options }))).status).toBe(404);
    expect((await post(request({ action: "get", jobId: staged.jobId }))).status).toBe(404);
    expect(await (await post(request({ action: "list" }))).json()).toMatchObject({ jobs: [] });
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
    await owner.query(`UPDATE parties SET phone_last4='1234' WHERE id=$1`, [partyId]);
    expect((await post(request({ ...body, reviewToken: rereview.review.reviewToken }))).status).toBe(409);
    const finalReview = await (await post(request({ action: "review-customer", ...options, externalCustomerCode: "C1", partyId }))).json();
    expect(finalReview.review.targetCustomer.phoneLast4).toBe("1234");
    const confirmed = await post(request({ ...body, reviewToken: finalReview.review.reviewToken }));
    expect(await confirmed.json()).toEqual({ result: "created" });
    const final = await (await post(request({ action: "preview", ...options }))).json();
    expect(final).toMatchObject({ executionAvailable: false, preview: { matchedCustomers: 1, toCreate: 1 } });
    for (const table of ["historical_sales_invoices", "orders", "payments", "journal_entries", "stock_movements"]) {
      expect((await owner.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n).toBe(0);
    }
    expect((await owner.query(`SELECT count(*)::int AS n FROM parties WHERE business_id = $1`, [scope.businessId])).rows[0].n).toBe(2);
  });
});
