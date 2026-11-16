/**
 * No-write document preview over the existing Data Transfer staging rows.
 * This internal building block is not a route or a queue registration: callers
 * must enforce transfer/accounting/CRM permissions and branch access. The UI
 * and worker must not treat this read as an approval or an accounting posting.
 */
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { withTenantTransaction } from "../db";
import { historicalInvoiceFingerprint, HistoricalArchiveError, lockHistoricalInvoiceSource, persistHistoricalDocument, type HistoricalArchiveActor } from "./historical-invoice-archive-service";
import { HistoricalJobPreviewError, loadHistoricalStagedRows, type HistoricalStagedInput } from "./historical-invoice-staged-rows";
import { previewHistoricalInvoices, previewHistoricalInvoiceSheets, type HistoricalCalendar, type HistoricalCurrency, type HistoricalPreviewDocument, type HistoricalInvoiceLineRow } from "./historical-invoice-preview";
import type { ImportMapping } from "./types";

export { HistoricalJobPreviewError } from "./historical-invoice-staged-rows";

export type HistoricalJobPreviewDocument = Omit<HistoricalPreviewDocument, "outcome"> & {
  outcome: HistoricalPreviewDocument["outcome"] | "conflict";
};
export interface HistoricalJobPreview {
  /** Cross-source and posted-sale reconciliation is not implemented yet. */
  crossSourceChecked: false;
  archiveReviewToken: string;
  totalInvoices: number;
  matchedCustomers: number;
  reviewNeeded: number;
  alreadyImported: number;
  conflicts: number;
  invalid: number;
  toCreate: number;
  summaryOnly: number;
  reconciliation: {
    totalRial: string;
    totalCount: number;
    paidRial: string;
    paidCount: number;
    balanceRial: string;
    balanceCount: number;
  };
  documents: HistoricalJobPreviewDocument[];
  /** Unmatched lines are not discarded or synthesized into invoices. */
  orphanLineCount: number;
  orphanLines: HistoricalInvoiceLineRow[];
  /** Separate offsets allow every invoice and orphan to be reviewed. */
  documentOffset: number;
  orphanOffset: number;
  hasMoreDocuments: boolean;
  hasMoreOrphans: boolean;
  truncated: boolean;
}

/** Preview is computed anew, not an approval token or an executable plan. */
export async function previewHistoricalImportJob(input: {
  businessId: string;
  locationId: string;
  jobId: string;
  sourceKey: string;
  provider: string;
  currency: HistoricalCurrency;
  calendar: HistoricalCalendar;
  mapping: ImportMapping;
  /** Required only when the explicitly selected workbook has a separate line sheet. */
  lineMapping?: ImportMapping;
  sampleLimit?: number;
  documentOffset?: number;
  orphanOffset?: number;
}): Promise<HistoricalJobPreview> {
  const sourceKey = input.sourceKey.trim();
  const provider = input.provider.trim();
  if (!sourceKey || sourceKey.length > 200 || provider.length > 200) throw new HistoricalJobPreviewError("invalid_source");
  if (input.currency !== "rial" && input.currency !== "toman") throw new HistoricalJobPreviewError("invalid_currency");
  if (input.calendar !== "jalali" && input.calendar !== "gregorian") throw new HistoricalJobPreviewError("invalid_calendar");
  const sampleLimit = Number.isFinite(input.sampleLimit) ? Math.min(Math.max(Math.trunc(input.sampleLimit!), 0), 200) : 100;
  const offset = (value: number | undefined) => Number.isFinite(value) ? Math.min(Math.max(Math.trunc(value!), 0), 50_000) : 0;
  const documentOffset = offset(input.documentOffset), orphanOffset = offset(input.orphanOffset);
  return withTenantTransaction(input.businessId, async (client) => {
    const { documents, orphanLines } = await historicalJobDocuments(client, { ...input, sourceKey, provider });
    const sum = (field: "totalRial" | "paidRial" | "balanceRial") => {
      const values = documents.map((doc) => doc[field]).filter((value): value is string => value !== null);
      return { value: values.reduce((n, value) => n + BigInt(value), 0n).toString(), count: values.length };
    };
    const total = sum("totalRial"), paid = sum("paidRial"), balance = sum("balanceRial");
    return {
      crossSourceChecked: false,
      archiveReviewToken: archiveReviewToken(input, documents, orphanLines),
      totalInvoices: documents.length,
      matchedCustomers: documents.filter((doc) => doc.partyId !== null).length,
      reviewNeeded: documents.filter((doc) => doc.outcome === "review").length,
      alreadyImported: documents.filter((doc) => doc.outcome === "already_imported").length,
      conflicts: documents.filter((doc) => doc.outcome === "conflict").length,
      invalid: documents.filter((doc) => doc.outcome === "invalid").length,
      toCreate: documents.filter((doc) => doc.outcome === "ready").length,
      summaryOnly: documents.filter((doc) => doc.summaryOnly).length,
      reconciliation: { totalRial: total.value, totalCount: total.count, paidRial: paid.value, paidCount: paid.count, balanceRial: balance.value, balanceCount: balance.count },
      documents: documents.slice(documentOffset, documentOffset + sampleLimit),
      orphanLineCount: orphanLines.length,
      orphanLines: orphanLines.slice(orphanOffset, orphanOffset + sampleLimit),
      documentOffset, orphanOffset,
      hasMoreDocuments: documents.length > documentOffset + sampleLimit,
      hasMoreOrphans: orphanLines.length > orphanOffset + sampleLimit,
      truncated: documents.length > sampleLimit || orphanLines.length > sampleLimit,
    };
  });
}

/** Shared full document set used by paginated preview and the archive executor. */
export async function historicalJobDocuments(client: PoolClient, input: HistoricalStagedInput, lock = false) {
  const sourceKey = input.sourceKey.trim(), provider = input.provider.trim();
  const { source, mapped, headerRows, lineRows } = await loadHistoricalStagedRows(client, { ...input, sourceKey, provider }, lock);
  const codes = [...new Set(mapped.map((row) => (row.externalCustomerCode ?? "").trim()).filter(Boolean))];
  const ids = [...new Set(mapped.map((row) => row.externalInvoiceId.trim()).filter(Boolean))];
  const identities = await client.query<{ external_id: string; canonical_id: string }>(
    `SELECT s.external_id, s.canonical_id FROM source_identities s JOIN parties p
        ON p.id::text = s.canonical_id AND p.business_id = s.business_id
      WHERE s.business_id = $1 AND s.source_key = $2 AND s.domain = 'party'
        AND s.external_type = 'historical_customer_code' AND s.external_id = ANY($3::text[]) AND s.provider = $4
        AND s.verified AND s.retired_at IS NULL AND s.canonical_type = 'parties'
        AND 'customer' = ANY(p.roles) AND p.is_active AND p.merged_into_id IS NULL
        AND (p.location_id IS NULL OR p.location_id = $5) ${lock ? "FOR SHARE OF s, p" : ""}`,
    [input.businessId, sourceKey, codes, provider, input.locationId],
  );
  const archived = await client.query<{ external_id: string; party_id: string; location_id: string; source_provider: string; source_fingerprint: string }>(
    `SELECT external_id, party_id, location_id, source_provider, source_fingerprint FROM historical_sales_invoices
      WHERE business_id = $1 AND source_key = $2 AND external_id = ANY($3::text[])`,
    [input.businessId, sourceKey, ids],
  );
  const existing = new Map(archived.rows.map((row) => [row.external_id, row]));
  const options = {
    sourceKey, currency: input.currency, calendar: input.calendar,
    verifiedCustomers: identities.rows.map((row) => ({ externalCustomerCode: row.external_id, partyId: row.canonical_id })),
    archivedExternalIds: [...existing.keys()],
  };
  const joined = source.structure === "header_lines"
    ? previewHistoricalInvoiceSheets(headerRows, lineRows, options)
    : { documents: previewHistoricalInvoices(mapped, options), orphanLines: [] };
  const documents: HistoricalJobPreviewDocument[] = joined.documents.map((doc) => {
    const old = existing.get(doc.externalInvoiceId);
    if (doc.externalInvoiceId.length > 300 || doc.rows.some((row) => (row.externalCustomerCode ?? "").trim().length > 300)) {
      return { ...doc, outcome: "invalid" as const, errors: [...doc.errors, "شناسهٔ فاکتور یا کد مشتری بیش از حد طولانی است."] };
    }
    if (doc.outcome !== "invalid" && old &&
        (!doc.partyId || doc.partyId !== old.party_id || old.location_id !== input.locationId || old.source_provider !== provider ||
         old.source_fingerprint !== historicalInvoiceFingerprint(doc.rows, input.currency, input.calendar))) {
      return { ...doc, outcome: "conflict" as const, warnings: [...doc.warnings, "این شناسه قبلاً با اطلاعات متفاوت ثبت شده و نیاز به بررسی دارد."] };
    }
    return doc;
  });
  return { documents, orphanLines: joined.orphanLines };
}

function archiveReviewToken(input: HistoricalStagedInput, documents: HistoricalJobPreviewDocument[], orphanLines: HistoricalInvoiceLineRow[]) {
  return createHash("sha256").update(JSON.stringify({
    businessId: input.businessId, locationId: input.locationId, jobId: input.jobId,
    sourceKey: input.sourceKey.trim(), provider: input.provider.trim(), currency: input.currency, calendar: input.calendar,
    mapping: input.mapping, lineMapping: input.lineMapping ?? null, documents, orphanLines,
  })).digest("hex");
}

/**
 * Archive a reviewed flat or grouped job atomically. The trusted caller must
 * enforce current actor permissions and cross-source review before approval.
 * Generic transfer workers must not call this historical-only executor.
 */
export async function executeHistoricalArchiveJob(input: HistoricalStagedInput & {
  actor: HistoricalArchiveActor; reviewToken: string; confirmed: true;
}): Promise<{ createdInvoices: number; skippedInvoices: number }> {
  if (input.confirmed !== true || !/^[a-f0-9]{64}$/.test(input.reviewToken)) throw new HistoricalArchiveError("review_confirmation_required");
  const sourceKey = input.sourceKey.trim(), provider = input.provider.trim();
  return withTenantTransaction(input.businessId, async (client) => {
    await lockHistoricalInvoiceSource(client, input.businessId, sourceKey);
    const actor = await client.query("SELECT id FROM users WHERE id = $1 AND business_id = $2 AND is_active FOR SHARE", [input.actor.userId, input.businessId]);
    if (!actor.rowCount) throw new HistoricalArchiveError("actor_not_active");
    const job = await client.query<{ status: string; options: { historicalArchiveResult?: { reviewToken: string; createdInvoices: number; skippedInvoices: number } } }>(
      `SELECT status, options FROM data_import_jobs WHERE id = $1 AND business_id = $2 AND location_id = $3
        AND entity_key = 'accounting.historical_invoices' AND created_by = $4 FOR UPDATE`,
      [input.jobId, input.businessId, input.locationId, input.actor.userId],
    );
    if (!job.rowCount) throw new HistoricalArchiveError("job_not_found");
    const saved = job.rows[0].options.historicalArchiveResult;
    if (job.rows[0].status === "completed" && saved?.reviewToken === input.reviewToken) {
      return { createdInvoices: saved.createdInvoices, skippedInvoices: saved.skippedInvoices };
    }

    const { documents, orphanLines } = await historicalJobDocuments(client, input, true);
    if (archiveReviewToken(input, documents, orphanLines) !== input.reviewToken) throw new HistoricalArchiveError("invoice_review_stale");
    if (!documents.length || orphanLines.length || documents.some((doc) => !["ready", "already_imported"].includes(doc.outcome))) {
      throw new HistoricalArchiveError("invoice_review_blocked");
    }

    let createdInvoices = 0, skippedInvoices = 0, createdRows = 0, skippedRows = 0;
    for (const doc of documents) {
      const code = doc.rows.find((row) => row.externalCustomerCode?.trim())?.externalCustomerCode?.trim();
      if (!doc.partyId || !code) throw new HistoricalArchiveError("customer_binding_changed");
      const archived = await persistHistoricalDocument(client, { ...input, sourceKey, provider }, doc, code, historicalInvoiceFingerprint(doc.rows, input.currency, input.calendar));
      const created = archived.status === "created";
      if (created) { createdInvoices++; createdRows += doc.rows.length; }
      else { skippedInvoices++; skippedRows += doc.rows.length; }
      await client.query(
        `UPDATE data_import_rows AS staged_row SET status = $2, target_id = $3, mapped = evidence.mapped
           FROM jsonb_to_recordset($4::jsonb) AS evidence(row_number integer, mapped jsonb)
          WHERE staged_row.job_id = $1 AND staged_row.row_number = evidence.row_number`,
        [input.jobId, created ? "created" : "skipped", archived.invoiceId,
          JSON.stringify(doc.rows.map((row) => ({ row_number: row.rowNumber, mapped: row })))],
      );
    }

    const result = { createdInvoices, skippedInvoices };
    await client.query(
      `UPDATE data_import_jobs SET status = 'completed', mapping = $2::jsonb,
         options = options || $3::jsonb, created_rows = $4, skipped_rows = $5,
         valid_rows = $4::integer + $5::integer, warning_rows = 0, error_rows = 0,
         started_at = now(), finished_at = now(), updated_at = now() WHERE id = $1`,
      [input.jobId, JSON.stringify(input.mapping), JSON.stringify({
        historicalArchiveResult: { ...result, reviewToken: input.reviewToken, lineMapping: input.lineMapping ?? null },
      }), createdRows, skippedRows],
    );
    return result;
  });
}
