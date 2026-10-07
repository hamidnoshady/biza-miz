/**
 * Phase 22 Wave 5, second slice — fixed-asset register & depreciation
 * (issue #160 §2), the DB-touching part. Pure math lives in
 * depreciation.ts (validateFixedAsset, monthlyDepreciation,
 * depreciationForPeriod) and is what depreciation.test.ts covers.
 *
 * accumulatedDepreciation/bookValue are always reconstructed from
 * fixed_asset_depreciation_entries — never a shadow column on the asset
 * row — the same discipline ar-service.ts/ap-service.ts already use for
 * their control-account balances. Depreciation posts a real, immediate
 * entry (Debit depreciationExpense / Credit accumulatedDepreciation)
 * through the same postJournalEntry() every other posting path uses, so
 * it's subject to the fiscal-period lock exactly like everything else.
 */
import type { PoolClient } from "pg";
import { getPool, query } from "./db";
import { accountIdsByCode, postJournalEntry } from "./ledger-service";
import { WELL_KNOWN_CODES } from "./coa-template";
import { businessToday } from "./business-day-service";
import {
  depreciationPeriodOfDate,
  planDepreciation,
  reconcileFixedAssetRegister,
  validateFixedAsset,
  type FixedAssetReconciliation,
} from "./depreciation";

export class FixedAssetError extends Error {
  status: number;
  constructor(code: string, status = 400) {
    super(code);
    this.status = status;
  }
}

export interface FixedAsset {
  id: string;
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
}

export type FixedAssetAcquisitionSource = "journal" | "opening_balance" | "unlinked";
const ACQUISITION_SOURCES: ReadonlySet<string> = new Set(["journal", "opening_balance", "unlinked"]);

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
}

interface FixedAssetRow extends Record<string, unknown> {
  id: string;
  name: string;
  acquisition_date: string;
  in_service_date: string;
  acquisition_source: FixedAssetAcquisitionSource;
  acquisition_entry_id: string | null;
  cost: string;
  salvage_value: string;
  useful_life_months: number;
  accumulated_depreciation: string;
  created_at: string;
  depreciation_count?: number;
  location_id?: string | null;
  location_name?: string | null;
}

const SELECT_FIXED_ASSETS = `
  SELECT fa.id, fa.location_id, l.name AS location_name, fa.name,
         fa.acquisition_date::text AS acquisition_date,
         COALESCE(fa.in_service_date, fa.acquisition_date)::text AS in_service_date,
         fa.acquisition_source, fa.acquisition_entry_id, fa.cost::text AS cost,
         fa.salvage_value::text AS salvage_value, fa.useful_life_months, fa.created_at::text AS created_at,
         COALESCE(SUM(d.amount), 0)::text AS accumulated_depreciation,
         COUNT(d.id)::int AS depreciation_count
    FROM fixed_assets fa
    LEFT JOIN locations l ON l.id = fa.location_id
    LEFT JOIN fixed_asset_depreciation_entries d ON d.fixed_asset_id = fa.id
   WHERE fa.business_id = $1
   GROUP BY fa.id, l.name
   ORDER BY fa.acquisition_date DESC, fa.created_at DESC`;

function toFixedAsset(r: FixedAssetRow): FixedAsset {
  const cost = Number(r.cost);
  const accumulatedDepreciation = Number(r.accumulated_depreciation);
  return {
    id: r.id,
    name: r.name,
    acquisitionDate: r.acquisition_date,
    inServiceDate: r.in_service_date,
    acquisitionSource: r.acquisition_source,
    acquisitionEntryId: r.acquisition_entry_id,
    cost,
    salvageValue: Number(r.salvage_value),
    usefulLifeMonths: r.useful_life_months,
    accumulatedDepreciation,
    bookValue: cost - accumulatedDepreciation,
    createdAt: r.created_at,
    depreciationCount: Number(r.depreciation_count ?? 0),
    locationId: (r.location_id as string) ?? null,
    locationName: (r.location_name as string) ?? null,
  };
}

export async function listFixedAssets(businessId: string): Promise<FixedAsset[]> {
  const { rows } = await query<FixedAssetRow>(SELECT_FIXED_ASSETS, [businessId]);
  return rows.map(toFixedAsset);
}

export async function getFixedAssetWithDepreciation(
  businessId: string,
  id: string,
): Promise<{
  fixedAsset: FixedAsset;
  depreciationEntries: FixedAssetDepreciationEntry[];
}> {
  const { rows } = await query<FixedAssetRow>(
    `SELECT fa.id, fa.location_id, l.name AS location_name, fa.name,
            fa.acquisition_date::text AS acquisition_date,
         COALESCE(fa.in_service_date, fa.acquisition_date)::text AS in_service_date,
         fa.acquisition_source, fa.acquisition_entry_id, fa.cost::text AS cost,
            fa.salvage_value::text AS salvage_value, fa.useful_life_months, fa.created_at::text AS created_at,
            COALESCE(SUM(d.amount), 0)::text AS accumulated_depreciation,
            COUNT(d.id)::int AS depreciation_count
       FROM fixed_assets fa
       LEFT JOIN locations l ON l.id = fa.location_id
       LEFT JOIN fixed_asset_depreciation_entries d ON d.fixed_asset_id = fa.id
      WHERE fa.business_id = $1 AND fa.id = $2
      GROUP BY fa.id, l.name`,
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
  }>(
    `SELECT d.id, d.fixed_asset_id, d.period_key, d.period_label, d.entry_date::text AS entry_date,
            d.amount::text AS amount, d.created_by, u.full_name AS created_by_name,
            d.created_at::text AS created_at, je.id AS journal_entry_id
       FROM fixed_asset_depreciation_entries d
       JOIN fixed_assets fa ON fa.id = d.fixed_asset_id
       LEFT JOIN users u ON u.id = d.created_by
       LEFT JOIN journal_entries je ON je.source_type = 'fixed_asset_depreciation' AND je.source_id = d.id
      WHERE fa.business_id = $1 AND d.fixed_asset_id = $2
      ORDER BY d.entry_date DESC, d.created_at DESC`,
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
    })),
  };
}

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
}): Promise<FixedAsset> {
  const errors = validateFixedAsset(params);
  if (errors.length > 0) throw new FixedAssetError(errors.join(" "));
  const link = normaliseAcquisitionLink(params.acquisitionSource, params.acquisitionEntryId);
  const inServiceDate = params.inServiceDate?.trim() || null;

  const client = await getPool().connect();
  let id: string;
  try {
    await client.query("BEGIN");
    if (link.entryId) await assertAcquisitionEntryCovers(client, params.businessId, link.entryId, params.cost, null);
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO fixed_assets
         (business_id, location_id, name, acquisition_date, in_service_date, cost, salvage_value,
          useful_life_months, acquisition_source, acquisition_entry_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
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
      ],
    );
    id = rows[0].id;
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  return (await getFixedAssetWithDepreciation(params.businessId, id)).fixedAsset;
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
 * The fixed-asset accounts are the 1500–1599 asset block (and numeric
 * extensions such as 150001); accumulated depreciation is the contra part of
 * it (`is_contra`, or 1510 and its extensions for a chart that predates the
 * flag). One definition, used by the link check, the candidate list and the
 * reconciliation.
 */
const FIXED_ASSET_ACCOUNT_SQL = `a.type = 'asset' AND a.code ~ '^15[0-9]{2}[0-9]*$'`;
const ACCUMULATED_ACCOUNT_SQL = `(a.is_contra OR a.code ~ '^1510[0-9]*$')`;

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
    const { rows } = await client.query<{ cost: string }>(
      `SELECT cost::text AS cost FROM fixed_assets WHERE business_id = $1 AND id = $2 FOR UPDATE`,
      [params.businessId, params.fixedAssetId],
    );
    if (!rows[0]) throw new FixedAssetError("fixed_asset_not_found", 404);
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
       (SELECT COALESCE(SUM(cost), 0) FROM fixed_assets WHERE business_id = $1)::text AS register_cost,
       (SELECT COALESCE(SUM(d.amount), 0) FROM fixed_asset_depreciation_entries d
          JOIN fixed_assets fa ON fa.id = d.fixed_asset_id WHERE fa.business_id = $1)::text AS register_accumulated,
       (SELECT count(*) FROM fixed_assets WHERE business_id = $1 AND acquisition_source = 'unlinked')::int AS unlinked_count,
       (SELECT COALESCE(SUM(cost), 0) FROM fixed_assets
         WHERE business_id = $1 AND acquisition_source = 'unlinked')::text AS unlinked_cost,
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

/** Only ever succeeds for an asset with no depreciation posted yet — otherwise the history it caused would go missing. */
export async function deleteFixedAsset(businessId: string, id: string): Promise<void> {
  const { rows } = await query<{ id: string }>(`SELECT id FROM fixed_assets WHERE business_id = $1 AND id = $2`, [
    businessId,
    id,
  ]);
  if (!rows[0]) throw new FixedAssetError("fixed_asset_not_found", 404);

  const { rows: depreciated } = await query(`SELECT 1 FROM fixed_asset_depreciation_entries WHERE fixed_asset_id = $1 LIMIT 1`, [
    id,
  ]);
  if (depreciated.length > 0) throw new FixedAssetError("fixed_asset_has_depreciation", 409);

  await query(`DELETE FROM fixed_assets WHERE business_id = $1 AND id = $2`, [businessId, id]);
}

/**
 * Posts one Jalali month's straight-line depreciation for one asset — audit
 * F07. Everything that decides the amount is read inside one transaction,
 * after `SELECT … FOR UPDATE` on the asset row, so two requests for the same
 * asset serialise: the second sees the first's entry and either refuses the
 * month or computes the next amount from the new accumulated total. The rules
 * (canonical month, in-service date, cap at cost − salvage) are the pure
 * `planDepreciation`; the partial UNIQUE index on (asset, period_key) is the
 * database's own backstop.
 *
 * `periodLabel` is only a memo now; the period is `periodKey` (`YYYY-MM`,
 * Jalali) or, when absent, the month of `entryDate` (or of the business's
 * today).
 */
export async function postDepreciation(params: {
  businessId: string;
  locationId: string | null;
  fixedAssetId: string;
  periodKey?: string | null;
  periodLabel?: string | null;
  entryDate?: string | null;
  createdBy: string | null;
}): Promise<{ amount: number; periodKey: string; periodLabel: string; entryDate: string }> {
  const memoLabel = params.periodLabel?.trim() ?? "";
  if (memoLabel.length > 120) throw new FixedAssetError("period_label_too_long");
  const today = await businessToday(params.businessId);

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    const { rows: assetRows } = await client.query<{
      cost: string;
      salvage_value: string;
      useful_life_months: number;
      in_service_date: string;
    }>(
      `SELECT cost::text AS cost, salvage_value::text AS salvage_value, useful_life_months,
              COALESCE(in_service_date, acquisition_date)::text AS in_service_date
         FROM fixed_assets WHERE business_id = $1 AND id = $2
        FOR UPDATE`,
      [params.businessId, params.fixedAssetId],
    );
    if (!assetRows[0]) throw new FixedAssetError("fixed_asset_not_found", 404);

    const { rows: posted } = await client.query<{ period_key: string | null; entry_date: string; amount: string }>(
      `SELECT period_key, entry_date::text AS entry_date, amount::text AS amount
         FROM fixed_asset_depreciation_entries WHERE fixed_asset_id = $1`,
      [params.fixedAssetId],
    );
    const postedPeriodKeys = posted.map((r) => r.period_key ?? depreciationPeriodOfDate(r.entry_date)?.key ?? r.entry_date);
    const accumulatedSoFar = posted.reduce((sum, r) => sum + Number(r.amount), 0);

    const plan = planDepreciation({
      asset: {
        cost: Number(assetRows[0].cost),
        salvageValue: Number(assetRows[0].salvage_value),
        usefulLifeMonths: assetRows[0].useful_life_months,
        inServiceDate: assetRows[0].in_service_date,
      },
      postedPeriodKeys,
      accumulatedSoFar,
      periodKey: params.periodKey,
      entryDate: params.entryDate,
      today,
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
        [params.fixedAssetId, plan.period.key, label, plan.entryDate, plan.amount, params.createdBy],
      );
      depreciationEntryId = rows[0].id;
    } catch (err) {
      if (err instanceof Error && "code" in err && (err as { code?: string }).code === "23505") {
        throw new FixedAssetError("period_already_depreciated", 409);
      }
      throw err;
    }

    const accounts = await accountIdsByCode(client, params.businessId, [
      WELL_KNOWN_CODES.depreciationExpense,
      WELL_KNOWN_CODES.accumulatedDepreciation,
    ]);
    await postJournalEntry(client, {
      businessId: params.businessId,
      locationId: params.locationId,
      entryDate: plan.entryDate,
      memo: `استهلاک — ${label}`,
      sourceType: "fixed_asset_depreciation",
      sourceId: depreciationEntryId,
      createdBy: params.createdBy,
      lines: [
        { accountId: accounts.get(WELL_KNOWN_CODES.depreciationExpense)!, debit: plan.amount, credit: 0 },
        { accountId: accounts.get(WELL_KNOWN_CODES.accumulatedDepreciation)!, debit: 0, credit: plan.amount },
      ],
    });

    await client.query("COMMIT");
    return { amount: plan.amount, periodKey: plan.period.key, periodLabel: label, entryDate: plan.entryDate };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
