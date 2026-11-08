/** Archive storage and binding must stay isolated from live books and tenants. */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { createAppRole, dropAppRole } from "../scripts/create-app-role";
import type { HistoricalInvoiceRow } from "../src/lib/data-transfer/historical-invoice-preview";

const root = process.env.DATABASE_URL;
if (!root) throw new Error("DATABASE_URL is required for database integration tests");
const role = "historical_invoice_test_role";
const password = "historical-invoice-test";
let dbName: string;
let owner: Client;
let app: Client;
let dbLib: typeof import("../src/lib/db");
let archive: typeof import("../src/lib/data-transfer/historical-invoice-archive-service");
let previewService: typeof import("../src/lib/data-transfer/historical-invoice-job-preview");
const a = { businessId: "", locationId: "", partyId: "", actorId: "", jobId: "" };
const b = { businessId: "", locationId: "", partyId: "", actorId: "", jobId: "" };

function url(database: string, appRole = false): string {
  const parsed = new URL(root!);
  parsed.pathname = `/${database}`;
  if (appRole) { parsed.username = role; parsed.password = password; }
  return parsed.toString();
}
async function seed(label: string) {
  const business = (await owner.query<{ id: string }>(`INSERT INTO businesses (name, slug) VALUES ($1, $2) RETURNING id`, [label, `${label}-${randomUUID().slice(0, 8)}`])).rows[0].id;
  const location = (await owner.query<{ id: string }>(`INSERT INTO locations (business_id, name) VALUES ($1, 'main') RETURNING id`, [business])).rows[0].id;
  const party = (await owner.query<{ id: string }>(`INSERT INTO parties (business_id, name, role) VALUES ($1, 'customer', 'customer') RETURNING id`, [business])).rows[0].id;
  const actor = (await owner.query<{ id: string }>(`INSERT INTO users (business_id, role, full_name, password_hash) VALUES ($1, 'owner', 'owner', 'test') RETURNING id`, [business])).rows[0].id;
  const job = (await owner.query<{ id: string }>(`INSERT INTO data_import_jobs (business_id, location_id, entity_key, status, created_by) VALUES ($1, $2, 'accounting.historical_invoices', 'running', $3) RETURNING id`, [business, location, actor])).rows[0].id;
  return { businessId: business, locationId: location, partyId: party, actorId: actor, jobId: job };
}
const rows: HistoricalInvoiceRow[] = [
  { rowNumber: 2, externalInvoiceId: "remote-1", invoiceNumber: "123", invoiceDate: "1403/01/01", externalCustomerCode: "customer-1", total: "100", paid: "40", balance: "60", lineName: "A", quantity: "2", unitPrice: "20" },
  { rowNumber: 3, externalInvoiceId: "remote-1", lineName: "B", quantity: "1", unitPrice: "60" },
];
function params() {
  return { businessId: a.businessId, locationId: a.locationId, jobId: a.jobId, sourceKey: "old-shop-1", provider: "generic", currency: "toman" as const, calendar: "jalali" as const, rows, expectedPartyId: a.partyId, actor: { userId: a.actorId, name: "owner" } };
}

const fields = ["externalInvoiceId", "invoiceNumber", "invoiceDate", "externalCustomerCode", "total", "paid", "balance", "lineName", "quantity", "unitPrice"];
const mapping = { columns: fields.map((field, column) => ({ field, column })) };
function previewParams() {
  return { businessId: a.businessId, locationId: a.locationId, jobId: a.jobId, sourceKey: "old-shop-1", provider: "generic", currency: "toman" as const, calendar: "jalali" as const, mapping };
}

async function stageJob(jobId: string, sourceKey: string, evidence: HistoricalInvoiceRow[]) {
  await owner.query(`UPDATE data_import_jobs SET options = $2::jsonb, source_columns = $3::jsonb WHERE id = $1`, [jobId, JSON.stringify({ historicalInvoice: { sourceKey, provider: "generic", currency: "toman", calendar: "jalali" } }), JSON.stringify(fields)]);
  for (const row of evidence) {
    const { rowNumber, ...mapped } = row;
    await owner.query(`INSERT INTO data_import_rows (job_id, row_number, mapped, raw) VALUES ($1, $2, $3::jsonb, $3::jsonb)`, [jobId, rowNumber, JSON.stringify(mapped)]);
  }
}

beforeAll(async () => {
  dbName = `pos_hist_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: url("postgres") });
  await maintenance.connect();
  await maintenance.query(`CREATE DATABASE "${dbName}"`);
  await maintenance.end();
  await runMigrations({ databaseUrl: url(dbName), quiet: true });
  await createAppRole({ databaseUrl: url(dbName), roleName: role, password, quiet: true });
  owner = new Client({ connectionString: url(dbName) }); await owner.connect();
  Object.assign(a, await seed("alpha")); Object.assign(b, await seed("beta"));
  await stageJob(a.jobId, "old-shop-1", rows);
  app = new Client({ connectionString: url(dbName, true) }); await app.connect();
  process.env.DATABASE_URL = url(dbName, true);
  dbLib = await import("../src/lib/db");
  archive = await import("../src/lib/data-transfer/historical-invoice-archive-service");
  previewService = await import("../src/lib/data-transfer/historical-invoice-job-preview");
}, 240_000);
afterAll(async () => {
  await app?.end(); await owner?.end(); await dbLib?.closeDatabasePool();
  const maintenance = new Client({ connectionString: url("postgres") }); await maintenance.connect();
  await maintenance.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  await dropAppRole(maintenance, role); await maintenance.end();
});

describe("historical invoice archive", () => {
  it("requires a reviewed, tenant-owned binding and refuses repointing", async () => {
    const input = { businessId: a.businessId, sourceKey: "old-shop-1", provider: "generic", externalCustomerCode: "customer-1", partyId: a.partyId, actor: { userId: a.actorId, name: "owner" } };
    await owner.query(`UPDATE data_import_jobs SET status = 'ready' WHERE id = $1`, [a.jobId]);
    const before = (await owner.query(`SELECT count(*)::int AS n FROM historical_sales_invoices`)).rows[0].n;
    const preview = await previewService.previewHistoricalImportJob(previewParams());
    expect(preview).toMatchObject({ crossSourceChecked: false, totalInvoices: 1, reviewNeeded: 1, toCreate: 0, matchedCustomers: 0, reconciliation: { totalRial: "1000", paidRial: "400", balanceRial: "600", totalCount: 1 } });
    expect((await owner.query(`SELECT count(*)::int AS n FROM historical_sales_invoices`)).rows[0].n).toBe(before);
    await owner.query(`UPDATE data_import_jobs SET status = 'running' WHERE id = $1`, [a.jobId]);
    await expect(archive.archiveHistoricalInvoice(params())).rejects.toMatchObject({ code: "customer_binding_changed" });
    await expect(archive.bindHistoricalCustomer({ ...input, partyId: b.partyId })).rejects.toMatchObject({ code: "customer_not_found" });
    expect(await archive.bindHistoricalCustomer(input)).toBe("created");
    expect(await archive.bindHistoricalCustomer(input)).toBe("unchanged");
    const other = (await owner.query<{ id: string }>(`INSERT INTO parties (business_id, name, role) VALUES ($1, 'other', 'customer') RETURNING id`, [a.businessId])).rows[0].id;
    await expect(archive.bindHistoricalCustomer({ ...input, partyId: other })).rejects.toMatchObject({ code: "customer_identity_conflict" });
  });
  it("archives one invoice atomically and concurrent retries do not double it", async () => {
    const tables = ["orders", "order_items", "payments", "journal_entries", "stock_movements", "tax_invoice_submissions", "parties"];
    const count = async () => {
      const values: number[] = [];
      for (const table of tables) values.push((await owner.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n);
      return values;
    };
    const before = await count();
    const results = await Promise.all([archive.archiveHistoricalInvoice(params()), archive.archiveHistoricalInvoice(params())]);
    expect(results.map((r) => r.status).sort()).toEqual(["already_imported", "created"]);
    expect(results[0].invoiceId).toBe(results[1].invoiceId);
    expect(await count()).toEqual(before);
    await owner.query(`UPDATE data_import_jobs SET status = 'ready' WHERE id = $1`, [a.jobId]);
    const duplicate = await previewService.previewHistoricalImportJob(previewParams());
    expect(duplicate).toMatchObject({ alreadyImported: 1, conflicts: 0, matchedCustomers: 1 });
    await owner.query(`UPDATE data_import_rows SET raw = jsonb_set(raw, '{invoiceNumber}', '"different"'::jsonb) WHERE job_id = $1 AND row_number = 2`, [a.jobId]);
    const conflict = await previewService.previewHistoricalImportJob(previewParams());
    expect(conflict).toMatchObject({ alreadyImported: 0, conflicts: 1, toCreate: 0 });
    await expect(previewService.previewHistoricalImportJob({ ...previewParams(), businessId: b.businessId })).rejects.toMatchObject({ code: "job_not_found" });
    await owner.query(`UPDATE data_import_rows SET raw = jsonb_set(raw, '{invoiceNumber}', '"123"'::jsonb) WHERE job_id = $1 AND row_number = 2`, [a.jobId]);
    await owner.query(`UPDATE data_import_jobs SET status = 'running' WHERE id = $1`, [a.jobId]);
    const saved = await owner.query(`SELECT * FROM historical_sales_invoices WHERE id = $1`, [results[0].invoiceId]);
    expect(saved.rows[0]).toMatchObject({ party_id: a.partyId, total_rial: "1000", paid_rial: "400", balance_rial: "600", summary_only: false, external_id: "remote-1" });
    expect((await owner.query(`SELECT * FROM historical_sales_invoice_lines WHERE invoice_id = $1`, [results[0].invoiceId])).rowCount).toBe(2);
    await expect(archive.archiveHistoricalInvoice({ ...params(), rows: [{ ...rows[0], total: "200" }, rows[1]] })).rejects.toMatchObject({ code: "staged_document_changed" });
    const changed = rows.map((r) => ({ ...r, invoiceNumber: "different" }));
    await owner.query(`UPDATE data_import_rows SET mapped = jsonb_set(mapped, '{invoiceNumber}', '"different"'::jsonb) WHERE job_id = $1`, [a.jobId]);
    await expect(archive.archiveHistoricalInvoice({ ...params(), rows: changed })).rejects.toMatchObject({ code: "document_identity_conflict" });
    await owner.query(`DELETE FROM data_import_rows WHERE job_id = $1`, [a.jobId]);
    await stageJob(a.jobId, "old-shop-1", rows);
    await expect(owner.query(`UPDATE historical_sales_invoices SET party_id = $2 WHERE id = $1`, [results[0].invoiceId, a.partyId])).rejects.toThrow("historical_sales_evidence_immutable");
  });
  it("blocks stale targets, wrong jobs and cross-tenant links", async () => {
    await expect(archive.archiveHistoricalInvoice({ ...params(), expectedPartyId: b.partyId })).rejects.toMatchObject({ code: "customer_binding_changed" });
    await expect(archive.archiveHistoricalInvoice({ ...params(), jobId: b.jobId })).rejects.toMatchObject({ code: "job_not_running_or_authorized" });
    await expect(archive.archiveHistoricalInvoice({ ...params(), currency: "rial" })).rejects.toMatchObject({ code: "job_source_changed" });
    await expect(archive.archiveHistoricalInvoice({ ...params(), rows: [rows[0]] })).rejects.toMatchObject({ code: "staged_document_changed" });
    await owner.query(`UPDATE data_import_jobs SET status = 'cancelled' WHERE id = $1`, [a.jobId]);
    await expect(archive.archiveHistoricalInvoice(params())).rejects.toMatchObject({ code: "job_not_running_or_authorized" });
    await owner.query(`UPDATE data_import_jobs SET status = 'running' WHERE id = $1`, [a.jobId]);
    await app.query(`SELECT set_config('app.business_id', $1, false)`, [b.businessId]);
    expect((await app.query(`SELECT * FROM historical_sales_invoices`)).rowCount).toBe(0);
    expect((await app.query(`SELECT * FROM historical_sales_invoice_lines`)).rowCount).toBe(0);
    await expect(owner.query(`INSERT INTO historical_sales_invoices
      (business_id, location_id, party_id, import_job_id, source_key, external_id, invoice_date, external_customer_code, source_currency, source_calendar, total_rial, summary_only, source_fingerprint, source_snapshot)
      VALUES ($1,$2,$3,$4,'s','id','2024-01-01','c','rial','gregorian',1,true,$5,'[]')`,
      [a.businessId, a.locationId, b.partyId, a.jobId, "a".repeat(64)])).rejects.toThrow();
  });
  it("lists and reads evidence only for the requested customer and branch", async () => {
    const list = await archive.listHistoricalInvoices({ businessId: a.businessId, locationId: a.locationId, partyId: a.partyId, search: "123" });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ totalRial: "1000", partyId: a.partyId, sourceKey: "old-shop-1" });
    expect(await archive.listHistoricalInvoices({ businessId: a.businessId, locationId: b.locationId })).toEqual([]);
    expect(await archive.listHistoricalInvoices({ businessId: b.businessId, locationId: a.locationId })).toEqual([]);
    expect(await archive.listHistoricalInvoices({ businessId: a.businessId, locationId: a.locationId, search: "%" })).toEqual([]);
    const details = await archive.getHistoricalInvoiceEvidence({ businessId: a.businessId, locationId: a.locationId, invoiceId: list[0].id });
    expect(details?.lines).toHaveLength(2);
    expect(details?.sourceSnapshot).toEqual(rows);
    expect(await archive.getHistoricalInvoiceEvidence({ businessId: b.businessId, locationId: a.locationId, invoiceId: list[0].id })).toBeNull();
    const page = await archive.listHistoricalInvoiceLines({ businessId: a.businessId, locationId: a.locationId, partyId: a.partyId, invoiceId: list[0].id });
    expect(page).toMatchObject({ lines: [
      { rowNumber: 2, externalInvoiceId: "remote-1", lineName: "A", quantity: "2", unitPrice: "20" },
      { rowNumber: 3, externalInvoiceId: "remote-1", lineName: "B", quantity: "1", unitPrice: "60" },
    ], hasMore: false });
    expect(page?.lines[0]).not.toHaveProperty("externalCustomerCode");
    expect(await archive.listHistoricalInvoiceLines({ businessId: a.businessId, locationId: a.locationId, partyId: b.partyId, invoiceId: list[0].id })).toBeNull();
    expect(await archive.listHistoricalInvoiceLines({ businessId: b.businessId, locationId: a.locationId, invoiceId: list[0].id })).toBeNull();
  });
  it("allows separate sources with the same document number and id", async () => {
    const newJob = (await owner.query<{ id: string }>(`INSERT INTO data_import_jobs (business_id, location_id, entity_key, status, created_by) VALUES ($1, $2, 'accounting.historical_invoices', 'running', $3) RETURNING id`, [a.businessId, a.locationId, a.actorId])).rows[0].id;
    await stageJob(newJob, "old-shop-2", rows);
    const second = { ...params(), sourceKey: "old-shop-2", jobId: newJob };
    await archive.bindHistoricalCustomer({ businessId: a.businessId, sourceKey: second.sourceKey, provider: second.provider, externalCustomerCode: "customer-1", partyId: a.partyId, actor: second.actor });
    expect((await archive.archiveHistoricalInvoice(second)).status).toBe("created");
    expect(await archive.listHistoricalInvoices({ businessId: a.businessId, locationId: a.locationId })).toHaveLength(2);
  });
  it("rejects inactive or foreign actors and unverified mappings", async () => {
    const input = { businessId: a.businessId, sourceKey: "other", provider: "generic", externalCustomerCode: "x", partyId: a.partyId, actor: { userId: b.actorId, name: "other" } };
    await expect(archive.bindHistoricalCustomer(input)).rejects.toMatchObject({ code: "actor_not_active" });
    await owner.query(`UPDATE source_identities SET verified = false WHERE business_id = $1 AND source_key = 'old-shop-1'`, [a.businessId]);
    await expect(archive.archiveHistoricalInvoice(params())).rejects.toMatchObject({ code: "customer_binding_changed" });
    await owner.query(`UPDATE source_identities SET verified = true WHERE business_id = $1 AND source_key = 'old-shop-1'`, [a.businessId]);
  });
  it("preserves original attribution while following the audited customer merge chain", async () => {
    const original = await archive.listHistoricalInvoices({ businessId: a.businessId, locationId: a.locationId, partyId: a.partyId });
    const winner = (await owner.query<{ id: string }>(`INSERT INTO parties (business_id, name, role) VALUES ($1, 'winner', 'customer') RETURNING id`, [a.businessId])).rows[0].id;
    const crm = await import("../src/lib/crm-service");
    expect(await dbLib.withTenant(a.businessId, () => crm.mergeCustomers(a.businessId, winner, a.partyId, { mergedBy: "reviewer" }))).not.toBeNull();
    const inherited = await archive.listHistoricalInvoices({ businessId: a.businessId, locationId: a.locationId, partyId: winner });
    expect(inherited.map((x) => x.id).sort()).toEqual(original.map((x) => x.id).sort());
    expect(inherited.every((x) => x.partyId === a.partyId)).toBe(true);
    expect(await archive.listHistoricalInvoiceLines({ businessId: a.businessId, locationId: a.locationId, invoiceId: original[0].id, partyId: winner })).not.toBeNull();
    const finalWinner = (await owner.query<{ id: string }>(`INSERT INTO parties (business_id, name, role) VALUES ($1, 'final winner', 'customer') RETURNING id`, [a.businessId])).rows[0].id;
    expect(await dbLib.withTenant(a.businessId, () => crm.mergeCustomers(a.businessId, finalWinner, winner, { mergedBy: "reviewer" }))).not.toBeNull();
    const chained = await archive.listHistoricalInvoices({ businessId: a.businessId, locationId: a.locationId, partyId: finalWinner });
    expect(chained.map((x) => x.id).sort()).toEqual(original.map((x) => x.id).sort());
    expect(chained.every((x) => x.partyId === a.partyId)).toBe(true);
    expect(await archive.listHistoricalInvoiceLines({ businessId: a.businessId, locationId: a.locationId, invoiceId: original[0].id, partyId: finalWinner })).not.toBeNull();
    expect(await archive.listHistoricalInvoiceLines({ businessId: b.businessId, locationId: a.locationId, invoiceId: original[0].id, partyId: finalWinner })).toBeNull();
  });
  it("permits normal tenant teardown", async () => {
    await owner.query("BEGIN");
    try {
      await owner.query("DELETE FROM businesses WHERE id = $1", [a.businessId]);
    } finally {
      await owner.query("ROLLBACK");
    }
  });

});
