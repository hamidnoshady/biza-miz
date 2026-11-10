/**
 * Internal, transactional staging for flat historical invoice files. No route,
 * queue registration, approval or archive write is provided here. A caller
 * must check Data Transfer and accounting/CRM permissions, service activation,
 * and access to the selected branch before invoking this function.
 */
import { createHash } from "node:crypto";
import { withTenantTransaction } from "../db";
import { parseHistoricalInvoiceFile } from "./historical-invoice-file";
import type { HistoricalCalendar, HistoricalCurrency } from "./historical-invoice-preview";
import type { HistoricalArchiveActor } from "./historical-invoice-archive-service";

export class HistoricalStagingError extends Error {
  constructor(readonly code: string) { super(code); this.name = "HistoricalStagingError"; }
}

export async function stageHistoricalInvoiceFile(input: {
  businessId: string;
  locationId: string;
  actor: HistoricalArchiveActor;
  fileName: string;
  format: "csv" | "xlsx" | "json";
  buffer: ArrayBuffer;
  sourceKey: string;
  provider: string;
  currency: HistoricalCurrency;
  calendar: HistoricalCalendar;
}): Promise<{ jobId: string; columns: string[]; rowCount: number }> {
  const sourceKey = input.sourceKey.trim(), provider = input.provider.trim();
  if (!sourceKey || sourceKey.length > 200 || provider.length > 200) throw new HistoricalStagingError("invalid_source");
  if (input.currency !== "rial" && input.currency !== "toman") throw new HistoricalStagingError("invalid_currency");
  if (input.calendar !== "jalali" && input.calendar !== "gregorian") throw new HistoricalStagingError("invalid_calendar");
  // Freeze caller-owned bytes before the asynchronous XLSX decoder runs, so
  // the stored fingerprint and staged rows always describe the same upload.
  if (input.buffer.byteLength > 20 * 1024 * 1024) throw new HistoricalStagingError("file_too_large");
  const bytes = input.buffer.slice(0);
  const sheets = await parseHistoricalInvoiceFile(bytes, input.format);
  // Never silently discard a second sheet. Relational header/line staging
  // requires its own reviewed join and is not implemented by this service.
  if (sheets.length !== 1) throw new HistoricalStagingError("multi_sheet_not_supported");
  const source = sheets[0];
  const fingerprint = createHash("sha256").update(new Uint8Array(bytes)).digest("hex");
  return withTenantTransaction(input.businessId, async (client) => {
    const actor = await client.query(`SELECT id FROM users WHERE id = $1 AND business_id = $2 AND is_active FOR SHARE`, [input.actor.userId, input.businessId]);
    if (!actor.rowCount) throw new HistoricalStagingError("actor_not_active");
    const location = await client.query(`SELECT id FROM locations WHERE id = $1 AND business_id = $2 AND is_active FOR SHARE`, [input.locationId, input.businessId]);
    if (!location.rowCount) throw new HistoricalStagingError("location_not_found");
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO data_import_jobs
       (business_id, location_id, entity_key, status, file_name, file_format, file_size_bytes, source_columns, mapping, options, total_rows, created_by, created_by_name)
       VALUES ($1,$2,'accounting.historical_invoices','pending',$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10,$11) RETURNING id`,
      [input.businessId, input.locationId, input.fileName.slice(0, 300), input.format, bytes.byteLength,
        JSON.stringify(source.columns), JSON.stringify({ columns: [] }),
        JSON.stringify({ historicalInvoice: { sourceKey, provider, currency: input.currency, calendar: input.calendar, sourceSheet: source.name, fileSha256: fingerprint } }),
        source.rows.length, input.actor.userId, input.actor.name.slice(0, 300)],
    );
    const jobId = inserted.rows[0].id;
    for (let i = 0; i < source.rows.length; i += 500) {
      const chunk = source.rows.slice(i, i + 500).map((row) => ({ row_number: row.rowNumber, raw: row.raw }));
      await client.query(
        `INSERT INTO data_import_rows (job_id, row_number, status, raw)
         SELECT $1, r.row_number, 'warning', r.raw FROM jsonb_to_recordset($2::jsonb) AS r(row_number integer, raw jsonb)`,
        [jobId, JSON.stringify(chunk)],
      );
    }
    await client.query(
      `INSERT INTO audit_log (business_id, user_id, action, entity, entity_id, payload)
       VALUES ($1,$2,'historical_invoice.staged','accounting.historical_invoices',$3,$4::jsonb)`,
      [input.businessId, input.actor.userId, jobId, JSON.stringify({ sourceKey, provider, fileSha256: fingerprint, rowCount: source.rows.length })],
    );
    return { jobId, columns: source.columns, rowCount: source.rows.length };
  });
}
