/**
 * No-write document preview over the existing Data Transfer staging rows.
 * This internal building block is not a route or a queue registration: callers
 * must enforce transfer/accounting/CRM permissions and branch access. The UI
 * and worker must not treat this read as an approval or an accounting posting.
 */
import { withTenantTransaction } from "../db";
import { historicalInvoiceFingerprint } from "./historical-invoice-archive-service";
import { mapHistoricalInvoiceRows, type HistoricalRawRow } from "./historical-invoice-mapping";
import { previewHistoricalInvoices, type HistoricalCalendar, type HistoricalCurrency, type HistoricalPreviewDocument } from "./historical-invoice-preview";
import type { ImportMapping } from "./types";

export class HistoricalJobPreviewError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "HistoricalJobPreviewError";
  }
}

export type HistoricalJobPreviewDocument = Omit<HistoricalPreviewDocument, "outcome"> & {
  outcome: HistoricalPreviewDocument["outcome"] | "conflict";
};
export interface HistoricalJobPreview {
  /** Cross-source and posted-sale reconciliation is not implemented yet. */
  crossSourceChecked: false;
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
  sampleLimit?: number;
}): Promise<HistoricalJobPreview> {
  const sourceKey = input.sourceKey.trim();
  const provider = input.provider.trim();
  if (!sourceKey || sourceKey.length > 200 || provider.length > 200) throw new HistoricalJobPreviewError("invalid_source");
  if (input.currency !== "rial" && input.currency !== "toman") throw new HistoricalJobPreviewError("invalid_currency");
  if (input.calendar !== "jalali" && input.calendar !== "gregorian") throw new HistoricalJobPreviewError("invalid_calendar");
  const sampleLimit = Number.isFinite(input.sampleLimit) ? Math.min(Math.max(Math.trunc(input.sampleLimit!), 0), 200) : 100;
  return withTenantTransaction(input.businessId, async (client) => {
    const job = await client.query<{ source_columns: unknown; status: string }>(
      `SELECT source_columns, status FROM data_import_jobs
        WHERE id = $1 AND business_id = $2 AND location_id = $3 AND entity_key = 'accounting.historical_invoices'`,
      [input.jobId, input.businessId, input.locationId],
    );
    if (!job.rowCount) throw new HistoricalJobPreviewError("job_not_found");
    if (!["pending", "ready"].includes(job.rows[0].status)) throw new HistoricalJobPreviewError("job_not_editable");
    const rawColumns = job.rows[0].source_columns;
    if (!Array.isArray(rawColumns) || !rawColumns.every((value) => typeof value === "string")) throw new HistoricalJobPreviewError("invalid_source_columns");
    const staged = await client.query<{ row_number: number; raw: Record<string, string> }>(
      `SELECT row_number, raw FROM data_import_rows WHERE job_id = $1 ORDER BY row_number LIMIT 50001`, [input.jobId],
    );
    if (staged.rows.length > 50_000) throw new HistoricalJobPreviewError("too_many_rows");
    if (staged.rows.length === 0) throw new HistoricalJobPreviewError("no_rows");
    const rawRows: HistoricalRawRow[] = staged.rows.map((row) => ({ rowNumber: row.row_number, raw: row.raw }));
    const mapped = mapHistoricalInvoiceRows(rawColumns, rawRows, input.mapping);
    const codes = [...new Set(mapped.map((row) => (row.externalCustomerCode ?? "").trim()).filter(Boolean))];
    const ids = [...new Set(mapped.map((row) => row.externalInvoiceId.trim()).filter(Boolean))];
    const identities = await client.query<{ external_id: string; canonical_id: string }>(
      `SELECT s.external_id, s.canonical_id FROM source_identities s JOIN parties p
          ON p.id::text = s.canonical_id AND p.business_id = s.business_id
        WHERE s.business_id = $1 AND s.source_key = $2 AND s.domain = 'party'
          AND s.external_type = 'historical_customer_code' AND s.external_id = ANY($3::text[])
          AND s.verified AND s.retired_at IS NULL AND s.canonical_type = 'parties'
          AND 'customer' = ANY(p.roles) AND p.merged_into_id IS NULL`,
      [input.businessId, sourceKey, codes],
    );
    const archived = await client.query<{ external_id: string; party_id: string; location_id: string; source_provider: string; source_fingerprint: string }>(
      `SELECT external_id, party_id, location_id, source_provider, source_fingerprint FROM historical_sales_invoices
        WHERE business_id = $1 AND source_key = $2 AND external_id = ANY($3::text[])`,
      [input.businessId, sourceKey, ids],
    );
    const existing = new Map(archived.rows.map((row) => [row.external_id, row]));
    const documents: HistoricalJobPreviewDocument[] = previewHistoricalInvoices(mapped, {
      sourceKey, currency: input.currency, calendar: input.calendar,
      verifiedCustomers: identities.rows.map((row) => ({ externalCustomerCode: row.external_id, partyId: row.canonical_id })),
      archivedExternalIds: [...existing.keys()],
    }).map((doc) => {
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
    const sum = (field: "totalRial" | "paidRial" | "balanceRial") => {
      const values = documents.map((doc) => doc[field]).filter((value): value is string => value !== null);
      return { value: values.reduce((n, value) => n + BigInt(value), 0n).toString(), count: values.length };
    };
    const total = sum("totalRial"), paid = sum("paidRial"), balance = sum("balanceRial");
    return {
      crossSourceChecked: false,
      totalInvoices: documents.length,
      matchedCustomers: documents.filter((doc) => doc.partyId !== null).length,
      reviewNeeded: documents.filter((doc) => doc.outcome === "review").length,
      alreadyImported: documents.filter((doc) => doc.outcome === "already_imported").length,
      conflicts: documents.filter((doc) => doc.outcome === "conflict").length,
      invalid: documents.filter((doc) => doc.outcome === "invalid").length,
      toCreate: documents.filter((doc) => doc.outcome === "ready").length,
      summaryOnly: documents.filter((doc) => doc.summaryOnly).length,
      reconciliation: { totalRial: total.value, totalCount: total.count, paidRial: paid.value, paidCount: paid.count, balanceRial: balance.value, balanceCount: balance.count },
      documents: documents.slice(0, sampleLimit),
      truncated: documents.length > sampleLimit,
    };
  });
}
