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
    await expect(archive.bindHistoricalCustomer({ ...input, provider: "other" })).rejects.toMatchObject({ code: "customer_identity_conflict" });
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
    await owner.query(`UPDATE parties SET is_active = false WHERE id = $1`, [a.partyId]);
    await expect(archive.bindHistoricalCustomer({ ...input, actor: { userId: a.actorId, name: "owner" }, partyId: a.partyId })).rejects.toMatchObject({ code: "customer_not_found" });
    await expect(archive.archiveHistoricalInvoice(params())).rejects.toMatchObject({ code: "customer_binding_changed" });
    await owner.query(`UPDATE data_import_jobs SET status = 'ready' WHERE id = $1`, [a.jobId]);
    expect((await previewService.previewHistoricalImportJob(previewParams())).matchedCustomers).toBe(0);
    await owner.query(`UPDATE data_import_jobs SET status = 'running' WHERE id = $1`, [a.jobId]);
    await owner.query(`UPDATE parties SET is_active = true WHERE id = $1`, [a.partyId]);
    await owner.query(`UPDATE source_identities SET provider = 'other' WHERE business_id = $1 AND source_key = 'old-shop-1'`, [a.businessId]);
    await expect(archive.archiveHistoricalInvoice(params())).rejects.toMatchObject({ code: "customer_binding_changed" });
    await owner.query(`UPDATE data_import_jobs SET status = 'ready' WHERE id = $1`, [a.jobId]);
    expect((await previewService.previewHistoricalImportJob(previewParams())).matchedCustomers).toBe(0);
    await owner.query(`UPDATE data_import_jobs SET status = 'running' WHERE id = $1`, [a.jobId]);
    await owner.query(`UPDATE source_identities SET provider = 'generic' WHERE business_id = $1 AND source_key = 'old-shop-1'`, [a.businessId]);
    const otherLocation = (await owner.query<{ id: string }>(`INSERT INTO locations (business_id, name) VALUES ($1, 'branch test') RETURNING id`, [a.businessId])).rows[0].id;
    await owner.query(`UPDATE parties SET location_id = $2 WHERE id = $1`, [a.partyId, otherLocation]);
    await expect(archive.archiveHistoricalInvoice(params())).rejects.toMatchObject({ code: "customer_binding_changed" });
    await owner.query(`UPDATE data_import_jobs SET status = 'ready' WHERE id = $1`, [a.jobId]);
    expect((await previewService.previewHistoricalImportJob(previewParams())).matchedCustomers).toBe(0);
    await owner.query(`UPDATE data_import_jobs SET status = 'running' WHERE id = $1`, [a.jobId]);
    await owner.query(`UPDATE parties SET location_id = NULL WHERE id = $1`, [a.partyId]);
  });
  it("stages exact flat-file evidence atomically for no-write preview", async () => {
    const staging = await import("../src/lib/data-transfer/historical-invoice-staging");
    const csv = `externalInvoiceId,invoiceDate,externalCustomerCode,total,invoiceNumber\nnew-001,1403/01/01,customer-1,9007199254740993,00001\n`;
    const input = { businessId: a.businessId, locationId: a.locationId, actor: { userId: a.actorId, name: "owner" }, fileName: "old.csv", format: "csv" as const, buffer: new TextEncoder().encode(csv).buffer as ArrayBuffer, sourceKey: "old-shop-1", provider: "generic", currency: "rial" as const, calendar: "jalali" as const };
    const protectedTables = ["historical_sales_invoices", "source_identities", "orders", "order_items", "payments", "journal_entries", "stock_movements", "parties"];
    const counts = async () => {
      const result: number[] = [];
      for (const table of protectedTables) result.push((await owner.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n);
      return result;
    };
    const before = await counts();
    const initialJobs = (await owner.query(`SELECT count(*)::int AS n FROM data_import_jobs`)).rows[0].n;
    await expect(staging.stageHistoricalInvoiceFile({ ...input, actor: { ...input.actor, userId: b.actorId } })).rejects.toMatchObject({ code: "actor_not_active" });
    await expect(staging.stageHistoricalInvoiceFile({ ...input, locationId: b.locationId })).rejects.toMatchObject({ code: "location_not_found" });
    await expect(staging.stageHistoricalInvoiceFile({ ...input, format: "json", buffer: new TextEncoder().encode('[{"total":"1","total":"2"}]').buffer as ArrayBuffer })).rejects.toMatchObject({ code: "duplicate_source_columns" });
    const ExcelJS = (await import("exceljs")).default;
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet("headers").addRows([["id"], ["1"]]);
    workbook.addWorksheet("lines").addRows([["id"], ["1"]]);
    const workbookBytes = await workbook.xlsx.writeBuffer();
    await expect(staging.stageHistoricalInvoiceFile({ ...input, format: "xlsx", buffer: Uint8Array.from(workbookBytes as unknown as Uint8Array).buffer })).rejects.toMatchObject({ code: "multi_sheet_not_supported" });
    expect((await owner.query(`SELECT count(*)::int AS n FROM data_import_jobs`)).rows[0].n).toBe(initialJobs);
    const staged = await staging.stageHistoricalInvoiceFile(input);
    expect(staged.rowCount).toBe(1);
    const job = await owner.query(`SELECT status, options, total_rows FROM data_import_jobs WHERE id = $1`, [staged.jobId]);
    expect(job.rows[0]).toMatchObject({ status: "pending", total_rows: 1, options: { historicalInvoice: { sourceKey: "old-shop-1", currency: "rial" } } });
    expect(job.rows[0].options.historicalInvoice.fileSha256).toMatch(/^[0-9a-f]{64}$/);
    const raw = await owner.query(`SELECT row_number, raw FROM data_import_rows WHERE job_id = $1`, [staged.jobId]);
    expect(raw.rows[0]).toMatchObject({ row_number: 2, raw: { total: "9007199254740993", invoiceNumber: "00001" } });
    const preview = await previewService.previewHistoricalImportJob({ ...previewParams(), jobId: staged.jobId, currency: "rial", mapping: { columns: staged.columns.map((field, column) => ({ field, column })) } });
    expect(preview).toMatchObject({ totalInvoices: 1, toCreate: 1, crossSourceChecked: false, reconciliation: { totalRial: "9007199254740993" } });
    await expect(previewService.previewHistoricalImportJob({ ...previewParams(), jobId: staged.jobId, currency: "toman", mapping: { columns: staged.columns.map((field, column) => ({ field, column })) } })).rejects.toMatchObject({ code: "job_source_changed" });
    expect(await counts()).toEqual(before);
  });
  it("stages and previews 2,000 invoice documents without writing the archive", async () => {
    const staging = await import("../src/lib/data-transfer/historical-invoice-staging");
    const header = "externalInvoiceId,invoiceDate,externalCustomerCode,total";
    const body = Array.from({ length: 2000 }, (_, i) => `batch-${i},1403/01/01,customer-1,10`).join("\n");
    const staged = await staging.stageHistoricalInvoiceFile({
      businessId: a.businessId, locationId: a.locationId, actor: { userId: a.actorId, name: "owner" },
      fileName: "batch.csv", format: "csv", buffer: new TextEncoder().encode(`${header}\n${body}`).buffer as ArrayBuffer,
      sourceKey: "old-shop-1", provider: "generic", currency: "rial", calendar: "jalali",
    });
    const preview = await previewService.previewHistoricalImportJob({ ...previewParams(), jobId: staged.jobId, currency: "rial", mapping: { columns: staged.columns.map((field, column) => ({ field, column })) } });
    expect(staged.rowCount).toBe(2000);
    expect(preview).toMatchObject({ totalInvoices: 2000, toCreate: 2000, invalid: 0, truncated: true, reconciliation: { totalRial: "20000" } });
    expect((await owner.query(`SELECT count(*)::int AS n FROM data_import_rows WHERE job_id = $1`, [staged.jobId])).rows[0].n).toBe(2000);
    expect((await owner.query(`SELECT count(*)::int AS n FROM historical_sales_invoices WHERE import_job_id = $1`, [staged.jobId])).rows[0].n).toBe(0);
  });
  it("stages explicit header and line sheets and previews duplicates and orphans without writes", async () => {
    const staging = await import("../src/lib/data-transfer/historical-invoice-staging");
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("Headers").addRows([
      ["externalInvoiceId", "invoiceDate", "externalCustomerCode", "total"],
      ["two-1", "1403/01/01", "customer-1", "100"],
      ["dup", "1403/01/01", "customer-1", "0"],
      ["dup", "1403/01/01", "customer-1", "0"],
      ["unknown", "1403/01/01", "unknown-code", "10"],
      ["summary", "1403/01/01", "customer-1", "100"],
    ]);
    wb.addWorksheet("Lines").addRows([
      ["externalInvoiceId", "lineName", "quantity", "unitPrice"],
      ["two-1", "A", "2", "20"], ["two-1", "B", "1", "60"], ["orphan", "C", "1", "1"],
    ]);
    const buffer = Uint8Array.from(await wb.xlsx.writeBuffer() as unknown as Uint8Array).buffer;
    const input = { businessId: a.businessId, locationId: a.locationId, actor: { userId: a.actorId, name: "owner" }, fileName: "two.xlsx", format: "xlsx" as const, buffer, sourceKey: "old-shop-1", provider: "generic", currency: "rial" as const, calendar: "jalali" as const };
    await expect(staging.stageHistoricalInvoiceFile({ ...input, sheets: { headers: "Headers", lines: "Headers" } })).rejects.toMatchObject({ code: "invalid_sheet_selection" });
    await expect(staging.stageHistoricalInvoiceFile({ ...input, sheets: { headers: "Headers", lines: "missing" } })).rejects.toMatchObject({ code: "invalid_sheet_selection" });
    const staged = await staging.stageHistoricalInvoiceFile({ ...input, sheets: { headers: "Headers", lines: "Lines" } });
    expect(staged.rowCount).toBe(8);
    const storedRows = await owner.query(`SELECT row_number, raw FROM data_import_rows WHERE job_id = $1 ORDER BY row_number`, [staged.jobId]);
    expect(storedRows.rows[0]).toMatchObject({ raw: { kind: "header", sheet: "Headers", sourceRowNumber: 2, cells: { externalInvoiceId: "two-1", total: "100" } } });
    expect(storedRows.rows[5]).toMatchObject({ raw: { kind: "line", sheet: "Lines", sourceRowNumber: 2, cells: { externalInvoiceId: "two-1", lineName: "A" } } });
    const options = { ...previewParams(), jobId: staged.jobId, currency: "rial" as const,
      mapping: { columns: staged.columns.map((field, column) => ({ field, column })) },
      lineMapping: { columns: staged.lineColumns!.map((field, column) => ({ field, column })) },
    };
    const countedTables = ["historical_sales_invoices", "historical_sales_invoice_lines", "orders", "order_items", "payments", "journal_entries", "stock_movements", "tax_invoice_submissions", "parties"];
    const counts = async () => {
      const result: number[] = [];
      for (const table of countedTables) result.push((await owner.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n);
      return result;
    };
    const before = await counts();
    const result = await previewService.previewHistoricalImportJob(options);
    expect(result).toMatchObject({ totalInvoices: 4, invalid: 1, reviewNeeded: 1, toCreate: 2, summaryOnly: 3, orphanLineCount: 1, crossSourceChecked: false, reconciliation: { totalRial: "210" } });
    expect(result.documents.find((d) => d.externalInvoiceId === "dup")?.outcome).toBe("invalid");
    expect(result.documents.find((d) => d.externalInvoiceId === "unknown")?.outcome).toBe("review");
    expect(result.documents.find((d) => d.externalInvoiceId === "two-1")?.rows).toMatchObject([
      { sourceSheet: "Headers", sourceRowNumber: 2 },
      { sourceSheet: "Lines", sourceRowNumber: 2, lineName: "A" },
      { sourceSheet: "Lines", sourceRowNumber: 3, lineName: "B" },
    ]);
    expect(result.orphanLines).toMatchObject([{ externalInvoiceId: "orphan", sourceSheet: "Lines", sourceRowNumber: 4 }]);
    const originalFingerprint = archive.historicalInvoiceFingerprint(rows, "toman", "jalali");
    expect(archive.historicalInvoiceFingerprint(rows.map((r, i) => ({ ...r, rowNumber: 80 + i, sourceSheet: "Moved", sourceRowNumber: 50 + i })), "toman", "jalali")).toBe(originalFingerprint);
    expect(archive.historicalInvoiceFingerprint([{ ...rows[0], total: "200" }, rows[1]], "toman", "jalali")).not.toBe(originalFingerprint);
    await owner.query(`UPDATE data_import_rows SET raw = jsonb_set(raw, '{cells,externalInvoiceId}', '"remote-1"'::jsonb) WHERE job_id = $1 AND row_number IN (1, 6, 7)`, [staged.jobId]);
    const conflict = await previewService.previewHistoricalImportJob(options);
    expect(conflict.documents.find((d) => d.externalInvoiceId === "remote-1")?.outcome).toBe("conflict");
    await owner.query(`UPDATE data_import_rows SET raw = jsonb_set(raw, '{cells,externalInvoiceId}', '"two-1"'::jsonb) WHERE job_id = $1 AND row_number IN (1, 6, 7)`, [staged.jobId]);
    const zeroPage = await previewService.previewHistoricalImportJob({ ...options, sampleLimit: 0 });
    expect(zeroPage).toMatchObject({ truncated: true, hasMoreDocuments: true, hasMoreOrphans: true });
    const orphanEnd = await previewService.previewHistoricalImportJob({ ...options, orphanOffset: 1 });
    expect(orphanEnd).toMatchObject({ orphanLineCount: 1, orphanOffset: 1, orphanLines: [], hasMoreOrphans: false });
    await expect(previewService.previewHistoricalImportJob({ ...options, businessId: b.businessId })).rejects.toMatchObject({ code: "job_not_found" });
    await expect(previewService.previewHistoricalImportJob({ ...options, locationId: b.locationId })).rejects.toMatchObject({ code: "job_not_found" });
    await expect(previewService.previewHistoricalImportJob({ ...options, lineMapping: undefined })).rejects.toMatchObject({ code: "invalid_sheet_configuration" });
    const customerReview = await archive.previewHistoricalCustomerReview({ ...options, externalCustomerCode: "unknown-code", partyId: a.partyId });
    expect(customerReview.rows).toMatchObject([{ sourceSheet: "Headers", sourceRowNumber: 5, externalCustomerCode: "unknown-code" }]);
    expect(await counts()).toEqual(before);
    await owner.query(`UPDATE data_import_jobs SET status = 'running' WHERE id = $1`, [staged.jobId]);
    const doc = result.documents.find((d) => d.externalInvoiceId === "two-1")!;
    await expect(archive.archiveHistoricalInvoice({ ...input, jobId: staged.jobId, rows: doc.rows, expectedPartyId: a.partyId })).rejects.toMatchObject({ code: "unsupported_staged_structure" });
    await owner.query(`UPDATE data_import_jobs SET status = 'pending' WHERE id = $1`, [staged.jobId]);
    await owner.query(`UPDATE data_import_rows SET raw = jsonb_set(raw, '{cells,quantity}', '"-1"'::jsonb) WHERE job_id = $1 AND row_number = 6`, [staged.jobId]);
    const invalidLine = (await previewService.previewHistoricalImportJob(options)).documents.find((d) => d.externalInvoiceId === "two-1");
    expect(invalidLine?.errors.join(" ")).toContain("ردیف 2 (برگهٔ Lines)");
    await owner.query(`UPDATE data_import_rows SET raw = jsonb_set(raw, '{sheet}', '"tampered"'::jsonb) WHERE job_id = $1 AND row_number = 6`, [staged.jobId]);
    await expect(previewService.previewHistoricalImportJob(options)).rejects.toMatchObject({ code: "invalid_staged_sheet_row" });
  });
  it("reviews and atomically confirms only a customer code in the staged job", async () => {
    const staging = await import("../src/lib/data-transfer/historical-invoice-staging");
    const source = "externalInvoiceId,invoiceDate,externalCustomerCode,total,sourceCustomerName,sourceCustomerPhone\n" +
      "r1,1403/01/01,manual-1,100,Name One,09121234567\n" +
      "r2,1403/01/02,manual-1,200,Name Two,09121234567\n" +
      "r2,,,,Name Three,\n";
    const staged = await staging.stageHistoricalInvoiceFile({ businessId: a.businessId, locationId: a.locationId,
      actor: { userId: a.actorId, name: "owner" }, fileName: "review.csv", format: "csv", buffer: new TextEncoder().encode(source).buffer,
      sourceKey: "review-source", provider: "generic", currency: "rial", calendar: "jalali" });
    const input = { businessId: a.businessId, locationId: a.locationId, jobId: staged.jobId, sourceKey: "review-source", provider: "generic",
      currency: "rial" as const, calendar: "jalali" as const, externalCustomerCode: "manual-1",
      mapping: { columns: staged.columns.map((field, column) => ({ field, column })) } };
    const review = await archive.previewHistoricalCustomerReview({ ...input, partyId: a.partyId });
    expect(review).toMatchObject({ matchingRows: 3, sourceNames: ["Name One", "Name Two", "Name Three"], sourcePhones: ["09121234567"], existingIdentity: null, evidenceTruncated: false });
    expect((await previewService.previewHistoricalImportJob(input))).toMatchObject({ reviewNeeded: 1, invalid: 1 });
    await expect(archive.previewHistoricalCustomerReview({ ...input, partyId: a.partyId, externalCustomerCode: "not-in-job" })).rejects.toMatchObject({ code: "customer_code_not_in_job" });
    await expect(archive.previewHistoricalCustomerReview({ ...input, partyId: a.partyId, locationId: b.locationId })).rejects.toMatchObject({ code: "job_not_found" });
    const otherLocation = (await owner.query<{ id: string }>(`INSERT INTO locations (business_id, name) VALUES ($1, 'other branch') RETURNING id`, [a.businessId])).rows[0].id;
    const branchParty = (await owner.query<{ id: string }>(`INSERT INTO parties (business_id, location_id, name, role) VALUES ($1, $2, 'other branch customer', 'customer') RETURNING id`, [a.businessId, otherLocation])).rows[0].id;
    await expect(archive.previewHistoricalCustomerReview({ ...input, partyId: branchParty })).rejects.toMatchObject({ code: "customer_not_found" });
    const confirm = { ...input, actor: { userId: a.actorId, name: "owner" }, partyId: a.partyId, reviewToken: review.reviewToken, confirmed: true as const };
    await expect(archive.confirmHistoricalCustomerReview({ ...confirm, partyId: b.partyId })).rejects.toMatchObject({ code: "customer_not_found" });
    await expect(archive.confirmHistoricalCustomerReview({ ...confirm, actor: { userId: b.actorId, name: "other" } })).rejects.toMatchObject({ code: "actor_not_active" });
    await expect(archive.confirmHistoricalCustomerReview({ ...confirm, reviewToken: "not-a-token" })).rejects.toMatchObject({ code: "review_confirmation_required" });
    await owner.query(`UPDATE data_import_jobs SET status = 'cancelled' WHERE id = $1`, [staged.jobId]);
    await expect(archive.confirmHistoricalCustomerReview(confirm)).rejects.toMatchObject({ code: "job_not_editable" });
    await owner.query(`UPDATE data_import_jobs SET status = 'pending' WHERE id = $1`, [staged.jobId]);
    await owner.query(`UPDATE data_import_rows SET raw = jsonb_set(raw, '{sourceCustomerName}', '"Changed"'::jsonb) WHERE job_id = $1 AND row_number = 4`, [staged.jobId]);
    await expect(archive.confirmHistoricalCustomerReview(confirm)).rejects.toMatchObject({ code: "customer_review_stale" });
    await owner.query(`UPDATE data_import_rows SET raw = jsonb_set(raw, '{sourceCustomerName}', '"Name Three"'::jsonb) WHERE job_id = $1 AND row_number = 4`, [staged.jobId]);
    await owner.query(`UPDATE data_import_rows SET raw = jsonb_set(raw, '{externalCustomerCode}', '"different"'::jsonb) WHERE job_id = $1 AND row_number = 4`, [staged.jobId]);
    await expect(archive.previewHistoricalCustomerReview({ ...input, partyId: a.partyId })).rejects.toMatchObject({ code: "customer_code_conflict" });
    await owner.query(`UPDATE data_import_rows SET raw = jsonb_set(raw, '{externalCustomerCode}', '""'::jsonb) WHERE job_id = $1 AND row_number = 4`, [staged.jobId]);
    await owner.query(`UPDATE parties SET name = 'changed review target' WHERE id = $1`, [a.partyId]);
    await expect(archive.confirmHistoricalCustomerReview(confirm)).rejects.toMatchObject({ code: "customer_review_stale" });
    await owner.query(`UPDATE parties SET name = 'customer' WHERE id = $1`, [a.partyId]);
    const refreshed = await archive.previewHistoricalCustomerReview({ ...input, partyId: a.partyId });
    confirm.reviewToken = refreshed.reviewToken;
    const operational = ["orders", "order_items", "payments", "journal_entries", "stock_movements", "tax_invoice_submissions", "historical_sales_invoices"];
    const operationalCounts = async () => {
      const counts: number[] = [];
      for (const table of operational) counts.push((await owner.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n);
      return counts;
    };
    const beforeLink = await operationalCounts();
    const results = await Promise.allSettled([archive.confirmHistoricalCustomerReview(confirm), archive.confirmHistoricalCustomerReview(confirm)]);
    expect(await operationalCounts()).toEqual(beforeLink);
    expect(results.filter((v) => v.status === "fulfilled")).toHaveLength(1);
    expect(results.find((v) => v.status === "rejected")).toMatchObject({ reason: { code: "customer_review_stale" } });
    const preview = await previewService.previewHistoricalImportJob(input);
    expect(preview).toMatchObject({ matchedCustomers: 2, toCreate: 1, invalid: 1, crossSourceChecked: false });
    expect(preview.documents.every((d) => d.partyId === a.partyId)).toBe(true);
    const after = await archive.previewHistoricalCustomerReview({ ...input, partyId: a.partyId });
    expect(after.existingIdentity).toMatchObject({ canonicalId: a.partyId, verified: true, provider: "generic" });
    expect(await archive.confirmHistoricalCustomerReview({ ...confirm, reviewToken: after.reviewToken })).toBe("unchanged");
    const other = (await owner.query<{ id: string }>(`INSERT INTO parties (business_id, name, role) VALUES ($1, 'review-other', 'customer') RETURNING id`, [a.businessId])).rows[0].id;
    await expect(archive.confirmHistoricalCustomerReview({ ...confirm, reviewToken: after.reviewToken, partyId: other })).rejects.toMatchObject({ code: "customer_review_stale" });
    const otherReview = await archive.previewHistoricalCustomerReview({ ...input, partyId: other });
    await expect(archive.confirmHistoricalCustomerReview({ ...confirm, reviewToken: otherReview.reviewToken, partyId: other })).rejects.toMatchObject({ code: "customer_identity_conflict" });
    expect((await owner.query(`SELECT count(*)::int AS n FROM historical_sales_invoices WHERE import_job_id = $1`, [staged.jobId])).rows[0].n).toBe(0);
    const logs = await owner.query(`SELECT payload FROM audit_log WHERE business_id = $1 AND action = 'historical_invoice.customer_reviewed' AND payload->>'jobId' = $2`, [a.businessId, staged.jobId]);
    expect(logs.rowCount).toBe(2);
    expect(logs.rows[0].payload).toMatchObject({ externalCustomerCode: "manual-1", mapping: input.mapping, matchingRows: 3 });
  });
  it("refuses a customer link when too many distinct customer hints would be hidden", async () => {
    const staging = await import("../src/lib/data-transfer/historical-invoice-staging");
    const rows = Array.from({ length: 21 }, (_, i) => `i${i},1403/01/01,code-21,1,Name${i}`).join("\n");
    const buffer = new TextEncoder().encode(`externalInvoiceId,invoiceDate,externalCustomerCode,total,sourceCustomerName\n${rows}`).buffer;
    const staged = await staging.stageHistoricalInvoiceFile({ businessId: a.businessId, locationId: a.locationId,
      actor: { userId: a.actorId, name: "owner" }, fileName: "review-large.csv", format: "csv", buffer,
      sourceKey: "review-source-21", provider: "generic", currency: "rial", calendar: "jalali" });
    const input = { businessId: a.businessId, locationId: a.locationId, jobId: staged.jobId, sourceKey: "review-source-21", provider: "generic",
      currency: "rial" as const, calendar: "jalali" as const, externalCustomerCode: "code-21", partyId: a.partyId,
      mapping: { columns: staged.columns.map((field, column) => ({ field, column })) } };
    const review = await archive.previewHistoricalCustomerReview(input);
    expect(review).toMatchObject({ matchingRows: 21, truncated: true, evidenceTruncated: true });
    expect(review.sourceNames).toHaveLength(20);
    await expect(archive.confirmHistoricalCustomerReview({ ...input, actor: { userId: a.actorId, name: "owner" },
      reviewToken: review.reviewToken, confirmed: true })).rejects.toMatchObject({ code: "customer_review_evidence_truncated" });
    expect((await owner.query(`SELECT count(*)::int AS n FROM source_identities WHERE business_id=$1 AND source_key='review-source-21'`, [a.businessId])).rows[0].n).toBe(0);
  });
  it("rejects over 50,000 combined workbook rows before creating a job", async () => {
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    const headers = wb.addWorksheet("Headers");
    const lines = wb.addWorksheet("Lines");
    headers.addRow(["id"]); lines.addRow(["id"]);
    for (let i = 0; i < 25_000; i++) { headers.addRow([`h${i}`]); lines.addRow([`l${i}`]); }
    const serialize = async () => Uint8Array.from(await wb.xlsx.writeBuffer() as unknown as Uint8Array).buffer;
    const { parseHistoricalInvoiceFile } = await import("../src/lib/data-transfer/historical-invoice-file");
    const atLimit = await parseHistoricalInvoiceFile(await serialize(), "xlsx");
    expect(atLimit.reduce((sum, sheet) => sum + sheet.rows.length, 0)).toBe(50_000);
    lines.addRow(["extra"]);
    const buffer = await serialize();
    const before = (await owner.query(`SELECT count(*)::int AS n FROM data_import_jobs WHERE business_id = $1`, [a.businessId])).rows[0].n;
    const staging = await import("../src/lib/data-transfer/historical-invoice-staging");
    const input = { businessId: a.businessId, locationId: a.locationId, actor: { userId: a.actorId, name: "owner" },
      fileName: "large.xlsx", format: "xlsx" as const, buffer, sourceKey: "old-shop-1", provider: "generic", currency: "rial" as const, calendar: "jalali" as const, sheets: { headers: "Headers", lines: "Lines" } };
    await expect(staging.stageHistoricalInvoiceFile(input)).rejects.toMatchObject({ code: "too_many_rows" });
    await expect(staging.stageHistoricalInvoiceFile({ ...input, buffer: new TextEncoder().encode("not an xlsx").buffer })).rejects.toMatchObject({ code: "invalid_xlsx" });
    expect((await owner.query(`SELECT count(*)::int AS n FROM data_import_jobs WHERE business_id = $1`, [a.businessId])).rows[0].n).toBe(before);
  }, 90_000);
  it("previews 2,000 two-sheet invoices against 500 verified existing customers without importing them", async () => {
    const customers = await owner.query<{ id: string; name: string }>(
      `INSERT INTO parties (business_id, name, role)
       SELECT $1, 'scale-' || n::text, 'customer' FROM generate_series(0,499) n RETURNING id, name`, [a.businessId],
    );
    await owner.query(
      `INSERT INTO source_identities (business_id, domain, source_key, provider, external_type, external_id, canonical_type, canonical_id, linked_by)
       SELECT $1, 'party', 'scale-source', 'generic', 'historical_customer_code', p.name, 'parties', p.id::text, $2
         FROM parties p WHERE p.business_id = $1 AND p.name LIKE 'scale-%'`, [a.businessId, a.actorId],
    );
    const customerIds = new Map(customers.rows.map((row) => [row.name, row.id]));
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    const heads = wb.addWorksheet("Invoices");
    const lines = wb.addWorksheet("Items");
    heads.addRow(["externalInvoiceId", "invoiceDate", "externalCustomerCode", "total"]);
    lines.addRow(["externalInvoiceId", "lineName", "quantity", "unitPrice"]);
    for (let i = 0; i < 2000; i++) {
      heads.addRow([`scale-inv-${i}`, "1403/01/01", `scale-${i % 500}`, "10"]);
      lines.addRow([`scale-inv-${i}`, "کالا", "1", "10"]);
    }
    const bytes = Uint8Array.from(await wb.xlsx.writeBuffer() as unknown as Uint8Array).buffer;
    const staging = await import("../src/lib/data-transfer/historical-invoice-staging");
    const countCustomers = async () => (await owner.query(`SELECT count(*)::int AS n FROM parties WHERE business_id = $1`, [a.businessId])).rows[0].n;
    const countBefore = await countCustomers();
    const staged = await staging.stageHistoricalInvoiceFile({ businessId: a.businessId, locationId: a.locationId,
      actor: { userId: a.actorId, name: "owner" }, fileName: "scale.xlsx", format: "xlsx", buffer: bytes,
      sourceKey: "scale-source", provider: "generic", currency: "rial", calendar: "jalali", sheets: { headers: "Invoices", lines: "Items" } });
    const previewInput = { businessId: a.businessId, locationId: a.locationId, jobId: staged.jobId,
      sourceKey: "scale-source", provider: "generic", currency: "rial" as const, calendar: "jalali" as const, sampleLimit: 200,
      mapping: { columns: staged.columns.map((field, column) => ({ field, column })) },
      lineMapping: { columns: staged.lineColumns!.map((field, column) => ({ field, column })) } };
    const result = await previewService.previewHistoricalImportJob(previewInput);
    expect(result).toMatchObject({ totalInvoices: 2000, matchedCustomers: 2000, toCreate: 2000, reviewNeeded: 0, invalid: 0, orphanLineCount: 0, truncated: true, reconciliation: { totalRial: "20000" } });
    expect(result.documents).toHaveLength(200);
    expect(result).toMatchObject({ documentOffset: 0, hasMoreDocuments: true, hasMoreOrphans: false });
    const lastPage = await previewService.previewHistoricalImportJob({ ...previewInput, documentOffset: 1800 });
    expect(lastPage.documents).toHaveLength(200);
    expect(lastPage.documents[0].externalInvoiceId).toBe("scale-inv-1800");
    expect(lastPage.documents[199].externalInvoiceId).toBe("scale-inv-1999");
    expect(lastPage.hasMoreDocuments).toBe(false);
    expect(lastPage.totalInvoices).toBe(2000);
    for (const doc of result.documents) {
      const index = Number(doc.externalInvoiceId.replace("scale-inv-", ""));
      expect(doc.partyId).toBe(customerIds.get(`scale-${index % 500}`));
      expect(doc.rows).toHaveLength(2);
    }
    expect((await owner.query(`SELECT count(*)::int AS n FROM historical_sales_invoices WHERE import_job_id = $1`, [staged.jobId])).rows[0].n).toBe(0);
    expect(await countCustomers()).toBe(countBefore);
  }, 60_000);
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
