/**
 * The import engine: upload → analyse → map → validate → preview → perform.
 *
 * ## The split, and why it is the whole design
 *
 * `createImportJob` parses and stores the file's rows and writes **nothing**
 * to the business's own tables. `previewImportJob` re-validates against the
 * current mapping, still writing nothing. `runImportJob` is the only function
 * that touches tenant data, and it re-derives everything from the stored rows
 * rather than trusting a plan the client computed.
 *
 * That is not ceremony. An import is the fastest way to destroy a customer
 * directory: one mis-mapped column and three thousand records get a phone
 * number in the name field, with no undo. Showing exactly what will happen —
 * how many created, matched, rejected, and why, row by row — converts an
 * irreversible bulk write into a decision somebody can actually make. And
 * re-deriving at perform time is what stops a stale approval from being
 * executed against data that moved underneath it.
 *
 * ## Row-at-a-time, not one transaction
 *
 * Each row is its own write. A 5,000-row import in a single transaction holds
 * locks for minutes and rolls the whole batch back over one bad row — whereas
 * partial success is exactly what the reported counts describe, and re-running
 * the file is safe because the rows that landed now *match* instead of
 * creating.
 *
 * ## Consent is never imported
 *
 * There is no consent column anywhere in the registry and no way to add one
 * through a mapping. A spreadsheet of names is not permission to text those
 * people; consent is a legal record with a source and a timestamp, and a CSV
 * cell is not that.
 */

import { query, withoutTenantScope, withTenant } from "../db";
import { findEntity, requireEntity } from "./registry";
import { ensureAdaptersRegistered } from "./entities";
import { RowRejection, requireAdapter, type AdapterContext } from "./adapters";
import {
  jsonToRows,
  parseCsv,
  pdfToRows,
  toCsv,
  xlsxToRows,
} from "./codecs";
import {
  missingRequiredFields,
  sheetFromRows,
  suggestMapping,
  unmappedColumns,
  validateSheet,
} from "./mapping";
import { recordDataTransferAudit } from "./audit";
import type {
  EntityDefinition,
  ImportFormat,
  ImportJobFormat,
  ImportJobStatus,
  ProviderJobMetadata,
  ImportMapping,
  ImportOptions,
  ParsedSheet,
  RowMessage,
  ValidatedRow,
} from "./types";

/** Beyond this a preview is unusable and a single job is the wrong unit. */
export const MAX_IMPORT_ROWS = 50_000;
/** Rows returned inline with a preview; the rest stay in `data_import_rows`. */
export const PREVIEW_ROW_LIMIT = 200;
export const MAX_IMPORT_FILE_BYTES = 20 * 1024 * 1024;

export class ImportError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ImportError";
  }
}

export interface ImportJob {
  id: string;
  entityKey: string;
  entityLabel: string;
  status: ImportJobStatus;
  fileName: string;
  fileFormat: ImportJobFormat;
  fileSizeBytes: number;
  providerMetadata: ProviderJobMetadata | null;
  sourceColumns: string[];
  mapping: ImportMapping;
  options: ImportOptions;
  totalRows: number;
  validRows: number;
  warningRows: number;
  errorRows: number;
  createdRows: number;
  updatedRows: number;
  skippedRows: number;
  failedRows: number;
  error: string | null;
  createdByName: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

interface JobRow extends Record<string, unknown> {
  id: string;
  entity_key: string;
  status: ImportJobStatus;
  file_name: string;
  file_format: ImportJobFormat;
  file_size_bytes: string | number;
  provider_metadata: unknown;
  source_columns: unknown;
  mapping: unknown;
  options: unknown;
  total_rows: number;
  valid_rows: number;
  warning_rows: number;
  error_rows: number;
  created_rows: number;
  updated_rows: number;
  skipped_rows: number;
  failed_rows: number;
  error: string | null;
  created_by_name: string;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

function normaliseProviderMetadata(value: unknown): ProviderJobMetadata | null {
  let candidate = value;
  if (typeof candidate === "string") {
    try { candidate = JSON.parse(candidate); } catch { return null; }
  }
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const metadata = candidate as Record<string, unknown>;
  if (
    typeof metadata.provider !== "string" ||
    typeof metadata.sourceFormat !== "string" ||
    typeof metadata.connectionId !== "string" ||
    typeof metadata.profileKey !== "string" ||
    typeof metadata.profileVersion !== "number" ||
    !Array.isArray(metadata.selectedScopes)
  ) return null;
  return metadata as unknown as ProviderJobMetadata;
}

function toJob(row: JobRow): ImportJob {
  const providerMetadata = normaliseProviderMetadata(row.provider_metadata);
  return {
    id: row.id,
    entityKey: row.entity_key,
    entityLabel: providerMetadata?.provider === "holoo" ? "انتقال هلو" : findEntity(row.entity_key)?.label ?? row.entity_key,
    status: row.status,
    fileName: row.file_name,
    fileFormat: row.file_format,
    fileSizeBytes: Number(row.file_size_bytes ?? 0),
    providerMetadata,
    sourceColumns: Array.isArray(row.source_columns) ? (row.source_columns as string[]) : [],
    mapping: normaliseMapping(row.mapping),
    options: (row.options ?? {}) as ImportOptions,
    totalRows: row.total_rows,
    validRows: row.valid_rows,
    warningRows: row.warning_rows,
    errorRows: row.error_rows,
    createdRows: row.created_rows,
    updatedRows: row.updated_rows,
    skippedRows: row.skipped_rows,
    failedRows: row.failed_rows,
    error: row.error,
    createdByName: row.created_by_name,
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    finishedAt: row.finished_at?.toISOString() ?? null,
  };
}

function normaliseMapping(value: unknown): ImportMapping {
  if (!value || typeof value !== "object") return { columns: [] };
  const columns = (value as { columns?: unknown }).columns;
  if (!Array.isArray(columns)) return { columns: [] };
  return {
    columns: columns.filter(
      (column): column is ImportMapping["columns"][number] =>
        typeof column === "object" &&
        column !== null &&
        typeof (column as { field?: unknown }).field === "string",
    ),
  };
}

const JOB_COLUMNS = `id, entity_key, status, file_name, file_format, file_size_bytes, provider_metadata,
  source_columns, mapping, options, total_rows, valid_rows, warning_rows, error_rows,
  created_rows, updated_rows, skipped_rows, failed_rows, error, created_by_name,
  created_at, started_at, finished_at`;

/** The format a filename implies. Content sniffing would be worse: a `.csv` that is really XLSX is a user error worth naming. */
export function formatForFileName(fileName: string): ImportFormat | null {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".csv") || lower.endsWith(".txt") || lower.endsWith(".tsv")) return "csv";
  if (lower.endsWith(".xlsx") || lower.endsWith(".xlsm")) return "xlsx";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".pdf")) return "pdf";
  return null;
}

/** Parse a file into a sheet, in whichever of the four formats it is. */
export async function parseImportFile(
  buffer: ArrayBuffer,
  format: ImportFormat,
): Promise<ParsedSheet> {
  let rows: string[][];
  switch (format) {
    case "csv":
      rows = parseCsv(new TextDecoder("utf-8").decode(buffer));
      break;
    case "xlsx":
      rows = await xlsxToRows(buffer);
      break;
    case "json":
      rows = jsonToRows(new TextDecoder("utf-8").decode(buffer));
      break;
    case "pdf":
      rows = await pdfToRows(buffer);
      break;
    default:
      throw new ImportError("unsupported_format");
  }
  return sheetFromRows(rows);
}

export interface CreateImportJobInput {
  businessId: string;
  locationId: string | null;
  entityKey: string;
  fileName: string;
  format: ImportFormat;
  buffer: ArrayBuffer;
  actorUserId: string | null;
  actorName: string;
  /** A saved mapping template to start from; otherwise suggestions. */
  mapping?: ImportMapping | null;
  options?: ImportOptions;
}

/**
 * Parse an upload, store its rows, and propose a mapping.
 *
 * Nothing about the business's own data is touched: this writes only to
 * `data_import_jobs` and `data_import_rows`, which is what makes the preview
 * the operator approves meaningful.
 */
export async function createImportJob(input: CreateImportJobInput): Promise<{
  job: ImportJob;
  sheet: ParsedSheet;
}> {
  ensureAdaptersRegistered();
  const entity = findEntity(input.entityKey);
  if (!entity) throw new ImportError("unknown_entity");
  if (!entity.importPermission) throw new ImportError("entity_not_importable");
  if (entity.locationScoped && !input.locationId) throw new ImportError("location_required");

  const sheet = await parseImportFile(input.buffer, input.format);
  if (sheet.columns.length === 0) throw new ImportError("empty_file");
  if (sheet.rows.length === 0) throw new ImportError("no_rows");
  if (sheet.rows.length > MAX_IMPORT_ROWS) throw new ImportError("too_many_rows");

  const mapping =
    input.mapping && input.mapping.columns.length > 0
      ? input.mapping
      : suggestMapping(entity, sheet);
  const options: ImportOptions = {
    duplicateStrategy: "skip",
    validOnly: true,
    ...input.options,
  };

  const { rows } = await query<JobRow>(
    `INSERT INTO data_import_jobs
       (business_id, location_id, entity_key, status, file_name, file_format,
        file_size_bytes, source_columns, mapping, options, total_rows,
        created_by, created_by_name)
     VALUES ($1, $2::uuid, $3, 'pending', $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10,
             $11::uuid, $12)
     RETURNING ${JOB_COLUMNS}`,
    [
      input.businessId,
      input.locationId,
      entity.key,
      input.fileName.slice(0, 300),
      input.format,
      input.buffer.byteLength,
      JSON.stringify(sheet.columns),
      JSON.stringify(mapping),
      JSON.stringify(options),
      sheet.rows.length,
      input.actorUserId,
      input.actorName,
    ],
  );
  const job = toJob(rows[0]);

  // The raw rows, stored once. Every later step — preview, perform, retry,
  // failed-row report — reads these rather than asking for the file again,
  // which is what makes "retry the failed rows" possible days later.
  await insertRows(job.id, entity, sheet, mapping, options);
  const counts = await recount(job.id);
  const updated = await updateJob(input.businessId, job.id, {
    status: "ready",
    ...counts,
  });

  await recordDataTransferAudit({
    businessId: input.businessId,
    action: "data.import.created",
    entityKey: entity.key,
    entityId: job.id,
    actorUserId: input.actorUserId,
    payload: {
      fileName: input.fileName,
      format: input.format,
      totalRows: sheet.rows.length,
    },
  });

  return { job: updated ?? job, sheet };
}

/** Store the validated rows of a job, replacing whatever was there. */
async function insertRows(
  jobId: string,
  entity: EntityDefinition,
  sheet: ParsedSheet,
  mapping: ImportMapping,
  options: ImportOptions,
): Promise<ValidatedRow[]> {
  const validated = validateSheet(entity, sheet, mapping, options);
  await query(`DELETE FROM data_import_rows WHERE job_id = $1`, [jobId]);

  // One multi-row INSERT per chunk: 5,000 individual statements is a minute of
  // round trips, and a single 5,000-row VALUES list exceeds the parameter
  // limit (65,535 / 6 columns).
  const CHUNK = 500;
  for (let start = 0; start < validated.length; start += CHUNK) {
    const chunk = validated.slice(start, start + CHUNK);
    const values: unknown[] = [];
    const tuples = chunk.map((row, index) => {
      const base = index * 6;
      values.push(
        jobId,
        row.rowNumber,
        rowStatus(row),
        JSON.stringify(row.raw),
        JSON.stringify(row.values),
        JSON.stringify(row.messages),
      );
      return `($${base + 1}::uuid, $${base + 2}, $${base + 3}, $${base + 4}::jsonb, $${base + 5}::jsonb, $${base + 6}::jsonb)`;
    });
    await query(
      `INSERT INTO data_import_rows (job_id, row_number, status, raw, mapped, messages)
       VALUES ${tuples.join(", ")}`,
      values,
    );
  }
  return validated;
}

function rowStatus(row: ValidatedRow): "valid" | "warning" | "error" {
  if (row.messages.some((message) => message.severity === "error")) return "error";
  if (row.messages.length > 0) return "warning";
  return "valid";
}

async function recount(jobId: string): Promise<{
  totalRows: number;
  validRows: number;
  warningRows: number;
  errorRows: number;
}> {
  const { rows } = await query<{
    total: string;
    valid: string;
    warning: string;
    error: string;
  }>(
    `SELECT count(*)::text AS total,
            count(*) FILTER (WHERE status = 'valid')::text AS valid,
            count(*) FILTER (WHERE status = 'warning')::text AS warning,
            count(*) FILTER (WHERE status = 'error')::text AS error
       FROM data_import_rows WHERE job_id = $1`,
    [jobId],
  );
  const row = rows[0];
  return {
    totalRows: Number(row?.total ?? 0),
    validRows: Number(row?.valid ?? 0),
    warningRows: Number(row?.warning ?? 0),
    errorRows: Number(row?.error ?? 0),
  };
}

async function updateJob(
  businessId: string,
  jobId: string,
  patch: Partial<{
    status: ImportJobStatus;
    mapping: ImportMapping;
    options: ImportOptions;
    totalRows: number;
    validRows: number;
    warningRows: number;
    errorRows: number;
    createdRows: number;
    updatedRows: number;
    skippedRows: number;
    failedRows: number;
    error: string | null;
    startedAt: "now" | null;
    finishedAt: "now" | null;
  }>,
): Promise<ImportJob | null> {
  const sets: string[] = ["updated_at = now()"];
  const params: unknown[] = [businessId, jobId];
  const add = (column: string, value: unknown) => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };
  if (patch.status !== undefined) add("status", patch.status);
  if (patch.mapping !== undefined) {
    params.push(JSON.stringify(patch.mapping));
    sets.push(`mapping = $${params.length}::jsonb`);
  }
  if (patch.options !== undefined) {
    params.push(JSON.stringify(patch.options));
    sets.push(`options = $${params.length}::jsonb`);
  }
  if (patch.totalRows !== undefined) add("total_rows", patch.totalRows);
  if (patch.validRows !== undefined) add("valid_rows", patch.validRows);
  if (patch.warningRows !== undefined) add("warning_rows", patch.warningRows);
  if (patch.errorRows !== undefined) add("error_rows", patch.errorRows);
  if (patch.createdRows !== undefined) add("created_rows", patch.createdRows);
  if (patch.updatedRows !== undefined) add("updated_rows", patch.updatedRows);
  if (patch.skippedRows !== undefined) add("skipped_rows", patch.skippedRows);
  if (patch.failedRows !== undefined) add("failed_rows", patch.failedRows);
  if (patch.error !== undefined) add("error", patch.error);
  if (patch.startedAt === "now") sets.push("started_at = now()");
  if (patch.finishedAt === "now") sets.push("finished_at = now()");

  const { rows } = await query<JobRow>(
    `UPDATE data_import_jobs SET ${sets.join(", ")}
      WHERE business_id = $1 AND id = $2
      RETURNING ${JOB_COLUMNS}`,
    params,
  );
  return rows[0] ? toJob(rows[0]) : null;
}

export async function getImportJob(businessId: string, jobId: string): Promise<ImportJob | null> {
  const { rows } = await query<JobRow>(
    `SELECT ${JOB_COLUMNS} FROM data_import_jobs WHERE business_id = $1 AND id = $2`,
    [businessId, jobId],
  );
  return rows[0] ? toJob(rows[0]) : null;
}

export async function listImportJobs(
  businessId: string,
  options: { entityKey?: string | null; limit?: number } = {},
): Promise<ImportJob[]> {
  const params: unknown[] = [businessId];
  const where = ["business_id = $1"];
  if (options.entityKey) {
    params.push(options.entityKey);
    where.push(`entity_key = $${params.length}`);
  }
  params.push(Math.min(Math.max(options.limit ?? 50, 1), 200));
  const { rows } = await query<JobRow>(
    `SELECT ${JOB_COLUMNS} FROM data_import_jobs
      WHERE ${where.join(" AND ")}
      ORDER BY created_at DESC
      LIMIT $${params.length}`,
    params,
  );
  return rows.map(toJob);
}

/** The job's rows, for the preview table and the error report. */
export async function listImportRows(
  businessId: string,
  jobId: string,
  options: { status?: string | null; limit?: number; offset?: number } = {},
): Promise<{
  rows: {
    rowNumber: number;
    status: string;
    raw: Record<string, string>;
    mapped: Record<string, unknown>;
    messages: RowMessage[];
    targetId: string | null;
  }[];
  total: number;
}> {
  const params: unknown[] = [businessId, jobId];
  const where = [
    "j.business_id = $1",
    "r.job_id = $2",
  ];
  if (options.status) {
    params.push(options.status);
    where.push(`r.status = $${params.length}`);
  }
  const { rows: totals } = await query<{ total: string }>(
    `SELECT count(*)::text AS total
       FROM data_import_rows r
       JOIN data_import_jobs j ON j.id = r.job_id
      WHERE ${where.join(" AND ")}`,
    params,
  );
  params.push(Math.min(Math.max(options.limit ?? PREVIEW_ROW_LIMIT, 1), 2000));
  params.push(Math.max(options.offset ?? 0, 0));
  const { rows } = await query<{
    row_number: number;
    status: string;
    raw: Record<string, string>;
    mapped: Record<string, unknown>;
    messages: RowMessage[];
    target_id: string | null;
  }>(
    `SELECT r.row_number, r.status, r.raw, r.mapped, r.messages, r.target_id
       FROM data_import_rows r
       JOIN data_import_jobs j ON j.id = r.job_id
      WHERE ${where.join(" AND ")}
      ORDER BY r.row_number
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return {
    total: Number(totals[0]?.total ?? 0),
    rows: rows.map((row) => ({
      rowNumber: row.row_number,
      status: row.status,
      raw: row.raw ?? {},
      mapped: row.mapped ?? {},
      messages: Array.isArray(row.messages) ? row.messages : [],
      targetId: row.target_id,
    })),
  };
}

/**
 * Re-run mapping and validation with a new mapping, without touching business
 * data. This is what the mapping screen calls on every change.
 */
export async function previewImportJob(
  businessId: string,
  jobId: string,
  patch: { mapping?: ImportMapping; options?: ImportOptions } = {},
): Promise<{
  job: ImportJob;
  preview: {
    totalRows: number;
    validRows: number;
    warningRows: number;
    errorRows: number;
    unmappedColumns: string[];
    missingRequired: string[];
    rows: ValidatedRow[];
  };
}> {
  const job = await getImportJob(businessId, jobId);
  if (!job) throw new ImportError("job_not_found");
  if (job.status === "running") throw new ImportError("job_running");
  const entity = requireEntity(job.entityKey);

  const mapping = patch.mapping ?? job.mapping;
  const options = { ...job.options, ...patch.options };
  const sheet = await sheetForJob(job);

  const validated = await insertRows(job.id, entity, sheet, mapping, options);
  const counts = await recount(job.id);
  const updated = await updateJob(businessId, job.id, {
    mapping,
    options,
    status: job.status === "completed" ? "completed" : "ready",
    ...counts,
  });

  return {
    job: updated ?? job,
    preview: {
      ...counts,
      unmappedColumns: unmappedColumns(sheet, mapping),
      missingRequired: missingRequiredFields(entity, mapping),
      rows: validated.slice(0, PREVIEW_ROW_LIMIT),
    },
  };
}

/**
 * Rebuild the parsed sheet from the stored rows.
 *
 * The uploaded file itself is deliberately NOT kept: it is the operator's
 * unfiltered data (a customer list, a price book) and holding a copy of it
 * indefinitely is a liability with no benefit. The raw cells are in
 * `data_import_rows`, which is everything later steps need.
 */
async function sheetForJob(job: ImportJob): Promise<ParsedSheet> {
  const { rows } = await query<{ raw: Record<string, string>; row_number: number }>(
    `SELECT raw, row_number FROM data_import_rows
      WHERE job_id = $1 ORDER BY row_number`,
    [job.id],
  );
  const columns = job.sourceColumns;
  return {
    columns,
    rows: rows.map((row) =>
      columns.map((column, index) => row.raw?.[column || `ستون ${index + 1}`] ?? ""),
    ),
  };
}

/** Queue a job for the background worker. */
export async function queueImportJob(
  businessId: string,
  jobId: string,
): Promise<ImportJob> {
  const job = await getImportJob(businessId, jobId);
  if (!job) throw new ImportError("job_not_found");
  if (job.status === "running" || job.status === "queued") return job;
  if (job.status === "completed") throw new ImportError("already_completed");
  const entity = requireEntity(job.entityKey);
  const missing = missingRequiredFields(entity, job.mapping);
  if (missing.length > 0) throw new ImportError("missing_required_fields");
  if (job.errorRows > 0 && job.options.validOnly !== true) {
    throw new ImportError("has_invalid_rows");
  }
  const updated = await updateJob(businessId, jobId, {
    status: "queued",
    error: null,
  });
  return updated ?? job;
}

export interface ImportRunResult {
  created: number;
  updated: number;
  skipped: number;
  failed: number;
}

/**
 * Perform the import.
 *
 * Runs inside the caller's tenant scope. Each row is attempted on its own: a
 * row that throws is recorded as failed and the next one is attempted, because
 * a file is not an atom and the operator's counts are what describe what
 * happened.
 */
export async function runImportJob(
  businessId: string,
  jobId: string,
  context: { locationId: string | null; actorUserId: string | null; actorName: string },
): Promise<ImportRunResult> {
  ensureAdaptersRegistered();
  const job = await getImportJob(businessId, jobId);
  if (!job) throw new ImportError("job_not_found");
  const entity = requireEntity(job.entityKey);
  const adapter = requireAdapter(entity.key);
  if (!adapter.write) throw new ImportError("entity_not_importable");

  await query(
    `UPDATE data_import_jobs
        SET status = 'running', started_at = now(), attempts = attempts + 1, updated_at = now()
      WHERE business_id = $1 AND id = $2`,
    [businessId, jobId],
  );

  const adapterContext: AdapterContext = {
    businessId,
    locationId: context.locationId,
    actorUserId: context.actorUserId,
    actorName: context.actorName,
  };
  const writeOptions = {
    duplicateStrategy: job.options.duplicateStrategy ?? "skip",
    duplicateRule: job.options.duplicateRule ?? entity.duplicateRules?.[0]?.key ?? null,
    relationStrategy: job.options.relationStrategy ?? {},
  };

  const result: ImportRunResult = { created: 0, updated: 0, skipped: 0, failed: 0 };

  // Claimed in pages rather than all at once: a 50,000-row job would otherwise
  // hold every mapped record in memory for the whole run.
  const PAGE = 200;
  for (;;) {
    const { rows } = await query<{
      id: string;
      row_number: number;
      status: string;
      mapped: Record<string, unknown>;
      messages: RowMessage[];
    }>(
      `SELECT id, row_number, status, mapped, messages
         FROM data_import_rows
        WHERE job_id = $1 AND status IN ('valid', 'warning')
        ORDER BY row_number
        LIMIT ${PAGE}`,
      [jobId],
    );
    if (rows.length === 0) break;

    for (const row of rows) {
      const messages: RowMessage[] = Array.isArray(row.messages) ? [...row.messages] : [];
      try {
        const outcome = await adapter.write(adapterContext, row.mapped ?? {}, writeOptions);
        for (const warning of ("warnings" in outcome && outcome.warnings) || []) {
          messages.push({ field: null, severity: "warning", message: warning });
        }
        if (outcome.status === "created") result.created += 1;
        else if (outcome.status === "updated") result.updated += 1;
        else if (outcome.status === "skipped") {
          result.skipped += 1;
          messages.push({ field: null, severity: "warning", message: outcome.reason });
        } else {
          result.failed += 1;
          messages.push({ field: null, severity: "error", message: outcome.reason });
        }
        await query(
          `UPDATE data_import_rows SET status = $2, messages = $3::jsonb, target_id = $4
            WHERE id = $1`,
          [
            row.id,
            outcome.status,
            JSON.stringify(messages),
            "id" in outcome ? (outcome.id ?? null) : null,
          ],
        );
      } catch (error) {
        result.failed += 1;
        const message =
          error instanceof RowRejection
            ? error.reason
            : `ثبت این سطر با خطا روبه‌رو شد: ${describeError(error)}`;
        messages.push({ field: null, severity: "error", message });
        await query(
          `UPDATE data_import_rows SET status = 'failed', messages = $2::jsonb WHERE id = $1`,
          [row.id, JSON.stringify(messages)],
        );
      }
    }
  }

  await updateJob(businessId, jobId, {
    status: "completed",
    createdRows: result.created,
    updatedRows: result.updated,
    skippedRows: result.skipped,
    failedRows: result.failed,
    finishedAt: "now",
  });

  await recordDataTransferAudit({
    businessId,
    action: "data.import.completed",
    entityKey: entity.key,
    entityId: jobId,
    actorUserId: context.actorUserId,
    payload: {
      fileName: job.fileName,
      created: result.created,
      updated: result.updated,
      skipped: result.skipped,
      failed: result.failed,
      // Recorded explicitly so an auditor can confirm no consent came in with
      // the file, without having to read this module.
      consentGranted: false,
    },
  });

  return result;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 200);
  return "خطای ناشناخته";
}

/**
 * Re-queue the rows a previous run could not write.
 *
 * The failed rows are reset to their validation verdict and the job is queued
 * again, so "fix the data and retry" does not mean re-uploading the file and
 * re-importing the rows that already landed.
 */
export async function retryFailedRows(businessId: string, jobId: string): Promise<ImportJob> {
  const job = await getImportJob(businessId, jobId);
  if (!job) throw new ImportError("job_not_found");
  if (job.status === "running") throw new ImportError("job_running");

  const { rowCount } = await query(
    `UPDATE data_import_rows r
        SET status = CASE WHEN jsonb_array_length(r.messages) > 0 THEN 'warning' ELSE 'valid' END,
            messages = '[]'::jsonb
       FROM data_import_jobs j
      WHERE j.id = r.job_id AND j.business_id = $1 AND r.job_id = $2
        AND r.status = 'failed'`,
    [businessId, jobId],
  );
  if (!rowCount) throw new ImportError("no_failed_rows");

  const counts = await recount(jobId);
  const updated = await updateJob(businessId, jobId, {
    status: "queued",
    error: null,
    failedRows: 0,
    ...counts,
  });
  return updated!;
}

export async function cancelImportJob(businessId: string, jobId: string): Promise<ImportJob> {
  const job = await getImportJob(businessId, jobId);
  if (!job) throw new ImportError("job_not_found");
  if (job.status === "completed") throw new ImportError("already_completed");
  const updated = await updateJob(businessId, jobId, {
    status: "cancelled",
    finishedAt: "now",
  });
  return updated!;
}

/**
 * The rows a run could not write, as a CSV the operator can fix and re-upload.
 *
 * Their ORIGINAL cells, plus a reason column — not our re-rendering of the
 * mapped values. A report that shows what we understood rather than what they
 * sent is a report they cannot act on.
 */
export async function failedRowsCsv(businessId: string, jobId: string): Promise<string> {
  const job = await getImportJob(businessId, jobId);
  if (!job) throw new ImportError("job_not_found");
  const { rows } = await query<{
    row_number: number;
    raw: Record<string, string>;
    messages: RowMessage[];
  }>(
    `SELECT r.row_number, r.raw, r.messages
       FROM data_import_rows r
       JOIN data_import_jobs j ON j.id = r.job_id
      WHERE j.business_id = $1 AND r.job_id = $2 AND r.status IN ('error', 'failed')
      ORDER BY r.row_number`,
    [businessId, jobId],
  );
  const headers = ["شمارهٔ سطر", ...job.sourceColumns, "دلیل رد شدن"];
  const body = rows.map((row) => [
    row.row_number,
    ...job.sourceColumns.map((column, index) => row.raw?.[column || `ستون ${index + 1}`] ?? ""),
    (Array.isArray(row.messages) ? row.messages : [])
      .filter((message) => message.severity === "error")
      .map((message) => message.message)
      .join(" | "),
  ]);
  return toCsv(headers, body);
}

/**
 * Drain the import queue — one job per tick.
 *
 * Enumerates queued jobs under the documented platform bypass and then
 * re-enters each business with `withTenant`, the same shape every other
 * background tick in `server.ts` uses. One job per tick on purpose: an import
 * can be slow, and a tick that drained the whole queue would hold a worker for
 * minutes and starve every other business.
 */
export const IMPORT_TICK_INTERVAL_MS = 10_000;
/** A job that has died this many times is parked rather than retried forever. */
const MAX_JOB_ATTEMPTS = 3;

export async function runImportQueueTick(): Promise<number> {
  ensureAdaptersRegistered();
  // Before claiming new work, return anything abandoned mid-flight by a worker
  // that stopped existing. Cheap (one indexed UPDATE that normally matches
  // nothing) and it has to happen here rather than at boot, because the
  // process that abandoned the job may not be the one that restarts.
  await reclaimStalledImports().catch((error) =>
    console.error("stalled import sweep failed:", error instanceof Error ? error.message : error),
  );
  // The claim has to run under the platform bypass, exactly like the messaging
  // and notification ticks: a background tick has no session, so there is no
  // tenant scope to inherit, and RLS keyed on `app.business_id` would match
  // zero rows on every business — the queue would simply never drain. This is
  // invisible when the database role is a superuser (RLS is ignored outright,
  // which is why an integration test cannot catch it), and total under the
  // unprivileged role a real deployment uses. The bypass covers only the claim
  // and the parking sweep — statements that are *about* the queue rather than
  // about any one business's data; the job itself runs inside `withTenant`
  // below, where every read and write is scoped again.
  const claim = await withoutTenantScope("platform", async () => {
    // A conditional UPDATE, so two app instances ticking at the same moment
    // cannot both take the same job — the second one's WHERE no longer
    // matches. Same shape as the notification outbox's claim.
    const { rows } = await query<{
      id: string;
      business_id: string;
      location_id: string | null;
      created_by: string | null;
      created_by_name: string;
      attempts: number;
    }>(
      `UPDATE data_import_jobs
          SET status = 'running', started_at = now(), updated_at = now()
        WHERE id = (
          SELECT id FROM data_import_jobs
           WHERE status = 'queued' AND attempts < ${MAX_JOB_ATTEMPTS}
           ORDER BY created_at
           FOR UPDATE SKIP LOCKED
           LIMIT 1
        )
        RETURNING id, business_id, location_id, created_by, created_by_name, attempts`,
    );
    if (rows[0]) return rows[0];
    // Park anything that has exhausted its attempts, so a poisoned job stops
    // occupying the queue and shows up in the history as failed.
    await query(
      `UPDATE data_import_jobs
          SET status = 'failed', error = coalesce(error, 'تلاش‌های مجاز به پایان رسید'),
              finished_at = now(), updated_at = now()
        WHERE status = 'queued' AND attempts >= ${MAX_JOB_ATTEMPTS}`,
    );
    return null;
  });
  if (!claim) return 0;

  try {
    await withTenant(claim.business_id, async () => {
      try {
        await runImportJob(claim.business_id, claim.id, {
          locationId: claim.location_id,
          actorUserId: claim.created_by,
          actorName: claim.created_by_name,
        });
      } catch (error) {
        // The job goes back to `queued` so the next tick retries it, until the
        // attempt ceiling parks it.
        await query(
          `UPDATE data_import_jobs
              SET status = CASE WHEN attempts >= ${MAX_JOB_ATTEMPTS} THEN 'failed' ELSE 'queued' END,
                  error = $3, updated_at = now(),
                  finished_at = CASE WHEN attempts >= ${MAX_JOB_ATTEMPTS} THEN now() ELSE NULL END
            WHERE business_id = $1 AND id = $2`,
          [claim.business_id, claim.id, describeError(error)],
        );
      }
    });
  } catch (error) {
    // The recovery write can fail too — that is precisely the case where the
    // database or the connection is the thing that broke, so the handler above
    // runs straight into the same wall. Without this second net the tick
    // rejects, and since `runImportQueueTick` is the queue for *every*
    // business, one unreachable moment would stop all of them. The job is left
    // `running` with its attempt counted; `reclaimStalledImports` below returns
    // it to the queue, which is the same outcome as a process that was killed
    // mid-job and the reason that sweep exists.
    console.error(
      `data import job ${claim.id} could not be finalised:`,
      error instanceof Error ? error.message : error,
    );
  }
  return 1;
}

/**
 * Return jobs that have been `running` implausibly long to the queue.
 *
 * A worker can stop existing between claiming a job and finishing it — a
 * deploy, an OOM kill, a lost database connection. Nothing in the claim itself
 * can undo that, because the process that would have done the undoing is the
 * one that died. Without this sweep such a job stays `running` forever: not
 * retried, not failed, just permanently mid-flight in the operator's history.
 *
 * The attempt counter is what makes re-queueing safe rather than an infinite
 * loop — a job that reliably kills its worker is parked by the claim's
 * `attempts < MAX_JOB_ATTEMPTS` guard after the third try. Re-running is
 * otherwise harmless: rows already written are marked `created`/`updated` and
 * are no longer selected, and duplicate detection matches the records that did
 * land instead of duplicating them.
 */
const STALLED_IMPORT_AFTER = "30 minutes";

export async function reclaimStalledImports(): Promise<number> {
  return withoutTenantScope("platform", async () => {
    const { rowCount } = await query(
      `UPDATE data_import_jobs
          SET status = CASE WHEN attempts >= ${MAX_JOB_ATTEMPTS} THEN 'failed' ELSE 'queued' END,
              error = CASE
                WHEN attempts >= ${MAX_JOB_ATTEMPTS}
                  THEN coalesce(error, 'اجرای این درون‌ریزی نیمه‌کاره متوقف شد')
                ELSE error
              END,
              finished_at = CASE WHEN attempts >= ${MAX_JOB_ATTEMPTS} THEN now() ELSE NULL END,
              updated_at = now()
        WHERE status = 'running'
          AND started_at < now() - interval '${STALLED_IMPORT_AFTER}'`,
    );
    return rowCount ?? 0;
  });
}
