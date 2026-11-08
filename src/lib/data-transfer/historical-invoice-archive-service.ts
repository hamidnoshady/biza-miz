/**
 * Archive-only persistence for issue #1289. Internal service, not an API or a
 * posting path. The future transfer worker must re-check the actor's effective
 * permissions and app activation before calling it. It is not yet registered
 * with the row-oriented transfer engine.
 */
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { withTenantTransaction } from "../db";
import { linkSourceIdentity } from "../import-reconciliation/service";
import { previewHistoricalInvoices, type HistoricalCalendar, type HistoricalCurrency, type HistoricalInvoiceRow } from "./historical-invoice-preview";

export class HistoricalArchiveError extends Error {
  constructor(readonly code: string, readonly details: unknown = null) {
    super(code);
    this.name = "HistoricalArchiveError";
  }
}

export interface HistoricalArchiveActor {
  userId: string;
  name: string;
}

const SOURCE_TYPE = "historical_customer_code";
const ENTITY_KEY = "accounting.historical_invoices";
const lineKeys = ["lineName", "lineSku", "lineBarcode", "quantity", "unitPrice", "lineDiscount", "lineTax"] as const;

function bounded(value: string, max: number, code: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) throw new HistoricalArchiveError(code);
  return trimmed;
}

/** Serialize binding and archive operations in this tenant/source scope. */
async function lockSource(client: PoolClient, businessId: string, sourceKey: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [JSON.stringify([businessId, sourceKey, "historical-invoices"])]);
}

async function assertActor(client: PoolClient, businessId: string, actorId: string): Promise<void> {
  const actor = await client.query(
    `SELECT id FROM users WHERE id = $1 AND business_id = $2 AND is_active FOR SHARE`,
    [actorId, businessId],
  );
  if (!actor.rowCount) throw new HistoricalArchiveError("actor_not_active");
}

/**
 * Explicit, operator-reviewed binding to an existing customer. Never creates or
 * edits a party, and a previously verified identity cannot be re-pointed.
 * The caller must authorize the operator before invoking this internal service.
 */
export async function bindHistoricalCustomer(input: {
  businessId: string;
  sourceKey: string;
  provider: string;
  externalCustomerCode: string;
  partyId: string;
  actor: HistoricalArchiveActor;
}): Promise<"created" | "unchanged"> {
  const sourceKey = bounded(input.sourceKey, 200, "source_required");
  const code = bounded(input.externalCustomerCode, 300, "customer_code_required");
  const provider = input.provider.trim();
  if (provider.length > 200) throw new HistoricalArchiveError("provider_too_long");
  return withTenantTransaction(input.businessId, async (client) => {
    await lockSource(client, input.businessId, sourceKey);
    await assertActor(client, input.businessId, input.actor.userId);
    const party = await client.query(
      `SELECT id FROM parties WHERE business_id = $1 AND id = $2
        AND 'customer' = ANY(roles) AND merged_into_id IS NULL FOR SHARE`,
      [input.businessId, input.partyId],
    );
    if (!party.rowCount) throw new HistoricalArchiveError("customer_not_found");
    const existing = await client.query<{ verified: boolean; canonical_type: string; canonical_id: string }>(
      `SELECT verified, canonical_type, canonical_id FROM source_identities
        WHERE business_id = $1 AND source_key = $2 AND domain = 'party'
          AND external_type = $3 AND external_id = $4 AND retired_at IS NULL FOR UPDATE`,
      [input.businessId, sourceKey, SOURCE_TYPE, code],
    );
    if (existing.rows[0] && (!existing.rows[0].verified || existing.rows[0].canonical_type !== "parties" || existing.rows[0].canonical_id !== input.partyId)) {
      throw new HistoricalArchiveError("customer_identity_conflict");
    }
    const result = await linkSourceIdentity(client, {
      businessId: input.businessId, domain: "party", sourceKey, provider,
      externalType: SOURCE_TYPE, externalId: code, canonicalType: "parties",
      canonicalId: input.partyId, linkedBy: input.actor.userId,
    });
    if (result === "created") {
      await client.query(
        `INSERT INTO audit_log (business_id, user_id, action, entity, entity_id, payload)
         VALUES ($1, $2, 'historical_invoice.customer_linked', 'party', $3, $4::jsonb)`,
        [input.businessId, input.actor.userId, input.partyId, JSON.stringify({ sourceKey, externalCustomerCode: code, provider, actorName: input.actor.name })],
      );
    }
    return result;
  });
}

/** Stable fingerprint of mapped evidence; row numbers are file-position metadata. */
function normalizedEvidence(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row)
    .filter(([key, value]) => key !== "rowNumber" && value !== undefined && value !== "")
    .sort(([a], [b]) => a.localeCompare(b)));
}

export function historicalInvoiceFingerprint(rows: readonly HistoricalInvoiceRow[], currency: HistoricalCurrency, calendar: HistoricalCalendar): string {
  // Sort each object's keys, to avoid key insertion order changing a retry.
  const evidence = rows.map((row) => normalizedEvidence({ ...row }));
  return createHash("sha256").update(JSON.stringify({ currency, calendar, evidence })).digest("hex");
}

/**
 * Revalidates one grouped document in a running, archive-specific import job.
 * A retry is idempotent only for identical mapped evidence and the same target;
 * changed data or a different customer is a conflict, never an update. The
 * caller must have verified job approval, access and current permissions. The
 * job must have stored options.historicalInvoice with the approved sourceKey,
 * provider, currency and calendar, and its mapped rows must be string-valued.
 */
export async function archiveHistoricalInvoice(input: {
  businessId: string;
  locationId: string;
  jobId: string;
  sourceKey: string;
  provider: string;
  currency: HistoricalCurrency;
  calendar: HistoricalCalendar;
  rows: readonly HistoricalInvoiceRow[];
  expectedPartyId: string;
  actor: HistoricalArchiveActor;
}): Promise<{ status: "created" | "already_imported"; invoiceId: string }> {
  const sourceKey = bounded(input.sourceKey, 200, "source_required");
  const provider = input.provider.trim();
  if (provider.length > 200) throw new HistoricalArchiveError("provider_too_long");
  if (!input.rows.length || input.rows.length > 50_000) throw new HistoricalArchiveError("invalid_document_rows");
  if (input.currency !== "rial" && input.currency !== "toman") throw new HistoricalArchiveError("invalid_currency");
  if (input.calendar !== "jalali" && input.calendar !== "gregorian") throw new HistoricalArchiveError("invalid_calendar");
  const code = bounded(input.rows.map((r) => r.externalCustomerCode?.trim()).find(Boolean) ?? "", 300, "customer_code_required");
  const externalId = bounded(input.rows[0].externalInvoiceId, 300, "invoice_id_required");
  const hash = historicalInvoiceFingerprint(input.rows, input.currency, input.calendar);
  return withTenantTransaction(input.businessId, async (client) => {
    await lockSource(client, input.businessId, sourceKey);
    await assertActor(client, input.businessId, input.actor.userId);
    const job = await client.query<{ options: { historicalInvoice?: { sourceKey?: string; provider?: string; currency?: string; calendar?: string } } }>(
      `SELECT options FROM data_import_jobs WHERE id = $1 AND business_id = $2
        AND location_id = $3 AND entity_key = $4 AND status = 'running' AND created_by = $5 FOR SHARE`,
      [input.jobId, input.businessId, input.locationId, ENTITY_KEY, input.actor.userId],
    );
    if (!job.rowCount) throw new HistoricalArchiveError("job_not_running_or_authorized");
    const approved = job.rows[0].options?.historicalInvoice;
    if (!approved || approved.sourceKey !== sourceKey || approved.provider !== provider || approved.currency !== input.currency || approved.calendar !== input.calendar) {
      throw new HistoricalArchiveError("job_source_changed");
    }
    // Do not trust worker arguments as evidence. A future document-aware worker
    // must use all the staged mapped rows for this ID, in source order. This
    // catches stale plans, partial groups and tampering before any write.
    const staged = await client.query<{ row_number: number; mapped: Record<string, unknown>; status: string }>(
      `SELECT row_number, mapped, status FROM data_import_rows
        WHERE job_id = $1 AND btrim(mapped->>'externalInvoiceId') = $2
        ORDER BY row_number FOR SHARE`,
      [input.jobId, externalId],
    );
    if (staged.rows.length !== input.rows.length || staged.rows.some((row, index) =>
      !["valid", "warning"].includes(row.status) || row.row_number !== input.rows[index].rowNumber ||
      JSON.stringify(normalizedEvidence(row.mapped)) !== JSON.stringify(normalizedEvidence({ ...input.rows[index] })),
    )) throw new HistoricalArchiveError("staged_document_changed");
    const identities = await client.query<{ canonical_id: string }>(
      `SELECT s.canonical_id FROM source_identities s JOIN parties p
        ON p.id::text = s.canonical_id AND p.business_id = s.business_id
       WHERE s.business_id = $1 AND s.source_key = $2 AND s.domain = 'party'
         AND s.external_type = $3 AND s.external_id = $4 AND s.verified AND s.retired_at IS NULL
         AND s.canonical_type = 'parties' AND 'customer' = ANY(p.roles) AND p.merged_into_id IS NULL
       FOR SHARE OF s, p`,
      [input.businessId, sourceKey, SOURCE_TYPE, code],
    );
    const partyId = identities.rows[0]?.canonical_id;
    if (!partyId || partyId !== input.expectedPartyId) throw new HistoricalArchiveError("customer_binding_changed");
    const docs = previewHistoricalInvoices(input.rows, {
      sourceKey, currency: input.currency, calendar: input.calendar,
      verifiedCustomers: [{ externalCustomerCode: code, partyId }], archivedExternalIds: [],
    });
    if (docs.length !== 1 || docs[0].outcome !== "ready") throw new HistoricalArchiveError("invalid_document", docs.map((doc) => ({ errors: doc.errors, warnings: doc.warnings })));
    const doc = docs[0];
    const prior = await client.query<{ id: string; party_id: string; location_id: string; source_fingerprint: string; source_provider: string }>(
      `SELECT id, party_id, location_id, source_fingerprint, source_provider FROM historical_sales_invoices
        WHERE business_id = $1 AND source_key = $2 AND external_id = $3 FOR SHARE`,
      [input.businessId, sourceKey, externalId],
    );
    if (prior.rows[0]) {
      const old = prior.rows[0];
      if (old.party_id !== partyId || old.location_id !== input.locationId || old.source_fingerprint !== hash || old.source_provider !== provider) {
        throw new HistoricalArchiveError("document_identity_conflict");
      }
      return { status: "already_imported", invoiceId: old.id };
    }
    const headerValue = (field: keyof HistoricalInvoiceRow): string => input.rows.map((r) => String(r[field] ?? "").trim()).find(Boolean) ?? "";
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO historical_sales_invoices
        (business_id, location_id, party_id, import_job_id, source_key, source_provider, external_id,
         invoice_number, invoice_date, external_customer_code, source_branch, source_currency, source_calendar,
         source_status, total_rial, paid_rial, balance_rial, summary_only, source_fingerprint, source_snapshot, created_by, created_by_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::date,$10,$11,$12,$13,$14,$15::bigint,$16::bigint,$17::bigint,$18,$19,$20::jsonb,$21,$22)
       RETURNING id`,
      [input.businessId, input.locationId, partyId, input.jobId, sourceKey, provider, externalId,
        headerValue("invoiceNumber"), doc.invoiceDate, code, headerValue("sourceBranch"), input.currency, input.calendar,
        headerValue("status"), doc.totalRial, doc.paidRial, doc.balanceRial, doc.summaryOnly, hash,
        JSON.stringify(input.rows), input.actor.userId, input.actor.name],
    );
    const invoiceId = inserted.rows[0].id;
    const lines = input.rows.filter((row) => lineKeys.some((key) => String(row[key] ?? "").trim()));
    for (const [index, row] of lines.entries()) {
      await client.query(
        `INSERT INTO historical_sales_invoice_lines (business_id, invoice_id, line_number, source_snapshot)
         VALUES ($1, $2, $3, $4::jsonb)`, [input.businessId, invoiceId, index + 1, JSON.stringify(row)],
      );
    }
    await client.query(
      `INSERT INTO audit_log (business_id, user_id, action, entity, entity_id, payload)
       VALUES ($1, $2, 'historical_invoice.archived', $3, $4, $5::jsonb)`,
      [input.businessId, input.actor.userId, ENTITY_KEY, invoiceId, JSON.stringify({ sourceKey, externalId, importJobId: input.jobId, partyId })],
    );
    return { status: "created", invoiceId };
  });
}

export interface HistoricalInvoiceSummary {
  id: string;
  partyId: string;
  sourceKey: string;
  provider: string;
  externalId: string;
  invoiceNumber: string;
  invoiceDate: string;
  externalCustomerCode: string;
  sourceBranch: string;
  sourceCurrency: HistoricalCurrency;
  sourceStatus: string;
  totalRial: string;
  paidRial: string | null;
  balanceRial: string | null;
  summaryOnly: boolean;
  importJobId: string;
  createdByName: string;
  createdAt: string;
}

/**
 * Internal read model. A route MUST check its accounting/CRM read permission
 * and the member's access to the supplied location before calling this. The
 * mandatory location filter prevents a branch-scoped caller accidentally
 * receiving all branches. Amounts are strings to preserve exact integer Rial.
 */
export async function listHistoricalInvoices(input: {
  businessId: string;
  locationId: string;
  partyId?: string;
  search?: string;
  limit?: number;
  offset?: number;
}): Promise<HistoricalInvoiceSummary[]> {
  const search = (input.search ?? "").trim().slice(0, 200);
  const escaped = search.replace(/[\\%_]/g, "\\$&");
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? 50) || 50, 1), 200);
  const offset = Math.max(Math.trunc(input.offset ?? 0) || 0, 0);
  return withTenantTransaction(input.businessId, async (client) => {
    const result = await client.query<HistoricalInvoiceSummary>(
      `WITH RECURSIVE customer_family AS (
          SELECT id FROM parties WHERE business_id = $1 AND id = $3::uuid
          UNION
          SELECT p.id FROM parties p JOIN customer_family f ON p.merged_into_id = f.id WHERE p.business_id = $1
       )
       SELECT id, party_id AS "partyId", source_key AS "sourceKey", source_provider AS "provider",
              external_id AS "externalId", invoice_number AS "invoiceNumber", invoice_date::text AS "invoiceDate",
              external_customer_code AS "externalCustomerCode", source_branch AS "sourceBranch", source_currency AS "sourceCurrency", source_status AS "sourceStatus",
              total_rial::text AS "totalRial", paid_rial::text AS "paidRial", balance_rial::text AS "balanceRial",
              summary_only AS "summaryOnly", import_job_id AS "importJobId", created_by_name AS "createdByName", created_at::text AS "createdAt"
         FROM historical_sales_invoices
        WHERE business_id = $1 AND location_id = $2 AND ($3::uuid IS NULL OR party_id IN (SELECT id FROM customer_family))
          AND ($4 = '' OR external_id ILIKE '%' || $4 || '%' ESCAPE '\\' OR invoice_number ILIKE '%' || $4 || '%' ESCAPE '\\'
               OR source_key ILIKE '%' || $4 || '%' ESCAPE '\\')
        ORDER BY invoice_date DESC, id DESC LIMIT $5 OFFSET $6`,
      [input.businessId, input.locationId, input.partyId ?? null, escaped, limit, offset],
    );
    return result.rows;
  });
}

/** Detail is branch-scoped too; raw mapped evidence may contain sensitive data. */
export async function getHistoricalInvoiceEvidence(input: {
  businessId: string;
  locationId: string;
  invoiceId: string;
}): Promise<{ sourceSnapshot: HistoricalInvoiceRow[]; lines: HistoricalInvoiceRow[] } | null> {
  return withTenantTransaction(input.businessId, async (client) => {
    const invoice = await client.query<{ source_snapshot: HistoricalInvoiceRow[] }>(
      `SELECT source_snapshot FROM historical_sales_invoices WHERE business_id = $1 AND location_id = $2 AND id = $3`,
      [input.businessId, input.locationId, input.invoiceId],
    );
    if (!invoice.rowCount) return null;
    const lines = await client.query<{ source_snapshot: HistoricalInvoiceRow }>(
      `SELECT source_snapshot FROM historical_sales_invoice_lines WHERE business_id = $1 AND invoice_id = $2 ORDER BY line_number`,
      [input.businessId, input.invoiceId],
    );
    return { sourceSnapshot: invoice.rows[0].source_snapshot, lines: lines.rows.map((line) => line.source_snapshot) };
  });
}

/** Bounded line inspection for authorized routes, with an optional customer constraint. */
export async function listHistoricalInvoiceLines(input: {
  businessId: string;
  locationId: string;
  invoiceId: string;
  partyId?: string;
  offset?: number;
}): Promise<{ lines: HistoricalInvoiceRow[]; hasMore: boolean } | null> {
  const offset = Number.isSafeInteger(input.offset) ? Math.min(Math.max(input.offset!, 0), 50_000) : 0;
  return withTenantTransaction(input.businessId, async (client) => {
    const invoice = await client.query(
      `WITH RECURSIVE customer_family AS (
          SELECT id FROM parties WHERE business_id = $1 AND id = $4::uuid
          UNION
          SELECT p.id FROM parties p JOIN customer_family f ON p.merged_into_id = f.id WHERE p.business_id = $1
       )
       SELECT id FROM historical_sales_invoices WHERE business_id = $1 AND location_id = $2 AND id = $3
        AND ($4::uuid IS NULL OR party_id IN (SELECT id FROM customer_family))`,
      [input.businessId, input.locationId, input.invoiceId, input.partyId ?? null],
    );
    if (!invoice.rowCount) return null;
    const lines = await client.query<{ source_snapshot: HistoricalInvoiceRow }>(
      `SELECT source_snapshot FROM historical_sales_invoice_lines WHERE business_id = $1 AND invoice_id = $2
        ORDER BY line_number LIMIT 21 OFFSET $3`, [input.businessId, input.invoiceId, offset],
    );
    return {
      lines: lines.rows.slice(0, 20).map(({ source_snapshot: row }) => ({
        rowNumber: row.rowNumber, externalInvoiceId: row.externalInvoiceId,
        lineName: row.lineName, lineSku: row.lineSku, lineBarcode: row.lineBarcode,
        quantity: row.quantity, unitPrice: row.unitPrice, lineDiscount: row.lineDiscount, lineTax: row.lineTax,
      })),
      hasMore: lines.rows.length > 20,
    };
  });
}
