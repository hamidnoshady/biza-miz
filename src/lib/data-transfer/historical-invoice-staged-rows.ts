/** Shared validated staged-row loader for preview and reviewed linking. */
import type { PoolClient } from "pg";
import { mapHistoricalInvoiceRows, mapHistoricalInvoiceHeaderRows, mapHistoricalInvoiceLineRows, type HistoricalRawRow } from "./historical-invoice-mapping";
import type { HistoricalCalendar, HistoricalCurrency, HistoricalInvoiceRow } from "./historical-invoice-preview";
import type { ImportMapping } from "./types";

export class HistoricalJobPreviewError extends Error {
  constructor(readonly code: string) { super(code); this.name = "HistoricalJobPreviewError"; }
}

export interface HistoricalStagedInput {
  businessId: string; locationId: string; jobId: string; sourceKey: string; provider: string;
  currency: HistoricalCurrency; calendar: HistoricalCalendar; mapping: ImportMapping; lineMapping?: ImportMapping;
}

/** lock=true requires a transaction and protects the source evidence while reviewing a link. */
export async function loadHistoricalStagedRows(client: PoolClient, input: HistoricalStagedInput, lock = false) {
  const sourceKey = input.sourceKey.trim(), provider = input.provider.trim();
  if (!sourceKey || sourceKey.length > 200 || provider.length > 200) throw new HistoricalJobPreviewError("invalid_source");
  if (input.currency !== "rial" && input.currency !== "toman") throw new HistoricalJobPreviewError("invalid_currency");
  if (input.calendar !== "jalali" && input.calendar !== "gregorian") throw new HistoricalJobPreviewError("invalid_calendar");
  const job = await client.query<{ source_columns: unknown; status: string; options: { historicalInvoice?: { sourceKey?: string; provider?: string; currency?: string; calendar?: string; structure?: string; sourceSheet?: string; lineSheet?: string; lineColumns?: unknown } } }>(
    `SELECT source_columns, status, options FROM data_import_jobs
      WHERE id = $1 AND business_id = $2 AND location_id = $3 AND entity_key = 'accounting.historical_invoices' ${lock ? "FOR UPDATE" : ""}`,
    [input.jobId, input.businessId, input.locationId],
  );
  if (!job.rowCount) throw new HistoricalJobPreviewError("job_not_found");
  if (!["pending", "ready"].includes(job.rows[0].status)) throw new HistoricalJobPreviewError("job_not_editable");
  const source = job.rows[0].options?.historicalInvoice;
  if (!source || source.sourceKey !== sourceKey || source.provider !== provider || source.currency !== input.currency || source.calendar !== input.calendar) {
    throw new HistoricalJobPreviewError("job_source_changed");
  }
  const rawColumns = job.rows[0].source_columns;
  if (!Array.isArray(rawColumns) || !rawColumns.every((value) => typeof value === "string")) throw new HistoricalJobPreviewError("invalid_source_columns");
  const staged = await client.query<{ row_number: number; raw: unknown }>(
    `SELECT row_number, raw FROM data_import_rows WHERE job_id = $1 ORDER BY row_number LIMIT 50001 ${lock ? "FOR SHARE" : ""}`, [input.jobId],
  );
  if (staged.rows.length > 50_000) throw new HistoricalJobPreviewError("too_many_rows");
  if (staged.rows.length === 0) throw new HistoricalJobPreviewError("no_rows");
  let mapped: HistoricalInvoiceRow[];
  let headerRows: HistoricalInvoiceRow[] = [];
  let lineRows: HistoricalInvoiceRow[] = [];
  if (source.structure === "header_lines") {
    if (!input.lineMapping || typeof source.sourceSheet !== "string" || !source.sourceSheet || typeof source.lineSheet !== "string" || !source.lineSheet || source.sourceSheet === source.lineSheet ||
        !Array.isArray(source.lineColumns) || !source.lineColumns.every((c) => typeof c === "string")) {
      throw new HistoricalJobPreviewError("invalid_sheet_configuration");
    }
    const groups: Record<"header" | "line", HistoricalRawRow[]> = { header: [], line: [] };
    const coordinates = new Map<number, { sourceSheet: string; sourceRowNumber: number }>();
    const seen = new Set<string>();
    for (const row of staged.rows) {
      const envelope = row.raw as { kind?: unknown; sheet?: unknown; sourceRowNumber?: unknown; cells?: unknown } | null;
      const kind = envelope?.kind;
      if (!envelope || (kind !== "header" && kind !== "line")) throw new HistoricalJobPreviewError("invalid_staged_sheet_row");
      const expectedSheet = kind === "header" ? source.sourceSheet : source.lineSheet;
      const cols = kind === "header" ? rawColumns : source.lineColumns;
      const cells = envelope.cells;
      if (envelope.sheet !== expectedSheet || !Number.isSafeInteger(envelope.sourceRowNumber) || Number(envelope.sourceRowNumber) < 2 ||
          !cells || typeof cells !== "object" || Array.isArray(cells) || Object.keys(cells).length !== cols.length ||
          cols.some((c) => !Object.hasOwn(cells, c) || typeof (cells as Record<string, unknown>)[c] !== "string")) {
        throw new HistoricalJobPreviewError("invalid_staged_sheet_row");
      }
      const key = `${kind}:${envelope.sourceRowNumber}`;
      if (seen.has(key)) throw new HistoricalJobPreviewError("invalid_staged_sheet_row");
      seen.add(key);
      groups[kind].push({ rowNumber: row.row_number, raw: cells as Record<string, string> });
      coordinates.set(row.row_number, { sourceSheet: expectedSheet, sourceRowNumber: Number(envelope.sourceRowNumber) });
    }
    if (!groups.header.length || !groups.line.length) throw new HistoricalJobPreviewError("invalid_staged_sheet_row");
    headerRows = mapHistoricalInvoiceHeaderRows(rawColumns, groups.header, input.mapping).map((row) => ({ ...row, ...coordinates.get(row.rowNumber) }));
    lineRows = mapHistoricalInvoiceLineRows(source.lineColumns, groups.line, input.lineMapping).map((row) => ({ ...row, ...coordinates.get(row.rowNumber) }));
    mapped = [...headerRows, ...lineRows];
  } else {
    if (source.structure !== undefined && source.structure !== "flat") throw new HistoricalJobPreviewError("invalid_sheet_configuration");
    if (input.lineMapping) throw new HistoricalJobPreviewError("invalid_sheet_configuration");
    const rawRows: HistoricalRawRow[] = staged.rows.map((row) => ({ rowNumber: row.row_number, raw: row.raw as Record<string, string> }));
    mapped = mapHistoricalInvoiceRows(rawColumns, rawRows, input.mapping);
  }
  return { source, mapped, headerRows, lineRows };
}
