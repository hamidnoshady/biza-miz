/** Branch-scoped review history; generic Data Transfer and AI history must not expose these jobs. */
import { withTenant } from "../db";
import { query } from "../db";
import { HistoricalJobPreviewError } from "./historical-invoice-staged-rows";

type HistoricalJobRow = {
  id: string; file_name: string; file_format: string; status: string; total_rows: number;
  created_at: Date; source_key: string; provider: string; currency: string; calendar: string;
};
const columns = `id, file_name, file_format, status, total_rows, created_at,
  options->'historicalInvoice'->>'sourceKey' AS source_key,
  options->'historicalInvoice'->>'provider' AS provider,
  options->'historicalInvoice'->>'currency' AS currency,
  options->'historicalInvoice'->>'calendar' AS calendar`;
function job(row: HistoricalJobRow) {
  return { jobId: row.id, fileName: row.file_name, format: row.file_format, status: row.status,
    rowCount: row.total_rows, createdAt: row.created_at, sourceKey: row.source_key,
    provider: row.provider, currency: row.currency, calendar: row.calendar };
}

export async function listHistoricalInvoiceJobs(input: { businessId: string; locationId: string; limit: number; offset: number }) {
  return withTenant(input.businessId, async () => {
    const { rows } = await query<HistoricalJobRow>(
      `SELECT ${columns} FROM data_import_jobs
       WHERE business_id = $1 AND location_id = $2 AND entity_key = 'accounting.historical_invoices'
       ORDER BY created_at DESC, id DESC LIMIT $3 OFFSET $4`,
      [input.businessId, input.locationId, input.limit + 1, input.offset],
    );
    return { jobs: rows.slice(0, input.limit).map(job), hasMore: rows.length > input.limit };
  });
}

export async function getHistoricalInvoiceJob(input: { businessId: string; locationId: string; jobId: string }) {
  return withTenant(input.businessId, async () => {
    const { rows } = await query<HistoricalJobRow & { source_columns: unknown; structure: string | null; line_columns: unknown }>(
      `SELECT ${columns}, source_columns, options->'historicalInvoice'->>'structure' AS structure,
        options->'historicalInvoice'->'lineColumns' AS line_columns
       FROM data_import_jobs WHERE business_id = $1 AND location_id = $2
         AND id = $3 AND entity_key = 'accounting.historical_invoices'`,
      [input.businessId, input.locationId, input.jobId],
    );
    if (!rows[0]) throw new HistoricalJobPreviewError("job_not_found");
    const row = rows[0];
    return { ...job(row), columns: row.source_columns, structure: row.structure ?? "flat", lineColumns: row.line_columns };
  });
}

/** Search names/phones using the shared directory matcher, but return only eligible
 * customer identities from the active branch. A result is never a binding. */
export async function searchHistoricalCustomers(input: { businessId: string; locationId: string; term: string }) {
  return withTenant(input.businessId, async () => {
    const { partySearchClause } = await import("../parties-service");
    const search = await partySearchClause(input.businessId, input.term, 3);
    const { rows } = await query<{ id: string; name: string; phone_last4: string | null }>(
      `SELECT p.id, p.name, p.phone_last4 FROM parties p
       WHERE p.business_id = $1 AND (p.location_id IS NULL OR p.location_id = $2)
         AND 'customer' = ANY(p.roles) AND p.is_active AND p.merged_into_id IS NULL
         AND ${search.sql}
       ORDER BY p.name, p.id LIMIT 21`,
      [input.businessId, input.locationId, ...search.params],
    );
    return { customers: rows.slice(0, 20).map((row) => ({ id: row.id, name: row.name, phoneLast4: row.phone_last4 })), hasMore: rows.length > 20 };
  });
}
