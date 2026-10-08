/**
 * Fixed-asset register, depreciation and lifecycle — the DB-touching part.
 * Pure math lives in depreciation.ts (validateFixedAsset,
 * depreciationForPeriod[,UnderRevision], planDepreciation, disposalOutcome)
 * and is what depreciation.test.ts covers.
 *
 * Issue #833's accounting-integrity rules, all enforced here in the service
 * layer (the UI only reflects them):
 *
 *   * every decision that determines an amount is read inside one
 *     transaction, after `SELECT … FOR UPDATE` on the asset row — posting,
 *     reversal, disposal, estimate change, transfer and deletion all
 *     serialise on that lock, so concurrent requests can neither
 *     over-depreciate nor delete history out from under a posting;
 *   * a journal entry an asset caused is posted to *the asset's own*
 *     location, never the operator's currently active branch;
 *   * posted accounting history is never destroyed: depreciation entries are
 *     reversed (marked, mirrored in the ledger), not deleted, and the
 *     database backs it with ON DELETE RESTRICT;
 *   * the posting identity is canonical — (source_type, source_id,
 *     posting_kind) with the stable kinds `depreciation`, `reversal` and
 *     `disposal` — so the ledger's uniqueness index is a second wall behind
 *     the canonical Jalali month key;
 *   * accumulatedDepreciation/bookValue are always reconstructed from
 *     *live* depreciation rows (reversed_at IS NULL) — never a shadow column
 *     on the asset row — the same discipline ar-service.ts/ap-service.ts
 *     already use for their control-account balances.
 *
 * `finance.assets_manage` is, deliberately, the one capability that both
 * reads and lets a member mutate this register, including the controlled
 * auto-postings (depreciation, reversal, disposal). It is the permission the
 * routes check; the UI mirrors it as a capability prop so a ledger-only
 * member never sees a live button the API would 403.
 */
import type { PoolClient } from "pg";
import { getPool, query } from "./db";
import { accountIdsByCode, postExactMirrorEntry, postJournalEntry } from "./ledger-service";
import { WELL_KNOWN_CODES } from "./coa-template";
import { businessToday } from "./business-day-service";
import { isValidIsoDate } from "./jalali";
import {
  depreciationPeriodOfDate,
  disposalOutcome,
  parseDepreciationPeriodKey,
  FIXED_ASSET_SERIAL_MAX_LENGTH,
  FIXED_ASSET_USEFUL_LIFE_MAX_MONTHS,
  planDepreciation,
  reconcileFixedAssetRegister,
  validateFixedAsset,
  type DepreciationRevision,
  type FixedAssetReconciliation,
} from "./depreciation";
import type { SheetData } from "./data-transfer/codecs";

export class FixedAssetError extends Error {
  status: number;
  constructor(code: string, status = 400) {
    super(code);
    this.status = status;
  }
}

export type FixedAssetStatus = "active" | "disposed";
export type FixedAssetDisposalKind = "sale" | "retirement" | "write_off";
export type FixedAssetAcquisitionSource = "journal" | "opening_balance" | "unlinked";
const ACQUISITION_SOURCES: ReadonlySet<string> = new Set(["journal", "opening_balance", "unlinked"]);
const DISPOSAL_KINDS: ReadonlySet<string> = new Set(["sale", "retirement", "write_off"]);

/** Field caps shared with the routes (issue #833 — validation hardening). */
export const FIXED_ASSET_CODE_MAX_LENGTH = 40;
export const FIXED_ASSET_CATEGORY_MAX_LENGTH = 100;
export const FIXED_ASSET_REFERENCE_MAX_LENGTH = 120;
export const FIXED_ASSET_NOTES_MAX_LENGTH = 2000;
export const FIXED_ASSET_IDEMPOTENCY_KEY_MAX_LENGTH = 200;
export const FIXED_ASSET_REASON_MAX_LENGTH = 500;

export interface FixedAsset {
  id: string;
  /** Stable per-business tag, e.g. `FA-0042`; auto-assigned when not given. */
  code: string | null;
  name: string;
  acquisitionDate: string;
  /** When depreciation may start; the purchase date unless set. */
  inServiceDate: string;
  /** Where the cost sits in the books — see migration 0210. */
  acquisitionSource: FixedAssetAcquisitionSource;
  acquisitionEntryId: string | null;
  cost: number;
  salvageValue: number;
  usefulLifeMonths: number;
  accumulatedDepreciation: number;
  bookValue: number;
  createdAt: string;
  depreciationCount?: number;
  locationId?: string | null;
  locationName?: string | null;
  category?: string | null;
  serialNumber?: string | null;
  vendorPartyId?: string | null;
  vendorName?: string | null;
  custodianPartyId?: string | null;
  custodianName?: string | null;
  purchaseReference?: string | null;
  notes?: string | null;
  /** The fixed-asset account this asset's cost is classified under. */
  assetAccountId?: string | null;
  assetAccountCode?: string | null;
  status: FixedAssetStatus;
  disposalKind?: FixedAssetDisposalKind | null;
  disposalDate?: string | null;
  disposalProceeds?: number | null;
  disposalJournalEntryId?: string | null;
  disposalReason?: string | null;
  archivedAt?: string | null;
  /** Derived, never stored: the live entries consumed the depreciable base. */
  fullyDepreciated?: boolean;
}

export interface FixedAssetDepreciationEntry {
  id: string;
  fixedAssetId: string;
  /** Jalali `YYYY-MM`; null for an entry posted before migration 0210. */
  periodKey: string | null;
  periodLabel: string;
  entryDate: string;
  amount: number;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
  journalEntryId: string | null;
  /** The branch the journal entry was posted to (the asset's own at the time). */
  postingLocationName?: string | null;
  reversedAt?: string | null;
  reversedByName?: string | null;
  reversalReason?: string | null;
  reversalJournalEntryId?: string | null;
}

export interface FixedAssetTransfer {
  id: string;
  fromLocationId: string | null;
  fromLocationName: string | null;
  toLocationId: string | null;
  toLocationName: string | null;
  effectiveDate: string;
  reason: string;
  transferredByName: string | null;
  createdAt: string;
}

export interface FixedAssetEstimateChange {
  id: string;
  changedAt: string;
  effectivePeriodKey: string;
  oldUsefulLifeMonths: number;
  newUsefulLifeMonths: number;
  oldSalvageValue: number;
  newSalvageValue: number;
  remainingLifeMonths: number;
  remainingBase: number;
  reason: string;
  changedByName: string | null;
}

interface FixedAssetRow extends Record<string, unknown> {
  id: string;
  code: string | null;
  name: string;
  acquisition_date: string;
  in_service_date: string;
  acquisition_source: FixedAssetAcquisitionSource;
  acquisition_entry_id: string | null;
  cost: string;
  salvage_value: string;
  useful_life_months: number;
  created_at: string;
  depreciation_count?: number;
  location_id?: string | null;
  location_name?: string | null;
  category?: string | null;
  serial_number?: string | null;
  vendor_party_id?: string | null;
  vendor_name?: string | null;
  custodian_party_id?: string | null;
  custodian_name?: string | null;
  purchase_reference?: string | null;
  notes?: string | null;
  asset_account_id?: string | null;
  asset_account_code?: string | null;
  status: FixedAssetStatus;
  disposal_kind: FixedAssetDisposalKind | null;
  disposal_date: string | null;
  disposal_proceeds: string | null;
  disposal_journal_entry_id: string | null;
  disposal_reason: string | null;
  archived_at: string | null;
}

// One SELECT of the register with every dimension the page, the filters and
// the export need. The accumulated depreciation and posted-period count come
// from a LATERAL over *live* rows only (reversed_at IS NULL) — a reversal
// restores the schedule, it does not leave a hole in it.
const FIXED_ASSET_FROM = `
    FROM fixed_assets fa
    LEFT JOIN locations l ON l.id = fa.location_id
    LEFT JOIN parties vp ON vp.id = fa.vendor_party_id
    LEFT JOIN parties cp ON cp.id = fa.custodian_party_id
    LEFT JOIN accounts aa ON aa.id = fa.asset_account_id
    LEFT JOIN LATERAL (
      SELECT SUM(d.amount) AS accumulated, COUNT(d.id) AS periods
        FROM fixed_asset_depreciation_entries d
       WHERE d.fixed_asset_id = fa.id AND d.reversed_at IS NULL
    ) live ON true`;

const FIXED_ASSET_SELECT = `
  SELECT fa.id, fa.code, fa.location_id, l.name AS location_name, fa.name,
         fa.category, fa.serial_number, fa.purchase_reference, fa.notes,
         fa.vendor_party_id, vp.name AS vendor_name,
         fa.custodian_party_id, cp.name AS custodian_name,
         fa.asset_account_id, aa.code AS asset_account_code,
         fa.acquisition_date::text AS acquisition_date,
         COALESCE(fa.in_service_date, fa.acquisition_date)::text AS in_service_date,
         fa.acquisition_source, fa.acquisition_entry_id, fa.cost::text AS cost,
         fa.salvage_value::text AS salvage_value, fa.useful_life_months, fa.created_at::text AS created_at,
         fa.status, fa.disposal_kind, fa.disposal_date::text AS disposal_date,
         fa.disposal_proceeds::text AS disposal_proceeds, fa.disposal_journal_entry_id,
         fa.disposal_reason, fa.archived_at::text AS archived_at,
         COALESCE(live.accumulated, 0)::text AS accumulated_depreciation,
         COALESCE(live.periods, 0)::int AS depreciation_count${FIXED_ASSET_FROM}`;

function toFixedAsset(r: FixedAssetRow): FixedAsset {
  const cost = Number(r.cost);
  const accumulatedDepreciation = Number(r.accumulated_depreciation);
  const salvageValue = Number(r.salvage_value);
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    acquisitionDate: r.acquisition_date,
    inServiceDate: r.in_service_date,
    acquisitionSource: r.acquisition_source,
    acquisitionEntryId: r.acquisition_entry_id,
    cost,
    salvageValue,
    usefulLifeMonths: r.useful_life_months,
    accumulatedDepreciation,
    bookValue: cost - accumulatedDepreciation,
    createdAt: r.created_at,
    depreciationCount: Number(r.depreciation_count ?? 0),
    locationId: (r.location_id as string) ?? null,
    locationName: (r.location_name as string) ?? null,
    category: r.category ?? null,
    serialNumber: r.serial_number ?? null,
    vendorPartyId: (r.vendor_party_id as string) ?? null,
    vendorName: r.vendor_name ?? null,
    custodianPartyId: (r.custodian_party_id as string) ?? null,
    custodianName: r.custodian_name ?? null,
    purchaseReference: r.purchase_reference ?? null,
    notes: r.notes ?? null,
    assetAccountId: (r.asset_account_id as string) ?? null,
    assetAccountCode: r.asset_account_code ?? null,
    status: r.status,
    disposalKind: r.disposal_kind ?? null,
    disposalDate: r.disposal_date ?? null,
    disposalProceeds: r.disposal_proceeds === null ? null : Number(r.disposal_proceeds),
    disposalJournalEntryId: r.disposal_journal_entry_id ?? null,
    disposalReason: r.disposal_reason ?? null,
    archivedAt: r.archived_at ?? null,
    fullyDepreciated: accumulatedDepreciation >= cost - salvageValue,
  };
}

// ---------------------------------------------------------------------------
// Listing — server-side filters, pagination and KPIs (issue #833: the browser
// must not load the whole register to search it, and the totals it shows must
// be the server's, not one page's).
// ---------------------------------------------------------------------------

export interface FixedAssetListFilters {
  search?: string | null;
  status?: "active" | "disposed" | "archived" | null;
  /**
   * none = nothing posted yet; partial = some; fully = depreciable base
   * consumed; open = the complement of fully (nothing or something posted,
   * base not yet consumed) — what the register's «در جریان» chip means.
   */
  depreciationState?: "none" | "partial" | "fully" | "open" | null;
  category?: string | null;
  locationId?: string | null;
  /** Acquisition-date range, ISO. */
  dateFrom?: string | null;
  dateTo?: string | null;
  /** Archived assets are housekeeping-noise; they appear only when asked for. */
  includeArchived?: boolean;
  sortBy?: "date_desc" | "date_asc" | "cost_desc" | "book_value_desc" | null;
  limit?: number | null;
  offset?: number | null;
}

export interface FixedAssetKpis {
  count: number;
  totalCost: number;
  totalAccumulatedDepreciation: number;
  totalBookValue: number;
  activeCount: number;
  fullyDepreciatedCount: number;
  disposedCount: number;
}

function fixedAssetWhere(filters: FixedAssetListFilters): { clause: string; params: unknown[] } {
  const conditions: string[] = ["fa.business_id = $1"];
  const params: unknown[] = [null];
  const push = (value: unknown) => `$${params.push(value)}`;
  const search = filters.search?.trim();
  if (search) {
    const like = `%${search}%`;
    conditions.push(
      `(fa.name ILIKE ${push(like)} OR fa.code ILIKE ${push(like)} OR fa.serial_number ILIKE ${push(like)} OR l.name ILIKE ${push(like)} OR vp.name ILIKE ${push(like)})`,
    );
  }
  if (filters.status === "archived") conditions.push("fa.archived_at IS NOT NULL");
  else {
    if (filters.status) conditions.push(`fa.status = ${push(filters.status)}`);
    if (!filters.includeArchived) conditions.push("fa.archived_at IS NULL");
  }
  if (filters.category) conditions.push(`fa.category = ${push(filters.category)}`);
  if (filters.locationId) conditions.push(`fa.location_id = ${push(filters.locationId)}`);
  if (filters.dateFrom) conditions.push(`fa.acquisition_date >= ${push(filters.dateFrom)}::date`);
  if (filters.dateTo) conditions.push(`fa.acquisition_date <= ${push(filters.dateTo)}::date`);
  if (filters.depreciationState === "none") {
    conditions.push("COALESCE(live.periods, 0) = 0");
  } else if (filters.depreciationState === "fully") {
    conditions.push("COALESCE(live.accumulated, 0) >= fa.cost - fa.salvage_value");
  } else if (filters.depreciationState === "partial") {
    conditions.push(
      "COALESCE(live.periods, 0) > 0 AND COALESCE(live.accumulated, 0) < fa.cost - fa.salvage_value",
    );
  } else if (filters.depreciationState === "open") {
    conditions.push("COALESCE(live.accumulated, 0) < fa.cost - fa.salvage_value");
  }
  return { clause: conditions.join(" AND "), params };
}

function fixedAssetOrderBy(sortBy: FixedAssetListFilters["sortBy"]): string {
  switch (sortBy) {
    case "date_asc":
      return "ORDER BY fa.acquisition_date ASC, fa.created_at ASC";
    case "cost_desc":
      return "ORDER BY fa.cost DESC, fa.created_at DESC";
    case "book_value_desc":
      return "ORDER BY (fa.cost - COALESCE(live.accumulated, 0)) DESC, fa.created_at DESC";
    default:
      return "ORDER BY fa.acquisition_date DESC, fa.created_at DESC";
  }
}

export const FIXED_ASSET_PAGE_DEFAULT_LIMIT = 50;
export const FIXED_ASSET_PAGE_MAX_LIMIT = 200;

export async function listFixedAssetsPage(
  businessId: string,
  filters: FixedAssetListFilters = {},
): Promise<{ assets: FixedAsset[]; hasMore: boolean; kpis: FixedAssetKpis }> {
  const { clause, params } = fixedAssetWhere(filters);
  params[0] = businessId;
  const limit = Math.min(
    Number.isInteger(filters.limit) && (filters.limit as number) > 0
      ? (filters.limit as number)
      : FIXED_ASSET_PAGE_DEFAULT_LIMIT,
    FIXED_ASSET_PAGE_MAX_LIMIT,
  );
  const offset = Number.isInteger(filters.offset) && (filters.offset as number) >= 0 ? (filters.offset as number) : 0;

  // limit + 1 rows, so hasMore is a fact the database stated.
  const { rows } = await query<FixedAssetRow & Record<string, unknown>>(
    `${FIXED_ASSET_SELECT} WHERE ${clause} ${fixedAssetOrderBy(filters.sortBy)} LIMIT ${limit + 1} OFFSET ${offset}`,
    params,
  );
  const hasMore = rows.length > limit;

  const { rows: totals } = await query<{
    count: number;
    total_cost: string;
    total_accumulated: string;
    total_book_value: string;
    active_count: number;
    fully_depreciated_count: number;
    disposed_count: number;
  }>(
    `SELECT count(*)::int AS count,
            COALESCE(SUM(fa.cost), 0)::text AS total_cost,
            COALESCE(SUM(COALESCE(live.accumulated, 0)), 0)::text AS total_accumulated,
            COALESCE(SUM(fa.cost - COALESCE(live.accumulated, 0)), 0)::text AS total_book_value,
            count(*) FILTER (WHERE fa.status = 'active' AND COALESCE(live.accumulated, 0) < fa.cost - fa.salvage_value)::int AS active_count,
            count(*) FILTER (WHERE fa.status = 'active' AND COALESCE(live.accumulated, 0) >= fa.cost - fa.salvage_value)::int AS fully_depreciated_count,
            count(*) FILTER (WHERE fa.status = 'disposed')::int AS disposed_count
       FROM fixed_assets fa
       LEFT JOIN locations l ON l.id = fa.location_id
       LEFT JOIN parties vp ON vp.id = fa.vendor_party_id
       LEFT JOIN LATERAL (
         SELECT SUM(d.amount) AS accumulated, COUNT(d.id) AS periods
           FROM fixed_asset_depreciation_entries d
          WHERE d.fixed_asset_id = fa.id AND d.reversed_at IS NULL
       ) live ON true
      WHERE ${clause}`,
    params,
  );
  const t = totals[0];
  return {
    assets: rows.slice(0, limit).map(toFixedAsset),
    hasMore,
    kpis: {
      count: t.count,
      totalCost: Number(t.total_cost),
      totalAccumulatedDepreciation: Number(t.total_accumulated),
      totalBookValue: Number(t.total_book_value),
      activeCount: t.active_count,
      fullyDepreciatedCount: t.fully_depreciated_count,
      disposedCount: t.disposed_count,
    },
  };
}

/** The whole register, unpaginated — for the tests and internal roll-ups. */
export async function listFixedAssets(businessId: string): Promise<FixedAsset[]> {
  const all: FixedAsset[] = [];
  let offset = 0;
  for (;;) {
    const { assets } = await listFixedAssetsPage(businessId, { limit: FIXED_ASSET_PAGE_MAX_LIMIT, offset });
    all.push(...assets);
    if (assets.length < FIXED_ASSET_PAGE_MAX_LIMIT) break;
    offset += assets.length;
  }
  return all;
}

// ---------------------------------------------------------------------------
// One asset, with its full history — depreciation (and each entry's reversal
// state), transfers and estimate changes. Nothing is inferred from memo text:
// every journal link is the stored source identity.
// ---------------------------------------------------------------------------

export async function getFixedAssetWithDepreciation(
  businessId: string,
  id: string,
): Promise<{
  fixedAsset: FixedAsset;
  depreciationEntries: FixedAssetDepreciationEntry[];
  transfers: FixedAssetTransfer[];
  estimateChanges: FixedAssetEstimateChange[];
}> {
  const { rows } = await query<FixedAssetRow>(
    `${FIXED_ASSET_SELECT} WHERE fa.business_id = $1 AND fa.id = $2`,
    [businessId, id],
  );
  if (!rows[0]) throw new FixedAssetError("fixed_asset_not_found", 404);

  const { rows: entries } = await query<{
    id: string;
    fixed_asset_id: string;
    period_key: string | null;
    period_label: string;
    entry_date: string;
    amount: string;
    created_by: string | null;
    created_by_name: string | null;
    created_at: string;
    journal_entry_id: string | null;
    posting_location_name: string | null;
    reversed_at: string | null;
    reversed_by_name: string | null;
    reversal_reason: string | null;
    reversal_journal_entry_id: string | null;
  }>(
    `SELECT d.id, d.fixed_asset_id, d.period_key, d.period_label, d.entry_date::text AS entry_date,
            d.amount::text AS amount, d.created_by, u.full_name AS created_by_name,
            d.created_at::text AS created_at, je.id AS journal_entry_id,
            jl.name AS posting_location_name,
            d.reversed_at::text AS reversed_at, ru.full_name AS reversed_by_name,
            d.reversal_reason, rje.id AS reversal_journal_entry_id
       FROM fixed_asset_depreciation_entries d
       JOIN fixed_assets fa ON fa.id = d.fixed_asset_id
       LEFT JOIN users u ON u.id = d.created_by
       LEFT JOIN users ru ON ru.id = d.reversed_by
       LEFT JOIN journal_entries je
         ON je.source_type = 'fixed_asset_depreciation' AND je.source_id = d.id AND je.reverses_entry_id IS NULL
       LEFT JOIN locations jl ON jl.id = je.location_id
       LEFT JOIN journal_entries rje ON rje.id = d.reversal_journal_entry_id
      WHERE fa.business_id = $1 AND d.fixed_asset_id = $2
      ORDER BY d.entry_date DESC, d.created_at DESC`,
    [businessId, id],
  );

  const { rows: transfers } = await query<{
    id: string;
    from_location_id: string | null;
    from_location_name: string | null;
    to_location_id: string | null;
    to_location_name: string | null;
    effective_date: string;
    reason: string;
    transferred_by_name: string | null;
    created_at: string;
  }>(
    `SELECT t.id, t.from_location_id, fl.name AS from_location_name, t.to_location_id,
            tl.name AS to_location_name, t.effective_date::text AS effective_date, t.reason,
            u.full_name AS transferred_by_name, t.created_at::text AS created_at
       FROM fixed_asset_transfers t
       JOIN fixed_assets fa ON fa.id = t.fixed_asset_id
       LEFT JOIN locations fl ON fl.id = t.from_location_id
       LEFT JOIN locations tl ON tl.id = t.to_location_id
       LEFT JOIN users u ON u.id = t.transferred_by
      WHERE fa.business_id = $1 AND t.fixed_asset_id = $2
      ORDER BY t.created_at DESC`,
    [businessId, id],
  );

  const { rows: changes } = await query<{
    id: string;
    changed_at: string;
    effective_period_key: string;
    old_useful_life_months: number;
    new_useful_life_months: number;
    old_salvage_value: string;
    new_salvage_value: string;
    remaining_life_months: number;
    remaining_base: string;
    reason: string;
    changed_by_name: string | null;
  }>(
    `SELECT c.id, c.changed_at::text AS changed_at, c.effective_period_key,
            c.old_useful_life_months, c.new_useful_life_months,
            c.old_salvage_value::text AS old_salvage_value, c.new_salvage_value::text AS new_salvage_value,
            c.remaining_life_months, c.remaining_base::text AS remaining_base, c.reason,
            u.full_name AS changed_by_name
       FROM fixed_asset_estimate_changes c
       JOIN fixed_assets fa ON fa.id = c.fixed_asset_id
       LEFT JOIN users u ON u.id = c.changed_by
      WHERE fa.business_id = $1 AND c.fixed_asset_id = $2
      ORDER BY c.created_at DESC`,
    [businessId, id],
  );

  return {
    fixedAsset: toFixedAsset(rows[0]),
    depreciationEntries: entries.map((e) => ({
      id: e.id,
      fixedAssetId: e.fixed_asset_id,
      periodKey: e.period_key,
      periodLabel: e.period_label,
      entryDate: e.entry_date,
      amount: Number(e.amount),
      createdBy: e.created_by,
      createdByName: e.created_by_name,
      createdAt: e.created_at,
      journalEntryId: e.journal_entry_id,
      postingLocationName: e.posting_location_name,
      reversedAt: e.reversed_at,
      reversedByName: e.reversed_by_name,
      reversalReason: e.reversal_reason,
      reversalJournalEntryId: e.reversal_journal_entry_id,
    })),
    transfers: transfers.map((t) => ({
      id: t.id,
      fromLocationId: t.from_location_id,
      fromLocationName: t.from_location_name,
      toLocationId: t.to_location_id,
      toLocationName: t.to_location_name,
      effectiveDate: t.effective_date,
      reason: t.reason,
      transferredByName: t.transferred_by_name,
      createdAt: t.created_at,
    })),
    estimateChanges: changes.map((c) => ({
      id: c.id,
      changedAt: c.changed_at,
      effectivePeriodKey: c.effective_period_key,
      oldUsefulLifeMonths: c.old_useful_life_months,
      newUsefulLifeMonths: c.new_useful_life_months,
      oldSalvageValue: Number(c.old_salvage_value),
      newSalvageValue: Number(c.new_salvage_value),
      remainingLifeMonths: c.remaining_life_months,
      remainingBase: Number(c.remaining_base),
      reason: c.reason,
      changedByName: c.changed_by_name,
    })),
  };
}

// ---------------------------------------------------------------------------
// Create — with idempotency, master data and affinity guards.
// ---------------------------------------------------------------------------

export async function createFixedAsset(params: {
  businessId: string;
  locationId: string | null;
  name: string;
  acquisitionDate: string;
  inServiceDate?: string | null;
  cost: number;
  salvageValue: number;
  usefulLifeMonths: number;
  acquisitionSource?: FixedAssetAcquisitionSource;
  acquisitionEntryId?: string | null;
  createdBy: string | null;
  /** Repeat-safe create: the same key returns the original asset (issue #833). */
  idempotencyKey?: string | null;
  code?: string | null;
  category?: string | null;
  serialNumber?: string | null;
  vendorPartyId?: string | null;
  custodianPartyId?: string | null;
  purchaseReference?: string | null;
  notes?: string | null;
  assetAccountId?: string | null;
}): Promise<FixedAsset> {
  const errors = validateFixedAsset(params);
  if (errors.length > 0) throw new FixedAssetError(errors.join(" "));
  const link = normaliseAcquisitionLink(params.acquisitionSource, params.acquisitionEntryId);
  const inServiceDate = params.inServiceDate?.trim() || null;

  const code = params.code?.trim() || null;
  if (code && code.length > FIXED_ASSET_CODE_MAX_LENGTH) throw new FixedAssetError("fixed_asset_code_too_long");
  const category = params.category?.trim() || null;
  if (category && category.length > FIXED_ASSET_CATEGORY_MAX_LENGTH) throw new FixedAssetError("fixed_asset_category_too_long");
  const serialNumber = params.serialNumber?.trim() || null;
  if (serialNumber && serialNumber.length > FIXED_ASSET_SERIAL_MAX_LENGTH) {
    throw new FixedAssetError("fixed_asset_serial_too_long");
  }
  const purchaseReference = params.purchaseReference?.trim() || null;
  if (purchaseReference && purchaseReference.length > FIXED_ASSET_REFERENCE_MAX_LENGTH) {
    throw new FixedAssetError("fixed_asset_reference_too_long");
  }
  const notes = params.notes?.trim() || null;
  if (notes && notes.length > FIXED_ASSET_NOTES_MAX_LENGTH) throw new FixedAssetError("fixed_asset_notes_too_long");
  const idempotencyKey = params.idempotencyKey?.trim() || null;
  if (idempotencyKey && idempotencyKey.length > FIXED_ASSET_IDEMPOTENCY_KEY_MAX_LENGTH) {
    throw new FixedAssetError("idempotency_key_too_long");
  }

  const client = await getPool().connect();
  let id: string;
  try {
    await client.query("BEGIN");
    if (idempotencyKey) {
      const { rows: existing } = await client.query<{ id: string }>(
        `SELECT id FROM fixed_assets WHERE business_id = $1 AND idempotency_key = $2`,
        [params.businessId, idempotencyKey],
      );
      if (existing[0]) {
        await client.query("COMMIT");
        return (await getFixedAssetWithDepreciation(params.businessId, existing[0].id)).fixedAsset;
      }
    }
    // Composite reference guards (issue #833): a typed id is checked against
    // the business before any RLS policy on a reader would hide the row. The
    // database has its own triggers; this is the clean domain error.
    if (params.locationId) await assertLocationOfBusiness(client, params.businessId, params.locationId);
    if (params.vendorPartyId) await assertPartyOfBusiness(client, params.businessId, params.vendorPartyId, "vendor_not_found");
    if (params.custodianPartyId) {
      await assertPartyOfBusiness(client, params.businessId, params.custodianPartyId, "custodian_not_found");
    }
    if (params.assetAccountId) await assertAssetAccountOfBusiness(client, params.businessId, params.assetAccountId);
    if (link.entryId) await assertAcquisitionEntryCovers(client, params.businessId, link.entryId, params.cost, null);

    // The stable tag: FA-#### per business. The business row's lock serialises
    // tag allocation, so two assets can never be handed the same number.
    let allocatedCode = code;
    if (!allocatedCode) {
      await client.query("SELECT id FROM businesses WHERE id = $1 FOR UPDATE", [params.businessId]);
      const { rows: numbered } = await client.query<{ next: number }>(
        `SELECT COALESCE(MAX((regexp_replace(code, '^FA-', ''))::int), 0) + 1 AS next
           FROM fixed_assets
          WHERE business_id = $1 AND code ~ '^FA-[0-9]+$'`,
        [params.businessId],
      );
      allocatedCode = `FA-${String(numbered[0].next).padStart(4, "0")}`;
    }

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO fixed_assets
         (business_id, location_id, name, acquisition_date, in_service_date, cost, salvage_value,
          useful_life_months, acquisition_source, acquisition_entry_id, created_by,
          code, category, serial_number, vendor_party_id, custodian_party_id,
          purchase_reference, notes, asset_account_id, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
       RETURNING id`,
      [
        params.businessId,
        params.locationId,
        params.name.trim(),
        params.acquisitionDate,
        inServiceDate,
        params.cost,
        params.salvageValue,
        params.usefulLifeMonths,
        link.source,
        link.entryId,
        params.createdBy,
        allocatedCode,
        category,
        serialNumber,
        params.vendorPartyId ?? null,
        params.custodianPartyId ?? null,
        purchaseReference,
        notes,
        params.assetAccountId ?? null,
        idempotencyKey,
      ],
    );
    id = rows[0].id;
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    // A concurrent create with the same key: the loser of the race returns
    // the winner's asset — one machine, one register row.
    if (isUniqueViolation(err)) {
      const constraint = (err as { constraint?: string }).constraint;
      if (constraint === "uq_fixed_assets_idempotency_key" && idempotencyKey) {
        const { rows } = await query<{ id: string }>(
          `SELECT id FROM fixed_assets WHERE business_id = $1 AND idempotency_key = $2`,
          [params.businessId, idempotencyKey],
        );
        if (rows[0]) return (await getFixedAssetWithDepreciation(params.businessId, rows[0].id)).fixedAsset;
      }
      if (constraint === "uq_fixed_assets_code") throw new FixedAssetError("fixed_asset_code_taken", 409);
    }
    throw err;
  } finally {
    client.release();
  }
  return (await getFixedAssetWithDepreciation(params.businessId, id)).fixedAsset;
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err as { code?: string }).code === "23505";
}

async function assertLocationOfBusiness(client: PoolClient, businessId: string, locationId: string): Promise<void> {
  const { rows } = await client.query(
    `SELECT 1 FROM locations WHERE id = $2 AND business_id = $1 AND is_active`,
    [businessId, locationId],
  );
  if (!rows[0]) throw new FixedAssetError("location_not_found", 404);
}

async function assertPartyOfBusiness(
  client: PoolClient,
  businessId: string,
  partyId: string,
  error: string,
): Promise<void> {
  const { rows } = await client.query(`SELECT 1 FROM parties WHERE id = $2 AND business_id = $1`, [
    businessId,
    partyId,
  ]);
  if (!rows[0]) throw new FixedAssetError(error, 404);
}

/**
 * The fixed-asset accounts are the 1500–1599 asset block (and numeric
 * extensions such as 150001); accumulated depreciation is the contra part of
 * it (`is_contra`, or 1510 and its extensions for a chart that predates the
 * flag). One definition, used by the link check, the candidate list and the
 * reconciliation.
 */
const FIXED_ASSET_ACCOUNT_SQL = `a.type = 'asset' AND a.code ~ '^15[0-9]{2}[0-9]*$'`;
const ACCUMULATED_ACCOUNT_SQL = `(a.is_contra OR a.code ~ '^1510[0-9]*$')`;

async function assertAssetAccountOfBusiness(
  client: PoolClient,
  businessId: string,
  accountId: string,
): Promise<void> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT a.id FROM accounts a
      WHERE a.id = $2 AND a.business_id = $1 AND a.is_active
        AND ${FIXED_ASSET_ACCOUNT_SQL} AND NOT ${ACCUMULATED_ACCOUNT_SQL}`,
    [businessId, accountId],
  );
  if (!rows[0]) throw new FixedAssetError("invalid_asset_account");
}

function normaliseAcquisitionLink(
  source: string | undefined,
  entryId: string | null | undefined,
): { source: FixedAssetAcquisitionSource; entryId: string | null } {
  const resolved = source ?? (entryId ? "journal" : "unlinked");
  if (!ACQUISITION_SOURCES.has(resolved)) throw new FixedAssetError("invalid_acquisition_source");
  if (resolved === "journal") {
    if (!entryId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(entryId)) {
      throw new FixedAssetError("acquisition_entry_required");
    }
    return { source: "journal", entryId };
  }
  return { source: resolved as FixedAssetAcquisitionSource, entryId: null };
}

/**
 * An acquisition link is refused unless the entry is this business's, still
 * stands (neither a reversal nor reversed), and debits the fixed-asset
 * accounts with at least this asset's cost on top of what other assets linked
 * to the same entry already claim. The entry row is locked so two assets
 * cannot both claim its last Rial.
 */
async function assertAcquisitionEntryCovers(
  client: PoolClient,
  businessId: string,
  entryId: string,
  cost: number,
  excludeAssetId: string | null,
): Promise<void> {
  const { rows } = await client.query<{ reverses_entry_id: string | null }>(
    `SELECT reverses_entry_id FROM journal_entries WHERE business_id = $1 AND id = $2 FOR UPDATE`,
    [businessId, entryId],
  );
  if (!rows[0]) throw new FixedAssetError("acquisition_entry_not_found", 404);
  const { rows: cover } = await client.query<{ reversed: boolean; debited: string; claimed: string }>(
    `SELECT
       EXISTS (SELECT 1 FROM journal_entries r WHERE r.business_id = $1 AND r.reverses_entry_id = $2) AS reversed,
       (SELECT COALESCE(SUM(l.debit - l.credit), 0) FROM journal_lines l JOIN accounts a ON a.id = l.account_id
         WHERE l.entry_id = $2 AND ${FIXED_ASSET_ACCOUNT_SQL} AND NOT ${ACCUMULATED_ACCOUNT_SQL})::text AS debited,
       (SELECT COALESCE(SUM(fa.cost), 0) FROM fixed_assets fa
         WHERE fa.business_id = $1 AND fa.acquisition_entry_id = $2
           AND ($3::uuid IS NULL OR fa.id <> $3::uuid))::text AS claimed`,
    [businessId, entryId, excludeAssetId],
  );
  if (rows[0].reverses_entry_id || cover[0].reversed) throw new FixedAssetError("acquisition_entry_reversed", 409);
  if (BigInt(cover[0].debited) - BigInt(cover[0].claimed) < BigInt(cost)) {
    throw new FixedAssetError("acquisition_entry_insufficient", 409);
  }
}

/** Records (or corrects) where an existing asset's cost sits in the books. Posts nothing. */
export async function setFixedAssetAcquisition(params: {
  businessId: string;
  fixedAssetId: string;
  acquisitionSource: string;
  acquisitionEntryId?: string | null;
}): Promise<FixedAsset> {
  const link = normaliseAcquisitionLink(params.acquisitionSource, params.acquisitionEntryId);
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ cost: string; status: FixedAssetStatus; archived_at: string | null }>(
      `SELECT cost::text AS cost, status, archived_at::text FROM fixed_assets WHERE business_id = $1 AND id = $2 FOR UPDATE`,
      [params.businessId, params.fixedAssetId],
    );
    if (!rows[0]) throw new FixedAssetError("fixed_asset_not_found", 404);
    if (rows[0].status === "disposed") throw new FixedAssetError("asset_disposed", 409);
    if (rows[0].archived_at) throw new FixedAssetError("asset_archived", 409);
    if (link.entryId) {
      await assertAcquisitionEntryCovers(client, params.businessId, link.entryId, Number(rows[0].cost), params.fixedAssetId);
    }
    await client.query(
      `UPDATE fixed_assets SET acquisition_source = $3, acquisition_entry_id = $4 WHERE business_id = $1 AND id = $2`,
      [params.businessId, params.fixedAssetId, link.source, link.entryId],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  return (await getFixedAssetWithDepreciation(params.businessId, params.fixedAssetId)).fixedAsset;
}

export interface AcquisitionCandidate {
  entryId: string;
  entryDate: string;
  memo: string | null;
  sourceType: string | null;
  /** Debited to the fixed-asset accounts, Rial. */
  debitedRial: string;
  /** Not yet claimed by a registered asset, Rial. */
  availableRial: string;
}

/** Standing entries that debit the fixed-asset accounts and still hold cost no asset claims. */
export async function listAcquisitionCandidates(businessId: string): Promise<AcquisitionCandidate[]> {
  const { rows } = await query<AcquisitionCandidate & Record<string, unknown>>(
    `WITH debits AS (
       SELECT l.entry_id, SUM(l.debit - l.credit) AS debited
         FROM journal_lines l
         JOIN journal_entries je ON je.id = l.entry_id
         JOIN accounts a ON a.id = l.account_id
        WHERE je.business_id = $1 AND je.reverses_entry_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.business_id = $1 AND r.reverses_entry_id = je.id)
          AND ${FIXED_ASSET_ACCOUNT_SQL} AND NOT ${ACCUMULATED_ACCOUNT_SQL}
        GROUP BY l.entry_id
       HAVING SUM(l.debit - l.credit) > 0
     ), claimed AS (
       SELECT acquisition_entry_id AS entry_id, SUM(cost) AS claimed
         FROM fixed_assets WHERE business_id = $1 AND acquisition_entry_id IS NOT NULL
        GROUP BY acquisition_entry_id
     )
     SELECT je.id AS "entryId", je.entry_date::text AS "entryDate", je.memo, je.source_type AS "sourceType",
            d.debited::text AS "debitedRial", (d.debited - COALESCE(c.claimed, 0))::text AS "availableRial"
       FROM debits d
       JOIN journal_entries je ON je.id = d.entry_id
       LEFT JOIN claimed c ON c.entry_id = d.entry_id
      WHERE d.debited > COALESCE(c.claimed, 0)
      ORDER BY je.entry_date DESC, je.posted_at DESC
      LIMIT 100`,
    [businessId],
  );
  return rows;
}

/**
 * Register ↔ GL (audit F09): the register's cost and accumulated depreciation
 * against the balances of the fixed-asset and accumulated-depreciation
 * accounts, plus how much of the register nobody has tied to a document.
 * Reversed depreciation and disposed assets are both excluded on the register
 * side — their ledger effect was backed out by the reversal/disposal entries,
 * so including them would manufacture a difference that is not one.
 */
export async function getFixedAssetReconciliation(businessId: string): Promise<FixedAssetReconciliation> {
  const { rows } = await query<{
    register_cost: string;
    register_accumulated: string;
    unlinked_count: number;
    unlinked_cost: string;
    ledger_cost: string;
    ledger_accumulated: string;
  }>(
    `SELECT
       (SELECT COALESCE(SUM(cost), 0) FROM fixed_assets WHERE business_id = $1 AND status = 'active')::text AS register_cost,
       (SELECT COALESCE(SUM(d.amount), 0) FROM fixed_asset_depreciation_entries d
          JOIN fixed_assets fa ON fa.id = d.fixed_asset_id
         WHERE fa.business_id = $1 AND fa.status = 'active' AND d.reversed_at IS NULL)::text AS register_accumulated,
       (SELECT count(*) FROM fixed_assets
         WHERE business_id = $1 AND status = 'active' AND acquisition_source = 'unlinked')::int AS unlinked_count,
       (SELECT COALESCE(SUM(cost), 0) FROM fixed_assets
         WHERE business_id = $1 AND status = 'active' AND acquisition_source = 'unlinked')::text AS unlinked_cost,
       (SELECT COALESCE(SUM(l.debit - l.credit), 0) FROM journal_lines l
          JOIN journal_entries je ON je.id = l.entry_id JOIN accounts a ON a.id = l.account_id
         WHERE je.business_id = $1 AND ${FIXED_ASSET_ACCOUNT_SQL} AND NOT ${ACCUMULATED_ACCOUNT_SQL})::text AS ledger_cost,
       (SELECT COALESCE(SUM(l.credit - l.debit), 0) FROM journal_lines l
          JOIN journal_entries je ON je.id = l.entry_id JOIN accounts a ON a.id = l.account_id
         WHERE je.business_id = $1 AND ${FIXED_ASSET_ACCOUNT_SQL} AND ${ACCUMULATED_ACCOUNT_SQL})::text AS ledger_accumulated`,
    [businessId],
  );
  const r = rows[0];
  return reconcileFixedAssetRegister({
    registerCost: BigInt(r.register_cost),
    registerAccumulated: BigInt(r.register_accumulated),
    ledgerCost: BigInt(r.ledger_cost),
    ledgerAccumulated: BigInt(r.ledger_accumulated),
    unlinkedCount: r.unlinked_count,
    unlinkedCost: BigInt(r.unlinked_cost),
  });
}

// ---------------------------------------------------------------------------
// Delete — one transaction, under the row lock, and only for an asset with no
// accounting history of any kind. Everything else is archived, not deleted.
// ---------------------------------------------------------------------------

export async function deleteFixedAsset(businessId: string, id: string): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{
      has_depreciation: boolean;
      has_other_history: boolean;
      status: FixedAssetStatus;
      archived_at: string | null;
    }>(
      `SELECT status, archived_at::text,
              EXISTS (SELECT 1 FROM fixed_asset_depreciation_entries d WHERE d.fixed_asset_id = fixed_assets.id) AS has_depreciation,
              (acquisition_source <> 'unlinked'
               OR EXISTS (SELECT 1 FROM fixed_asset_transfers t WHERE t.fixed_asset_id = fixed_assets.id)
               OR EXISTS (SELECT 1 FROM fixed_asset_estimate_changes c WHERE c.fixed_asset_id = fixed_assets.id)) AS has_other_history
         FROM fixed_assets WHERE business_id = $1 AND id = $2 FOR UPDATE`,
      [businessId, id],
    );
    if (!rows[0]) throw new FixedAssetError("fixed_asset_not_found", 404);
    // A reversed entry is still history — it says a posting happened, so it
    // protects the asset from deletion exactly like a live one.
    if (rows[0].has_depreciation) throw new FixedAssetError("fixed_asset_has_depreciation", 409);
    if (rows[0].has_other_history) throw new FixedAssetError("fixed_asset_has_history", 409);
    if (rows[0].status === "disposed") throw new FixedAssetError("asset_disposed", 409);
    if (rows[0].archived_at) throw new FixedAssetError("asset_archived", 409);
    await client.query(`DELETE FROM fixed_assets WHERE business_id = $1 AND id = $2`, [businessId, id]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Depreciation, reversal, disposal, estimate change, transfer, archive.
// Every one runs inside one transaction and locks the asset row first.
// ---------------------------------------------------------------------------

/** The state a mutation needs from the locked asset row, one shape for all of them. */
interface LockedAsset {
  id: string;
  name: string;
  locationId: string | null;
  cost: number;
  salvageValue: number;
  usefulLifeMonths: number;
  inServiceDate: string;
  status: FixedAssetStatus;
  archivedAt: string | null;
  assetAccountId: string | null;
}

async function lockAsset(client: PoolClient, businessId: string, fixedAssetId: string): Promise<LockedAsset> {
  const { rows } = await client.query<{
    id: string;
    name: string;
    location_id: string | null;
    cost: string;
    salvage_value: string;
    useful_life_months: number;
    in_service_date: string;
    status: FixedAssetStatus;
    archived_at: string | null;
    asset_account_id: string | null;
  }>(
    `SELECT id, name, location_id, cost::text AS cost, salvage_value::text AS salvage_value,
            useful_life_months,
            COALESCE(in_service_date, acquisition_date)::text AS in_service_date,
            status, archived_at::text AS archived_at, asset_account_id
       FROM fixed_assets WHERE business_id = $1 AND id = $2 FOR UPDATE`,
    [businessId, fixedAssetId],
  );
  if (!rows[0]) throw new FixedAssetError("fixed_asset_not_found", 404);
  const r = rows[0];
  return {
    id: r.id,
    name: r.name,
    locationId: r.location_id,
    cost: Number(r.cost),
    salvageValue: Number(r.salvage_value),
    usefulLifeMonths: r.useful_life_months,
    inServiceDate: r.in_service_date,
    status: r.status,
    archivedAt: r.archived_at,
    assetAccountId: r.asset_account_id,
  };
}

function assertMutable(asset: LockedAsset): void {
  if (asset.status === "disposed") throw new FixedAssetError("asset_disposed", 409);
  if (asset.archivedAt) throw new FixedAssetError("asset_archived", 409);
}

/** One live (non-reversed) depreciation posting, as the schedule sees it. */
interface LiveDepreciationPosting {
  /** Canonical `YYYY-MM`; legacy free-text rows resolve by their entry date. */
  periodKey: string;
  amount: number;
}

/** Live (non-reversed) depreciation state, read under the asset's lock. */
async function liveDepreciation(
  client: PoolClient,
  fixedAssetId: string,
): Promise<{ periodKeys: string[]; accumulated: number; entryDates: string[]; postings: LiveDepreciationPosting[] }> {
  const { rows } = await client.query<{ period_key: string | null; entry_date: string; amount: string }>(
    `SELECT period_key, entry_date::text AS entry_date, amount::text AS amount
       FROM fixed_asset_depreciation_entries WHERE fixed_asset_id = $1 AND reversed_at IS NULL`,
    [fixedAssetId],
  );
  const postings = rows.map((r) => ({
    periodKey: r.period_key ?? depreciationPeriodOfDate(r.entry_date)?.key ?? r.entry_date,
    amount: Number(r.amount),
  }));
  return {
    periodKeys: postings.map((p) => p.periodKey),
    accumulated: postings.reduce((sum, p) => sum + p.amount, 0),
    entryDates: rows.map((r) => r.entry_date),
    postings,
  };
}

/**
 * What `planDepreciation` should count for one target month: the estimate
 * change in force *for that month* — the latest whose effective period is at
 * or before it, not merely the latest recorded — and the live totals scoped
 * to that schedule's window.
 *
 * A month from before a change is catch-up under the schedule that governed
 * it: with no applicable change, the amount comes from the original schedule
 * and only the postings before the first change count against it. A month
 * from after a change runs on that change's frozen schedule: the snapshot
 * (`accumulated_at_change` / `periods_posted_at_change` / the period keys
 * live at the change) is the baseline, plus everything posted since into the
 * window the change governs — its own periods, catch-ups from before it
 * (they consume its remaining base), and nothing from a later change's
 * window, which that later change already accounted for in its own snapshot.
 */
async function revisionContextForPeriod(
  client: PoolClient,
  asset: LockedAsset,
  targetPeriodKey: string,
  live: { postings: LiveDepreciationPosting[]; accumulated: number },
): Promise<{
  revision: DepreciationRevision | null;
  accumulatedSoFar: number;
  schedulePeriodsPosted: number;
  /** The schedule parameters in force for the target month. */
  scheduleAsset: { cost: number; salvageValue: number; usefulLifeMonths: number; inServiceDate: string };
}> {
  interface ChangeRow {
    effective_period_key: string;
    periods_posted_at_change: number;
    accumulated_at_change: string;
    remaining_base: string;
    remaining_life_months: number;
    snapshot_period_keys: string[] | null;
    old_useful_life_months: number;
    old_salvage_value: string;
  }
  const { rows } = await client.query<ChangeRow>(
    `SELECT effective_period_key, periods_posted_at_change, accumulated_at_change::text AS accumulated_at_change,
            remaining_base::text AS remaining_base, remaining_life_months, snapshot_period_keys,
            old_useful_life_months, old_salvage_value::text AS old_salvage_value
       FROM fixed_asset_estimate_changes WHERE fixed_asset_id = $1
      ORDER BY effective_period_key ASC, created_at ASC`,
    [asset.id],
  );

  const currentAsset = {
    cost: asset.cost,
    salvageValue: asset.salvageValue,
    usefulLifeMonths: asset.usefulLifeMonths,
    inServiceDate: asset.inServiceDate,
  };

  // No estimate changes ever: the original schedule, all live postings.
  if (rows.length === 0) {
    return {
      revision: null,
      accumulatedSoFar: live.accumulated,
      schedulePeriodsPosted: live.postings.length,
      scheduleAsset: currentAsset,
    };
  }

  // The change in force for the target month: the latest with an effective
  // period at or before it (period keys are zero-padded YYYY-MM, so the
  // string comparison is chronological).
  let applicable: ChangeRow | null = null;
  let nextBoundary: string | null = null;
  for (const change of rows) {
    if (change.effective_period_key <= targetPeriodKey) applicable = change;
    else {
      nextBoundary = change.effective_period_key;
      break;
    }
  }

  // The target month predates every change: the ORIGINAL schedule — the
  // parameters the first change recorded replacing, not the asset row's
  // current values, which that change already overwrote. Two different
  // counts matter here: the schedule's PROGRESSION (how many of the
  // original schedule's months are consumed, whether this posting is its
  // final one) sees only the postings from before the first change, while
  // the lifetime CAP sees every live posting — the depreciable base is the
  // asset's, shared across every revision, so a fully-depreciated asset must
  // refuse a late pre-change catch-up just the same.
  if (!applicable) {
    const first = rows[0];
    const firstBoundary = first.effective_period_key;
    const windowCount = live.postings.filter((p) => p.periodKey < firstBoundary).length;
    return {
      revision: null,
      accumulatedSoFar: live.accumulated,
      schedulePeriodsPosted: windowCount,
      scheduleAsset: {
        cost: asset.cost,
        salvageValue: Number(first.old_salvage_value),
        usefulLifeMonths: first.old_useful_life_months,
        inServiceDate: asset.inServiceDate,
      },
    };
  }

  const snapshot = new Set(applicable.snapshot_period_keys ?? []);
  const since = live.postings.filter(
    (p) => !snapshot.has(p.periodKey) && (nextBoundary === null || p.periodKey < nextBoundary),
  );
  return {
    revision: {
      periodsPostedAtChange: applicable.periods_posted_at_change,
      accumulatedAtChange: Number(applicable.accumulated_at_change),
      remainingBase: Number(applicable.remaining_base),
      remainingLifeMonths: applicable.remaining_life_months,
    },
    accumulatedSoFar: Number(applicable.accumulated_at_change) + since.reduce((sum, p) => sum + p.amount, 0),
    schedulePeriodsPosted: applicable.periods_posted_at_change + since.length,
    // The revision's own numbers govern the amount; the asset row's current
    // parameters are only the identity/cost this schedule belongs to.
    scheduleAsset: currentAsset,
  };
}

/**
 * The branch an asset belonged to on a given date (issue #833): the transfers
 * that had taken effect by then, applied in order. Read under the asset's
 * lock, so a concurrent transfer cannot move the answer mid-posting.
 */
async function locationAtDate(client: PoolClient, asset: LockedAsset, isoDate: string): Promise<string> {
  const { rows } = await client.query<{ to_location_id: string }>(
    `SELECT to_location_id FROM fixed_asset_transfers
      WHERE fixed_asset_id = $1 AND effective_date <= $2
      ORDER BY effective_date DESC, created_at DESC LIMIT 1`,
    [asset.id, isoDate],
  );
  if (rows[0]) return rows[0].to_location_id;
  // Before any transfer took effect the asset sat where it was registered —
  // which the first transfer recorded as its `from`, and which is still
  // `location_id` when there was never a transfer at all.
  const { rows: first } = await client.query<{ from_location_id: string }>(
    `SELECT from_location_id FROM fixed_asset_transfers
      WHERE fixed_asset_id = $1 ORDER BY effective_date ASC, created_at ASC LIMIT 1`,
    [asset.id],
  );
  return first[0]?.from_location_id ?? asset.locationId;
}

/** The latest recorded transfer, under the asset's lock, for chronology checks. */
async function latestTransfer(
  client: PoolClient,
  fixedAssetId: string,
): Promise<{ effective_date: string; to_location_id: string } | null> {
  const { rows } = await client.query<{ effective_date: string; to_location_id: string }>(
    `SELECT effective_date::text AS effective_date, to_location_id FROM fixed_asset_transfers
      WHERE fixed_asset_id = $1 ORDER BY effective_date DESC, created_at DESC LIMIT 1`,
    [fixedAssetId],
  );
  return rows[0] ?? null;
}

function assertReason(reason: string | null | undefined): string {
  const trimmed = reason?.trim() ?? "";
  if (!trimmed) throw new FixedAssetError("reason_required");
  if (trimmed.length > FIXED_ASSET_REASON_MAX_LENGTH) throw new FixedAssetError("reason_too_long");
  return trimmed;
}

/**
 * Posts one Jalali month's straight-line depreciation for one asset — audit
 * F07. Everything that decides the amount is read inside one transaction,
 * after `SELECT … FOR UPDATE` on the asset row, so two requests for the same
 * asset serialise: the second sees the first's entry and either refuses the
 * month or computes the next amount from the new accumulated total. The rules
 * (canonical month, in-service date, cap at cost − salvage, revised
 * estimates) are the pure `planDepreciation`; the partial UNIQUE index on
 * (asset, period_key) and the ledger's
 * (business, source_type, source_id, posting_kind) index are the database's
 * own backstops.
 *
 * The journal entry is posted to **the asset's own location** — never the
 * operator's currently active branch (issue #833): an asset registered at
 * Branch A keeps depreciating on Branch A's books until a recorded transfer
 * moves it.
 */
export async function postDepreciation(params: {
  businessId: string;
  fixedAssetId: string;
  periodKey?: string | null;
  periodLabel?: string | null;
  entryDate?: string | null;
  createdBy: string | null;
}): Promise<{
  amount: number;
  periodKey: string;
  periodLabel: string;
  entryDate: string;
  /** The register's own row for this posting — what a reversal undoes. */
  depreciationEntryId: string;
  journalEntryId: string | null;
}> {
  const memoLabel = params.periodLabel?.trim() ?? "";
  if (memoLabel.length > 120) throw new FixedAssetError("period_label_too_long");
  const today = await businessToday(params.businessId);

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const asset = await lockAsset(client, params.businessId, params.fixedAssetId);
    if (asset.status === "disposed") throw new FixedAssetError("asset_disposed", 409);
    if (asset.archivedAt) throw new FixedAssetError("asset_archived", 409);

    const live = await liveDepreciation(client, asset.id);

    // The month being asked for decides which estimate schedule governs it —
    // resolve the period first, then the schedule in force for that period.
    const requestedPeriodKey = params.periodKey?.trim() ?? null;
    const targetPeriod = requestedPeriodKey
      ? parseDepreciationPeriodKey(requestedPeriodKey)
      : params.entryDate?.trim() && isValidIsoDate(params.entryDate.trim())
        ? depreciationPeriodOfDate(params.entryDate.trim())
        : depreciationPeriodOfDate(today);
    const revisionContext = targetPeriod
      ? await revisionContextForPeriod(client, asset, targetPeriod.key, live)
      : {
          revision: null,
          accumulatedSoFar: live.accumulated,
          schedulePeriodsPosted: live.postings.length,
          scheduleAsset: {
            cost: asset.cost,
            salvageValue: asset.salvageValue,
            usefulLifeMonths: asset.usefulLifeMonths,
            inServiceDate: asset.inServiceDate,
          },
        };

    const plan = planDepreciation({
      // The schedule in force for the requested month — the original
      // parameters for a pre-change month, the asset row's otherwise.
      asset: revisionContext.scheduleAsset,
      // The full live list is what the duplicate-month check needs; the
      // amount comes from the window-scoped totals of the applicable schedule.
      postedPeriodKeys: live.periodKeys,
      accumulatedSoFar: revisionContext.accumulatedSoFar,
      schedulePeriodsPosted: revisionContext.schedulePeriodsPosted,
      periodKey: params.periodKey,
      entryDate: params.entryDate,
      today,
      revision: revisionContext.revision,
    });
    if (!plan.ok) {
      const status = plan.error === "period_already_depreciated" || plan.error === "fully_depreciated" ? 409 : 400;
      throw new FixedAssetError(plan.error, status);
    }
    const label = memoLabel || plan.period.label;

    let depreciationEntryId: string;
    try {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO fixed_asset_depreciation_entries
           (fixed_asset_id, period_key, period_label, entry_date, amount, created_by)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [asset.id, plan.period.key, label, plan.entryDate, plan.amount, params.createdBy],
      );
      depreciationEntryId = rows[0].id;
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new FixedAssetError("period_already_depreciated", 409);
      }
      throw err;
    }

    // The asset's branch *at the document's date*, not its branch today: a
    // transfer recorded after the fact must not move a historical posting.
    const postingLocationId = await locationAtDate(client, asset, plan.entryDate);

    const accounts = await accountIdsByCode(client, params.businessId, [
      WELL_KNOWN_CODES.depreciationExpense,
      WELL_KNOWN_CODES.accumulatedDepreciation,
    ]);
    const journalEntryId = await postJournalEntry(client, {
      businessId: params.businessId,
      locationId: postingLocationId,
      entryDate: plan.entryDate,
      memo: `استهلاک — ${label}`,
      sourceType: "fixed_asset_depreciation",
      sourceId: depreciationEntryId,
      postingKind: "depreciation",
      createdBy: params.createdBy,
      lines: [
        { accountId: accounts.get(WELL_KNOWN_CODES.depreciationExpense)!, debit: plan.amount, credit: 0 },
        { accountId: accounts.get(WELL_KNOWN_CODES.accumulatedDepreciation)!, debit: 0, credit: plan.amount },
      ],
    });

    await client.query("COMMIT");
    return {
      amount: plan.amount,
      periodKey: plan.period.key,
      periodLabel: label,
      entryDate: plan.entryDate,
      depreciationEntryId,
      journalEntryId,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Reverses one posted depreciation entry (issue #833): the exact mirror of
 * the original entry's live effect, posted through the ledger's own reversal
 * path, with the asset's attribution preserved. The source row is marked
 * reversed — never deleted — so the history says what happened, who undid it
 * and why. The reversed month may be posted again; the reconstructed schedule
 * treats it as never posted.
 *
 * When the original period is locked, the reversal cannot be dated into it:
 * the caller must then pass a `reversalDate` in an open period (the fiscal
 * lock does the refusing, exactly as it would for any other posting).
 */
export async function reverseDepreciation(params: {
  businessId: string;
  fixedAssetId: string;
  depreciationEntryId: string;
  reversalDate?: string | null;
  reason: string;
  createdBy: string | null;
}): Promise<{
  amount: number;
  periodKey: string | null;
  reversalJournalEntryId: string | null;
  reversalDate: string;
}> {
  const reason = assertReason(params.reason);
  const requestedDate = params.reversalDate?.trim() || null;
  if (requestedDate && !isValidIsoDate(requestedDate)) throw new FixedAssetError("invalid_reversal_date");

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const asset = await lockAsset(client, params.businessId, params.fixedAssetId);
    assertMutable(asset);

    const { rows: entries } = await client.query<{
      id: string;
      period_key: string | null;
      period_label: string;
      entry_date: string;
      amount: string;
      reversed_at: string | null;
    }>(
      `SELECT id, period_key, period_label, entry_date::text AS entry_date, amount::text AS amount, reversed_at::text
         FROM fixed_asset_depreciation_entries
        WHERE fixed_asset_id = $1 AND id = $2 FOR UPDATE`,
      [asset.id, params.depreciationEntryId],
    );
    const entry = entries[0];
    if (!entry) throw new FixedAssetError("depreciation_entry_not_found", 404);
    if (entry.reversed_at) throw new FixedAssetError("depreciation_already_reversed", 409);

    // The original posting's own branch, not the asset's branch today: a
    // transfer recorded since must not move the undo of an old posting to the
    // new branch. The mirror undoes the original where the original happened.
    const { rows: journals } = await client.query<{ id: string; location_id: string | null }>(
      `SELECT id, location_id FROM journal_entries
        WHERE business_id = $1 AND source_type = 'fixed_asset_depreciation' AND source_id = $2
          AND reverses_entry_id IS NULL`,
      [params.businessId, entry.id],
    );

    let reversalJournalEntryId: string | null = null;
    const reversalDate = requestedDate ?? entry.entry_date;
    if (journals[0]) {
      reversalJournalEntryId = await postExactMirrorEntry(client, {
        businessId: params.businessId,
        locationId: journals[0].location_id ?? asset.locationId,
        originalEntryId: journals[0].id,
        sourceType: "fixed_asset_depreciation",
        sourceId: entry.id,
        postingKind: "reversal",
        memo: `برگشت استهلاک — ${entry.period_label}`,
        createdBy: params.createdBy,
        entryDate: reversalDate,
      });
    }

    await client.query(
      `UPDATE fixed_asset_depreciation_entries
          SET reversed_at = now(), reversed_by = $2, reversal_reason = $3, reversal_journal_entry_id = $4
        WHERE id = $1 AND reversed_at IS NULL`,
      [entry.id, params.createdBy, reason, reversalJournalEntryId],
    );

    await client.query("COMMIT");
    return {
      amount: Number(entry.amount),
      periodKey: entry.period_key,
      reversalJournalEntryId,
      reversalDate,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Disposes of an asset — sale, retirement or write-off (issue #833) — and
 * posts the entry that takes both the cost and the live accumulated
 * depreciation off the Balance Sheet:
 *
 *   Dr proceeds account (a sale)   Dr accumulated depreciation (1510)
 *   Dr loss on sale (5750)         Cr the asset's fixed-asset account (cost)
 *                                  Cr gain on sale (4920)
 *
 * The gain/loss is proceeds against net book value — cost less *live*
 * accumulated depreciation. After disposal the asset can never depreciate
 * again, and its cost leaves the register↔GL reconciliation on both sides at
 * once (the disposal entry credits it back out of the 1500 block).
 */
export async function disposeFixedAsset(params: {
  businessId: string;
  fixedAssetId: string;
  kind: FixedAssetDisposalKind;
  disposalDate?: string | null;
  /** Required and > 0 for a sale; must be absent for retirement/write-off. */
  proceeds?: number | null;
  /** The settlement account the proceeds land in (cash, bank, …). Required for a sale. */
  proceedsAccountId?: string | null;
  reason?: string | null;
  createdBy: string | null;
}): Promise<{
  netBookValue: number;
  gain: number;
  loss: number;
  proceeds: number;
  journalEntryId: string | null;
}> {
  if (!DISPOSAL_KINDS.has(params.kind)) throw new FixedAssetError("invalid_disposal_kind");
  const reason = params.reason?.trim() || null;
  if (reason && reason.length > FIXED_ASSET_REASON_MAX_LENGTH) throw new FixedAssetError("reason_too_long");
  const today = await businessToday(params.businessId);
  const disposalDate = params.disposalDate?.trim() || today;
  if (!isValidIsoDate(disposalDate)) throw new FixedAssetError("invalid_disposal_date");
  if (disposalDate > today) throw new FixedAssetError("disposal_date_in_future");

  const isSale = params.kind === "sale";
  const proceeds = isSale ? Number(params.proceeds ?? 0) : 0;
  if (isSale && (!Number.isSafeInteger(proceeds) || proceeds <= 0)) {
    throw new FixedAssetError("disposal_proceeds_required");
  }
  if (!isSale && Number(params.proceeds ?? 0) !== 0) throw new FixedAssetError("disposal_proceeds_not_allowed");
  if (isSale && !params.proceedsAccountId) throw new FixedAssetError("proceeds_account_required");

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const asset = await lockAsset(client, params.businessId, params.fixedAssetId);
    if (asset.status === "disposed") throw new FixedAssetError("asset_disposed", 409);
    if (asset.archivedAt) throw new FixedAssetError("asset_archived", 409);
    if (disposalDate < asset.inServiceDate) throw new FixedAssetError("disposal_before_in_service");
    // A disposal dated before the latest transfer would claim the asset left
    // the register before it demonstrably moved between branches — the
    // transfer happened while the asset was still in service.
    const latest = await latestTransfer(client, asset.id);
    if (latest && disposalDate < latest.effective_date) {
      throw new FixedAssetError("disposal_before_last_transfer");
    }

    const live = await liveDepreciation(client, asset.id);
    const outcome = disposalOutcome({
      cost: asset.cost,
      accumulatedDepreciation: live.accumulated,
      proceeds,
    });

    // The cost side: the asset's own account when the register recorded one,
    // else the chart's fixed-asset root. Never the accumulated-depreciation
    // contra account, and never the proceeds account (that would corrupt the
    // register↔GL reconciliation this disposal is about keeping honest).
    let assetAccountId: string | null = null;
    if (asset.assetAccountId) {
      const { rows: classified } = await client.query<{ id: string }>(
        `SELECT a.id FROM accounts a
          WHERE a.id = $2 AND a.business_id = $1 AND a.is_active`,
        [params.businessId, asset.assetAccountId],
      );
      assetAccountId = classified[0]?.id ?? null;
    }
    const neededCodes: string[] = [WELL_KNOWN_CODES.accumulatedDepreciation];
    if (!assetAccountId) neededCodes.push(WELL_KNOWN_CODES.fixedAssets);
    if (outcome.gain > 0) neededCodes.push(WELL_KNOWN_CODES.gainOnAssetSale);
    if (outcome.loss > 0) neededCodes.push(WELL_KNOWN_CODES.lossOnAssetSale);
    const accounts = await accountIdsByCode(client, params.businessId, neededCodes);
    const costAccountId =
      assetAccountId ?? accounts.get(WELL_KNOWN_CODES.fixedAssets)!;

    let proceedsAccountId: string | null = null;
    if (isSale) {
      const { rows: proceedsRows } = await client.query<{ id: string }>(
        `SELECT a.id FROM accounts a
          WHERE a.id = $2 AND a.business_id = $1 AND a.is_active
            AND NOT (${FIXED_ASSET_ACCOUNT_SQL})`,
        [params.businessId, params.proceedsAccountId],
      );
      if (!proceedsRows[0]) throw new FixedAssetError("invalid_proceeds_account");
      proceedsAccountId = proceedsRows[0].id;
    }

    const lines: { accountId: string; debit: number; credit: number }[] = [
      { accountId: costAccountId, debit: 0, credit: asset.cost },
    ];
    if (live.accumulated > 0) {
      lines.push({
        accountId: accounts.get(WELL_KNOWN_CODES.accumulatedDepreciation)!,
        debit: live.accumulated,
        credit: 0,
      });
    }
    if (proceeds > 0 && proceedsAccountId) {
      lines.push({ accountId: proceedsAccountId, debit: proceeds, credit: 0 });
    }
    if (outcome.loss > 0) {
      lines.push({ accountId: accounts.get(WELL_KNOWN_CODES.lossOnAssetSale)!, debit: outcome.loss, credit: 0 });
    }
    if (outcome.gain > 0) {
      lines.push({ accountId: accounts.get(WELL_KNOWN_CODES.gainOnAssetSale)!, debit: 0, credit: outcome.gain });
    }

    const memo =
      params.kind === "sale"
        ? `فروش دارایی ثابت — ${asset.name}`
        : params.kind === "retirement"
          ? `اسقاط دارایی ثابت — ${asset.name}`
          : `حذف دارایی ثابت — ${asset.name}`;
    // The branch that held the asset on the disposal date — the same
    // effective-dated rule depreciation posts under.
    const disposalLocationId = await locationAtDate(client, asset, disposalDate);
    const journalEntryId = await postJournalEntry(client, {
      businessId: params.businessId,
      locationId: disposalLocationId,
      entryDate: disposalDate,
      memo,
      sourceType: "fixed_asset_disposal",
      sourceId: asset.id,
      postingKind: "disposal",
      createdBy: params.createdBy,
      lines,
    });

    await client.query(
      `UPDATE fixed_assets
          SET status = 'disposed', disposal_kind = $3, disposal_date = $4, disposal_proceeds = $5,
              disposal_journal_entry_id = $6, disposal_reason = $7, disposed_by = $8
        WHERE business_id = $1 AND id = $2`,
      [
        params.businessId,
        asset.id,
        params.kind,
        disposalDate,
        proceeds > 0 ? proceeds : (params.proceeds ?? null),
        journalEntryId,
        reason,
        params.createdBy,
      ],
    );

    await client.query("COMMIT");
    return { ...outcome, proceeds, journalEntryId };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Changes an asset's useful life or salvage value *prospectively* (issue
 * #833): the posted periods are never rewritten. The new estimate and a
 * snapshot of the remaining schedule it implies are recorded together, under
 * the asset's lock, so every later period spreads what was left over the life
 * that was left.
 */
export async function changeFixedAssetEstimate(params: {
  businessId: string;
  fixedAssetId: string;
  usefulLifeMonths?: number | null;
  salvageValue?: number | null;
  reason: string;
  createdBy: string | null;
}): Promise<{ fixedAsset: FixedAsset; estimateChange: FixedAssetEstimateChange }> {
  const reason = assertReason(params.reason);
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const asset = await lockAsset(client, params.businessId, params.fixedAssetId);
    assertMutable(asset);

    const wantsLife = params.usefulLifeMonths ?? null;
    const wantsSalvage = params.salvageValue ?? null;
    if (wantsLife === null && wantsSalvage === null) throw new FixedAssetError("estimate_change_required");
    if (wantsLife !== null && (!Number.isInteger(wantsLife) || wantsLife <= 0 || wantsLife > FIXED_ASSET_USEFUL_LIFE_MAX_MONTHS)) {
      throw new FixedAssetError("invalid_useful_life");
    }
    if (wantsSalvage !== null && (!Number.isSafeInteger(wantsSalvage) || wantsSalvage < 0 || wantsSalvage >= asset.cost)) {
      throw new FixedAssetError("salvage_not_less_than_cost");
    }
    const newLife = wantsLife ?? asset.usefulLifeMonths;
    const newSalvage = wantsSalvage ?? asset.salvageValue;
    if (newLife === asset.usefulLifeMonths && newSalvage === asset.salvageValue) {
      throw new FixedAssetError("estimate_unchanged");
    }

    const live = await liveDepreciation(client, asset.id);
    // The snapshot: what the change leaves to depreciate, and how long it now
    // has to take. A life shortened past what's already consumed (0 months
    // left) makes the whole remainder due on the next period.
    const remainingBase = Math.max(0, asset.cost - newSalvage - live.accumulated);
    const remainingLifeMonths = Math.max(0, newLife - live.periodKeys.length);
    const effectivePeriod = depreciationPeriodOfDate(await businessToday(params.businessId));
    if (!effectivePeriod) throw new FixedAssetError("invalid_period");

    await client.query(
      `UPDATE fixed_assets SET useful_life_months = $3, salvage_value = $4 WHERE business_id = $1 AND id = $2`,
      [params.businessId, asset.id, newLife, newSalvage],
    );
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO fixed_asset_estimate_changes
         (fixed_asset_id, effective_period_key, old_useful_life_months, new_useful_life_months,
          old_salvage_value, new_salvage_value, periods_posted_at_change, remaining_life_months,
          remaining_base, accumulated_at_change, snapshot_period_keys, reason, changed_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
      [
        asset.id,
        effectivePeriod.key,
        asset.usefulLifeMonths,
        newLife,
        asset.salvageValue,
        newSalvage,
        live.periodKeys.length,
        remainingLifeMonths,
        remainingBase,
        live.accumulated,
        // Which months the live history covered — not just how many — so a
        // later catch-up for a pre-change month can be told apart from a
        // posting made under the revised schedule.
        live.periodKeys,
        reason,
        params.createdBy,
      ],
    );

    await client.query("COMMIT");
    const detail = await getFixedAssetWithDepreciation(params.businessId, asset.id);
    const estimateChange = detail.estimateChanges.find((change) => change.id === rows[0].id);
    if (!estimateChange) throw new FixedAssetError("estimate_change_failed", 500);
    return { fixedAsset: detail.fixedAsset, estimateChange };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Moves an asset to another branch with an audited history row (issue #833)
 * — the location is never silently edited. Depreciation after the transfer
 * posts to the new branch, because the journal's location is always the
 * asset's own.
 */
export async function transferFixedAsset(params: {
  businessId: string;
  fixedAssetId: string;
  toLocationId: string;
  effectiveDate?: string | null;
  reason: string;
  createdBy: string | null;
}): Promise<{ fixedAsset: FixedAsset }> {
  const reason = assertReason(params.reason);
  const today = await businessToday(params.businessId);
  const effectiveDate = params.effectiveDate?.trim() || today;
  if (!isValidIsoDate(effectiveDate)) throw new FixedAssetError("invalid_transfer_date");
  // A future transfer would not be honoured by anything (depreciation reads
  // the asset's current location), so it is refused rather than recorded as
  // if it would be.
  if (effectiveDate > today) throw new FixedAssetError("transfer_date_in_future");

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const asset = await lockAsset(client, params.businessId, params.fixedAssetId);
    assertMutable(asset);
    await assertLocationOfBusiness(client, params.businessId, params.toLocationId);
    if (asset.locationId === params.toLocationId) throw new FixedAssetError("transfer_same_location", 409);

    // Chronology: a transfer is a fact about a date, recorded in order. An
    // entry dated before the asset entered service would move an asset that
    // did not exist yet, and one dated before the latest recorded transfer
    // would need that transfer's `from` rewritten — history is append-only.
    if (effectiveDate < asset.inServiceDate) throw new FixedAssetError("transfer_before_in_service");
    const latest = await latestTransfer(client, asset.id);
    if (latest && effectiveDate < latest.effective_date) {
      throw new FixedAssetError("transfer_before_last_transfer");
    }

    await client.query(
      `INSERT INTO fixed_asset_transfers
         (fixed_asset_id, from_location_id, to_location_id, effective_date, reason, transferred_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [asset.id, asset.locationId, params.toLocationId, effectiveDate, reason, params.createdBy],
    );
    await client.query(`UPDATE fixed_assets SET location_id = $3 WHERE business_id = $1 AND id = $2`, [
      params.businessId,
      asset.id,
      params.toLocationId,
    ]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  return { fixedAsset: (await getFixedAssetWithDepreciation(params.businessId, params.fixedAssetId)).fixedAsset };
}

/**
 * Archives (cancels) an asset instead of deleting it (issue #833): the row,
 * its history and every journal link stay; it simply leaves the working
 * register and can no longer depreciate, transfer or change estimate.
 */
export async function archiveFixedAsset(params: {
  businessId: string;
  fixedAssetId: string;
  reason: string;
  createdBy: string | null;
}): Promise<{ fixedAsset: FixedAsset }> {
  const reason = assertReason(params.reason);
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const asset = await lockAsset(client, params.businessId, params.fixedAssetId);
    if (asset.status === "disposed") throw new FixedAssetError("asset_disposed", 409);
    if (asset.archivedAt) throw new FixedAssetError("asset_archived", 409);
    await client.query(
      `UPDATE fixed_assets SET archived_at = now(), archived_by = $3, archive_reason = $4
        WHERE business_id = $1 AND id = $2`,
      [params.businessId, asset.id, params.createdBy, reason],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  return { fixedAsset: (await getFixedAssetWithDepreciation(params.businessId, params.fixedAssetId)).fixedAsset };
}

// ---------------------------------------------------------------------------
// Export — the accountant-grade outputs (issue #833), built from the full
// filtered dataset, never just the visible page.
// ---------------------------------------------------------------------------

export const FIXED_ASSET_EXPORT_MAX_ROWS = 20_000;

/** What `fixedAssetsExportSheets` produced, including the honesty it owes the reader. */
export interface FixedAssetsExportResult {
  /** The workbook sheets, in reading order. */
  sheets: SheetData[];
  /** True when any sheet hit its row cap — the workbook is knowingly partial, and must say so. */
  truncated: boolean;
  /** Rows in the filtered register before any cap — the number the reader expected. */
  registerTotal: number;
  /** The per-sheet row cap that was applied. */
  maxRows: number;
}

/**
 * The accountant-grade outputs (issue #833): the register, the depreciation
 * schedule, the disposals, the transfers and the estimate changes — every
 * sheet over the SAME filtered asset set, so a filter narrows the whole
 * workbook, not just the register.
 *
 * Each sheet is capped at `maxRows` rows (a workbook is a document, not a
 * database dump). Hitting the cap is never silent: `truncated` tells the
 * caller, and `fixedAssetExportTruncationNotice` is the sheet the route puts
 * in front of the workbook so the reader knows to narrow the filters.
 */
export async function fixedAssetsExportSheets(
  businessId: string,
  filters: FixedAssetListFilters = {},
  options: { maxRows?: number } = {},
): Promise<FixedAssetsExportResult> {
  const maxRows = Math.max(1, Math.floor(options.maxRows ?? FIXED_ASSET_EXPORT_MAX_ROWS));
  const { clause, params } = fixedAssetWhere(filters);
  params[0] = businessId;

  // The one filtered asset selection every sheet reads from — resolved once,
  // so the register, the schedule and the history sheets can never disagree
  // about which assets the filter admitted.
  const { rows: idRows } = await query<{ id: string }>(
    `SELECT fa.id${FIXED_ASSET_FROM} WHERE ${clause}`,
    params,
  );
  const assetIds = idRows.map((r) => r.id);

  const register = await query<FixedAssetRow & Record<string, unknown>>(
    `${FIXED_ASSET_SELECT} WHERE fa.id = ANY($1) ${fixedAssetOrderBy(filters.sortBy)} LIMIT ${maxRows + 1}`,
    [assetIds],
  );
  let truncated = register.rows.length > maxRows;

  const schedule = await query<{
    code: string | null;
    name: string;
    period_label: string;
    period_key: string | null;
    entry_date: string;
    amount: string;
    reversed_at: string | null;
    created_by_name: string | null;
    location_name: string | null;
  }>(
    `SELECT fa.code, fa.name, d.period_label, d.period_key, d.entry_date::text AS entry_date,
            d.amount::text AS amount, d.reversed_at::text AS reversed_at,
            u.full_name AS created_by_name,
            -- The branch the posting was journalled to — the asset's branch at
            -- the document date, which a later transfer does not rewrite. The
            -- asset's current branch is only the fallback for legacy rows that
            -- predate journal linking.
            COALESCE(jl.name, l.name) AS location_name
       FROM fixed_asset_depreciation_entries d
       JOIN fixed_assets fa ON fa.id = d.fixed_asset_id
       LEFT JOIN users u ON u.id = d.created_by
       LEFT JOIN locations l ON l.id = fa.location_id
       LEFT JOIN journal_entries je
         ON je.source_type = 'fixed_asset_depreciation' AND je.source_id = d.id AND je.reverses_entry_id IS NULL
       LEFT JOIN locations jl ON jl.id = je.location_id
      WHERE fa.id = ANY($1)
      ORDER BY fa.code NULLS LAST, d.entry_date ASC
      LIMIT ${maxRows + 1}`,
    [assetIds],
  );
  truncated = truncated || schedule.rows.length > maxRows;

  const transfers = await query<{
    code: string | null;
    name: string;
    from_location_name: string | null;
    to_location_name: string | null;
    effective_date: string;
    reason: string;
    transferred_by_name: string | null;
  }>(
    `SELECT fa.code, fa.name, fl.name AS from_location_name, tl.name AS to_location_name,
            t.effective_date::text AS effective_date, t.reason, u.full_name AS transferred_by_name
       FROM fixed_asset_transfers t
       JOIN fixed_assets fa ON fa.id = t.fixed_asset_id
       LEFT JOIN locations fl ON fl.id = t.from_location_id
       LEFT JOIN locations tl ON tl.id = t.to_location_id
       LEFT JOIN users u ON u.id = t.transferred_by
      WHERE fa.id = ANY($1)
      ORDER BY t.effective_date DESC
      LIMIT ${maxRows + 1}`,
    [assetIds],
  );
  truncated = truncated || transfers.rows.length > maxRows;

  const changes = await query<{
    code: string | null;
    name: string;
    changed_at: string;
    effective_period_key: string;
    old_useful_life_months: number;
    new_useful_life_months: number;
    old_salvage_value: string;
    new_salvage_value: string;
    reason: string;
    changed_by_name: string | null;
  }>(
    `SELECT fa.code, fa.name, c.changed_at::text AS changed_at, c.effective_period_key,
            c.old_useful_life_months, c.new_useful_life_months,
            c.old_salvage_value::text AS old_salvage_value, c.new_salvage_value::text AS new_salvage_value,
            c.reason, u.full_name AS changed_by_name
       FROM fixed_asset_estimate_changes c
       JOIN fixed_assets fa ON fa.id = c.fixed_asset_id
       LEFT JOIN users u ON u.id = c.changed_by
      WHERE fa.id = ANY($1)
      ORDER BY c.changed_at DESC
      LIMIT ${maxRows + 1}`,
    [assetIds],
  );
  truncated = truncated || changes.rows.length > maxRows;

  const disposals = await query<{
    code: string | null;
    name: string;
    disposal_date: string;
    disposal_kind: FixedAssetDisposalKind;
    disposal_proceeds: string | null;
    disposal_reason: string | null;
    cost: string;
    accumulated: string;
  }>(
    `SELECT fa.code, fa.name, fa.disposal_date::text AS disposal_date, fa.disposal_kind,
            fa.disposal_proceeds::text AS disposal_proceeds, fa.disposal_reason,
            fa.cost::text AS cost, COALESCE(live.accumulated, 0)::text AS accumulated
       FROM fixed_assets fa
       LEFT JOIN LATERAL (
         SELECT SUM(d.amount) AS accumulated
           FROM fixed_asset_depreciation_entries d
          WHERE d.fixed_asset_id = fa.id AND d.reversed_at IS NULL
       ) live ON true
      WHERE fa.id = ANY($1) AND fa.status = 'disposed'
      ORDER BY fa.disposal_date DESC, fa.created_at DESC
      LIMIT ${maxRows + 1}`,
    [assetIds],
  );
  truncated = truncated || disposals.rows.length > maxRows;

  const sheets: SheetData[] = [
    {
      name: "دفتر اموال",
      columns: [
        { key: "code", label: "کد دارایی" },
        { key: "name", label: "نام دارایی" },
        { key: "category", label: "دسته" },
        { key: "status", label: "وضعیت" },
        { key: "locationName", label: "شعبه" },
        { key: "acquisitionDate", label: "تاریخ خرید", type: "date" },
        { key: "inServiceDate", label: "تاریخ بهره‌برداری", type: "date" },
        { key: "cost", label: "بهای تمام‌شده", type: "money" },
        { key: "salvageValue", label: "ارزش اسقاط", type: "money" },
        { key: "usefulLifeMonths", label: "عمر مفید (ماه)", type: "integer" },
        { key: "depreciationCount", label: "دوره‌های ثبت‌شده", type: "integer" },
        { key: "accumulatedDepreciation", label: "استهلاک انباشته", type: "money" },
        { key: "bookValue", label: "ارزش دفتری خالص", type: "money" },
        { key: "acquisitionSource", label: "منشأ بهای دارایی" },
        { key: "vendorName", label: "فروشنده" },
        { key: "custodianName", label: "متصدی" },
        { key: "serialNumber", label: "شماره سریال" },
        { key: "purchaseReference", label: "مرجع خرید" },
        { key: "notes", label: "یادداشت" },
      ],
      rows: register.rows.slice(0, maxRows).map((r) => {
        const asset = toFixedAsset(r);
        return {
          code: asset.code ?? "",
          name: asset.name,
          category: asset.category ?? "",
          status: asset.status === "disposed" ? `واگذارشده (${asset.disposalKind ?? ""})` : asset.archivedAt ? "بایگانی‌شده" : asset.fullyDepreciated ? "مستهلک‌شده" : "فعال",
          locationName: asset.locationName ?? "",
          acquisitionDate: asset.acquisitionDate,
          inServiceDate: asset.inServiceDate,
          cost: asset.cost,
          salvageValue: asset.salvageValue,
          usefulLifeMonths: asset.usefulLifeMonths,
          depreciationCount: asset.depreciationCount ?? 0,
          accumulatedDepreciation: asset.accumulatedDepreciation,
          bookValue: asset.bookValue,
          acquisitionSource: asset.acquisitionSource,
          vendorName: asset.vendorName ?? "",
          custodianName: asset.custodianName ?? "",
          serialNumber: asset.serialNumber ?? "",
          purchaseReference: asset.purchaseReference ?? "",
          notes: asset.notes ?? "",
        };
      }),
    },
    {
      name: "برنامه استهلاک",
      columns: [
        { key: "code", label: "کد دارایی" },
        { key: "name", label: "نام دارایی" },
        { key: "period", label: "دوره" },
        { key: "entryDate", label: "تاریخ سند", type: "date" },
        { key: "amount", label: "مبلغ استهلاک", type: "money" },
        { key: "reversed", label: "برگشت خورده" },
        { key: "createdByName", label: "ثبت‌کننده" },
        { key: "locationName", label: "شعبه" },
      ],
      rows: schedule.rows.slice(0, maxRows).map((r) => ({
        code: r.code ?? "",
        name: r.name,
        period: r.period_key ? `${r.period_key} (${r.period_label})` : r.period_label,
        entryDate: r.entry_date,
        amount: Number(r.amount),
        reversed: r.reversed_at ? "بله" : "خیر",
        createdByName: r.created_by_name ?? "",
        locationName: r.location_name ?? "",
      })),
    },
  ];

  const DISPOSAL_KIND_LABELS: Record<FixedAssetDisposalKind, string> = {
    sale: "فروش",
    retirement: "بازنشستگی",
    write_off: "اسقاط",
  };

  if (disposals.rows.length > 0) {
    sheets.push({
      name: "واگذاری‌ها",
      columns: [
        { key: "code", label: "کد دارایی" },
        { key: "name", label: "نام دارایی" },
        { key: "kind", label: "نوع واگذاری" },
        { key: "disposalDate", label: "تاریخ واگذاری", type: "date" },
        { key: "cost", label: "بهای تمام‌شده", type: "money" },
        { key: "accumulated", label: "استهلاک انباشته", type: "money" },
        { key: "netBookValue", label: "ارزش دفتری خالص", type: "money" },
        { key: "proceeds", label: "مبلغ واگذاری", type: "money" },
        { key: "gainLoss", label: "سود (+) / زیان (−)", type: "money" },
        { key: "reason", label: "دلیل" },
      ],
      rows: disposals.rows.slice(0, maxRows).map((r) => {
        const cost = Number(r.cost);
        const accumulated = Number(r.accumulated);
        const proceeds = Number(r.disposal_proceeds ?? 0);
        const netBookValue = Math.max(0, cost - accumulated);
        return {
          code: r.code ?? "",
          name: r.name,
          kind: DISPOSAL_KIND_LABELS[r.disposal_kind] ?? r.disposal_kind,
          disposalDate: r.disposal_date,
          cost,
          accumulated,
          netBookValue,
          proceeds,
          gainLoss: proceeds - netBookValue,
          reason: r.disposal_reason ?? "",
        };
      }),
    });
  }

  if (transfers.rows.length > 0) {
    sheets.push({
      name: "انتقال شعب",
      columns: [
        { key: "code", label: "کد دارایی" },
        { key: "name", label: "نام دارایی" },
        { key: "from", label: "از شعبه" },
        { key: "to", label: "به شعبه" },
        { key: "effectiveDate", label: "تاریخ مؤثر", type: "date" },
        { key: "reason", label: "دلیل" },
        { key: "transferredByName", label: "انتقال‌دهنده" },
      ],
      rows: transfers.rows.slice(0, maxRows).map((r) => ({
        code: r.code ?? "",
        name: r.name,
        from: r.from_location_name ?? "",
        to: r.to_location_name ?? "",
        effectiveDate: r.effective_date,
        reason: r.reason,
        transferredByName: r.transferred_by_name ?? "",
      })),
    });
  }

  if (changes.rows.length > 0) {
    sheets.push({
      name: "تغییر برآوردها",
      columns: [
        { key: "code", label: "کد دارایی" },
        { key: "name", label: "نام دارایی" },
        { key: "changedAt", label: "تاریخ تغییر" },
        { key: "life", label: "عمر مفید (قدیم ← جدید)" },
        { key: "salvage", label: "ارزش اسقاط (قدیم ← جدید)" },
        { key: "reason", label: "دلیل" },
        { key: "changedByName", label: "تغییردهنده" },
      ],
      rows: changes.rows.slice(0, maxRows).map((r) => ({
        code: r.code ?? "",
        name: r.name,
        changedAt: r.changed_at,
        life: `${r.old_useful_life_months} ← ${r.new_useful_life_months}`,
        salvage: `${Number(r.old_salvage_value)} ← ${Number(r.new_salvage_value)}`,
        reason: r.reason,
        changedByName: r.changed_by_name ?? "",
      })),
    });
  }

  return {
    sheets,
    truncated,
    registerTotal: assetIds.length,
    maxRows,
  };
}

/**
 * The sheet the export route puts in front of a truncated workbook (issue
 * #833): the reader is told, in the workbook itself, that what they hold is
 * partial and how to get the rest — a silently short export is an accounting
 * report that lies by omission.
 */
export function fixedAssetExportTruncationNotice(registerTotal: number, maxRows: number): SheetData {
  return {
    name: "توجه",
    columns: [{ key: "message", label: "محدودیت خروجی" }],
    rows: [
      {
        message:
          `این خروجی در سقف ${maxRows.toLocaleString("fa-IR")} ردیف در هر برگه محدود شده است؛ ` +
          `دفتر اموال شما ${registerTotal.toLocaleString("fa-IR")} ردیف دارد و فقط ${maxRows.toLocaleString("fa-IR")} ردیف نخست هر برگه آمده است. ` +
          "برای دریافت کامل، فیلترها را محدودتر کنید (مثلاً دسته، شعبه یا بازهٔ تاریخ).",
      },
    ],
  };
}
