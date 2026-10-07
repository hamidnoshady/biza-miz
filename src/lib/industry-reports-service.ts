/**
 * Phase 21 Wave 7 — the industry-specific reports and audit controls
 * (DB-touching): weight reconciliation for jewelry, warranty/repair
 * reporting for watch, variant-level sales analysis for accessories, and
 * an item-level audit trail shared by all three.
 *
 * Every figure here is read back from records that already exist — the
 * domain-event log, the ledger, the item tables — rather than from any
 * running total kept alongside them, the same "reconstruct, never a shadow
 * copy" rule Phase 16's reports follow. That is what makes the audit trail
 * worth anything: it is the same log the postings themselves came from.
 *
 * DB-touching, so per repo convention (see industry-reports.ts for the pure
 * rules this leans on) it has no direct unit test; covered instead by
 * integration/industry-reports.integration.test.ts.
 */
import { queryReportPage } from "./report-page-query";
import { query } from "./db";
import { isPurity, PURITIES, type Purity } from "./gold";
import { weightVariance, type WarrantyState } from "./industry-reports";

/* ------------------------------------------------------------------ *
 * Jewelry — weight reconciliation
 * ------------------------------------------------------------------ */

export interface WeightOnHand {
  purity: Purity;
  /** Grams of gold the books believe are on the shelf (net weight of every unsold weighed piece). */
  netWeight: string;
  pieces: number;
}

/** What the system believes is on hand, by purity — the "system" side of a reconciliation. */
export async function weightOnHand(locationId: string): Promise<WeightOnHand[]> {
  const { rows } = await query<{ purity: Purity; net_weight: string; pieces: string }>(
    `SELECT w.purity, COALESCE(SUM(w.net_weight), 0)::text AS net_weight, COUNT(*)::text AS pieces
       FROM item_weight_attributes w
       JOIN items i ON i.id = w.item_id
      WHERE i.location_id = $1 AND w.status <> 'sold'
      GROUP BY w.purity
      ORDER BY w.purity`,
    [locationId],
  );
  return rows.map((r) => ({ purity: r.purity, netWeight: r.net_weight, pieces: Number(r.pieces) }));
}

export interface WeightCount {
  id: string;
  countDate: string;
  purity: Purity;
  countedWeight: string;
  systemWeight: string;
  variance: string;
  variancePercent: number | null;
  notes: string | null;
  createdAt: string;
}

interface WeightCountRow extends Record<string, unknown> {
  id: string;
  count_date: string;
  purity: Purity;
  counted_weight: string;
  system_weight: string;
  notes: string | null;
  created_at: string;
}

function mapWeightCount(row: WeightCountRow): WeightCount {
  const variance = weightVariance(row.counted_weight, row.system_weight);
  return {
    id: row.id,
    countDate: row.count_date,
    purity: row.purity,
    countedWeight: row.counted_weight,
    systemWeight: row.system_weight,
    variance: variance.variance,
    variancePercent: variance.variancePercent,
    notes: row.notes,
    createdAt: row.created_at,
  };
}

const WEIGHT_COUNT_COLUMNS =
  "id, count_date::text AS count_date, purity, counted_weight, system_weight, notes, created_at";

/**
 * Records a physical scale count against what the books believed at that
 * moment. `systemWeight` is captured here, not on read: a count is evidence
 * of a discrepancy on a given day, and a figure that drifted as later sales
 * posted would be worthless as evidence (see migration 0069).
 */
export async function recordWeightCount(input: {
  locationId: string;
  purity: string;
  countedWeight: string;
  countDate?: string;
  notes?: string | null;
  createdBy?: string | null;
}): Promise<WeightCount> {
  if (!isPurity(input.purity)) throw new Error(`عیار «${input.purity}» نامعتبر است.`);
  const counted = Number(input.countedWeight);
  if (!Number.isFinite(counted) || counted < 0) {
    throw new Error("وزن شمارش‌شده باید عددی غیرمنفی باشد.");
  }

  const onHand = await weightOnHand(input.locationId);
  const systemWeight = onHand.find((row) => row.purity === input.purity)?.netWeight ?? "0";

  const { rows } = await query<WeightCountRow>(
    `INSERT INTO weight_counts (location_id, count_date, purity, counted_weight, system_weight, notes, created_by)
     VALUES ($1, COALESCE($2::date, CURRENT_DATE), $3, $4, $5, $6, $7)
     RETURNING ${WEIGHT_COUNT_COLUMNS}`,
    [
      input.locationId,
      input.countDate ?? null,
      input.purity,
      input.countedWeight,
      systemWeight,
      input.notes?.trim() || null,
      input.createdBy ?? null,
    ],
  );
  return mapWeightCount(rows[0]);
}

export async function listWeightCounts(locationId: string, limit = 50): Promise<WeightCount[]> {
  const { rows } = await query<WeightCountRow>(
    `SELECT ${WEIGHT_COUNT_COLUMNS} FROM weight_counts
      WHERE location_id = $1 ORDER BY count_date DESC, created_at DESC LIMIT $2`,
    [locationId, limit],
  );
  return rows.map(mapWeightCount);
}

/** The reconciliation board: what the books hold per purity today, alongside the most recent count of each. */
export async function weightReconciliation(locationId: string): Promise<
  {
    purity: Purity;
    systemWeight: string;
    pieces: number;
    lastCount: WeightCount | null;
  }[]
> {
  const [onHand, counts] = await Promise.all([weightOnHand(locationId), listWeightCounts(locationId)]);
  const latestByPurity = new Map<string, WeightCount>();
  for (const count of counts) {
    if (!latestByPurity.has(count.purity)) latestByPurity.set(count.purity, count);
  }

  const purities = new Set<Purity>([
    ...PURITIES.filter((p) => onHand.some((row) => row.purity === p) || latestByPurity.has(p)),
  ]);

  return [...purities].map((purity) => {
    const row = onHand.find((r) => r.purity === purity);
    return {
      purity,
      systemWeight: row?.netWeight ?? "0",
      pieces: row?.pieces ?? 0,
      lastCount: latestByPurity.get(purity) ?? null,
    };
  });
}

/* ------------------------------------------------------------------ *
 * Watch — warranty and repair reporting
 * ------------------------------------------------------------------ */

export interface WarrantyReportRow {
  serialId: string;
  serialNumber: string;
  itemName: string;
  soldAt: string | null;
  startDate: string;
  endDate: string;
  months: number;
  state: WarrantyState;
}

/** Every warranty window that has ever opened at this branch, classified against `asOfDate` (defaults to today). */
async function readWarrantyReport(locationId: string, options: { asOfDate?: string; expiringWithinDays?: number } = {}, page?: number) {
  const asOfDate = options.asOfDate ?? new Date().toISOString().slice(0, 10);
  const result = await queryReportPage<{
    serial_id: string; serial_number: string; item_name: string; sold_at: string | null;
    start_date: string; end_date: string; months: number; state: WarrantyState;
  }, Record<WarrantyState, number>>(
    `SELECT w.serial_id, s.serial_number, i.name AS item_name, s.sold_at::text AS sold_at,
            w.start_date::text AS start_date, w.end_date::text AS end_date, w.months,
            CASE WHEN $2::date < w.start_date THEN 'active'
                 WHEN $2::date > w.end_date THEN 'expired'
                 WHEN w.end_date - $2::date <= $3::double precision THEN 'expiring'
                 ELSE 'active' END AS state
       FROM serial_warranties w JOIN item_serials s ON s.id = w.serial_id
       JOIN items i ON i.id = s.item_id WHERE i.location_id = $1`,
    [locationId, asOfDate, options.expiringWithinDays ?? 30],
    { page, orderBy: "end_date, serial_id", summary: `jsonb_build_object(
      'active', count(*) FILTER (WHERE state='active'), 'expiring', count(*) FILTER (WHERE state='expiring'),
      'expired', count(*) FILTER (WHERE state='expired'), 'none', 0)` },
  );
  return { ...result, rows: result.rows.map((r): WarrantyReportRow => ({
    serialId: r.serial_id, serialNumber: r.serial_number, itemName: r.item_name, soldAt: r.sold_at,
    startDate: r.start_date, endDate: r.end_date, months: r.months, state: r.state,
  })) };
}
export async function warrantyReport(locationId: string, options: { asOfDate?: string; expiringWithinDays?: number } = {}) {
  const result = await readWarrantyReport(locationId, options);
  return { rows: result.rows, counts: result.summary };
}
export const warrantyReportPage = (locationId: string, options: { asOfDate?: string; expiringWithinDays?: number }, page: number) =>
  readWarrantyReport(locationId, options, page);

export interface RepairReportRow {
  ticketId: string;
  ticketNumber: number;
  itemDescription: string;
  status: string;
  underWarranty: boolean;
  /** Labor + parts billed, excluding VAT. */
  net: number;
  partsCost: number;
  closedAt: string | null;
}

/**
 * Repair throughput and profitability over a date window (on the ticket's
 * intake date). Margin is revenue less what the consumed parts cost —
 * negative for a warranty job, which is the honest number: the shop spent
 * parts and billed nobody.
 */
async function readRepairReport(locationId: string, options: { from?: string; to?: string } = {}, page?: number) {
  const result = await queryReportPage<{
    id: string; ticket_number: string; item_description: string; status: string; under_warranty: boolean;
    labor_charge: string; parts_charge: string | null; parts_cost: string | null; closed_at: string | null;
  }, { byStatus: Record<string, number>; totals: { revenue: number; partsCost: number; margin: number } }>(
    `SELECT t.id, t.ticket_number, t.item_description, t.status, t.under_warranty, t.labor_charge,
            (SELECT COALESCE(SUM(p.charge), 0)::text FROM repair_ticket_parts p WHERE p.ticket_id = t.id) AS parts_charge,
            (SELECT COALESCE(SUM(p.quantity * p.unit_cost), 0)::text FROM repair_ticket_parts p WHERE p.ticket_id = t.id) AS parts_cost,
            t.closed_at
       FROM repair_tickets t
      WHERE t.location_id = $1
        AND ($2::date IS NULL OR t.created_at >= $2::date)
        AND ($3::date IS NULL OR t.created_at < ($3::date + 1))
      `,
    [locationId, options.from ?? null, options.to ?? null],
    { page, orderBy: "ticket_number DESC, id", summary: `jsonb_build_object(
      'byStatus', (SELECT coalesce(jsonb_object_agg(status, n), '{}'::jsonb)
        FROM (SELECT status, count(*) AS n FROM report_source GROUP BY status) grouped),
      'totals', jsonb_build_object(
        'revenue', coalesce(sum(labor_charge::numeric + coalesce(parts_charge::numeric,0)) FILTER (WHERE status='closed'),0),
        'partsCost', coalesce(sum(floor(coalesce(parts_cost,'0')::double precision + 0.5)) FILTER (WHERE status='closed'),0),
        'margin', coalesce(sum(labor_charge::numeric + coalesce(parts_charge::numeric,0) - floor(coalesce(parts_cost,'0')::double precision + 0.5)) FILTER (WHERE status='closed'),0)))` },
  );
  return { ...result, rows: result.rows.map((r): RepairReportRow => ({
    ticketId: r.id, ticketNumber: Number(r.ticket_number), itemDescription: r.item_description,
    status: r.status, underWarranty: r.under_warranty, net: Number(r.labor_charge) + Number(r.parts_charge ?? 0),
    partsCost: Math.round(Number(r.parts_cost ?? 0)), closedAt: r.closed_at,
  })) };
}
export async function repairReport(locationId: string, options: { from?: string; to?: string } = {}) {
  const result = await readRepairReport(locationId, options);
  return { rows: result.rows, ...result.summary };
}
export const repairReportPage = (locationId: string, options: { from?: string; to?: string }, page: number) =>
  readRepairReport(locationId, options, page);

/* ------------------------------------------------------------------ *
 * Accessories — variant-level sales analysis
 * ------------------------------------------------------------------ */

/**
 * The channel-neutral sale facts both trade reports read (dashboard audit F04).
 *
 * The counter writes `{trade}.sale_revenue` / `{trade}.sale_cogs` domain events;
 * a website sale (WooCommerce / Eshobe CMS) writes one `online_sale_lines` row
 * (migration 0209) instead, because its revenue is posted by the adapter, not
 * by a posting rule. Neither path writes the other, so the union below counts
 * every sale exactly once. A voided online line (a reversed order) drops out,
 * and an online line is dated by its own `occurred_at`, not the import's.
 * `$1` business, `$2` branch, `$3`/`$4` from/to dates, `$5` trade prefix.
 */
const SALE_FACTS_CTE = `revenue AS (
        SELECT item_id, SUM(quantity_sold) AS quantity_sold, SUM(net_revenue) AS net_revenue
          FROM (
            SELECT e.source_id AS item_id,
                   (e.payload->>'quantity')::numeric AS quantity_sold,
                   (e.payload->>'net')::numeric      AS net_revenue
              FROM domain_events e
             WHERE e.business_id = $1 AND e.location_id = $2
               AND e.event_type = $5 || '.sale_revenue'
               AND ($3::date IS NULL OR e.created_at >= $3::date)
               AND ($4::date IS NULL OR e.created_at < ($4::date + 1))
            UNION ALL
            SELECT f.item_id, f.quantity, f.net_rial::numeric
              FROM online_sale_lines f
              JOIN order_items oi ON oi.id = f.order_item_id AND oi.status <> 'voided'
             WHERE f.location_id = $2 AND f.item_id IS NOT NULL
               AND ($3::date IS NULL OR f.occurred_at >= $3::date)
               AND ($4::date IS NULL OR f.occurred_at < ($4::date + 1))
          ) facts
         GROUP BY item_id
      ), cost AS (
        SELECT item_id, SUM(cogs) AS cogs
          FROM (
            SELECT e.source_id AS item_id, (e.payload->>'cost')::numeric AS cogs
              FROM domain_events e
             WHERE e.business_id = $1 AND e.location_id = $2
               AND e.event_type = $5 || '.sale_cogs'
               AND ($3::date IS NULL OR e.created_at >= $3::date)
               AND ($4::date IS NULL OR e.created_at < ($4::date + 1))
            UNION ALL
            SELECT f.item_id, (f.cogs_rial - f.restored_cogs_rial)::numeric
              FROM online_sale_lines f
              JOIN order_items oi ON oi.id = f.order_item_id AND oi.status <> 'voided'
             WHERE f.location_id = $2 AND f.item_id IS NOT NULL
               AND ($3::date IS NULL OR f.occurred_at >= $3::date)
               AND ($4::date IS NULL OR f.occurred_at < ($4::date + 1))
          ) facts
         GROUP BY item_id
      )`;

export interface VariantSalesRow {
  itemId: string;
  itemName: string;
  parentName: string | null;
  attributes: { name: string; value: string }[];
  quantitySold: string;
  netRevenue: number;
  cogs: number;
  margin: number;
}

/**
 * Which variants actually sell, read straight off the sale facts (the
 * counter's domain events plus the website's `online_sale_lines`, see
 * SALE_FACTS_CTE) rather than off any per-item counter. `eventPrefix` names which trade's
 * sale events to read (`accessory.*` or `cosmetic.*`) — one implementation,
 * because a variant sale is a variant sale whichever fungible trade wrote it.
 */
async function readVariantSalesAnalysis(
  businessId: string,
  locationId: string,
  options: { from?: string; to?: string; eventPrefix?: string } = {},
  page?: number,
) {
  const prefix = options.eventPrefix ?? "accessory";
  const result = await queryReportPage<{
    item_id: string;
    item_name: string;
    parent_name: string | null;
    attributes: { name: string; value: string }[] | null;
    quantity_sold: string;
    net_revenue: string;
    cogs: string;
  }>(
    `WITH ${SALE_FACTS_CTE}
      SELECT i.id AS item_id, i.name AS item_name, p.name AS parent_name,
             COALESCE(
               (SELECT json_agg(json_build_object('name', a.name, 'value', a.value) ORDER BY a.name)
                  FROM item_variant_attributes a WHERE a.item_id = i.id),
               '[]'::json
             ) AS attributes,
             COALESCE(r.quantity_sold, 0)::text AS quantity_sold,
             COALESCE(r.net_revenue, 0)::text   AS net_revenue,
             COALESCE(c.cogs, 0)::text          AS cogs
        FROM revenue r
        JOIN items i ON i.id = r.item_id
        LEFT JOIN items p ON p.id = i.parent_item_id
        LEFT JOIN cost c ON c.item_id = i.id
       `,
    [businessId, locationId, options.from ?? null, options.to ?? null, prefix],
    { page, orderBy: "net_revenue::numeric DESC, item_id" },
  );
  const { rows } = result;

  return { ...result, rows: rows.map((r) => {
    const netRevenue = Number(r.net_revenue);
    const cogs = Number(r.cogs);
    return {
      itemId: r.item_id,
      itemName: r.item_name,
      parentName: r.parent_name,
      attributes: r.attributes ?? [],
      quantitySold: r.quantity_sold,
      netRevenue,
      cogs,
      margin: netRevenue - cogs,
    };
  }) };
}

export async function variantSalesAnalysis(businessId: string, locationId: string, options: { from?: string; to?: string; eventPrefix?: string } = {}) {
  return (await readVariantSalesAnalysis(businessId, locationId, options)).rows;
}
export const variantSalesAnalysisPage = (businessId: string, locationId: string, options: { from?: string; to?: string; eventPrefix?: string }, page: number) =>
  readVariantSalesAnalysis(businessId, locationId, options, page);

export interface BrandSalesRow {
  brandId: string | null;
  brandName: string | null;
  quantitySold: string;
  netRevenue: number;
  cogs: number;
  margin: number;
}

/**
 * Phase 27 Wave 3 — sell-through by برند, read off the same sale events the
 * variant analysis reads, joined to the item's brand. An item with no brand
 * is grouped under «بدون برند» (brandId null) so nothing silently vanishes.
 */
async function readBrandSalesAnalysis(
  businessId: string,
  locationId: string,
  options: { from?: string; to?: string; eventPrefix?: string } = {},
  page?: number,
) {
  const prefix = options.eventPrefix ?? "cosmetic";
  const result = await queryReportPage<{
    brand_id: string | null;
    brand_name: string | null;
    quantity_sold: string;
    net_revenue: string;
    cogs: string;
  }>(
    `WITH ${SALE_FACTS_CTE}
      SELECT i.brand_id, br.name AS brand_name,
             COALESCE(SUM(r.quantity_sold), 0)::text AS quantity_sold,
             COALESCE(SUM(r.net_revenue), 0)::text   AS net_revenue,
             COALESCE(SUM(c.cogs), 0)::text          AS cogs
        FROM revenue r
        JOIN items i ON i.id = r.item_id
        LEFT JOIN item_brands br ON br.id = i.brand_id
        LEFT JOIN cost c ON c.item_id = i.id
       GROUP BY i.brand_id, br.name
       `,
    [businessId, locationId, options.from ?? null, options.to ?? null, prefix],
    { page, orderBy: "net_revenue DESC, brand_id NULLS LAST" },
  );
  const { rows } = result;

  return { ...result, rows: rows.map((r) => {
    const netRevenue = Number(r.net_revenue);
    const cogs = Number(r.cogs);
    return {
      brandId: r.brand_id,
      brandName: r.brand_name,
      quantitySold: r.quantity_sold,
      netRevenue,
      cogs,
      margin: netRevenue - cogs,
    };
  }) };
}

export async function brandSalesAnalysis(businessId: string, locationId: string, options: { from?: string; to?: string; eventPrefix?: string } = {}) {
  return (await readBrandSalesAnalysis(businessId, locationId, options)).rows;
}
export const brandSalesAnalysisPage = (businessId: string, locationId: string, options: { from?: string; to?: string; eventPrefix?: string }, page: number) =>
  readBrandSalesAnalysis(businessId, locationId, options, page);

/* ------------------------------------------------------------------ *
 * All three — item-level audit trail
 * ------------------------------------------------------------------ */

export interface ItemAuditEntry {
  id: string;
  eventType: string;
  payload: Record<string, unknown>;
  entryId: string | null;
  /** The journal entry this event posted, when it posted one — null for a recorded-but-unposted event. */
  entryDate: string | null;
  memo: string | null;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
}

/**
 * Everything that has ever happened to one high-value item, in order: its
 * intake and edits (recorded events with no ledger effect), and its sale or
 * repairs (events that posted). Reads the domain-event log directly — the
 * same rows the posting engine acted on — so an auditor is looking at the
 * record, not a summary of it.
 */
export async function itemAuditTrail(businessId: string, itemId: string): Promise<ItemAuditEntry[]> {
  const { rows } = await query<{
    id: string;
    event_type: string;
    payload: Record<string, unknown>;
    entry_id: string | null;
    entry_date: string | null;
    memo: string | null;
    created_by: string | null;
    created_by_name: string | null;
    created_at: string;
  }>(
    `SELECT e.id, e.event_type, e.payload, e.entry_id, je.entry_date::text AS entry_date, je.memo,
            e.created_by, u.full_name AS created_by_name, e.created_at
       FROM domain_events e
       LEFT JOIN journal_entries je ON je.id = e.entry_id
       LEFT JOIN users u ON u.id = e.created_by
      WHERE e.business_id = $1
        AND (e.source_id = $2 OR e.payload->>'itemId' = $2::text OR e.payload->>'serialId' = $2::text)
      ORDER BY e.created_at`,
    [businessId, itemId],
  );

  return rows.map((r) => ({
    id: r.id,
    eventType: r.event_type,
    payload: r.payload ?? {},
    entryId: r.entry_id,
    entryDate: r.entry_date,
    memo: r.memo,
    createdBy: r.created_by,
    createdByName: r.created_by_name,
    createdAt: r.created_at,
  }));
}
