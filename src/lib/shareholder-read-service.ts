/**
 * Tenant-scoped, authorized shareholder read models. List pages are bounded;
 * aggregate totals and CSV exports are independent of presentation paging.
 */
import { createHash } from "node:crypto";
import { isValidIsoDate } from "./jalali";
import { inSnapshot } from "./payroll-db";
import { PERMISSIONS } from "./permissions";
import {
  projectDistributionFinancials,
  summarizeDistributionFinancials,
  SHAREHOLDER_ACCOUNT_CODES,
  type DistributionFinancialFact,
} from "./shareholder-accounting";
import {
  loadDistributionDetail,
  ShareholderError,
  type ShareholderAccountStatement,
  type ShareholderAccountStatementLine,
  type ShareholderActor,
  type ShareholderDistributionLinePage,
  type ShareholderDistributionLineRow,
  type ShareholderDistributionPage,
  type ShareholderDistributionRow,
  type ShareholderEventFilters,
  type ShareholderEventPage,
  type ShareholderEventRow,
  type ShareholderOffsetPageOptions,
  type ShareholderPaymentFilters,
  type ShareholderPaymentPage,
  type ShareholderPaymentRow,
  type ShareholderDistributionFilters,
} from "./shareholder-service";

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
const MAX_OFFSET = 1_000_000;
const OWNERSHIP_EVENT_TYPES = [
  "shareholder_added", "ownership_changed", "shareholder_removed", "ownership_transfer_out", "ownership_transfer_in",
] as const;
const CAPITAL_EVENT_TYPES = ["capital_contribution", "capital_withdrawal", "capital_reversal"] as const;
const ALL_EVENT_TYPES = new Set<string>([...OWNERSHIP_EVENT_TYPES, ...CAPITAL_EVENT_TYPES]);
const DISTRIBUTION_STATUSES = new Set(["draft", "approved", "posted", "partially_paid", "paid", "cancelled", "reversed"]);
const ACCOUNT_CODES = Object.values(SHAREHOLDER_ACCOUNT_CODES);

function requireRead(actor: ShareholderActor): void {
  if (!actor.permissions.has(PERMISSIONS.shareholdersView)) {
    throw new ShareholderError("permission_required", 403, { permission: PERMISSIONS.shareholdersView });
  }
}

function requireUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new ShareholderError(`invalid_${field}`, 400);
  }
  return value;
}

function optionalUuid(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  return requireUuid(value, field);
}

function optionalDate(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (!isValidIsoDate(value)) throw new ShareholderError(`invalid_${field}`, 400);
  return value;
}

function assertDateOrder(dateFrom: string | null, dateTo: string | null): void {
  if (dateFrom && dateTo && dateFrom > dateTo) throw new ShareholderError("invalid_date_range", 400);
}

function pageSize(value: unknown): number {
  if (value === undefined || value === null || value === "") return DEFAULT_PAGE_SIZE;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_PAGE_SIZE) {
    throw new ShareholderError("invalid_page_size", 400, { maxPageSize: MAX_PAGE_SIZE });
  }
  return parsed;
}

function pageOffset(value: unknown): number {
  if (value === undefined || value === null || value === "") return 0;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > MAX_OFFSET) {
    throw new ShareholderError("invalid_page_offset", 400, { maxOffset: MAX_OFFSET });
  }
  return parsed;
}

function numberFromCount(value: string | number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new ShareholderError("count_out_of_range", 500);
  return parsed;
}

function filterFingerprint(filters: Record<string, string | null>): string {
  return createHash("sha256").update(JSON.stringify(filters)).digest("hex").slice(0, 20);
}

function encodeCursor(
  cursor: { date: string; createdAt: string; id: string },
  fingerprint: string,
): string {
  return Buffer.from(JSON.stringify({ ...cursor, fingerprint })).toString("base64url");
}

function decodeCursor(
  value: unknown,
  fingerprint: string,
  dateField: string,
): { date: string; createdAt: string; id: string } | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 1024) throw new ShareholderError("invalid_page_cursor", 400);
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    if (decoded.fingerprint !== fingerprint || typeof decoded.date !== "string" || typeof decoded.createdAt !== "string") {
      throw new Error("cursor_shape");
    }
    if (!isValidIsoDate(decoded.date) || !Number.isFinite(Date.parse(decoded.createdAt))) throw new Error("cursor_date");
    return {
      date: decoded.date,
      createdAt: decoded.createdAt,
      id: requireUuid(decoded.id, dateField),
    };
  } catch {
    throw new ShareholderError("invalid_page_cursor", 400);
  }
}

function safeCount(value: string | number): number {
  return numberFromCount(value);
}

interface EventDbRow extends ShareholderEventRow {
  createdAt: string;
}

const EVENT_FROM = `
  FROM shareholder_events e
  JOIN shareholder_accounts sa ON sa.id = e.shareholder_id AND sa.business_id = e.business_id
  JOIN parties p ON p.id = sa.party_id AND p.business_id = e.business_id
  LEFT JOIN accounts pa ON pa.id = e.payment_account_id AND pa.business_id = e.business_id
  LEFT JOIN journal_entries je ON je.id = e.journal_entry_id AND je.business_id = e.business_id
  LEFT JOIN users u ON u.id = e.created_by
  LEFT JOIN shareholder_events original ON original.id = e.reverses_event_id AND original.business_id = e.business_id`;

const EVENT_SELECT = `
  SELECT e.id, e.shareholder_id AS "shareholderId", sa.party_id AS "partyId", p.name AS "partyName",
         e.event_type AS "eventType", e.effective_on::text AS "effectiveOn",
         e.ownership_percent::text AS "ownershipPercent", e.share_units::text AS "shareUnits",
         e.transfer_percent::text AS "transferPercent", e.transfer_group_id AS "transferGroupId",
         e.capital_class AS "capitalClass", e.amount_rial::text AS "amountRial",
         e.payment_account_id AS "paymentAccountId", pa.name AS "paymentAccountName",
         e.journal_entry_id AS "journalEntryId", je.voucher_number AS "journalVoucher",
         e.reverses_event_id AS "reversesEventId",
         EXISTS (SELECT 1 FROM shareholder_events reversal WHERE reversal.business_id = e.business_id AND reversal.reverses_event_id = e.id) AS "isReversed",
         e.reason, e.source_reference AS "sourceReference",
         e.notes, u.full_name AS "createdByName", e.created_at::text AS "createdAt"`;

interface EventFilterValues {
  dateFrom: string | null;
  dateTo: string | null;
  partyId: string | null;
  eventType: string | null;
  category: "ownership" | "capital" | null;
}

function normalizeEventFilters(filters: ShareholderEventFilters): EventFilterValues {
  const dateFrom = optionalDate(filters.dateFrom, "date_from");
  const dateTo = optionalDate(filters.dateTo, "date_to");
  assertDateOrder(dateFrom, dateTo);
  const partyId = optionalUuid(filters.partyId, "party_id");
  const eventType = filters.eventType === undefined || filters.eventType === null || filters.eventType === ""
    ? null
    : String(filters.eventType);
  if (eventType && !ALL_EVENT_TYPES.has(eventType)) throw new ShareholderError("invalid_event_type", 400);
  const rawCategory = filters.category === undefined || filters.category === null || filters.category === ""
    ? null
    : String(filters.category);
  if (rawCategory && rawCategory !== "ownership" && rawCategory !== "capital") {
    throw new ShareholderError("invalid_event_category", 400);
  }
  return { dateFrom, dateTo, partyId, eventType, category: rawCategory as EventFilterValues["category"] };
}

function eventFilterHash(filters: EventFilterValues): string {
  return filterFingerprint({
    dateFrom: filters.dateFrom,
    dateTo: filters.dateTo,
    partyId: filters.partyId,
    eventType: filters.eventType,
    category: filters.category,
  });
}

function eventWhereValues(filters: EventFilterValues, cursor: ReturnType<typeof decodeCursor>): unknown[] {
  return [
    filters.dateFrom,
    filters.dateTo,
    filters.partyId,
    filters.eventType,
    filters.category,
    cursor?.date ?? null,
    cursor?.createdAt ?? null,
    cursor?.id ?? null,
  ];
}

const EVENT_WHERE = `
  e.business_id = $1
  AND ($2::date IS NULL OR e.effective_on >= $2::date)
  AND ($3::date IS NULL OR e.effective_on <= $3::date)
  AND ($4::uuid IS NULL OR sa.party_id = $4::uuid)
  AND ($5::text IS NULL OR e.event_type = $5)
  AND ($6::text IS NULL OR ($6 = 'ownership' AND e.ownership_percent IS NOT NULL) OR ($6 = 'capital' AND e.amount_rial IS NOT NULL))
  AND ($7::date IS NULL OR (e.effective_on, e.created_at, e.id) < ($7::date, $8::timestamptz, $9::uuid))`;

function mapEventRow(row: EventDbRow): ShareholderEventRow {
  return row;
}

export async function listShareholderEvents(
  businessId: string,
  actor: ShareholderActor,
  filterInput: ShareholderEventFilters = {},
): Promise<ShareholderEventPage> {
  requireRead(actor);
  const filters = normalizeEventFilters(filterInput);
  const limit = pageSize(filterInput.limit);
  const fingerprint = eventFilterHash(filters);
  const cursor = decodeCursor(filterInput.cursor, fingerprint, "event_id");
  return inSnapshot(async (client) => {
    const [summaryResult, rowsResult] = await Promise.all([
      client.query<{ total_count: string; net_capital_movement_rial: string }>(
        `SELECT COUNT(*)::text AS total_count,
                COALESCE(SUM(CASE
                  WHEN e.event_type = 'capital_contribution' THEN e.amount_rial
                  WHEN e.event_type = 'capital_withdrawal' THEN -e.amount_rial
                  WHEN e.event_type = 'capital_reversal' AND original.event_type = 'capital_contribution' THEN -e.amount_rial
                  WHEN e.event_type = 'capital_reversal' AND original.event_type = 'capital_withdrawal' THEN e.amount_rial
                  ELSE 0 END), 0)::text AS net_capital_movement_rial
           ${EVENT_FROM}
          WHERE ${EVENT_WHERE}`,
        [businessId, ...eventWhereValues(filters, null)],
      ),
      client.query<EventDbRow>(
        `${EVENT_SELECT}
           ${EVENT_FROM}
          WHERE ${EVENT_WHERE}
          ORDER BY e.effective_on DESC, e.created_at DESC, e.id DESC
          LIMIT $10 OFFSET 0`,
        [businessId, ...eventWhereValues(filters, cursor), limit + 1],
      ),
    ]);
    const allRows = rowsResult.rows;
    const hasMore = allRows.length > limit;
    const events = allRows.slice(0, limit).map(mapEventRow);
    const last = events.at(-1);
    const summary = summaryResult.rows[0];
    return {
      events,
      totalCount: safeCount(summary?.total_count ?? "0"),
      netCapitalMovementRial: summary?.net_capital_movement_rial ?? "0",
      limit,
      hasMore,
      nextCursor: hasMore && last
        ? encodeCursor({ date: last.effectiveOn, createdAt: last.createdAt, id: last.id }, fingerprint)
        : null,
    };
  });
}

function csvCell(value: unknown, text = false): string {
  let normalized = value === null || value === undefined ? "" : String(value);
  if (text && /^[\s]*[=+@\-\t\r]/.test(normalized)) normalized = `'${normalized}`;
  return `"${normalized.replaceAll('"', '""')}"`;
}

export async function exportShareholderEventsCsv(
  businessId: string,
  actor: ShareholderActor,
  filterInput: ShareholderEventFilters = {},
): Promise<string> {
  requireRead(actor);
  const filters = normalizeEventFilters(filterInput);
  const fingerprint = eventFilterHash(filters);
  return inSnapshot(async (client) => {
    const header = [
      "event_id", "effective_on", "event_type", "party_id", "party_name", "ownership_percent", "share_units",
      "transfer_percent", "capital_class", "amount_rial", "payment_account", "journal_entry_id", "journal_voucher",
      "reverses_event_id", "reason", "source_reference", "notes", "created_by", "created_at",
    ];
    const lines = [header.map((value) => csvCell(value)).join(",")];
    let cursor: ReturnType<typeof decodeCursor> = null;
    while (true) {
      const result: { rows: EventDbRow[] } = await client.query<EventDbRow>(
        `${EVENT_SELECT}
           ${EVENT_FROM}
          WHERE ${EVENT_WHERE}
          ORDER BY e.effective_on DESC, e.created_at DESC, e.id DESC
          LIMIT $10 OFFSET 0`,
        [businessId, ...eventWhereValues(filters, cursor), 1000],
      );
      const rows: EventDbRow[] = result.rows;
      if (rows.length === 0) break;
      for (const row of rows) {
        const values = [
          row.id,
          row.effectiveOn,
          row.eventType,
          row.partyId,
          row.partyName,
          row.ownershipPercent,
          row.shareUnits,
          row.transferPercent,
          row.capitalClass,
          row.amountRial,
          row.paymentAccountName,
          row.journalEntryId,
          row.journalVoucher,
          row.reversesEventId,
          row.reason,
          row.sourceReference,
          row.notes,
          row.createdByName,
          row.createdAt,
        ];
        lines.push(values.map((value, index) => csvCell(value, [2, 4, 8, 10, 13, 14, 15, 16, 17].includes(index))).join(","));
      }
      const last: EventDbRow = rows[rows.length - 1];
      cursor = { date: last.effectiveOn, createdAt: last.createdAt, id: last.id };
      if (rows.length < 1000) break;
    }
    return `\uFEFF${lines.join("\r\n")}\r\n`;
  });
}

function normalizeDistributionFilters(filters: ShareholderDistributionFilters): {
  fiscalYearId: string | null;
  status: string | null;
} {
  const fiscalYearId = optionalUuid(filters.fiscalYearId, "fiscal_year_id");
  const status = filters.status === undefined || filters.status === null || filters.status === "" || filters.status === "all"
    ? null
    : String(filters.status);
  if (status && !DISTRIBUTION_STATUSES.has(status)) throw new ShareholderError("invalid_distribution_status", 400);
  return { fiscalYearId, status };
}

const DISTRIBUTION_SELECT = `
  SELECT d.id, d.fiscal_year_id AS "fiscalYearId", fy.label AS "fiscalYearLabel",
         d.closing_entry_id AS "closingEntryId", d.snapshot_on::text AS "snapshotOn",
         d.source_profit_rial::text AS "sourceProfitRial", d.tax_adjustment_rial::text AS "taxAdjustmentRial",
         d.reserve_adjustment_rial::text AS "reserveAdjustmentRial", d.manual_adjustment_rial::text AS "manualAdjustmentRial",
         d.adjustment_reason AS "adjustmentReason", d.distributable_rial::text AS "distributableRial",
         d.status, d.posting_entry_id AS "postingEntryId", d.reversal_entry_id AS "reversalEntryId",
         d.created_by AS "createdById", creator.full_name AS "createdByName", d.created_at::text AS "createdAt",
         approver.full_name AS "approvedByName", d.approved_at::text AS "approvedAt",
         poster.full_name AS "postedByName", d.posted_at::text AS "postedAt",
         reverser.full_name AS "reversedByName", d.reversed_at::text AS "reversedAt",
         canceller.full_name AS "cancelledByName", d.cancelled_at::text AS "cancelledAt",
         d.cancel_reason AS "cancelReason", COALESCE(payments.paid_rial, '0') AS "paidRial",
         '0'::text AS "outstandingRial"
    FROM shareholder_distributions d
    JOIN fiscal_years fy ON fy.id = d.fiscal_year_id AND fy.business_id = d.business_id
    LEFT JOIN users creator ON creator.id = d.created_by
    LEFT JOIN users approver ON approver.id = d.approved_by
    LEFT JOIN users poster ON poster.id = d.posted_by
    LEFT JOIN users reverser ON reverser.id = d.reversed_by
    LEFT JOIN users canceller ON canceller.id = d.cancelled_by
    LEFT JOIN LATERAL (
      SELECT SUM(CASE WHEN payment_type = 'payment' THEN amount_rial ELSE -amount_rial END)::text AS paid_rial
        FROM shareholder_distribution_payments
       WHERE distribution_id = d.id AND business_id = d.business_id
    ) payments ON true`;

function projectDistributionRow(row: ShareholderDistributionRow): ShareholderDistributionRow {
  const projection = projectDistributionFinancials(row.status, row.distributableRial, row.paidRial);
  return { ...row, paidRial: projection.paidRial, outstandingRial: projection.outstandingRial };
}

export async function listShareholderDistributions(
  businessId: string,
  actor: ShareholderActor,
  filterInput: ShareholderDistributionFilters = {},
): Promise<ShareholderDistributionPage> {
  requireRead(actor);
  const filters = normalizeDistributionFilters(filterInput);
  const limit = pageSize(filterInput.limit);
  const fingerprint = filterFingerprint(filters);
  const cursor = decodeCursor(filterInput.cursor, fingerprint, "distribution_id");
  return inSnapshot(async (client) => {
    const factsResult = await client.query<{
      status: string;
      distribution_count: string;
      distributable_rial: string;
      net_paid_rial: string;
    }>(
      `SELECT d.status, COUNT(*)::text AS distribution_count,
              COALESCE(SUM(d.distributable_rial), 0)::text AS distributable_rial,
              COALESCE(SUM(payments.net_paid_rial::numeric), 0)::text AS net_paid_rial
         FROM shareholder_distributions d
         LEFT JOIN LATERAL (
           SELECT COALESCE(SUM(CASE WHEN pmt.payment_type = 'payment' THEN pmt.amount_rial ELSE -pmt.amount_rial END), 0)::text AS net_paid_rial
             FROM shareholder_distribution_payments pmt
            WHERE pmt.business_id = d.business_id AND pmt.distribution_id = d.id
         ) payments ON true
        WHERE d.business_id = $1 AND ($2::uuid IS NULL OR d.fiscal_year_id = $2)
          AND ($3::text IS NULL OR d.status = $3)
        GROUP BY d.status`,
      [businessId, filters.fiscalYearId, filters.status],
    );
    const summary = summarizeDistributionFinancials(factsResult.rows.map((row): DistributionFinancialFact => ({
      status: row.status,
      count: numberFromCount(row.distribution_count),
      distributableRial: row.distributable_rial,
      netPaidRial: row.net_paid_rial,
    })));
    const rowsResult = await client.query<ShareholderDistributionRow>(
      `${DISTRIBUTION_SELECT}
        WHERE d.business_id = $1 AND ($2::uuid IS NULL OR d.fiscal_year_id = $2)
          AND ($3::text IS NULL OR d.status = $3)
          AND ($4::timestamptz IS NULL OR (d.created_at, d.id) < ($4::timestamptz, $5::uuid))
        ORDER BY d.created_at DESC, d.id DESC
        LIMIT $6 OFFSET 0`,
      [businessId, filters.fiscalYearId, filters.status, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1],
    );
    const hasMore = rowsResult.rows.length > limit;
    const distributions = rowsResult.rows.slice(0, limit).map(projectDistributionRow);
    const last = distributions.at(-1);
    return {
      distributions,
      totalCount: summary.distributionCount,
      summary,
      limit,
      hasMore,
      nextCursor: hasMore && last
        ? encodeCursor({ date: last.createdAt.slice(0, 10), createdAt: last.createdAt, id: last.id }, fingerprint)
        : null,
    };
  });
}

export async function getShareholderDistributionDetail(
  businessId: string,
  actor: ShareholderActor,
  distributionIdValue: unknown,
): Promise<ShareholderDistributionRow | null> {
  requireRead(actor);
  const distributionId = requireUuid(distributionIdValue, "distribution_id");
  return inSnapshot((client) => loadDistributionDetail(client, businessId, distributionId));
}

export async function listShareholderDistributionLines(
  businessId: string,
  actor: ShareholderActor,
  distributionIdValue: unknown,
  options: ShareholderOffsetPageOptions & { partyId?: unknown } = {},
): Promise<ShareholderDistributionLinePage> {
  requireRead(actor);
  const distributionId = requireUuid(distributionIdValue, "distribution_id");
  const partyId = optionalUuid(options.partyId, "party_id");
  const limit = pageSize(options.limit);
  const offset = pageOffset(options.offset);
  return inSnapshot(async (client) => {
    const distribution = await loadDistributionDetail(client, businessId, distributionId);
    if (!distribution) throw new ShareholderError("distribution_not_found", 404);
    const [summaryResult, rowsResult] = await Promise.all([
      client.query<{ total_count: string; total_allocated_rial: string; total_paid_rial: string }>(
        `SELECT COUNT(*)::text AS total_count,
                COALESCE(SUM(dl.allocated_rial), 0)::text AS total_allocated_rial,
                COALESCE(SUM(paid.net_paid_rial::numeric), 0)::text AS total_paid_rial
           FROM shareholder_distribution_lines dl
           LEFT JOIN LATERAL (
             SELECT COALESCE(SUM(CASE WHEN pmt.payment_type = 'payment' THEN pmt.amount_rial ELSE -pmt.amount_rial END), 0)::text AS net_paid_rial
               FROM shareholder_distribution_payments pmt
              WHERE pmt.business_id = dl.business_id AND pmt.distribution_line_id = dl.id
           ) paid ON true
          WHERE dl.business_id = $1 AND dl.distribution_id = $2 AND ($3::uuid IS NULL OR dl.party_id = $3)`,
        [businessId, distributionId, partyId],
      ),
      client.query<ShareholderDistributionLineRow & { netPaidRial: string }>(
        `SELECT dl.distribution_id AS "distributionId", dl.shareholder_id AS "shareholderId",
                dl.party_id AS "partyId", p.name AS "partyName",
                dl.ownership_percent::text AS "ownershipPercent", dl.share_units::text AS "shareUnits",
                dl.allocated_rial::text AS "allocatedRial", COALESCE(paid.net_paid_rial, '0') AS "netPaidRial",
                '0'::text AS "paidRial", '0'::text AS "outstandingRial"
           FROM shareholder_distribution_lines dl
           JOIN parties p ON p.id = dl.party_id AND p.business_id = dl.business_id
           LEFT JOIN LATERAL (
             SELECT SUM(CASE WHEN pmt.payment_type = 'payment' THEN pmt.amount_rial ELSE -pmt.amount_rial END)::text AS net_paid_rial
               FROM shareholder_distribution_payments pmt
              WHERE pmt.business_id = dl.business_id AND pmt.distribution_line_id = dl.id
           ) paid ON true
          WHERE dl.business_id = $1 AND dl.distribution_id = $2 AND ($3::uuid IS NULL OR dl.party_id = $3)
          ORDER BY p.name, dl.shareholder_id
          LIMIT $4 OFFSET $5`,
        [businessId, distributionId, partyId, limit + 1, offset],
      ),
    ]);
    const summaryRow = summaryResult.rows[0];
    const totalCount = safeCount(summaryRow?.total_count ?? "0");
    const totalAllocatedRial = summaryRow?.total_allocated_rial ?? "0";
    const totalProjection = projectDistributionFinancials(
      distribution.status,
      totalAllocatedRial,
      summaryRow?.total_paid_rial ?? "0",
    );
    const hasMore = rowsResult.rows.length > limit;
    const lines = rowsResult.rows.slice(0, limit).map(({ netPaidRial, ...row }) => {
      const projection = projectDistributionFinancials(distribution.status, row.allocatedRial, netPaidRial);
      return { ...row, paidRial: projection.paidRial, outstandingRial: projection.outstandingRial };
    });
    return {
      lines,
      totalCount,
      totalAllocatedRial,
      totalPaidRial: totalProjection.paidRial,
      totalOutstandingRial: totalProjection.outstandingRial,
      limit,
      offset,
      nextOffset: hasMore ? offset + limit : null,
    };
  });
}

interface PaymentCursor {
  paidOn: string;
  createdAt: string;
  id: string;
  fingerprint: string;
}

function paymentFingerprint(filters: {
  dateFrom: string | null;
  dateTo: string | null;
  partyId: string | null;
  distributionId: string | null;
  paymentType: string | null;
}): string {
  return filterFingerprint(filters);
}

function decodePaymentCursor(value: unknown, fingerprint: string): Omit<PaymentCursor, "fingerprint"> | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 1024) throw new ShareholderError("invalid_page_cursor", 400);
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    if (decoded.fingerprint !== fingerprint || typeof decoded.paidOn !== "string" || typeof decoded.createdAt !== "string") {
      throw new Error("cursor_shape");
    }
    if (!isValidIsoDate(decoded.paidOn) || !Number.isFinite(Date.parse(decoded.createdAt))) throw new Error("cursor_date");
    return { paidOn: decoded.paidOn, createdAt: decoded.createdAt, id: requireUuid(decoded.id, "payment_id") };
  } catch {
    throw new ShareholderError("invalid_page_cursor", 400);
  }
}

export async function listShareholderPayments(
  businessId: string,
  actor: ShareholderActor,
  filterInput: ShareholderPaymentFilters = {},
): Promise<ShareholderPaymentPage> {
  requireRead(actor);
  const dateFrom = optionalDate(filterInput.dateFrom, "date_from");
  const dateTo = optionalDate(filterInput.dateTo, "date_to");
  assertDateOrder(dateFrom, dateTo);
  const partyId = optionalUuid(filterInput.partyId, "party_id");
  const distributionId = optionalUuid(filterInput.distributionId, "distribution_id");
  const paymentTypeValue = filterInput.paymentType ?? filterInput.eventType;
  const paymentType = paymentTypeValue === undefined || paymentTypeValue === null || paymentTypeValue === ""
    ? null
    : String(paymentTypeValue);
  if (paymentType && paymentType !== "payment" && paymentType !== "reversal") {
    throw new ShareholderError("invalid_payment_type", 400);
  }
  const limit = pageSize(filterInput.limit);
  const filters = { dateFrom, dateTo, partyId, distributionId, paymentType };
  const fingerprint = paymentFingerprint(filters);
  const cursor = decodePaymentCursor(filterInput.cursor, fingerprint);
  return inSnapshot(async (client) => {
    const [summaryResult, rowsResult] = await Promise.all([
      client.query<{ total_count: string; net_paid_rial: string }>(
        `SELECT COUNT(*)::text AS total_count,
                COALESCE(SUM(CASE WHEN pmt.payment_type = 'payment' THEN pmt.amount_rial ELSE -pmt.amount_rial END), 0)::text AS net_paid_rial
           FROM shareholder_distribution_payments pmt
          WHERE pmt.business_id = $1
            AND ($2::uuid IS NULL OR pmt.distribution_id = $2)
            AND ($3::uuid IS NULL OR pmt.party_id = $3)
            AND ($4::date IS NULL OR pmt.paid_on >= $4::date)
            AND ($5::date IS NULL OR pmt.paid_on <= $5::date)
            AND ($6::text IS NULL OR pmt.payment_type = $6)`,
        [businessId, distributionId, partyId, dateFrom, dateTo, paymentType],
      ),
      client.query<ShareholderPaymentRow>(
        `SELECT pmt.id, pmt.distribution_id AS "distributionId", pmt.shareholder_id AS "shareholderId",
                pmt.party_id AS "partyId", party.name AS "partyName", pmt.payment_type AS "paymentType",
                pmt.paid_on::text AS "paidOn", pmt.amount_rial::text AS "amountRial",
                pmt.payment_account_id AS "paymentAccountId", account.name AS "paymentAccountName",
                pmt.journal_entry_id AS "journalEntryId", je.voucher_number AS "journalVoucher",
                pmt.reverses_payment_id AS "reversesPaymentId",
                EXISTS (SELECT 1 FROM shareholder_distribution_payments reversal WHERE reversal.business_id = pmt.business_id AND reversal.reverses_payment_id = pmt.id) AS "isReversed",
                pmt.note, actor.full_name AS "createdByName", pmt.created_at::text AS "createdAt"
           FROM shareholder_distribution_payments pmt
           JOIN parties party ON party.id = pmt.party_id AND party.business_id = pmt.business_id
           JOIN accounts account ON account.id = pmt.payment_account_id AND account.business_id = pmt.business_id
           JOIN journal_entries je ON je.id = pmt.journal_entry_id AND je.business_id = pmt.business_id
           LEFT JOIN users actor ON actor.id = pmt.created_by
          WHERE pmt.business_id = $1
            AND ($2::uuid IS NULL OR pmt.distribution_id = $2)
            AND ($3::uuid IS NULL OR pmt.party_id = $3)
            AND ($4::date IS NULL OR pmt.paid_on >= $4::date)
            AND ($5::date IS NULL OR pmt.paid_on <= $5::date)
            AND ($6::text IS NULL OR pmt.payment_type = $6)
            AND ($7::date IS NULL OR (pmt.paid_on, pmt.created_at, pmt.id) < ($7::date, $8::timestamptz, $9::uuid))
          ORDER BY pmt.paid_on DESC, pmt.created_at DESC, pmt.id DESC
          LIMIT $10 OFFSET 0`,
        [businessId, distributionId, partyId, dateFrom, dateTo, paymentType, cursor?.paidOn ?? null, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1],
      ),
    ]);
    const allRows = rowsResult.rows;
    const hasMore = allRows.length > limit;
    const payments = allRows.slice(0, limit);
    const last = payments.at(-1);
    const summary = summaryResult.rows[0];
    return {
      payments,
      totalCount: safeCount(summary?.total_count ?? "0"),
      netPaidRial: summary?.net_paid_rial ?? "0",
      limit,
      hasMore,
      nextCursor: hasMore && last
        ? Buffer.from(JSON.stringify({ paidOn: last.paidOn, createdAt: last.createdAt, id: last.id, fingerprint })).toString("base64url")
        : null,
    };
  });
}

export async function loadShareholderAccountStatement(
  businessId: string,
  actor: ShareholderActor,
  accountIdValue: unknown,
  options: ShareholderEventFilters & ShareholderOffsetPageOptions = {},
): Promise<ShareholderAccountStatement> {
  requireRead(actor);
  const accountId = requireUuid(accountIdValue, "account_id");
  const partyId = optionalUuid(options.partyId, "party_id");
  const dateFrom = optionalDate(options.dateFrom, "date_from");
  const dateTo = optionalDate(options.dateTo, "date_to");
  assertDateOrder(dateFrom, dateTo);
  const limit = pageSize(options.limit);
  const offset = pageOffset(options.offset);
  return inSnapshot(async (client) => {
    const { rows: accountRows } = await client.query<{
      id: string;
      code: string;
      name: string;
      type: "asset" | "liability" | "equity" | "revenue" | "expense";
      is_contra: boolean;
    }>(
      `SELECT id, code, name, type::text AS type, is_contra
         FROM accounts
        WHERE business_id = $1 AND id = $2 AND code = ANY($3::text[])`,
      [businessId, accountId, ACCOUNT_CODES],
    );
    const account = accountRows[0];
    if (!account) throw new ShareholderError("shareholder_account_not_found", 404);
    const baseNormal: "debit" | "credit" = account.type === "asset" || account.type === "expense" ? "debit" : "credit";
    const normalBalance = account.is_contra ? (baseNormal === "debit" ? "credit" : "debit") : baseNormal;
    const summaryResult = await client.query<{
      total_count: string;
      total_debit_rial: string;
      total_credit_rial: string;
    }>(
      `WITH movements AS (
         SELECT je.id, jl.party_id, SUM(jl.debit)::numeric AS debit, SUM(jl.credit)::numeric AS credit
           FROM journal_entries je
           JOIN journal_lines jl ON jl.entry_id = je.id
          WHERE je.business_id = $1 AND jl.account_id = $2
            AND ($3::uuid IS NULL OR jl.party_id = $3)
            AND ($4::date IS NULL OR je.entry_date >= $4::date)
            AND ($5::date IS NULL OR je.entry_date <= $5::date)
          GROUP BY je.id, jl.party_id
       )
       SELECT COUNT(*)::text AS total_count, COALESCE(SUM(debit), 0)::text AS total_debit_rial,
              COALESCE(SUM(credit), 0)::text AS total_credit_rial
         FROM movements`,
      [businessId, accountId, partyId, dateFrom, dateTo],
    );
    const openingResult = await client.query<{ raw_opening_rial: string }>(
      `SELECT COALESCE(SUM(jl.debit - jl.credit), 0)::text AS raw_opening_rial
         FROM journal_entries je
         JOIN journal_lines jl ON jl.entry_id = je.id
        WHERE je.business_id = $1 AND jl.account_id = $2
          AND ($3::uuid IS NULL OR jl.party_id = $3)
          AND $4::date IS NOT NULL AND je.entry_date < $4::date`,
      [businessId, accountId, partyId, dateFrom],
    );
    const rowsResult = await client.query<{
      entry_id: string;
      voucher_number: string | null;
      date: string;
      memo: string | null;
      source_type: string | null;
      party_id: string | null;
      party_name: string | null;
      debit_rial: string;
      credit_rial: string;
      cumulative_raw_rial: string;
    }>(
      `WITH movements AS (
         SELECT je.id AS entry_id, je.voucher_number, je.entry_date::text AS date, je.memo, je.source_type,
                jl.party_id, p.name AS party_name, SUM(jl.debit)::numeric AS debit,
                SUM(jl.credit)::numeric AS credit
           FROM journal_entries je
           JOIN journal_lines jl ON jl.entry_id = je.id
           LEFT JOIN parties p ON p.id = jl.party_id AND p.business_id = je.business_id
          WHERE je.business_id = $1 AND jl.account_id = $2
            AND ($3::uuid IS NULL OR jl.party_id = $3)
            AND ($4::date IS NULL OR je.entry_date >= $4::date)
            AND ($5::date IS NULL OR je.entry_date <= $5::date)
          GROUP BY je.id, je.voucher_number, je.entry_date, je.memo, je.source_type, jl.party_id, p.name
       ), running AS (
         SELECT *, SUM(debit - credit) OVER (ORDER BY date, entry_id, party_id NULLS FIRST ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS cumulative_raw
           FROM movements
       )
       SELECT entry_id, voucher_number, date, memo, source_type, party_id, party_name,
              debit::text AS debit_rial, credit::text AS credit_rial, cumulative_raw::text AS cumulative_raw_rial
         FROM running
        ORDER BY date, entry_id, party_id NULLS FIRST
        LIMIT $6 OFFSET $7`,
      [businessId, accountId, partyId, dateFrom, dateTo, limit, offset],
    );
    const summary = summaryResult.rows[0];
    const totalCount = safeCount(summary?.total_count ?? "0");
    const rawOpening = BigInt(openingResult.rows[0]?.raw_opening_rial ?? "0");
    const sign = normalBalance === "debit" ? 1n : -1n;
    const openingBalance = rawOpening * sign;
    const totalDebit = BigInt(summary?.total_debit_rial ?? "0");
    const totalCredit = BigInt(summary?.total_credit_rial ?? "0");
    const periodMovement = (totalDebit - totalCredit) * sign;
    const lines: ShareholderAccountStatementLine[] = rowsResult.rows.map((row) => ({
      entryId: row.entry_id,
      voucherNumber: row.voucher_number,
      date: row.date,
      memo: row.memo,
      sourceType: row.source_type,
      partyId: row.party_id,
      partyName: row.party_name,
      debitRial: row.debit_rial,
      creditRial: row.credit_rial,
      balanceRial: (openingBalance + BigInt(row.cumulative_raw_rial) * sign).toString(),
    }));
    return {
      accountId: account.id,
      accountCode: account.code,
      accountName: account.name,
      normalBalance,
      partyId,
      dateFrom,
      dateTo,
      openingBalanceRial: openingBalance.toString(),
      lines,
      totalDebitRial: totalDebit.toString(),
      totalCreditRial: totalCredit.toString(),
      closingBalanceRial: (openingBalance + periodMovement).toString(),
      totalCount,
      limit,
      offset,
      nextOffset: offset + lines.length < totalCount ? offset + lines.length : null,
    };
  });
}
