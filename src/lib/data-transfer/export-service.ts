/**
 * The export engine: field chooser → filters → four formats → stored history.
 *
 * ## Human-readable, always
 *
 * An export names things the way the screens do. `category = پیتزا`, never
 * `category_id = 15`; a date is Shamsi; money is the business's own display
 * unit with the unit in the column header; a boolean is «بله»/«خیر». That is a
 * hard requirement of this engine, not a preference: an export whose foreign
 * keys are integers is one nobody can read and nobody can re-import, which
 * makes it useless in both directions. The adapters return resolved labels and
 * this module renders them.
 *
 * ## Every export is kept
 *
 * The produced bytes are stored on the job row, so «دانلود دوبارهٔ خروجی قبلی»
 * is a real feature rather than "run it again and hope the data has not moved".
 * They are pruned on a ceiling and an age, because an export is a copy of the
 * business's data and holding copies forever is a liability.
 */

import { query, withoutTenantScope, withTenant } from "../db";
import { formatMoney, moneyToInput, type MoneyUnit } from "../money";
import { formatJalali } from "../jalali";
import { toPersianDigits } from "../digits";
import { getSetting, SETTING_KEYS } from "../settings";
import { renderReportTableHtml, type ReportPdfBusinessInfo } from "../report-pdf-template";
import { defaultExportFields, findEntity, requireEntity } from "./registry";
import { ensureAdaptersRegistered } from "./entities";
import { requireAdapter, type AdapterContext } from "./adapters";
import { displayCell, sheetsToXlsxBuffer, toCsv, toJsonDocument } from "./codecs";
import { recordDataTransferAudit } from "./audit";
import type { EntityDefinition, ExportFormat, ExportJobFormat, ExportJobStatus, ProviderJobMetadata } from "./types";

/** A hard ceiling on one export, whatever the caller asks for. */
export const MAX_EXPORT_ROWS = 100_000;
/** Bytes above which the file is produced but not retained for re-download. */
export const MAX_STORED_EXPORT_BYTES = 25 * 1024 * 1024;
/** How long a stored export stays downloadable. */
export const EXPORT_RETENTION_DAYS = 30;

export class ExportError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ExportError";
  }
}

export interface ExportJob {
  id: string;
  entityKey: string;
  entityLabel: string;
  format: ExportJobFormat;
  status: ExportJobStatus;
  fields: string[];
  filters: Record<string, unknown>;
  rowCount: number;
  fileName: string;
  contentType: string;
  providerMetadata: ProviderJobMetadata | null;
  sizeBytes: number;
  error: string | null;
  scheduleId: string | null;
  createdByName: string;
  createdAt: string;
  finishedAt: string | null;
  /** False once the bytes have been pruned; the history row survives. */
  downloadable: boolean;
}

interface JobRow extends Record<string, unknown> {
  id: string;
  entity_key: string;
  format: ExportJobFormat;
  status: ExportJobStatus;
  fields: unknown;
  filters: unknown;
  provider_metadata: unknown;
  row_count: number;
  file_name: string;
  content_type: string;
  size_bytes: string | number;
  error: string | null;
  schedule_id: string | null;
  created_by_name: string;
  created_at: Date;
  finished_at: Date | null;
  has_content: boolean;
}

const JOB_COLUMNS = `id, entity_key, format, status, fields, filters, provider_metadata, row_count, file_name,
  content_type, size_bytes, error, schedule_id, created_by_name, created_at, finished_at,
  (content IS NOT NULL) AS has_content`;

function exportProviderMetadata(value: unknown): ProviderJobMetadata | null {
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

function toJob(row: JobRow): ExportJob {
  const providerMetadata = exportProviderMetadata(row.provider_metadata);
  return {
    id: row.id,
    entityKey: row.entity_key,
    entityLabel: providerMetadata?.provider === "holoo" ? "خروجی هلو" : findEntity(row.entity_key)?.label ?? row.entity_key,
    format: row.format,
    status: row.status,
    fields: Array.isArray(row.fields) ? (row.fields as string[]) : [],
    filters: (row.filters ?? {}) as Record<string, unknown>,
    rowCount: row.row_count,
    fileName: row.file_name,
    contentType: row.content_type,
    providerMetadata,
    sizeBytes: Number(row.size_bytes ?? 0),
    error: row.error,
    scheduleId: row.schedule_id,
    createdByName: row.created_by_name,
    createdAt: row.created_at.toISOString(),
    finishedAt: row.finished_at?.toISOString() ?? null,
    downloadable: row.has_content && row.status === "completed",
  };
}

export const CONTENT_TYPES: Record<ExportFormat, string> = {
  csv: "text/csv; charset=utf-8",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pdf: "application/pdf",
  json: "application/json; charset=utf-8",
};

const EXTENSIONS: Record<ExportFormat, string> = {
  csv: "csv",
  xlsx: "xlsx",
  pdf: "pdf",
  json: "json",
};

export interface BuildExportInput {
  businessId: string;
  locationId: string | null;
  entityKey: string;
  format: ExportFormat;
  fields?: readonly string[];
  filters?: Record<string, unknown>;
  ids?: readonly string[];
  limit?: number;
  actorUserId: string | null;
  actorName: string;
  /** Set when a schedule produced this export rather than a person. */
  scheduleId?: string | null;
}

export interface BuiltExport {
  fileName: string;
  contentType: string;
  body: Buffer;
  rowCount: number;
}

/**
 * Produce the file. Pure production — storage and history are `createExportJob`'s.
 */
export async function buildExport(input: BuildExportInput): Promise<BuiltExport> {
  ensureAdaptersRegistered();
  const entity = findEntity(input.entityKey);
  if (!entity) throw new ExportError("unknown_entity");
  if (entity.locationScoped && !input.locationId) throw new ExportError("location_required");
  const adapter = requireAdapter(entity.key);

  const fieldKeys = resolveFields(entity, input.fields);
  if (fieldKeys.length === 0) throw new ExportError("no_fields");

  const context: AdapterContext = {
    businessId: input.businessId,
    locationId: input.locationId,
    actorUserId: input.actorUserId,
    actorName: input.actorName,
  };
  const rows = await adapter.read(context, {
    fields: fieldKeys,
    filters: input.filters ?? {},
    limit: Math.min(Math.max(input.limit ?? MAX_EXPORT_ROWS, 1), MAX_EXPORT_ROWS),
    ids: input.ids,
  });

  const unit = await moneyUnitFor(input.businessId);
  const columns = fieldKeys.map((key) => {
    const field = entity.fields.find((candidate) => candidate.key === key)!;
    return {
      key,
      // A money column says which unit it is in, in its own header. A file
      // whose numbers are Rial and whose reader assumes Toman is a 10× error
      // nobody notices until it is in an accountant's spreadsheet.
      label:
        field.type === "money"
          ? `${field.label} (${unit === "rial" ? "ریال" : "تومان"})`
          : field.label,
      type: field.type,
    };
  });

  const fileName = `${entity.label}-${todayStamp()}.${EXTENSIONS[input.format]}`;
  const rendered = rows.map((row) => renderRow(entity, fieldKeys, row, unit, input.format));

  if (input.format === "json") {
    // JSON is the machine format: raw values, ISO dates, integer Rial, no
    // Persian digits. A consumer that wanted the pretty version would have
    // asked for CSV.
    const machine = rows.map((row) =>
      Object.fromEntries(fieldKeys.map((key) => [key, row[key] ?? null])),
    );
    const body = Buffer.from(
      toJsonDocument(
        columns.map((column) => ({ key: column.key, label: column.label })),
        machine,
      ),
      "utf8",
    );
    return { fileName, contentType: CONTENT_TYPES.json, body, rowCount: rows.length };
  }

  if (input.format === "csv") {
    const body = Buffer.from(
      toCsv(
        columns.map((column) => column.label),
        rendered.map((row) => columns.map((column) => row[column.key] ?? "")),
      ),
      "utf8",
    );
    return { fileName, contentType: CONTENT_TYPES.csv, body, rowCount: rows.length };
  }

  if (input.format === "xlsx") {
    const body = await sheetsToXlsxBuffer([
      {
        name: entity.label,
        columns: columns.map((column) => ({ key: column.key, label: column.label })),
        rows: rendered,
      },
    ]);
    return { fileName, contentType: CONTENT_TYPES.xlsx, body, rowCount: rows.length };
  }

  const html = renderReportTableHtml({
    business: await businessInfo(input.businessId),
    title: entity.label,
    generatedAt: new Date(),
    filterSummary: describeFilters(input.filters ?? {}),
    columns: columns.map((column) => ({ key: column.key, label: column.label })),
    rows: rendered,
  });
  // Imported lazily, and this is load-bearing rather than a micro-optimisation.
  // `pdf-render` pulls in `playwright-core`, which cannot be bundled: esbuild
  // fails to resolve its `chromium-bidi` requires, and the desktop installer
  // compiles `server.ts` — including this module, which a background tick
  // imports for the retention sweep — into a single CJS bundle. A static
  // import here therefore breaks `npm run desktop:runtime`, and with it both
  // the `verify-shippables` and `build-desktop-installer` workflows, even
  // though nothing on that path ever renders a PDF. Same treatment `codecs.ts`
  // gives `exceljs` and `unpdf`. Keep it lazy.
  const { renderHtmlToPdf } = await import("../pdf-render");
  const body = await renderHtmlToPdf(html);
  return { fileName, contentType: CONTENT_TYPES.pdf, body, rowCount: rows.length };
}

function resolveFields(entity: EntityDefinition, requested?: readonly string[]): string[] {
  if (!requested || requested.length === 0) return defaultExportFields(entity);
  const known = new Set(entity.fields.map((field) => field.key));
  // Filtered rather than rejected: a saved export template naming a field a
  // later release removed must still produce a file.
  const chosen = requested.filter((key) => known.has(key));
  return chosen.length > 0 ? chosen : defaultExportFields(entity);
}

/**
 * One row, rendered for a human-facing format.
 *
 * Money is converted into the business's display unit and formatted; dates are
 * Shamsi; enums become their Persian labels; booleans become «بله»/«خیر».
 */
function renderRow(
  entity: EntityDefinition,
  fieldKeys: readonly string[],
  row: Record<string, unknown>,
  unit: MoneyUnit,
  format: ExportFormat,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of fieldKeys) {
    const field = entity.fields.find((candidate) => candidate.key === key)!;
    const value = row[key];
    if (value === null || value === undefined || value === "") {
      out[key] = "";
      continue;
    }
    switch (field.type) {
      case "money": {
        const rial = Number(value);
        if (!Number.isFinite(rial)) {
          out[key] = "";
          break;
        }
        // A PDF is read, so it gets the formatted string; a spreadsheet is
        // calculated with, so it gets a number in the same unit the header
        // names.
        out[key] = format === "pdf" ? formatMoney(rial, unit) : moneyToInput(rial, unit);
        break;
      }
      case "date":
      case "datetime":
        out[key] = toPersianDigits(formatJalali(String(value)));
        break;
      case "enum": {
        const option = field.options?.find((candidate) => candidate.value === String(value));
        out[key] = option ? option.label : String(value);
        break;
      }
      case "boolean":
        out[key] = value ? "بله" : "خیر";
        break;
      case "tags":
        out[key] = Array.isArray(value) ? value.join("، ") : String(value);
        break;
      case "integer":
      case "number":
        out[key] = typeof value === "number" ? value : Number(value);
        break;
      default:
        out[key] = displayCell(value);
    }
  }
  return out;
}

async function moneyUnitFor(businessId: string): Promise<MoneyUnit> {
  const prefs = await getSetting<{ currencyDisplay?: "toman" | "rial" }>(
    businessId,
    SETTING_KEYS.businessPrefs,
  );
  return prefs?.currencyDisplay === "rial" ? "rial" : "toman";
}

async function businessInfo(businessId: string): Promise<ReportPdfBusinessInfo> {
  const { rows } = await query<{ name: string }>("SELECT name FROM businesses WHERE id = $1", [
    businessId,
  ]);
  const { rows: locations } = await query<{ address: string | null; phone: string | null }>(
    `SELECT address, phone FROM locations
      WHERE business_id = $1 AND is_active ORDER BY created_at LIMIT 1`,
    [businessId],
  );
  return {
    name: rows[0]?.name ?? "",
    address: locations[0]?.address ?? null,
    phone: locations[0]?.phone ?? null,
  };
}

function describeFilters(filters: Record<string, unknown>): string {
  const parts: string[] = [];
  const from = typeof filters.dateFrom === "string" ? filters.dateFrom : null;
  const to = typeof filters.dateTo === "string" ? filters.dateTo : null;
  if (from && to) {
    parts.push(`از ${toPersianDigits(formatJalali(from))} تا ${toPersianDigits(formatJalali(to))}`);
  } else if (from) parts.push(`از ${toPersianDigits(formatJalali(from))}`);
  else if (to) parts.push(`تا ${toPersianDigits(formatJalali(to))}`);
  if (typeof filters.status === "string" && filters.status) parts.push(`وضعیت: ${filters.status}`);
  if (filters.activeOnly === true) parts.push("فقط موارد فعال");
  return parts.length > 0 ? parts.join(" — ") : "همهٔ رکوردها";
}

function todayStamp(): string {
  // ASCII digits in a filename: a Persian-digit filename is unopenable on some
  // Windows setups and unsortable everywhere.
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/**
 * Produce an export and record it in the history, returning both the job and
 * the bytes so the caller can stream them straight back.
 */
export async function createExportJob(input: BuildExportInput): Promise<{
  job: ExportJob;
  body: Buffer;
}> {
  const entity = findEntity(input.entityKey);
  if (!entity) throw new ExportError("unknown_entity");
  const fields = resolveFields(entity, input.fields);

  const { rows } = await query<JobRow>(
    `INSERT INTO data_export_jobs
       (business_id, location_id, entity_key, format, status, fields, filters,
        schedule_id, created_by, created_by_name, started_at, expires_at)
     VALUES ($1, $2::uuid, $3, $4, 'running', $5::jsonb, $6::jsonb, $7::uuid, $8::uuid, $9,
             now(), now() + interval '${EXPORT_RETENTION_DAYS} days')
     RETURNING ${JOB_COLUMNS}`,
    [
      input.businessId,
      input.locationId,
      entity.key,
      input.format,
      JSON.stringify(fields),
      JSON.stringify(input.filters ?? {}),
      input.scheduleId ?? null,
      input.actorUserId,
      input.actorName,
    ],
  );
  const jobId = rows[0].id;

  try {
    const built = await buildExport({ ...input, fields });
    const store = built.body.byteLength <= MAX_STORED_EXPORT_BYTES;
    const { rows: done } = await query<JobRow>(
      `UPDATE data_export_jobs
          SET status = 'completed', row_count = $3, file_name = $4, content_type = $5,
              size_bytes = $6, content = $7, finished_at = now()
        WHERE business_id = $1 AND id = $2
        RETURNING ${JOB_COLUMNS}`,
      [
        input.businessId,
        jobId,
        built.rowCount,
        built.fileName,
        built.contentType,
        built.body.byteLength,
        store ? built.body : null,
      ],
    );

    await recordDataTransferAudit({
      businessId: input.businessId,
      action: "data.export.completed",
      entityKey: entity.key,
      entityId: jobId,
      actorUserId: input.actorUserId,
      payload: {
        format: input.format,
        rowCount: built.rowCount,
        fields,
        filters: input.filters ?? {},
        scheduled: Boolean(input.scheduleId),
      },
    });

    return { job: toJob(done[0]), body: built.body };
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 300) : "unknown";
    await query(
      `UPDATE data_export_jobs
          SET status = 'failed', error = $3, finished_at = now()
        WHERE business_id = $1 AND id = $2`,
      [input.businessId, jobId, message],
    );
    throw error;
  }
}

export async function listExportJobs(
  businessId: string,
  options: { entityKey?: string | null; limit?: number } = {},
): Promise<ExportJob[]> {
  const params: unknown[] = [businessId];
  const where = ["business_id = $1"];
  if (options.entityKey) {
    params.push(options.entityKey);
    where.push(`entity_key = $${params.length}`);
  }
  params.push(Math.min(Math.max(options.limit ?? 50, 1), 200));
  const { rows } = await query<JobRow>(
    `SELECT ${JOB_COLUMNS} FROM data_export_jobs
      WHERE ${where.join(" AND ")}
      ORDER BY created_at DESC
      LIMIT $${params.length}`,
    params,
  );
  return rows.map(toJob);
}

export async function getExportJob(businessId: string, jobId: string): Promise<ExportJob | null> {
  const { rows } = await query<JobRow>(
    `SELECT ${JOB_COLUMNS} FROM data_export_jobs WHERE business_id = $1 AND id = $2`,
    [businessId, jobId],
  );
  return rows[0] ? toJob(rows[0]) : null;
}

/** A previously produced export's bytes, for re-download. */
export async function getExportContent(
  businessId: string,
  jobId: string,
): Promise<{ fileName: string; contentType: string; body: Buffer } | null> {
  const { rows } = await query<{
    file_name: string;
    content_type: string;
    content: Buffer | null;
  }>(
    `SELECT file_name, content_type, content FROM data_export_jobs
      WHERE business_id = $1 AND id = $2 AND status = 'completed'`,
    [businessId, jobId],
  );
  const row = rows[0];
  if (!row || !row.content) return null;
  return { fileName: row.file_name, contentType: row.content_type, body: row.content };
}

/**
 * Drop the bytes of exports that are past their retention window.
 *
 * The history row stays — who exported what, when, how many rows — because
 * that is the audit record. Only the copy of the business's data goes.
 *
 * Deliberately deployment-wide and therefore under the documented platform
 * bypass: retention is an operator-level property of the install, the sweep
 * touches no row's *content* other than to erase it, and enumerating every
 * business first only to re-enter each one would be a hundred scoped
 * statements to do one indexed UPDATE. It never reads tenant data — the
 * statement's only output is a row count.
 */
export async function pruneExpiredExports(): Promise<number> {
  const { rowCount } = await withoutTenantScope("platform", () =>
    query(
      `UPDATE data_export_jobs SET content = NULL
        WHERE content IS NOT NULL AND expires_at IS NOT NULL AND expires_at < now()`,
    ),
  );
  return rowCount ?? 0;
}

/** The same prune, scoped to one business — for a tenant-initiated cleanup. */
export async function pruneBusinessExports(businessId: string): Promise<number> {
  const { rowCount } = await withTenant(businessId, () =>
    query(
      `UPDATE data_export_jobs SET content = NULL
        WHERE business_id = $1 AND content IS NOT NULL
          AND expires_at IS NOT NULL AND expires_at < now()`,
      [businessId],
    ),
  );
  return rowCount ?? 0;
}
