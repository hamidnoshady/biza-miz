/**
 * No-write document preview over the existing Data Transfer staging rows.
 * This internal building block is not a route or a queue registration: callers
 * must enforce transfer/accounting/CRM permissions and branch access. The UI
 * and worker must not treat this read as an approval or an accounting posting.
 */
import { withTenantTransaction } from "../db";
import { historicalInvoiceFingerprint } from "./historical-invoice-archive-service";
import { HistoricalJobPreviewError, loadHistoricalStagedRows } from "./historical-invoice-staged-rows";
import { previewHistoricalInvoices, previewHistoricalInvoiceSheets, type HistoricalCalendar, type HistoricalCurrency, type HistoricalPreviewDocument, type HistoricalInvoiceLineRow } from "./historical-invoice-preview";
import type { ImportMapping } from "./types";

export { HistoricalJobPreviewError } from "./historical-invoice-staged-rows";

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
    const { source, mapped, headerRows, lineRows } = await loadHistoricalStagedRows(client, { ...input, sourceKey, provider });
    const codes = [...new Set(mapped.map((row) => (row.externalCustomerCode ?? "").trim()).filter(Boolean))];
    const ids = [...new Set(mapped.map((row) => row.externalInvoiceId.trim()).filter(Boolean))];
    const identities = await client.query<{ external_id: string; canonical_id: string }>(
      `SELECT s.external_id, s.canonical_id FROM source_identities s JOIN parties p
          ON p.id::text = s.canonical_id AND p.business_id = s.business_id
        WHERE s.business_id = $1 AND s.source_key = $2 AND s.domain = 'party'
          AND s.external_type = 'historical_customer_code' AND s.external_id = ANY($3::text[]) AND s.provider = $4
          AND s.verified AND s.retired_at IS NULL AND s.canonical_type = 'parties'
          AND 'customer' = ANY(p.roles) AND p.is_active AND p.merged_into_id IS NULL
          AND (p.location_id IS NULL OR p.location_id = $5)`,
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
      documents: documents.slice(documentOffset, documentOffset + sampleLimit),
      orphanLineCount: joined.orphanLines.length,
      orphanLines: joined.orphanLines.slice(orphanOffset, orphanOffset + sampleLimit),
      documentOffset, orphanOffset,
      hasMoreDocuments: documents.length > documentOffset + sampleLimit,
      hasMoreOrphans: joined.orphanLines.length > orphanOffset + sampleLimit,
      truncated: documents.length > sampleLimit || joined.orphanLines.length > sampleLimit,
    };
  });
}
