/**
 * Issue #866 — taxpayer e-invoicing: the read side.
 *
 * The register, a record's history, the sales still waiting to be prepared, the
 * reconciliation against the sales ledger, the provider error report, the
 * pending queue, and the export. Reads only: nothing here changes a record or
 * posts to the ledger.
 *
 * Display fields (order number, branch, buyer, sale time) come from the stored
 * snapshot, not from the live order, so a record shows what was reported even if
 * the sale has since been renamed or re-priced. The reconciliation is the one
 * deliberate exception: it compares the snapshot to the live sale, because that
 * comparison is its purpose.
 */
import { query, withTenant } from "./db";
import { formatJalali } from "./jalali";
import type { MoneyUnit } from "./money";
import { moneyColumnLabel, moneyExportCell, type ReportTable } from "./report-export";
import { reconcileSales, type ProviderIssue, type ReconRecord, type ReconRow, type ReconSource, type ReconTotals, type TaxPayloadV1 } from "./tax-invoice-core";
import { statusesForView, type TaxEnvironment, type TaxKind, type TaxStatus, type TaxView } from "./tax-invoice";

export interface TaxRegisterFilters {
  view?: TaxView | "all";
  status?: TaxStatus;
  kind?: TaxKind;
  /** Business-day bounds, `YYYY-MM-DD`, in the business's own timezone. */
  from?: string;
  to?: string;
  locationId?: string;
  customerId?: string;
  q?: string;
}

/** Builds `$n` placeholders as it goes, so a filter can never be concatenated in. */
class SqlWhere {
  readonly params: unknown[] = [];
  readonly clauses: string[] = [];
  p(value: unknown): string {
    this.params.push(value);
    return `$${this.params.length}`;
  }
  add(clause: string): void {
    this.clauses.push(clause);
  }
  sql(): string {
    return this.clauses.join(" AND ");
  }
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function requireDay(value: string | undefined): string | null {
  if (value === undefined || value === "") return null;
  if (!ISO_DAY.test(value)) throw new RangeError("تاریخ باید به صورت YYYY-MM-DD باشد.");
  return value;
}

export async function getBusinessTimeZone(businessId: string): Promise<string> {
  const { rows } = await query<{ timezone: string }>(`SELECT timezone FROM businesses WHERE id = $1`, [businessId]);
  return rows[0]?.timezone ?? "Asia/Tehran";
}

function registerWhere(
  businessId: string,
  filters: TaxRegisterFilters,
  timeZone: string,
  options: { applyView: boolean; applyStatus: boolean },
): SqlWhere {
  const w = new SqlWhere();
  w.add(`s.business_id = ${w.p(businessId)}`);
  if (options.applyView && filters.view && filters.view !== "all") {
    w.add(`s.status = ANY(${w.p([...statusesForView(filters.view)])}::text[])`);
  }
  if (options.applyStatus && filters.status) w.add(`s.status = ${w.p(filters.status)}`);
  if (filters.kind) w.add(`s.kind = ${w.p(filters.kind)}`);
  if (filters.locationId) w.add(`s.location_id = ${w.p(filters.locationId)}::uuid`);
  if (filters.customerId) w.add(`s.payload_snapshot->'buyer'->>'partyId' = ${w.p(filters.customerId)}`);
  const from = requireDay(filters.from);
  if (from) {
    w.add(`(s.payload_snapshot->'source'->>'closedAt')::timestamptz >= (${w.p(from)}::date)::timestamp AT TIME ZONE ${w.p(timeZone)}`);
  }
  const to = requireDay(filters.to);
  if (to) {
    w.add(`(s.payload_snapshot->'source'->>'closedAt')::timestamptz < ((${w.p(to)}::date) + 1)::timestamp AT TIME ZONE ${w.p(timeZone)}`);
  }
  const q = filters.q?.trim();
  if (q) {
    const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    const likeRef = w.p(like);
    w.add(
      `(s.reference_number ILIKE ${likeRef} OR s.uid ILIKE ${likeRef} OR s.payload_snapshot->'buyer'->>'name' ILIKE ${likeRef}
        OR s.payload_snapshot->'source'->>'orderNumber' = ${w.p(q)})`,
    );
  }
  return w;
}

export interface TaxRegisterRow {
  id: string;
  kind: TaxKind;
  revision: number;
  status: TaxStatus;
  environment: TaxEnvironment;
  provider: "sandbox" | "moodian";
  referenceNumber: string;
  uid: string;
  receiptId: string | null;
  orderId: string;
  locationId: string;
  orderNumber: number | null;
  locationName: string | null;
  buyerName: string | null;
  closedAt: string | null;
  totalRial: number;
  vatRial: number;
  attempts: number;
  lastErrorCode: string | null;
  nextAttemptAt: string | null;
  submittedAt: string | null;
  acceptedAt: string | null;
  preparedAt: string;
  parentSubmissionId: string | null;
  archivedAt?: string | null;
  retentionHoldAt?: string | null;
}

export interface TaxRegisterPage {
  rows: TaxRegisterRow[];
  nextCursor: string | null;
  counts: Record<TaxView, number> & { total: number };
}

function encodeCursor(preparedAt: string, id: string): string {
  return Buffer.from(`${preparedAt}|${id}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): { preparedAt: string; id: string } {
  const [preparedAt, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  if (!preparedAt || !id || Number.isNaN(Date.parse(preparedAt))) {
    throw new RangeError("cursor_invalid");
  }
  return { preparedAt, id };
}

export async function listTaxRegister(
  businessId: string,
  filters: TaxRegisterFilters,
  options: { limit?: number; cursor?: string | null } = {},
): Promise<TaxRegisterPage> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  return withTenant(businessId, async () => {
    const timeZone = await getBusinessTimeZone(businessId);
    const page = registerWhere(businessId, filters, timeZone, { applyView: true, applyStatus: true });
    if (options.cursor) {
      const cursor = decodeCursor(options.cursor);
      page.add(`(s.prepared_at, s.id) < (${page.p(cursor.preparedAt)}::timestamptz, ${page.p(cursor.id)}::uuid)`);
    }
    const rows = await query<Record<string, unknown>>(
      `SELECT s.id, s.kind, s.revision, s.status, s.environment, s.provider, s.reference_number, s.uid, s.receipt_id,
              s.order_id, s.location_id,
              s.payload_snapshot->'source'->>'orderNumber' AS order_number,
              s.payload_snapshot->'source'->>'locationName' AS location_name,
              s.payload_snapshot->'buyer'->>'name' AS buyer_name,
              s.payload_snapshot->'source'->>'closedAt' AS closed_at,
              s.total_rial::bigint AS total_rial, s.vat_rial::bigint AS vat_rial,
              s.attempts, s.last_error_code, s.next_attempt_at, s.submitted_at, s.accepted_at, s.retention_hold_at,
              s.prepared_at, s.parent_submission_id,
              (SELECT a.archived_at FROM tax_invoice_archives a WHERE a.submission_id = s.id) AS archived_at
         FROM tax_invoice_submissions s
        WHERE ${page.sql()}
        ORDER BY s.prepared_at DESC, s.id DESC
        LIMIT ${page.p(limit + 1)}`,
      page.params,
    );

    const counting = registerWhere(businessId, filters, timeZone, { applyView: false, applyStatus: false });
    const byStatus = await query<{ status: TaxStatus; n: number }>(
      `SELECT s.status, COUNT(*)::int AS n FROM tax_invoice_submissions s WHERE ${counting.sql()} GROUP BY s.status`,
      counting.params,
    );
    const statusCounts = new Map(byStatus.rows.map((row) => [row.status, row.n]));
    const countView = (view: TaxView) => statusesForView(view).reduce((sum, status) => sum + (statusCounts.get(status) ?? 0), 0);
    const total = [...statusCounts.values()].reduce((sum, n) => sum + n, 0);

    const hasMore = rows.rows.length > limit;
    const pageRows = rows.rows.slice(0, limit).map((row) => ({
      id: row.id as string,
      kind: row.kind as TaxKind,
      revision: Number(row.revision),
      status: row.status as TaxStatus,
      environment: row.environment as TaxEnvironment,
      provider: row.provider as "sandbox" | "moodian",
      referenceNumber: row.reference_number as string,
      uid: row.uid as string,
      receiptId: (row.receipt_id as string | null) ?? null,
      orderId: row.order_id as string,
      locationId: row.location_id as string,
      orderNumber: row.order_number === null ? null : Number(row.order_number),
      locationName: (row.location_name as string | null) ?? null,
      buyerName: (row.buyer_name as string | null) ?? null,
      closedAt: (row.closed_at as string | null) ?? null,
      totalRial: Number(row.total_rial),
      vatRial: Number(row.vat_rial),
      attempts: Number(row.attempts),
      lastErrorCode: (row.last_error_code as string | null) ?? null,
      nextAttemptAt: row.next_attempt_at ? (row.next_attempt_at as Date).toISOString() : null,
      submittedAt: row.submitted_at ? (row.submitted_at as Date).toISOString() : null,
      acceptedAt: row.accepted_at ? (row.accepted_at as Date).toISOString() : null,
      retentionHoldAt: row.retention_hold_at ? (row.retention_hold_at as Date).toISOString() : null,
      preparedAt: (row.prepared_at as Date).toISOString(),
      parentSubmissionId: (row.parent_submission_id as string | null) ?? null,
      archivedAt: row.archived_at ? (row.archived_at as Date).toISOString() : null,
    }));
    const last = pageRows[pageRows.length - 1];
    return {
      rows: pageRows,
      nextCursor: hasMore && last ? encodeCursor(last.preparedAt, last.id) : null,
      counts: {
        unsent: countView("unsent"),
        sent: countView("sent"),
        error: countView("error"),
        total,
      },
    };
  });
}

export interface TaxRecordDetail extends TaxRegisterRow {
  idempotencyKey: string;
  payloadVersion: string;
  payloadHash: string;
  payloadSnapshot: TaxPayloadV1;
  subtotalRial: number;
  discountRial: number;
  inquiryResult: { state: string; at: string } | null;
  lastInquiredAt: string | null;
  providerErrors: ProviderIssue[];
  lastErrorMessage: string | null;
  correlationId: string;
  queuedAt: string | null;
  events: TaxEventRow[];
  siblings: { id: string; kind: TaxKind; revision: number; status: TaxStatus; referenceNumber: string }[];
}

export interface TaxEventRow {
  id: string;
  eventType: string;
  fromStatus: TaxStatus | null;
  toStatus: TaxStatus | null;
  actorUserId: string | null;
  correlationId: string;
  detail: Record<string, unknown>;
  createdAt: string;
}

export async function getTaxRecordDetail(businessId: string, id: string): Promise<TaxRecordDetail | null> {
  return withTenant(businessId, async () => {
    const { rows } = await query<Record<string, unknown>>(
      `SELECT s.*, s.total_rial::bigint AS total_bigint, s.vat_rial::bigint AS vat_bigint,
              s.subtotal_rial::bigint AS subtotal_bigint, s.discount_rial::bigint AS discount_bigint,
              s.payload_snapshot->'source'->>'orderNumber' AS order_number,
              s.payload_snapshot->'source'->>'locationName' AS location_name,
              s.payload_snapshot->'buyer'->>'name' AS buyer_name,
              s.payload_snapshot->'source'->>'closedAt' AS closed_at,
              (SELECT a.archived_at FROM tax_invoice_archives a WHERE a.submission_id = s.id) AS archived_at
         FROM tax_invoice_submissions s WHERE s.id = $1`,
      [id],
    );
    const row = rows[0];
    if (!row) return null;
    const events = await query<Record<string, unknown>>(
      `SELECT id, event_type, from_status, to_status, actor_user_id, correlation_id, detail, created_at
         FROM tax_invoice_events WHERE submission_id = $1 ORDER BY created_at, id`,
      [id],
    );
    const siblings = await query<Record<string, unknown>>(
      `SELECT id, kind, revision, status, reference_number FROM tax_invoice_submissions
        WHERE order_id = $1 AND id <> $2 ORDER BY kind, revision`,
      [row.order_id, id],
    );
    return {
      id: row.id as string,
      kind: row.kind as TaxKind,
      revision: Number(row.revision),
      status: row.status as TaxStatus,
      environment: row.environment as TaxEnvironment,
      provider: row.provider as "sandbox" | "moodian",
      referenceNumber: row.reference_number as string,
      uid: row.uid as string,
      receiptId: (row.receipt_id as string | null) ?? null,
      orderId: row.order_id as string,
      locationId: row.location_id as string,
      orderNumber: row.order_number === null ? null : Number(row.order_number),
      locationName: (row.location_name as string | null) ?? null,
      buyerName: (row.buyer_name as string | null) ?? null,
      closedAt: (row.closed_at as string | null) ?? null,
      totalRial: Number(row.total_bigint),
      vatRial: Number(row.vat_bigint),
      subtotalRial: Number(row.subtotal_bigint),
      discountRial: Number(row.discount_bigint),
      attempts: Number(row.attempts),
      lastErrorCode: (row.last_error_code as string | null) ?? null,
      lastErrorMessage: (row.last_error_message as string | null) ?? null,
      nextAttemptAt: row.next_attempt_at ? (row.next_attempt_at as Date).toISOString() : null,
      submittedAt: row.submitted_at ? (row.submitted_at as Date).toISOString() : null,
      acceptedAt: row.accepted_at ? (row.accepted_at as Date).toISOString() : null,
      retentionHoldAt: row.retention_hold_at ? (row.retention_hold_at as Date).toISOString() : null,
      preparedAt: (row.prepared_at as Date).toISOString(),
      queuedAt: row.queued_at ? (row.queued_at as Date).toISOString() : null,
      parentSubmissionId: (row.parent_submission_id as string | null) ?? null,
      archivedAt: row.archived_at ? (row.archived_at as Date).toISOString() : null,
      idempotencyKey: row.idempotency_key as string,
      payloadVersion: row.payload_version as string,
      payloadHash: row.payload_hash as string,
      payloadSnapshot: row.payload_snapshot as TaxPayloadV1,
      inquiryResult: (row.inquiry_result as { state: string; at: string } | null) ?? null,
      lastInquiredAt: row.last_inquired_at ? (row.last_inquired_at as Date).toISOString() : null,
      providerErrors: (row.provider_errors as ProviderIssue[]) ?? [],
      correlationId: row.correlation_id as string,
      events: events.rows.map((event) => ({
        id: event.id as string,
        eventType: event.event_type as string,
        fromStatus: (event.from_status as TaxStatus | null) ?? null,
        toStatus: (event.to_status as TaxStatus | null) ?? null,
        actorUserId: (event.actor_user_id as string | null) ?? null,
        correlationId: event.correlation_id as string,
        detail: (event.detail as Record<string, unknown>) ?? {},
        createdAt: (event.created_at as Date).toISOString(),
      })),
      siblings: siblings.rows.map((sibling) => ({
        id: sibling.id as string,
        kind: sibling.kind as TaxKind,
        revision: Number(sibling.revision),
        status: sibling.status as TaxStatus,
        referenceNumber: sibling.reference_number as string,
      })),
    };
  });
}

export interface UnpreparedSale {
  orderId: string;
  orderNumber: number;
  locationId: string;
  locationName: string;
  closedAt: string;
  buyerName: string | null;
  totalRial: number;
  vatRial: number;
  uncodedLines: number;
}

/** Completed sales that no live tax record reports yet: the batch-preparation worklist. */
export async function listUnpreparedSales(
  businessId: string,
  filters: { from?: string; to?: string; locationId?: string; q?: string },
  limit = 200,
): Promise<UnpreparedSale[]> {
  return withTenant(businessId, async () => {
    const timeZone = await getBusinessTimeZone(businessId);
    const w = new SqlWhere();
    w.add(`o.status = 'completed'`);
    const when = `COALESCE(o.closed_at, o.opened_at)`;
    const from = requireDay(filters.from);
    if (from) w.add(`${when} >= (${w.p(from)}::date)::timestamp AT TIME ZONE ${w.p(timeZone)}`);
    const to = requireDay(filters.to);
    if (to) w.add(`${when} < ((${w.p(to)}::date) + 1)::timestamp AT TIME ZONE ${w.p(timeZone)}`);
    if (filters.locationId) w.add(`o.location_id = ${w.p(filters.locationId)}::uuid`);
    const q = filters.q?.trim();
    if (q && /^\d+$/.test(q)) w.add(`o.order_number = ${w.p(Number(q))}`);
    const { rows } = await query<Record<string, unknown>>(
      `SELECT o.id, o.order_number, o.location_id, l.name AS location_name, ${when} AS closed_at,
              p.name AS buyer_name, o.total::bigint AS total_rial, o.tax::bigint AS vat_rial,
              (SELECT COUNT(*)::int FROM order_items oi
                 WHERE oi.order_id = o.id AND oi.status <> 'voided'
                   AND NOT EXISTS (SELECT 1 FROM tax_item_codes c
                                    WHERE c.business_id = ${w.p(businessId)} AND c.product_id = COALESCE(oi.menu_item_id, oi.item_id))
              ) AS uncoded_lines
         FROM orders o
         JOIN locations l ON l.id = o.location_id
         LEFT JOIN parties p ON p.id = o.customer_id
        WHERE ${w.sql()}
          AND NOT EXISTS (SELECT 1 FROM tax_invoice_submissions s
                           WHERE s.order_id = o.id AND s.kind = 'sale' AND s.status NOT IN ('rejected', 'cancelled'))
        ORDER BY ${when} DESC, o.order_number DESC
        LIMIT ${w.p(Math.min(Math.max(limit, 1), 500))}`,
      w.params,
    );
    return rows.map((row) => ({
      orderId: row.id as string,
      orderNumber: Number(row.order_number),
      locationId: row.location_id as string,
      locationName: row.location_name as string,
      closedAt: (row.closed_at as Date).toISOString(),
      buyerName: (row.buyer_name as string | null) ?? null,
      totalRial: Number(row.total_rial),
      vatRial: Number(row.vat_rial),
      uncodedLines: Number(row.uncoded_lines),
    }));
  });
}

export interface ReconciliationPage {
  rows: ReconRow[];
  totals: ReconTotals;
  truncated: boolean;
}

/**
 * The register tied back to the sales ledger for a window of business days.
 * Reads the posted sales (`orders`) and the tax records; writes nothing. The VAT
 * compared is the sale's own VAT column, the same figure the VAT report sums.
 */
export async function getTaxReconciliation(
  businessId: string,
  filters: { from: string; to: string; locationId?: string; customerId?: string },
): Promise<ReconciliationPage> {
  return withTenant(businessId, async () => {
    const timeZone = await getBusinessTimeZone(businessId);
    const w = new SqlWhere();
    w.add(`o.status IN ('completed', 'voided')`);
    const when = `COALESCE(o.closed_at, o.opened_at)`;
    w.add(`${when} >= (${w.p(requireDay(filters.from))}::date)::timestamp AT TIME ZONE ${w.p(timeZone)}`);
    w.add(`${when} < ((${w.p(requireDay(filters.to))}::date) + 1)::timestamp AT TIME ZONE ${w.p(timeZone)}`);
    if (filters.locationId) w.add(`o.location_id = ${w.p(filters.locationId)}::uuid`);
    if (filters.customerId) w.add(`o.customer_id = ${w.p(filters.customerId)}::uuid`);
    const cap = 5001;
    const sourceRows = await query<Record<string, unknown>>(
      `SELECT o.id, o.order_number, o.location_id, l.name AS location_name, ${when} AS closed_at, o.status,
              o.tax::bigint AS vat, o.total::bigint AS total
         FROM orders o JOIN locations l ON l.id = o.location_id
        WHERE ${w.sql()}
        ORDER BY ${when}, o.order_number
        LIMIT ${cap}`,
      w.params,
    );
    const truncated = sourceRows.rows.length >= cap;
    const sources: ReconSource[] = sourceRows.rows.slice(0, cap - 1).map((row) => ({
      orderId: row.id as string,
      orderNumber: Number(row.order_number),
      locationId: row.location_id as string,
      locationName: row.location_name as string,
      closedAt: (row.closed_at as Date).toISOString(),
      status: row.status as string,
      vatRial: Number(row.vat),
      totalRial: Number(row.total),
    }));
    const orderIds = sources.map((source) => source.orderId);
    const recordRows = orderIds.length === 0
      ? { rows: [] as Record<string, unknown>[] }
      : await query<Record<string, unknown>>(
          `SELECT s.id, s.order_id, s.kind, s.revision, s.status, s.reference_number, s.receipt_id,
                  s.vat_rial::bigint AS vat, s.total_rial::bigint AS total
             FROM tax_invoice_submissions s
            WHERE s.business_id = $1 AND s.order_id = ANY($2::uuid[])`,
          [businessId, orderIds],
        );
    const records: ReconRecord[] = recordRows.rows.map((row) => ({
      id: row.id as string,
      orderId: row.order_id as string,
      kind: row.kind as TaxKind,
      revision: Number(row.revision),
      status: row.status as TaxStatus,
      reference: row.reference_number as string,
      receiptId: (row.receipt_id as string | null) ?? null,
      vatRial: Number(row.vat),
      totalRial: Number(row.total),
    }));
    const { rows, totals } = reconcileSales(sources, records);
    return { rows, totals, truncated };
  });
}

export interface ProviderErrorRow {
  code: string;
  message: string;
  records: number;
  occurrences: number;
}

/** What the authority and the transport kept refusing, grouped by code. */
export async function getProviderErrorReport(businessId: string, filters: { from?: string; to?: string } = {}): Promise<ProviderErrorRow[]> {
  return withTenant(businessId, async () => {
    const timeZone = await getBusinessTimeZone(businessId);
    const w = new SqlWhere();
    w.add(`s.business_id = ${w.p(businessId)}`);
    const from = requireDay(filters.from);
    if (from) w.add(`s.prepared_at >= (${w.p(from)}::date)::timestamp AT TIME ZONE ${w.p(timeZone)}`);
    const to = requireDay(filters.to);
    if (to) w.add(`s.prepared_at < ((${w.p(to)}::date) + 1)::timestamp AT TIME ZONE ${w.p(timeZone)}`);
    const { rows } = await query<{ code: string; message: string; records: number; occurrences: number }>(
      `SELECT issue->>'code' AS code, MIN(issue->>'message') AS message,
              COUNT(DISTINCT s.id)::int AS records, COUNT(*)::int AS occurrences
         FROM tax_invoice_submissions s CROSS JOIN LATERAL jsonb_array_elements(s.provider_errors) AS issue
        WHERE ${w.sql()} AND s.status = 'rejected'
        GROUP BY issue->>'code'
       UNION ALL
       SELECT COALESCE(s.last_error_code, 'unknown') AS code, MIN(s.last_error_message) AS message,
              COUNT(*)::int AS records, COUNT(*)::int AS occurrences
         FROM tax_invoice_submissions s
        WHERE ${w.sql()} AND s.status = 'error'
        GROUP BY COALESCE(s.last_error_code, 'unknown')
       ORDER BY records DESC, code`,
      w.params,
    );
    return rows.map((row) => ({
      code: row.code,
      message: row.message ?? "",
      records: Number(row.records),
      occurrences: Number(row.occurrences),
    }));
  });
}

export interface PendingRow {
  id: string;
  kind: TaxKind;
  status: TaxStatus;
  referenceNumber: string;
  orderNumber: number | null;
  attempts: number;
  nextAttemptAt: string | null;
  preparedAt: string;
  submittedAt: string | null;
  lastErrorCode: string | null;
}

/** Records whose outcome is not yet known or that are waiting to go out. */
export async function listPendingQueue(businessId: string): Promise<PendingRow[]> {
  return withTenant(businessId, async () => {
    const { rows } = await query<Record<string, unknown>>(
      `SELECT s.id, s.kind, s.status, s.reference_number, s.attempts, s.next_attempt_at, s.prepared_at,
              s.submitted_at, s.last_error_code,
              s.payload_snapshot->'source'->>'orderNumber' AS order_number
         FROM tax_invoice_submissions s
        WHERE s.business_id = $1 AND s.status IN ('queued', 'sending', 'submitted', 'awaiting_inquiry')
        ORDER BY s.prepared_at, s.id
        LIMIT 500`,
      [businessId],
    );
    return rows.map((row) => ({
      id: row.id as string,
      kind: row.kind as TaxKind,
      status: row.status as TaxStatus,
      referenceNumber: row.reference_number as string,
      orderNumber: row.order_number === null ? null : Number(row.order_number),
      attempts: Number(row.attempts),
      nextAttemptAt: row.next_attempt_at ? (row.next_attempt_at as Date).toISOString() : null,
      preparedAt: (row.prepared_at as Date).toISOString(),
      submittedAt: row.submitted_at ? (row.submitted_at as Date).toISOString() : null,
      lastErrorCode: (row.last_error_code as string | null) ?? null,
    }));
  });
}

/** The register as a report table, for CSV and Excel. Amounts in the business's unit; dates in Shamsi. */
export async function buildTaxRegisterExport(
  businessId: string,
  filters: TaxRegisterFilters,
  unit: MoneyUnit,
): Promise<ReportTable> {
  const rows: Record<string, unknown>[] = [];
  let cursor: string | null = null;
  // The export is bounded: a register larger than this is exported in parts.
  for (let guard = 0; guard < 50; guard += 1) {
    const page: TaxRegisterPage = await listTaxRegister(businessId, filters, { limit: 200, cursor });
    for (const row of page.rows) {
      rows.push({
        referenceNumber: row.referenceNumber,
        uid: row.uid,
        kind: row.kind,
        revision: row.revision,
        status: row.status,
        environment: row.environment,
        orderNumber: row.orderNumber ?? "",
        locationName: row.locationName ?? "",
        buyerName: row.buyerName ?? "",
        closedAt: row.closedAt ? formatJalali(row.closedAt, { withTime: true }) : "",
        total: moneyExportCell(row.totalRial, unit, "csv"),
        vat: moneyExportCell(row.vatRial, unit, "csv"),
        submittedAt: row.submittedAt ? formatJalali(row.submittedAt, { withTime: true }) : "",
        acceptedAt: row.acceptedAt ? formatJalali(row.acceptedAt, { withTime: true }) : "",
        receiptId: row.receiptId ?? "",
        attempts: row.attempts,
        lastErrorCode: row.lastErrorCode ?? "",
      });
    }
    cursor = page.nextCursor;
    if (!cursor) break;
  }
  return {
    columns: [
      { key: "referenceNumber", label: "شماره ارجاع" },
      { key: "uid", label: "شناسه یکتای ارسال" },
      { key: "kind", label: "نوع" },
      { key: "revision", label: "نسخه" },
      { key: "status", label: "وضعیت" },
      { key: "environment", label: "محیط" },
      { key: "orderNumber", label: "شماره فروش" },
      { key: "locationName", label: "شعبه" },
      { key: "buyerName", label: "خریدار" },
      { key: "closedAt", label: "تاریخ فروش" },
      { key: "total", label: moneyColumnLabel("مبلغ کل", unit) },
      { key: "vat", label: moneyColumnLabel("مالیات بر ارزش افزوده", unit) },
      { key: "submittedAt", label: "زمان ارسال" },
      { key: "acceptedAt", label: "زمان پذیرش" },
      { key: "receiptId", label: "شناسه رسید" },
      { key: "attempts", label: "تعداد تلاش" },
      { key: "lastErrorCode", label: "آخرین خطا" },
    ],
    rows,
  };
}

/** Customer choices include stored buyer identities, even after a party was removed. */
export async function listTaxCustomers(businessId: string): Promise<{ id: string; name: string }[]> {
  return withTenant(businessId, async () => {
    const { rows } = await query<{ id: string; name: string }>(`
      SELECT id, MAX(name) AS name FROM (
        SELECT p.id::text AS id, p.name FROM parties p
         WHERE p.business_id = $1 AND 'customer' = ANY(p.roles)
        UNION ALL
        SELECT payload_snapshot->'buyer'->>'partyId', payload_snapshot->'buyer'->>'name'
          FROM tax_invoice_submissions WHERE business_id = $1
      ) customers WHERE id IS NOT NULL AND name IS NOT NULL
      GROUP BY id ORDER BY name, id`, [businessId]);
    return rows;
  });
}
