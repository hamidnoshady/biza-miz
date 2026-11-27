/**
 * Intangible-asset register, amortization, impairment and disposal — the
 * DB-touching part (issue #1326). The accounting rules live in
 * `intangible-assets.ts`; this module only reads, locks and posts.
 *
 * The rules it enforces, mirroring the fixed-asset service's discipline:
 *
 *   * every amount is decided inside one transaction after
 *     `SELECT … FOR UPDATE` on the asset row, so two requests for the same
 *     asset serialise and neither can double-post a month;
 *   * accumulated amortization/impairment and the carrying amount are always
 *     reconstructed from LIVE history (a reversal is simply absent) — there is
 *     no balance column on the asset row;
 *   * posted history is never rewritten: amortization and impairment are
 *     reversed (marked and mirrored in the ledger), never deleted;
 *   * the posting identity is canonical — `(source_type, source_id,
 *     posting_kind)` with the stable kinds `acquisition`, `amortization`,
 *     `impairment`, `reversal` and `disposal`;
 *   * an indefinite-life asset is refused by `postAmortization` outright, and
 *     is reviewed through `assessImpairment` instead;
 *   * the asset's own branch gets the entry, never the operator's current one.
 *
 * `finance.assets_manage` is the one capability the routes check for reads and
 * writes, exactly as the fixed-asset register does.
 */
import type { PoolClient } from "pg";
import type { SheetData } from "./data-transfer/codecs";
import { getPool, query } from "./db";
import { postExactMirrorEntry, postJournalEntry } from "./ledger-service";
import { WELL_KNOWN_CODES } from "./coa-template";
import { businessToday } from "./business-day-service";
import { isValidIsoDate } from "./jalali";
import { isUuid } from "./uuid";
import { addMonthsToPeriodKey, depreciationPeriodOfDate } from "./depreciation";
import {
  DISPOSAL_KIND_LABELS,
  INTANGIBLE_ASSET_CLASS_LABELS,
  INTANGIBLE_REASON_MAX_LENGTH,
  INTANGIBLE_USEFUL_LIFE_MAX_MONTHS,
  USEFUL_LIFE_TYPE_LABELS,
  amortizableBase,
  impairmentCharge,
  intangibleDisposalOutcome,
  intrinsicCarryingAmount,
  planAmortization,
  projectAmortization,
  reconcileIntangibleRegister,
  reversibleImpairment,
  validateIntangibleAsset,
  type AmortizationRevision,
  type AmortizationScheduleRow,
  type AmortizationScheduleTotals,
  type DisposalKind,
  type IntangibleAssetClass,
  type IntangibleReconciliation,
  type UsefulLifeType,
} from "./intangible-assets";

export class IntangibleAssetError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "IntangibleAssetError";
    this.status = status;
  }
}

export interface IntangibleAsset {
  id: string;
  code: string;
  name: string;
  description: string | null;
  assetClass: IntangibleAssetClass;
  acquisitionDate: string;
  availableForUseDate: string;
  acquisitionSource: string;
  cost: number;
  directlyAttributableCost: number;
  usefulLifeType: UsefulLifeType;
  usefulLifeMonths: number | null;
  residualValue: number;
  assetAccountId: string | null;
  accumulatedAmortizationAccountId: string | null;
  amortizationExpenseAccountId: string | null;
  impairmentLossAccountId: string | null;
  accumulatedImpairmentAccountId: string | null;
  capitalizationPolicyNote: string | null;
  capitalizedByName: string | null;
  evidenceReference: string | null;
  custodianPartyId: string | null;
  notes: string | null;
  status: "active" | "disposed";
  locationId: string | null;
  disposalKind: DisposalKind | null;
  disposalDate: string | null;
  disposalProceeds: number | null;
  disposalReason: string | null;
  /** Derived: sum of live amortization postings. */
  accumulatedAmortization: number;
  /** Derived: outstanding (posted minus reversed) impairment. */
  accumulatedImpairment: number;
  /** cost − accumulated amortization − accumulated impairment. */
  carryingAmount: number;
  amortizableBase: number;
  /** Finite life left after the months already posted; null for indefinite. */
  remainingLifeMonths: number | null;
  periodsPosted: number;
  locationName: string | null;
  custodianName: string | null;
  lastPostingDate: string | null;
  lastReviewDate: string | null;
  createdAt: string;
}

interface AssetRow extends Record<string, unknown> {
  id: string;
  code: string;
  name: string;
  description: string | null;
  asset_class: IntangibleAssetClass;
  acquisition_date: string;
  available_for_use_date: string | null;
  acquisition_source: string;
  cost: string;
  directly_attributable_cost: string;
  useful_life_type: UsefulLifeType;
  useful_life_months: number | null;
  residual_value: string;
  asset_account_id: string | null;
  accumulated_amortization_account_id: string | null;
  amortization_expense_account_id: string | null;
  impairment_loss_account_id: string | null;
  accumulated_impairment_account_id: string | null;
  capitalization_policy_note: string | null;
  capitalized_by_name: string | null;
  evidence_reference: string | null;
  custodian_party_id: string | null;
  notes: string | null;
  status: "active" | "disposed";
  location_id: string | null;
  disposal_kind: DisposalKind | null;
  disposal_date: string | null;
  disposal_proceeds: string | null;
  disposal_reason: string | null;
  accumulated_amortization: string;
  accumulated_impairment: string;
  periods_posted: string;
  location_name: string | null;
  custodian_name: string | null;
  last_posting_date: string | null;
  last_review_date: string | null;
  created_at: string;
}

/**
 * The projection every read shares: live totals attached to the row. The
 * impairment sum nets a reversal row against the assessment it names, so a
 * partially reversed assessment keeps exactly its remaining amount.
 */
const ASSET_SELECT = `
  SELECT a.id, a.code, a.name, a.description, a.asset_class,
         a.acquisition_date::text AS acquisition_date,
         a.available_for_use_date::text AS available_for_use_date,
         a.acquisition_source,
         a.cost::text AS cost,
         a.directly_attributable_cost::text AS directly_attributable_cost,
         a.useful_life_type, a.useful_life_months,
         a.residual_value::text AS residual_value,
         a.asset_account_id, a.accumulated_amortization_account_id,
         a.amortization_expense_account_id, a.impairment_loss_account_id,
         a.accumulated_impairment_account_id,
         a.capitalization_policy_note, cu.full_name AS capitalized_by_name,
         a.evidence_reference, a.custodian_party_id, a.notes,
         a.status, a.location_id, a.disposal_kind,
         a.disposal_date::text AS disposal_date,
         a.disposal_proceeds::text AS disposal_proceeds,
         a.disposal_reason,
         a.created_at::text AS created_at,
         l.name AS location_name, p.name AS custodian_name,
         (SELECT max(e.entry_date)::text FROM intangible_asset_amortization_entries e
           WHERE e.intangible_asset_id = a.id AND e.reversed_at IS NULL) AS last_posting_date,
         (SELECT max(i.effective_date)::text FROM intangible_asset_impairments i
           WHERE i.intangible_asset_id = a.id AND i.reversal_of IS NULL) AS last_review_date,
         (SELECT count(*) FROM intangible_asset_amortization_entries e
           WHERE e.intangible_asset_id = a.id AND e.reversed_at IS NULL)::text AS periods_posted,
         COALESCE((
           SELECT SUM(e.amount) FROM intangible_asset_amortization_entries e
            WHERE e.intangible_asset_id = a.id AND e.reversed_at IS NULL
         ), 0)::text AS accumulated_amortization,
         (
           COALESCE((
             SELECT SUM(i.impairment_amount) FROM intangible_asset_impairments i
              WHERE i.intangible_asset_id = a.id AND i.reversal_of IS NULL AND i.reversed_at IS NULL
           ), 0)
           - COALESCE((
             SELECT SUM(i.impairment_amount) FROM intangible_asset_impairments i
              WHERE i.intangible_asset_id = a.id AND i.reversal_of IS NOT NULL
           ), 0)
         )::text AS accumulated_impairment
         FROM intangible_assets a
     LEFT JOIN locations l ON l.id = a.location_id
     LEFT JOIN parties p ON p.id = a.custodian_party_id
     LEFT JOIN users cu ON cu.id = a.capitalized_by`;

function toAsset(r: AssetRow): IntangibleAsset {
  const cost = Number(r.cost);
  const accumulatedAmortization = Number(r.accumulated_amortization);
  const accumulatedImpairment = Math.max(0, Number(r.accumulated_impairment));
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    description: r.description,
    assetClass: r.asset_class,
    acquisitionDate: r.acquisition_date,
    availableForUseDate: r.available_for_use_date ?? r.acquisition_date,
    acquisitionSource: r.acquisition_source,
    cost,
    directlyAttributableCost: Number(r.directly_attributable_cost),
    usefulLifeType: r.useful_life_type,
    usefulLifeMonths: r.useful_life_months,
    residualValue: Number(r.residual_value),
    assetAccountId: r.asset_account_id,
    accumulatedAmortizationAccountId: r.accumulated_amortization_account_id,
    amortizationExpenseAccountId: r.amortization_expense_account_id,
    impairmentLossAccountId: r.impairment_loss_account_id,
    accumulatedImpairmentAccountId: r.accumulated_impairment_account_id,
    capitalizationPolicyNote: r.capitalization_policy_note,
    capitalizedByName: r.capitalized_by_name,
    evidenceReference: r.evidence_reference,
    custodianPartyId: r.custodian_party_id,
    notes: r.notes,
    status: r.status,
    locationId: r.location_id,
    disposalKind: r.disposal_kind,
    disposalDate: r.disposal_date,
    disposalProceeds: r.disposal_proceeds === null ? null : Number(r.disposal_proceeds),
    disposalReason: r.disposal_reason,
    accumulatedAmortization,
    accumulatedImpairment,
    carryingAmount: intrinsicCarryingAmount({ cost, accumulatedAmortization, accumulatedImpairment }),
    amortizableBase: amortizableBase({ cost, residualValue: Number(r.residual_value) }),
    remainingLifeMonths:
      r.useful_life_type === "finite" && r.useful_life_months
        ? Math.max(0, r.useful_life_months - Number(r.periods_posted))
        : null,
    periodsPosted: Number(r.periods_posted),
    locationName: r.location_name,
    custodianName: r.custodian_name,
    lastPostingDate: r.last_posting_date,
    lastReviewDate: r.last_review_date,
    createdAt: r.created_at,
  };
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: string }).code === "23505";
}

async function assertAccountOfBusiness(
  client: PoolClient,
  businessId: string,
  accountId: string,
  allowedTypes: string[],
  errorCode: string,
): Promise<void> {
  if (!isUuid(accountId)) throw new IntangibleAssetError(errorCode);
  const { rows } = await client.query<{ type: string; is_active: boolean }>(
    `SELECT type, is_active FROM accounts WHERE business_id = $1 AND id = $2`,
    [businessId, accountId],
  );
  const account = rows[0];
  if (!account || !account.is_active || !allowedTypes.includes(account.type)) {
    throw new IntangibleAssetError(errorCode);
  }
}

async function assertLocationOfBusiness(client: PoolClient, businessId: string, locationId: string): Promise<void> {
  if (!isUuid(locationId)) throw new IntangibleAssetError("location_not_found", 404);
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM locations WHERE business_id = $1 AND id = $2`,
    [businessId, locationId],
  );
  if (!rows[0]) throw new IntangibleAssetError("location_not_found", 404);
}

/** Next `IA-0001` code for the business, under a per-business advisory lock. */
async function nextCode(client: PoolClient, businessId: string): Promise<string> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`intangible-code:${businessId}`]);
  const { rows } = await client.query<{ max: string | null }>(
    `SELECT max(substring(code from '^IA-([0-9]+)$')) AS max
       FROM intangible_assets WHERE business_id = $1`,
    [businessId],
  );
  const next = Number(rows[0]?.max ?? "0") + 1;
  return `IA-${String(next).padStart(4, "0")}`;
}

export interface CreateIntangibleAssetParams {
  businessId: string;
  locationId: string | null;
  name: string;
  code?: string | null;
  description?: string | null;
  assetClass: string;
  acquisitionDate: string;
  availableForUseDate?: string | null;
  acquisitionSource?: string | null;
  cost: number;
  directlyAttributableCost?: number | null;
  usefulLifeType: string;
  usefulLifeMonths?: number | null;
  residualValue?: number | null;
  assetAccountId: string | null;
  accumulatedAmortizationAccountId: string | null;
  amortizationExpenseAccountId: string | null;
  impairmentLossAccountId?: string | null;
  accumulatedImpairmentAccountId?: string | null;
  capitalizationPolicyNote?: string | null;
  capitalizedBy?: string | null;
  evidenceReference?: string | null;
  custodianPartyId?: string | null;
  notes?: string | null;
  /** Post Dr asset account / Cr this settlement account with the registration. */
  acquisition?: { sourceAccountId: string; entryDate?: string | null } | null;
  createdBy: string | null;
  idempotencyKey?: string | null;
}

/**
 * Registers an intangible. Capitalization is always an explicit, attributed
 * decision: the policy note and the approving user are validated, not defaulted
 * (issue #1326 §1). With `acquisition`, the purchase entry posts in the same
 * transaction so the register and the ledger start from the same fact.
 */
export async function createIntangibleAsset(params: CreateIntangibleAssetParams): Promise<IntangibleAsset> {
  const errors = validateIntangibleAsset({
    name: params.name,
    code: params.code,
    assetClass: params.assetClass,
    acquisitionDate: params.acquisitionDate,
    availableForUseDate: params.availableForUseDate,
    acquisitionSource: params.acquisitionSource,
    cost: params.cost,
    directlyAttributableCost: params.directlyAttributableCost,
    usefulLifeType: params.usefulLifeType,
    usefulLifeMonths: params.usefulLifeMonths,
    residualValue: params.residualValue,
    capitalizationPolicyNote: params.capitalizationPolicyNote,
  });
  if (errors.length > 0) throw new IntangibleAssetError(errors.join(" "));

  const usefulLifeType = params.usefulLifeType as UsefulLifeType;
  const acquisitionDate = params.acquisitionDate.trim();
  const availableForUseDate = params.availableForUseDate?.trim() || acquisitionDate;
  if (!isValidIsoDate(acquisitionDate) || !isValidIsoDate(availableForUseDate)) {
    throw new IntangibleAssetError("invalid_date");
  }
  if (!params.assetAccountId) throw new IntangibleAssetError("asset_account_required");
  if (usefulLifeType === "finite") {
    if (!params.accumulatedAmortizationAccountId) {
      throw new IntangibleAssetError("accumulated_amortization_account_required");
    }
    if (!params.amortizationExpenseAccountId) throw new IntangibleAssetError("amortization_expense_account_required");
  }
  if (params.acquisition?.entryDate && !isValidIsoDate(params.acquisition.entryDate.trim())) {
    throw new IntangibleAssetError("invalid_acquisition_date");
  }
  const idempotencyKey = params.idempotencyKey?.trim() || null;
  if (idempotencyKey && idempotencyKey.length > 120) throw new IntangibleAssetError("idempotency_key_too_long");

  const client = await getPool().connect();
  let assetId: string;
  try {
    await client.query("BEGIN");
    if (params.locationId) await assertLocationOfBusiness(client, params.businessId, params.locationId);
    await assertAccountOfBusiness(client, params.businessId, params.assetAccountId, ["asset"], "invalid_asset_account");
    if (params.accumulatedAmortizationAccountId) {
      await assertAccountOfBusiness(
        client,
        params.businessId,
        params.accumulatedAmortizationAccountId,
        ["asset"],
        "invalid_accumulated_amortization_account",
      );
    }
    if (params.amortizationExpenseAccountId) {
      await assertAccountOfBusiness(
        client,
        params.businessId,
        params.amortizationExpenseAccountId,
        ["expense"],
        "invalid_amortization_expense_account",
      );
    }
    if (params.impairmentLossAccountId) {
      await assertAccountOfBusiness(
        client,
        params.businessId,
        params.impairmentLossAccountId,
        ["expense"],
        "invalid_impairment_loss_account",
      );
    }
    if (params.accumulatedImpairmentAccountId) {
      await assertAccountOfBusiness(
        client,
        params.businessId,
        params.accumulatedImpairmentAccountId,
        ["asset"],
        "invalid_accumulated_impairment_account",
      );
    }
    if (params.acquisition) {
      await assertAccountOfBusiness(
        client,
        params.businessId,
        params.acquisition.sourceAccountId,
        ["asset"],
        "invalid_acquisition_account",
      );
    }

    if (idempotencyKey) {
      const { rows } = await client.query<{ id: string }>(
        `SELECT id FROM intangible_assets WHERE business_id = $1 AND idempotency_key = $2`,
        [params.businessId, idempotencyKey],
      );
      if (rows[0]) {
        await client.query("COMMIT");
        const existing = await getIntangibleAsset(params.businessId, rows[0].id);
        if (!existing) throw new IntangibleAssetError("intangible_asset_not_found", 404);
        return existing.asset;
      }
    }

    const code = params.code?.trim() || (await nextCode(client, params.businessId));
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO intangible_assets
         (business_id, location_id, code, name, description, asset_class, acquisition_date,
          available_for_use_date, acquisition_source, cost, directly_attributable_cost,
          useful_life_type, useful_life_months, residual_value, asset_account_id,
          accumulated_amortization_account_id, amortization_expense_account_id,
          impairment_loss_account_id, accumulated_impairment_account_id,
          capitalization_policy_note, capitalized_by, evidence_reference, custodian_party_id,
          notes, idempotency_key, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19,
               $20, $21, $22, $23, $24, $25, $26)
       RETURNING id`,
      [
        params.businessId,
        params.locationId,
        code,
        params.name.trim(),
        params.description?.trim() || null,
        params.assetClass,
        acquisitionDate,
        availableForUseDate,
        params.acquisitionSource?.trim() || "purchase",
        params.cost,
        params.directlyAttributableCost ?? 0,
        usefulLifeType,
        usefulLifeType === "finite" ? params.usefulLifeMonths : null,
        params.residualValue ?? 0,
        params.assetAccountId,
        params.accumulatedAmortizationAccountId,
        params.amortizationExpenseAccountId,
        params.impairmentLossAccountId ?? null,
        params.accumulatedImpairmentAccountId ?? null,
        params.capitalizationPolicyNote?.trim() || null,
        params.capitalizedBy ?? params.createdBy,
        params.evidenceReference?.trim() || null,
        params.custodianPartyId ?? null,
        params.notes?.trim() || null,
        idempotencyKey,
        params.createdBy,
      ],
    );
    assetId = rows[0].id;

    if (params.acquisition) {
      const entryDate = params.acquisition.entryDate?.trim() || acquisitionDate;
      await postJournalEntry(client, {
        businessId: params.businessId,
        locationId: params.locationId,
        entryDate,
        memo: `تحصیل دارایی نامشهود — ${params.name.trim()}`,
        sourceType: "intangible_asset_acquisition",
        sourceId: assetId,
        postingKind: "acquisition",
        createdBy: params.createdBy,
        lines: [
          { accountId: params.assetAccountId, debit: params.cost, credit: 0 },
          { accountId: params.acquisition.sourceAccountId, debit: 0, credit: params.cost },
        ],
      });
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    if (err instanceof IntangibleAssetError) throw err;
    if (isUniqueViolation(err)) throw new IntangibleAssetError("intangible_asset_code_in_use", 409);
    throw err;
  } finally {
    client.release();
  }

  const asset = await getIntangibleAsset(params.businessId, assetId!);
  if (!asset) throw new IntangibleAssetError("intangible_asset_not_found", 404);
  return asset.asset;
}

export interface IntangibleListFilters {
  search?: string | null;
  status?: "active" | "disposed" | null;
  assetClass?: string | null;
  usefulLifeType?: UsefulLifeType | null;
  locationId?: string | null;
  dateFrom?: string | null;
  dateTo?: string | null;
}

export async function listIntangibleAssets(
  businessId: string,
  filters: IntangibleListFilters = {},
): Promise<IntangibleAsset[]> {
  const args: unknown[] = [businessId];
  const conditions: string[] = ["a.business_id = $1"];
  if (filters.search?.trim()) {
    args.push(`%${filters.search.trim()}%`);
    conditions.push(`(a.name ILIKE $${args.length} OR a.code ILIKE $${args.length})`);
  }
  if (filters.status) {
    args.push(filters.status);
    conditions.push(`a.status = $${args.length}`);
  }
  if (filters.assetClass) {
    args.push(filters.assetClass);
    conditions.push(`a.asset_class = $${args.length}`);
  }
  if (filters.usefulLifeType) {
    args.push(filters.usefulLifeType);
    conditions.push(`a.useful_life_type = $${args.length}`);
  }
  if (filters.locationId) {
    args.push(filters.locationId);
    conditions.push(`a.location_id = $${args.length}`);
  }
  if (filters.dateFrom) {
    args.push(filters.dateFrom);
    conditions.push(`a.acquisition_date >= $${args.length}::date`);
  }
  if (filters.dateTo) {
    args.push(filters.dateTo);
    conditions.push(`a.acquisition_date <= $${args.length}::date`);
  }
  const { rows } = await query<AssetRow>(
    `${ASSET_SELECT} WHERE ${conditions.join(" AND ")} ORDER BY a.acquisition_date DESC, a.created_at DESC`,
    args,
  );
  return rows.map(toAsset);
}

export interface IntangibleAmortizationEntry {
  id: string;
  periodKey: string;
  periodLabel: string;
  entryDate: string;
  amount: number;
  reversedAt: string | null;
  journalEntryId: string | null;
}

export interface IntangibleImpairment {
  id: string;
  assessmentDate: string;
  effectiveDate: string;
  recoverableAmount: number;
  carryingAmountBefore: number;
  impairmentAmount: number;
  reason: string;
  evidenceReference: string | null;
  reversedAt: string | null;
  reversalOf: string | null;
  journalEntryId: string | null;
}

export interface IntangibleEstimateChange {
  id: string;
  effectiveDate: string;
  effectivePeriodKey: string;
  previousUsefulLifeType: UsefulLifeType;
  previousUsefulLifeMonths: number | null;
  previousResidualValue: number;
  newUsefulLifeType: UsefulLifeType;
  newUsefulLifeMonths: number | null;
  newResidualValue: number;
  /** Carrying amount less the new residual, at the effective date. */
  remainingBase: number;
  remainingLifeMonths: number | null;
  accumulatedAmortizationAtChange: number;
  accumulatedImpairmentAtChange: number;
  periodsPostedAtChange: number;
  reason: string;
  evidenceReference: string | null;
  approvedByName: string | null;
  changedByName: string | null;
  createdAt: string;
}

export interface IntangibleAssetDetail {
  asset: IntangibleAsset;
  entries: IntangibleAmortizationEntry[];
  impairments: IntangibleImpairment[];
  estimateChanges: IntangibleEstimateChange[];
  schedule: AmortizationScheduleRow[];
  totals: AmortizationScheduleTotals;
}

async function liveAmortization(client: PoolClient, assetId: string) {
  const { rows } = await client.query<{
    id: string;
    period_key: string;
    period_label: string;
    amount: string;
    entry_date: string;
    journal_entry_id: string | null;
  }>(
    `SELECT e.id, e.period_key, e.period_label, e.amount::text AS amount,
            e.entry_date::text AS entry_date, je.id AS journal_entry_id
       FROM intangible_asset_amortization_entries e
       LEFT JOIN journal_entries je
         ON je.source_type = 'intangible_asset_amortization'
        AND je.source_id = e.id
        AND je.reverses_entry_id IS NULL
      WHERE e.intangible_asset_id = $1 AND e.reversed_at IS NULL
      ORDER BY e.period_key`,
    [assetId],
  );
  return {
    periodKeys: rows.map((r) => r.period_key),
    accumulated: rows.reduce((sum, r) => sum + Number(r.amount), 0),
    postings: rows.map((r) => ({ periodKey: r.period_key, amount: Number(r.amount) })),
    rows,
  };
}

async function outstandingImpairment(client: PoolClient, assetId: string): Promise<number> {
  const { rows } = await client.query<{ outstanding: string }>(
    `SELECT (
       COALESCE((SELECT SUM(impairment_amount) FROM intangible_asset_impairments
                  WHERE intangible_asset_id = $1 AND reversal_of IS NULL AND reversed_at IS NULL), 0)
       - COALESCE((SELECT SUM(impairment_amount) FROM intangible_asset_impairments
                    WHERE intangible_asset_id = $1 AND reversal_of IS NOT NULL), 0)
     )::text AS outstanding`,
    [assetId],
  );
  return Math.max(0, Number(rows[0]?.outstanding ?? 0));
}

interface EstimateChangeRow extends Record<string, unknown> {
  id: string;
  effective_date: string;
  effective_period_key: string;
  previous_useful_life_type: UsefulLifeType;
  previous_useful_life_months: number | null;
  previous_residual_value: string;
  new_useful_life_type: UsefulLifeType;
  new_useful_life_months: number | null;
  new_residual_value: string;
  remaining_base: string;
  remaining_life_months: number | null;
  accumulated_amortization_at_change: string;
  accumulated_impairment_at_change: string;
  periods_posted_at_change: number;
  reason: string;
  evidence_reference: string | null;
  approved_by_name: string | null;
  changed_by_name: string | null;
  created_at: string;
}

function toEstimateChange(row: EstimateChangeRow): IntangibleEstimateChange {
  return {
    id: row.id,
    effectiveDate: row.effective_date,
    effectivePeriodKey: row.effective_period_key,
    previousUsefulLifeType: row.previous_useful_life_type,
    previousUsefulLifeMonths: row.previous_useful_life_months,
    previousResidualValue: Number(row.previous_residual_value),
    newUsefulLifeType: row.new_useful_life_type,
    newUsefulLifeMonths: row.new_useful_life_months,
    newResidualValue: Number(row.new_residual_value),
    remainingBase: Number(row.remaining_base),
    remainingLifeMonths: row.remaining_life_months,
    accumulatedAmortizationAtChange: Number(row.accumulated_amortization_at_change),
    accumulatedImpairmentAtChange: Number(row.accumulated_impairment_at_change),
    periodsPostedAtChange: row.periods_posted_at_change,
    reason: row.reason,
    evidenceReference: row.evidence_reference,
    approvedByName: row.approved_by_name,
    changedByName: row.changed_by_name,
    createdAt: row.created_at,
  };
}

async function estimateChangeRows(client: PoolClient, assetId: string): Promise<EstimateChangeRow[]> {
  const { rows } = await client.query<EstimateChangeRow>(
    `SELECT c.id, c.effective_date::text AS effective_date, c.effective_period_key,
            c.previous_useful_life_type, c.previous_useful_life_months,
            c.previous_residual_value::text AS previous_residual_value,
            c.new_useful_life_type, c.new_useful_life_months,
            c.new_residual_value::text AS new_residual_value,
            c.remaining_base::text AS remaining_base, c.remaining_life_months,
            c.accumulated_amortization_at_change::text AS accumulated_amortization_at_change,
            c.accumulated_impairment_at_change::text AS accumulated_impairment_at_change,
            c.periods_posted_at_change,
            c.reason, c.evidence_reference, c.created_at::text AS created_at,
            pc.full_name AS approved_by_name, cc.full_name AS changed_by_name
       FROM intangible_asset_estimate_changes c
       LEFT JOIN users pc ON pc.id = c.approved_by
       LEFT JOIN users cc ON cc.id = c.changed_by
      WHERE c.intangible_asset_id = $1
      ORDER BY c.effective_period_key ASC, c.created_at ASC, c.id ASC`,
    [assetId],
  );
  return rows;
}

/**
 * The estimate that governs one month. Before the first revision the original
 * parameters (recorded on that revision) apply; from a revision's effective
 * month its approved base and life apply. `null` means the original asset row
 * still governs (no changes at all). Indefinite months return `null` — they are
 * never amortized.
 */
function revisionForPeriod(
  changes: EstimateChangeRow[],
  asset: IntangibleAsset,
  targetPeriodKey: string,
  postings: { periodKey: string; amount: number }[],
): AmortizationRevision | null {
  if (changes.length === 0) return null;
  let applicable: EstimateChangeRow | null = null;
  for (const change of changes) {
    if (change.effective_period_key <= targetPeriodKey) applicable = change;
  }
  const accumulatedSince = (effectivePeriodKey: string) =>
    postings
      .filter((posting) => posting.periodKey >= effectivePeriodKey)
      .reduce((sum, posting) => sum + posting.amount, 0);

  if (!applicable) {
    const first = changes[0];
    if (first.previous_useful_life_type !== "finite" || !first.previous_useful_life_months) return null;
    const previousResidual = Number(first.previous_residual_value);
    const startKey = depreciationPeriodOfDate(asset.availableForUseDate)?.key;
    if (!startKey) return null;
    return {
      effectivePeriodKey: startKey,
      usefulLifeMonths: first.previous_useful_life_months,
      residualValue: previousResidual,
      remainingBase: Math.max(0, asset.cost - previousResidual),
      accumulatedSinceEffective: 0,
    };
  }
  if (applicable.new_useful_life_type !== "finite" || !applicable.new_useful_life_months) return null;
  return {
    effectivePeriodKey: applicable.effective_period_key,
    usefulLifeMonths: applicable.new_useful_life_months,
    residualValue: Number(applicable.new_residual_value),
    remainingBase: Number(applicable.remaining_base),
    accumulatedSinceEffective: accumulatedSince(applicable.effective_period_key),
  };
}

function projectionRevisions(changes: EstimateChangeRow[]) {
  return changes.map((change) => ({
    effectivePeriodKey: change.effective_period_key,
    previousUsefulLifeType: change.previous_useful_life_type,
    previousUsefulLifeMonths: change.previous_useful_life_months ?? 0,
    previousResidualValue: Number(change.previous_residual_value),
    usefulLifeMonths: change.new_useful_life_months ?? 0,
    residualValue: Number(change.new_residual_value),
    remainingBase: Number(change.remaining_base),
  }));
}

export async function getIntangibleAsset(
  businessId: string,
  id: string,
): Promise<IntangibleAssetDetail | null> {
  if (!isUuid(id)) return null;
  const { rows } = await query<AssetRow>(`${ASSET_SELECT} WHERE a.business_id = $1 AND a.id = $2`, [businessId, id]);
  const row = rows[0];
  if (!row) return null;
  const asset = toAsset(row);

  const [{ rows: entries }, { rows: impairments }, today] = await Promise.all([
    query<{
      id: string;
      period_key: string;
      period_label: string;
      entry_date: string;
      amount: string;
      reversed_at: string | null;
      journal_entry_id: string | null;
    }>(
      `SELECT e.id, e.period_key, e.period_label, e.entry_date::text AS entry_date, e.amount::text AS amount,
              e.reversed_at::text AS reversed_at, je.id AS journal_entry_id
         FROM intangible_asset_amortization_entries e
         LEFT JOIN journal_entries je
           ON je.source_type = 'intangible_asset_amortization' AND je.source_id = e.id AND je.reverses_entry_id IS NULL
        WHERE e.intangible_asset_id = $1
        ORDER BY e.period_key`,
      [asset.id],
    ),
    query<{
      id: string;
      assessment_date: string;
      effective_date: string;
      recoverable_amount: string;
      carrying_amount_before: string;
      impairment_amount: string;
      reason: string;
      evidence_reference: string | null;
      reversed_at: string | null;
      reversal_of: string | null;
      journal_entry_id: string | null;
    }>(
      `SELECT id, assessment_date::text AS assessment_date, effective_date::text AS effective_date,
              recoverable_amount::text AS recoverable_amount,
              carrying_amount_before::text AS carrying_amount_before,
              impairment_amount::text AS impairment_amount, reason, evidence_reference,
              reversed_at::text AS reversed_at, reversal_of, journal_entry_id
         FROM intangible_asset_impairments
        WHERE intangible_asset_id = $1
        ORDER BY effective_date, created_at`,
      [asset.id],
    ),
    businessToday(businessId),
  ]);

  const changeClient = await getPool().connect();
  let changeRows: EstimateChangeRow[];
  try {
    changeRows = await estimateChangeRows(changeClient, asset.id);
  } finally {
    changeClient.release();
  }

  const todayPeriodKey = depreciationPeriodOfDate(today)?.key ?? "";
  const { rows: scheduleRows, totals } = projectAmortization({
    usefulLifeType: asset.usefulLifeType,
    asset: {
      cost: asset.cost,
      residualValue: asset.residualValue,
      usefulLifeMonths: asset.usefulLifeMonths ?? 0,
      availableForUseDate: asset.availableForUseDate,
    },
    livePostings: entries
      .filter((e) => e.reversed_at === null)
      .map((e) => ({
        periodKey: e.period_key,
        amount: Number(e.amount),
        entryId: e.id,
        journalEntryId: e.journal_entry_id,
        periodLabel: e.period_label,
      })),
    todayPeriodKey,
    accumulatedImpairment: asset.accumulatedImpairment,
    revisions: projectionRevisions(changeRows),
  });

  return {
    asset,
    entries: entries.map((e) => ({
      id: e.id,
      periodKey: e.period_key,
      periodLabel: e.period_label,
      entryDate: e.entry_date,
      amount: Number(e.amount),
      reversedAt: e.reversed_at,
      journalEntryId: e.journal_entry_id,
    })),
    impairments: impairments.map((i) => ({
      id: i.id,
      assessmentDate: i.assessment_date,
      effectiveDate: i.effective_date,
      recoverableAmount: Number(i.recoverable_amount),
      carryingAmountBefore: Number(i.carrying_amount_before),
      impairmentAmount: Number(i.impairment_amount),
      reason: i.reason,
      evidenceReference: i.evidence_reference,
      reversedAt: i.reversed_at,
      reversalOf: i.reversal_of,
      journalEntryId: i.journal_entry_id,
    })),
    estimateChanges: changeRows.map(toEstimateChange),
    schedule: scheduleRows,
    totals,
  };
}

async function lockAsset(client: PoolClient, businessId: string, id: string): Promise<AssetRow> {
  if (!isUuid(id)) throw new IntangibleAssetError("intangible_asset_not_found", 404);
  // Taken on the bare row first: `FOR UPDATE` cannot carry the derived
  // accumulated columns' aggregate subqueries, and the lock is what matters.
  const lock = await client.query<{ id: string }>(
    `SELECT id FROM intangible_assets WHERE business_id = $1 AND id = $2 FOR UPDATE`,
    [businessId, id],
  );
  if (!lock.rows[0]) throw new IntangibleAssetError("intangible_asset_not_found", 404);
  const { rows } = await client.query<AssetRow>(`${ASSET_SELECT} WHERE a.business_id = $1 AND a.id = $2`, [
    businessId,
    id,
  ]);
  const row = rows[0];
  if (!row) throw new IntangibleAssetError("intangible_asset_not_found", 404);
  return row;
}

/** Posts one Jalali month's amortization for a finite-life intangible. */
export async function postIntangibleAmortization(params: {
  businessId: string;
  intangibleAssetId: string;
  periodKey?: string | null;
  periodLabel?: string | null;
  entryDate?: string | null;
  createdBy: string | null;
}): Promise<{
  amount: number;
  periodKey: string;
  periodLabel: string;
  entryDate: string;
  amortizationEntryId: string;
  journalEntryId: string | null;
}> {
  const memoLabel = params.periodLabel?.trim() ?? "";
  if (memoLabel.length > 120) throw new IntangibleAssetError("period_label_too_long");
  const today = await businessToday(params.businessId);

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const row = await lockAsset(client, params.businessId, params.intangibleAssetId);
    const asset = toAsset(row);
    if (asset.status === "disposed") throw new IntangibleAssetError("intangible_asset_disposed", 409);
    if (asset.usefulLifeType !== "finite") {
      throw new IntangibleAssetError("indefinite_life_not_amortized", 409);
    }
    if (!asset.accumulatedAmortizationAccountId || !asset.amortizationExpenseAccountId) {
      throw new IntangibleAssetError("amortization_accounts_required");
    }

    const live = await liveAmortization(client, asset.id);
    // The month decides which approved estimate governs it: a revision only
    // affects the effective month forward, so a month before it is still
    // priced from the parameters recorded as "previous" on the first change.
    const targetPeriodKey =
      params.periodKey?.trim() || depreciationPeriodOfDate(params.entryDate ?? today)?.key || null;
    if (!targetPeriodKey) throw new IntangibleAssetError("invalid_period");
    const changes = await estimateChangeRows(client, asset.id);
    const revision = revisionForPeriod(changes, asset, targetPeriodKey, live.postings);
    const plan = planAmortization({
      usefulLifeType: asset.usefulLifeType,
      asset: {
        cost: asset.cost,
        residualValue: asset.residualValue,
        usefulLifeMonths: asset.usefulLifeMonths ?? 0,
        availableForUseDate: asset.availableForUseDate,
      },
      postedPeriodKeys: live.periodKeys,
      accumulatedSoFar: live.accumulated,
      postedPostings: live.postings,
      periodKey: targetPeriodKey,
      entryDate: params.entryDate,
      today,
      revision,
    });
    if (!plan.ok) {
      const status = plan.error === "period_already_amortized" || plan.error === "fully_amortized" ? 409 : 400;
      throw new IntangibleAssetError(plan.error, status);
    }

    const label = memoLabel || plan.period.label;
    let amortizationEntryId: string;
    try {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO intangible_asset_amortization_entries
           (intangible_asset_id, period_key, period_label, entry_date, amount, created_by)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [asset.id, plan.period.key, label, plan.entryDate, plan.amount, params.createdBy],
      );
      amortizationEntryId = rows[0].id;
    } catch (err) {
      if (isUniqueViolation(err)) throw new IntangibleAssetError("period_already_amortized", 409);
      throw err;
    }

    const journalEntryId = await postJournalEntry(client, {
      businessId: params.businessId,
      locationId: asset.locationId,
      entryDate: plan.entryDate,
      memo: `استهلاک دارایی نامشهود — ${label}`,
      sourceType: "intangible_asset_amortization",
      sourceId: amortizationEntryId,
      postingKind: "amortization",
      createdBy: params.createdBy,
      lines: [
        {
          accountId: asset.amortizationExpenseAccountId,
          debit: plan.amount,
          credit: 0,
        },
        { accountId: asset.accumulatedAmortizationAccountId, debit: 0, credit: plan.amount },
      ],
    });

    await client.query("COMMIT");
    return {
      amount: plan.amount,
      periodKey: plan.period.key,
      periodLabel: label,
      entryDate: plan.entryDate,
      amortizationEntryId,
      journalEntryId,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** Reverses one posted amortization month; the month may then be posted again. */
export async function reverseIntangibleAmortization(params: {
  businessId: string;
  intangibleAssetId: string;
  amortizationEntryId: string;
  reversalDate?: string | null;
  reason: string;
  createdBy: string | null;
}): Promise<{
  amount: number;
  periodKey: string;
  reversalJournalEntryId: string | null;
  reversalDate: string;
}> {
  const reason = params.reason?.trim() ?? "";
  if (!reason) throw new IntangibleAssetError("reason_required");
  if (reason.length > 500) throw new IntangibleAssetError("reason_too_long");
  if (!isUuid(params.amortizationEntryId)) throw new IntangibleAssetError("amortization_entry_not_found", 404);
  const requestedDate = params.reversalDate?.trim() || null;
  if (requestedDate && !isValidIsoDate(requestedDate)) throw new IntangibleAssetError("invalid_reversal_date");

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const row = await lockAsset(client, params.businessId, params.intangibleAssetId);
    const asset = toAsset(row);

    const { rows: entries } = await client.query<{
      id: string;
      period_key: string;
      period_label: string;
      entry_date: string;
      amount: string;
      reversed_at: string | null;
    }>(
      `SELECT id, period_key, period_label, entry_date::text AS entry_date, amount::text AS amount,
              reversed_at::text AS reversed_at
         FROM intangible_asset_amortization_entries
        WHERE intangible_asset_id = $1 AND id = $2 FOR UPDATE`,
      [asset.id, params.amortizationEntryId],
    );
    const entry = entries[0];
    if (!entry) throw new IntangibleAssetError("amortization_entry_not_found", 404);
    if (entry.reversed_at) throw new IntangibleAssetError("amortization_already_reversed", 409);

    const { rows: journals } = await client.query<{ id: string; location_id: string | null }>(
      `SELECT id, location_id FROM journal_entries
        WHERE business_id = $1 AND source_type = 'intangible_asset_amortization' AND source_id = $2
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
        sourceType: "intangible_asset_amortization",
        sourceId: entry.id,
        postingKind: "reversal",
        memo: `برگشت استهلاک دارایی نامشهود — ${entry.period_label}`,
        createdBy: params.createdBy,
        entryDate: reversalDate,
      });
    }

    await client.query(
      `UPDATE intangible_asset_amortization_entries
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
 * Records an impairment assessment and posts the approved write-down.
 *
 *   Dr impairment loss (expense)   Cr accumulated impairment (contra-asset)
 *
 * A recoverable amount at or above carrying means no impairment: the service
 * refuses rather than posting a zero-valued document, so the register only ever
 * shows real write-downs. Indefinite-life assets use this path instead of
 * amortization, which is why it works for both life types.
 */
export async function assessIntangibleImpairment(params: {
  businessId: string;
  intangibleAssetId: string;
  assessmentDate?: string | null;
  effectiveDate: string;
  recoverableAmount: number;
  reason: string;
  evidenceReference?: string | null;
  createdBy: string | null;
}): Promise<{
  impairmentId: string;
  amount: number;
  carryingAmountBefore: number;
  netBookValue: number;
  journalEntryId: string | null;
}> {
  const reason = params.reason?.trim() ?? "";
  if (!reason) throw new IntangibleAssetError("reason_required");
  if (reason.length > 500) throw new IntangibleAssetError("reason_too_long");
  const effectiveDate = params.effectiveDate?.trim() ?? "";
  if (!isValidIsoDate(effectiveDate)) throw new IntangibleAssetError("invalid_effective_date");
  const today = await businessToday(params.businessId);
  if (effectiveDate > today) throw new IntangibleAssetError("effective_date_in_future");
  const assessmentDate = params.assessmentDate?.trim() || effectiveDate;
  if (!isValidIsoDate(assessmentDate)) throw new IntangibleAssetError("invalid_assessment_date");
  if (!Number.isSafeInteger(params.recoverableAmount) || params.recoverableAmount < 0) {
    throw new IntangibleAssetError("invalid_recoverable_amount");
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const row = await lockAsset(client, params.businessId, params.intangibleAssetId);
    const asset = toAsset(row);
    if (asset.status === "disposed") throw new IntangibleAssetError("intangible_asset_disposed", 409);
    if (!asset.impairmentLossAccountId || !asset.accumulatedImpairmentAccountId) {
      throw new IntangibleAssetError("impairment_accounts_required");
    }
    if (effectiveDate < asset.availableForUseDate) {
      throw new IntangibleAssetError("impairment_before_available_for_use");
    }

    const live = await liveAmortization(client, asset.id);
    const carryingAmountBefore = intrinsicCarryingAmount({
      cost: asset.cost,
      accumulatedAmortization: live.accumulated,
      accumulatedImpairment: asset.accumulatedImpairment,
    });
    const amount = impairmentCharge({
      carryingAmount: carryingAmountBefore,
      recoverableAmount: params.recoverableAmount,
    });
    if (amount === null) throw new IntangibleAssetError("no_impairment_required", 409);

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO intangible_asset_impairments
         (intangible_asset_id, assessment_date, effective_date, recoverable_amount,
          carrying_amount_before, impairment_amount, reason, evidence_reference, assessed_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [
        asset.id,
        assessmentDate,
        effectiveDate,
        params.recoverableAmount,
        carryingAmountBefore,
        amount,
        reason,
        params.evidenceReference?.trim() || null,
        params.createdBy,
      ],
    );
    const impairmentId = rows[0].id;

    const journalEntryId = await postJournalEntry(client, {
      businessId: params.businessId,
      locationId: asset.locationId,
      entryDate: effectiveDate,
      memo: `کاهش ارزش دارایی نامشهود — ${asset.name}`,
      sourceType: "intangible_asset_impairment",
      sourceId: impairmentId,
      postingKind: "impairment",
      createdBy: params.createdBy,
      lines: [
        { accountId: asset.impairmentLossAccountId, debit: amount, credit: 0 },
        { accountId: asset.accumulatedImpairmentAccountId, debit: 0, credit: amount },
      ],
    });

    await client.query(`UPDATE intangible_asset_impairments SET journal_entry_id = $2 WHERE id = $1`, [
      impairmentId,
      journalEntryId,
    ]);

    await client.query("COMMIT");
    return {
      impairmentId,
      amount,
      carryingAmountBefore,
      netBookValue: carryingAmountBefore - amount,
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
 * Reverses (part of) an accepted impairment — only where the recoverable amount
 * has genuinely recovered, never above what is still recognized, and never as a
 * revaluation above original cost. Mirrors the original posting.
 */
export async function reverseIntangibleImpairment(params: {
  businessId: string;
  intangibleAssetId: string;
  impairmentId: string;
  amount?: number | null;
  reversalDate?: string | null;
  reason: string;
  createdBy: string | null;
}): Promise<{ amount: number; journalEntryId: string | null; reversalDate: string }> {
  const reason = params.reason?.trim() ?? "";
  if (!reason) throw new IntangibleAssetError("reason_required");
  if (!isUuid(params.impairmentId)) throw new IntangibleAssetError("impairment_not_found", 404);
  const requestedDate = params.reversalDate?.trim() || null;
  if (requestedDate && !isValidIsoDate(requestedDate)) throw new IntangibleAssetError("invalid_reversal_date");
  const today = await businessToday(params.businessId);

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const row = await lockAsset(client, params.businessId, params.intangibleAssetId);
    const asset = toAsset(row);
    if (asset.status === "disposed") throw new IntangibleAssetError("intangible_asset_disposed", 409);

    const { rows } = await client.query<{
      id: string;
      impairment_amount: string;
      effective_date: string;
      journal_entry_id: string | null;
      reversed_at: string | null;
      reversal_of: string | null;
    }>(
      `SELECT id, impairment_amount::text AS impairment_amount, effective_date::text AS effective_date,
              journal_entry_id, reversed_at::text AS reversed_at, reversal_of
         FROM intangible_asset_impairments
        WHERE intangible_asset_id = $1 AND id = $2 FOR UPDATE`,
      [asset.id, params.impairmentId],
    );
    const impairment = rows[0];
    if (!impairment || impairment.reversal_of !== null) {
      throw new IntangibleAssetError("impairment_not_found", 404);
    }
    if (impairment.reversed_at) throw new IntangibleAssetError("impairment_already_reversed", 409);

    const { rows: reversals } = await client.query<{ used: string }>(
      `SELECT COALESCE(SUM(impairment_amount), 0)::text AS used
         FROM intangible_asset_impairments WHERE reversal_of = $1`,
      [impairment.id],
    );
    const outstanding = Number(impairment.impairment_amount) - Number(reversals[0]?.used ?? 0);
    const requested = params.amount ?? outstanding;
    const amount = reversibleImpairment({ outstandingImpairment: outstanding, requestedAmount: requested });
    if (amount === null) {
      throw new IntangibleAssetError("no_reversible_impairment", 409);
    }

    const reversalDate = requestedDate ?? today;
    if (reversalDate < impairment.effective_date) {
      throw new IntangibleAssetError("reversal_before_impairment");
    }

    let journalEntryId: string | null = null;
    if (impairment.journal_entry_id && amount >= outstanding) {
      // A full reversal undoes the original document exactly — the mirror is
      // the ledger's own reversal path, so the pair nets to nothing.
      const { rows: original } = await client.query<{ location_id: string | null }>(
        `SELECT location_id FROM journal_entries WHERE business_id = $1 AND id = $2`,
        [params.businessId, impairment.journal_entry_id],
      );
      journalEntryId = await postExactMirrorEntry(client, {
        businessId: params.businessId,
        locationId: original[0]?.location_id ?? asset.locationId,
        originalEntryId: impairment.journal_entry_id,
        sourceType: "intangible_asset_impairment",
        sourceId: impairment.id,
        postingKind: "reversal",
        memo: `برگشت کاهش ارزش دارایی نامشهود — ${asset.name}`,
        createdBy: params.createdBy,
        entryDate: reversalDate,
      });
    } else if (impairment.journal_entry_id) {
      // A partial reversal is its own approved document for the recovered
      // amount; it must not mirror a document it only partly undoes.
      if (!asset.impairmentLossAccountId || !asset.accumulatedImpairmentAccountId) {
        throw new IntangibleAssetError("impairment_accounts_required");
      }
      journalEntryId = await postJournalEntry(client, {
        businessId: params.businessId,
        locationId: asset.locationId,
        entryDate: reversalDate,
        memo: `برگشت جزئی کاهش ارزش دارایی نامشهود — ${asset.name}`,
        sourceType: "intangible_asset_impairment",
        sourceId: impairment.id,
        postingKind: "reversal",
        createdBy: params.createdBy,
        lines: [
          { accountId: asset.accumulatedImpairmentAccountId, debit: amount, credit: 0 },
          { accountId: asset.impairmentLossAccountId, debit: 0, credit: amount },
        ],
      });
    }

    await client.query(
      `INSERT INTO intangible_asset_impairments
         (intangible_asset_id, assessment_date, effective_date, recoverable_amount,
          carrying_amount_before, impairment_amount, reason, reversal_of,
          reversal_journal_entry_id, assessed_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        asset.id,
        reversalDate,
        reversalDate,
        asset.carryingAmount,
        asset.carryingAmount,
        amount,
        reason,
        impairment.id,
        journalEntryId,
        params.createdBy,
      ],
    );

    if (amount >= outstanding) {
      await client.query(
        `UPDATE intangible_asset_impairments
            SET reversed_at = now(), reversed_by = $2, reversal_reason = $3, reversal_journal_entry_id = $4
          WHERE id = $1`,
        [impairment.id, params.createdBy, reason, journalEntryId],
      );
    }

    await client.query("COMMIT");
    return { amount, journalEntryId, reversalDate };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Derecognizes an intangible — sale, retirement or write-off — and posts:
 *
 *   Dr accumulated amortization     Dr accumulated impairment
 *   Dr proceeds (sale)              Dr loss / Cr gain
 *                                   Cr the asset account (cost)
 *
 * Gain/loss is proceeds against carrying amount (cost − amortization −
 * impairment), never against amortization alone. The asset can never amortize
 * after disposal.
 */
export async function disposeIntangibleAsset(params: {
  businessId: string;
  intangibleAssetId: string;
  kind: DisposalKind;
  disposalDate?: string | null;
  proceeds?: number | null;
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
  if (!["sale", "retirement", "write_off"].includes(params.kind)) {
    throw new IntangibleAssetError("invalid_disposal_kind");
  }
  const today = await businessToday(params.businessId);
  const disposalDate = params.disposalDate?.trim() || today;
  if (!isValidIsoDate(disposalDate)) throw new IntangibleAssetError("invalid_disposal_date");
  if (disposalDate > today) throw new IntangibleAssetError("disposal_date_in_future");
  const isSale = params.kind === "sale";
  const proceeds = isSale ? Number(params.proceeds ?? 0) : 0;
  if (isSale && (!Number.isSafeInteger(proceeds) || proceeds <= 0)) {
    throw new IntangibleAssetError("disposal_proceeds_required");
  }
  if (!isSale && Number(params.proceeds ?? 0) !== 0) {
    throw new IntangibleAssetError("disposal_proceeds_not_allowed");
  }
  if (isSale && !params.proceedsAccountId) throw new IntangibleAssetError("proceeds_account_required");
  const reason = params.reason?.trim() || null;
  if (reason && reason.length > 500) throw new IntangibleAssetError("reason_too_long");

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const row = await lockAsset(client, params.businessId, params.intangibleAssetId);
    const asset = toAsset(row);
    if (asset.status === "disposed") throw new IntangibleAssetError("intangible_asset_disposed", 409);
    if (!asset.assetAccountId) throw new IntangibleAssetError("asset_account_required");
    if (disposalDate < asset.availableForUseDate) {
      throw new IntangibleAssetError("disposal_before_available_for_use");
    }

    const live = await liveAmortization(client, asset.id);
    const latestEntryDate = live.rows.reduce((max, r) => (r.entry_date > max ? r.entry_date : max), "");
    if (latestEntryDate && disposalDate < latestEntryDate) {
      throw new IntangibleAssetError("disposal_before_amortization");
    }

    const outcome = intangibleDisposalOutcome({
      cost: asset.cost,
      accumulatedAmortization: live.accumulated,
      accumulatedImpairment: asset.accumulatedImpairment,
      proceeds,
    });

    let proceedsAccountId: string | null = null;
    if (isSale) {
      await assertAccountOfBusiness(
        client,
        params.businessId,
        params.proceedsAccountId!,
        ["asset"],
        "invalid_proceeds_account",
      );
      proceedsAccountId = params.proceedsAccountId!;
    }

    const { rows: accounts } = await client.query<{ code: string; id: string }>(
      `SELECT code, id FROM accounts WHERE business_id = $1 AND code IN ($2, $3)`,
      [params.businessId, WELL_KNOWN_CODES.gainOnAssetSale, WELL_KNOWN_CODES.lossOnAssetSale],
    );
    const byCode = new Map(accounts.map((a) => [a.code, a.id]));
    const gainAccount = byCode.get(WELL_KNOWN_CODES.gainOnAssetSale);
    const lossAccount = byCode.get(WELL_KNOWN_CODES.lossOnAssetSale);
    if (outcome.gain > 0 && !gainAccount) throw new IntangibleAssetError("ledger_account_missing");
    if (outcome.loss > 0 && !lossAccount) throw new IntangibleAssetError("ledger_account_missing");

    const lines: { accountId: string; debit: number; credit: number }[] = [
      { accountId: asset.assetAccountId, debit: 0, credit: asset.cost },
    ];
    if (live.accumulated > 0) {
      if (!asset.accumulatedAmortizationAccountId) {
        throw new IntangibleAssetError("amortization_accounts_required");
      }
      lines.push({ accountId: asset.accumulatedAmortizationAccountId, debit: live.accumulated, credit: 0 });
    }
    if (asset.accumulatedImpairment > 0) {
      if (!asset.accumulatedImpairmentAccountId) {
        throw new IntangibleAssetError("impairment_accounts_required");
      }
      lines.push({ accountId: asset.accumulatedImpairmentAccountId, debit: asset.accumulatedImpairment, credit: 0 });
    }
    if (proceeds > 0 && proceedsAccountId) {
      lines.push({ accountId: proceedsAccountId, debit: proceeds, credit: 0 });
    }
    if (outcome.loss > 0) lines.push({ accountId: lossAccount!, debit: outcome.loss, credit: 0 });
    if (outcome.gain > 0) lines.push({ accountId: gainAccount!, debit: 0, credit: outcome.gain });

    const memo =
      params.kind === "sale"
        ? `فروش دارایی نامشهود — ${asset.name}`
        : params.kind === "retirement"
          ? `کنارگذاری دارایی نامشهود — ${asset.name}`
          : `حذف دارایی نامشهود — ${asset.name}`;

    const journalEntryId = await postJournalEntry(client, {
      businessId: params.businessId,
      locationId: asset.locationId,
      entryDate: disposalDate,
      memo,
      sourceType: "intangible_asset_disposal",
      sourceId: asset.id,
      postingKind: "disposal",
      createdBy: params.createdBy,
      lines,
    });

    await client.query(
      `UPDATE intangible_assets
          SET status = 'disposed', disposal_kind = $3, disposal_date = $4, disposal_proceeds = $5,
              disposal_journal_entry_id = $6, disposal_reason = $7, disposed_by = $8, updated_at = now()
        WHERE business_id = $1 AND id = $2`,
      [
        params.businessId,
        asset.id,
        params.kind,
        disposalDate,
        isSale ? proceeds : null,
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
 * Register ↔ ledger for the mapped control accounts only.
 *
 * "Live" means the same thing it does everywhere else in this module: an entry
 * that was reversed (`reversed_at`) and the mirror that reversed it
 * (`reverses_entry_id`) are both excluded, so a reversed posting contributes
 * nothing instead of cancelling itself twice.
 */
/**
 * Changes an intangible's remaining useful life and/or residual value
 * *prospectively* (issue #1326, ESH-163).
 *
 * Only the current and future periods change. Previously posted amortization
 * and its vouchers are never rewritten: the new estimate is a new, approved
 * history row that records the previous and new values, the effective date,
 * the remaining amortizable base it left, the reason and the evidence. Posting
 * a later month reads that snapshot, so the remaining carrying amount spreads
 * over the revised remaining life and the final month still lands exactly on
 * the new residual.
 *
 * The asset row is locked for the whole decision, so two concurrent changes
 * serialise; the `(asset, idempotency_key)` unique index makes a retried
 * request return the change already recorded instead of creating a second one.
 */
export async function changeIntangibleEstimate(params: {
  businessId: string;
  intangibleAssetId: string;
  effectiveDate: string;
  usefulLifeType?: string | null;
  usefulLifeMonths?: number | null;
  residualValue?: number | null;
  reason: string;
  evidenceReference?: string | null;
  createdBy: string | null;
  idempotencyKey?: string | null;
}): Promise<{ asset: IntangibleAsset; estimateChange: IntangibleEstimateChange }> {
  const reason = params.reason?.trim() ?? "";
  if (!reason) throw new IntangibleAssetError("reason_required");
  if (reason.length > INTANGIBLE_REASON_MAX_LENGTH) throw new IntangibleAssetError("reason_too_long");
  const effectiveDate = params.effectiveDate?.trim() ?? "";
  if (!isValidIsoDate(effectiveDate)) throw new IntangibleAssetError("invalid_effective_date");
  const idempotencyKey = params.idempotencyKey?.trim() || null;
  if (idempotencyKey && idempotencyKey.length > 120) throw new IntangibleAssetError("idempotency_key_too_long");
  if (!isUuid(params.intangibleAssetId)) throw new IntangibleAssetError("intangible_asset_not_found", 404);

  const today = await businessToday(params.businessId);
  const client = await getPool().connect();
  let changeId: string;
  try {
    await client.query("BEGIN");
    const row = await lockAsset(client, params.businessId, params.intangibleAssetId);
    const asset = toAsset(row);
    if (asset.status === "disposed") throw new IntangibleAssetError("intangible_asset_disposed", 409);

    const effectivePeriod = depreciationPeriodOfDate(effectiveDate);
    const currentPeriod = depreciationPeriodOfDate(today);
    if (!effectivePeriod || !currentPeriod) throw new IntangibleAssetError("invalid_effective_date");
    // Prospective: the change belongs to the current period or a later one.
    // An earlier effective date would silently reinterpret posted history.
    if (effectivePeriod.key < currentPeriod.key) {
      throw new IntangibleAssetError("estimate_effective_in_past", 409);
    }
    if (effectiveDate < asset.availableForUseDate) {
      throw new IntangibleAssetError("estimate_before_available_for_use");
    }

    const { rows: periods } = await client.query<{ status: string }>(
      `SELECT status FROM fiscal_periods
        WHERE business_id = $1 AND starts_on <= $2::date AND ends_on >= $2::date
        LIMIT 1`,
      [params.businessId, effectiveDate],
    );
    if (periods[0]?.status === "locked") {
      throw new IntangibleAssetError("fiscal_period_locked", 409);
    }

    if (idempotencyKey) {
      const { rows: existing } = await client.query<{ id: string }>(
        `SELECT id FROM intangible_asset_estimate_changes
          WHERE intangible_asset_id = $1 AND idempotency_key = $2`,
        [asset.id, idempotencyKey],
      );
      if (existing[0]) {
        changeId = existing[0].id;
        await client.query("COMMIT");
        const detail = await getIntangibleAsset(params.businessId, asset.id);
        const estimateChange = detail?.estimateChanges.find((change) => change.id === changeId);
        if (!detail || !estimateChange) throw new IntangibleAssetError("estimate_change_failed", 500);
        return { asset: detail.asset, estimateChange };
      }
    }

    const newType = (params.usefulLifeType?.trim() || asset.usefulLifeType) as UsefulLifeType;
    if (newType !== "finite" && newType !== "indefinite") {
      throw new IntangibleAssetError("invalid_useful_life_type");
    }
    const newMonths =
      newType === "finite" ? (params.usefulLifeMonths ?? asset.usefulLifeMonths ?? null) : null;
    if (
      newType === "finite" &&
      (newMonths === null ||
        !Number.isInteger(newMonths) ||
        newMonths <= 0 ||
        newMonths > INTANGIBLE_USEFUL_LIFE_MAX_MONTHS)
    ) {
      throw new IntangibleAssetError("invalid_useful_life");
    }
    const newResidual = params.residualValue ?? asset.residualValue;
    if (!Number.isSafeInteger(newResidual) || newResidual < 0) {
      throw new IntangibleAssetError("invalid_residual_value");
    }
    if (newResidual >= asset.cost) throw new IntangibleAssetError("residual_not_less_than_cost");

    const live = await liveAmortization(client, asset.id);
    const carryingBefore = intrinsicCarryingAmount({
      cost: asset.cost,
      accumulatedAmortization: live.accumulated,
      accumulatedImpairment: asset.accumulatedImpairment,
    });
    // A residual above the carrying amount would make the remaining
    // amortizable base negative — the asset would be "over-amortized" the
    // moment the decision landed.
    if (newResidual > carryingBefore) {
      throw new IntangibleAssetError("residual_above_carrying_amount");
    }
    if (
      newType === asset.usefulLifeType &&
      newMonths === asset.usefulLifeMonths &&
      newResidual === asset.residualValue
    ) {
      throw new IntangibleAssetError("estimate_unchanged", 409);
    }
    if (newType === "finite" && newMonths) {
      const newEnd = addMonthsToPeriodKey(effectivePeriod.key, newMonths - 1);
      if (live.periodKeys.some((key) => key > newEnd)) {
        throw new IntangibleAssetError("estimate_change_excludes_history", 409);
      }
    }

    const remainingBase = Math.max(0, carryingBefore - newResidual);
    const change = await client.query<{ id: string }>(
      `INSERT INTO intangible_asset_estimate_changes
         (intangible_asset_id, effective_date, effective_period_key,
          previous_useful_life_type, previous_useful_life_months, previous_residual_value,
          new_useful_life_type, new_useful_life_months, new_residual_value,
          remaining_base, remaining_life_months,
          accumulated_amortization_at_change, accumulated_impairment_at_change,
          periods_posted_at_change, posted_period_keys,
          reason, evidence_reference, approved_by, changed_by, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
       RETURNING id`,
      [
        asset.id,
        effectiveDate,
        effectivePeriod.key,
        asset.usefulLifeType,
        asset.usefulLifeMonths,
        asset.residualValue,
        newType,
        newType === "finite" ? newMonths : null,
        newResidual,
        remainingBase,
        newType === "finite" ? newMonths : null,
        live.accumulated,
        asset.accumulatedImpairment,
        live.periodKeys.length,
        live.periodKeys,
        reason,
        params.evidenceReference?.trim() || null,
        params.createdBy,
        params.createdBy,
        idempotencyKey,
      ],
    );
    changeId = change.rows[0].id;

    await client.query(
      `UPDATE intangible_assets
          SET useful_life_type = $3, useful_life_months = $4, residual_value = $5, updated_at = now()
        WHERE business_id = $1 AND id = $2`,
      [params.businessId, asset.id, newType, newType === "finite" ? newMonths : null, newResidual],
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    if (isUniqueViolation(err)) throw new IntangibleAssetError("estimate_change_conflict", 409);
    throw err;
  } finally {
    client.release();
  }

  const detail = await getIntangibleAsset(params.businessId, params.intangibleAssetId);
  const estimateChange = detail?.estimateChanges.find((c) => c.id === changeId);
  if (!detail || !estimateChange) throw new IntangibleAssetError("estimate_change_failed", 500);
  return { asset: detail.asset, estimateChange };
}

/**
 * A side-effect-free preview of an estimate change: the remaining base, the
 * revised monthly amount and the projected schedule as if the change had been
 * recorded. Nothing is written; the UI uses the same arithmetic the posting
 * path will use.
 */
export async function previewIntangibleEstimate(params: {
  businessId: string;
  intangibleAssetId: string;
  effectiveDate: string;
  usefulLifeType?: string | null;
  usefulLifeMonths?: number | null;
  residualValue?: number | null;
}): Promise<{
  remainingBase: number;
  monthlyAmount: number | null;
  totals: AmortizationScheduleTotals;
  schedule: AmortizationScheduleRow[];
}> {
  const detail = await getIntangibleAsset(params.businessId, params.intangibleAssetId);
  if (!detail) throw new IntangibleAssetError("intangible_asset_not_found", 404);
  const effectiveDate = params.effectiveDate?.trim() ?? "";
  if (!isValidIsoDate(effectiveDate)) throw new IntangibleAssetError("invalid_effective_date");
  const effectivePeriod = depreciationPeriodOfDate(effectiveDate);
  if (!effectivePeriod) throw new IntangibleAssetError("invalid_effective_date");
  const newType = (params.usefulLifeType?.trim() || detail.asset.usefulLifeType) as UsefulLifeType;
  const newMonths =
    newType === "finite" ? (params.usefulLifeMonths ?? detail.asset.usefulLifeMonths ?? null) : null;
  if (
    newType === "finite" &&
    (newMonths === null ||
      !Number.isInteger(newMonths) ||
      newMonths <= 0 ||
      newMonths > INTANGIBLE_USEFUL_LIFE_MAX_MONTHS)
  ) {
    throw new IntangibleAssetError("invalid_useful_life");
  }
  const newResidual = params.residualValue ?? detail.asset.residualValue;
  if (!Number.isSafeInteger(newResidual) || newResidual < 0) {
    throw new IntangibleAssetError("invalid_residual_value");
  }
  if (newResidual > detail.asset.carryingAmount) {
    throw new IntangibleAssetError("residual_above_carrying_amount");
  }

  const { rows: schedule, totals } = projectAmortization({
    usefulLifeType: newType,
    asset: {
      cost: detail.asset.cost,
      residualValue: newResidual,
      usefulLifeMonths: newMonths ?? 0,
      availableForUseDate: detail.asset.availableForUseDate,
    },
    livePostings: detail.entries
      .filter((entry) => entry.reversedAt === null)
      .map((entry) => ({
        periodKey: entry.periodKey,
        amount: entry.amount,
        entryId: entry.id,
        journalEntryId: entry.journalEntryId,
        periodLabel: entry.periodLabel,
      })),
    todayPeriodKey: depreciationPeriodOfDate(await businessToday(params.businessId))?.key ?? "",
    accumulatedImpairment: detail.asset.accumulatedImpairment,
    revisions: [
      ...projectionRevisions(
        detail.estimateChanges.map((change) => ({
          id: change.id,
          effective_date: change.effectiveDate,
          effective_period_key: change.effectivePeriodKey,
          previous_useful_life_type: change.previousUsefulLifeType,
          previous_useful_life_months: change.previousUsefulLifeMonths,
          previous_residual_value: String(change.previousResidualValue),
          new_useful_life_type: change.newUsefulLifeType,
          new_useful_life_months: change.newUsefulLifeMonths,
          new_residual_value: String(change.newResidualValue),
          remaining_base: String(change.remainingBase),
          remaining_life_months: change.remainingLifeMonths,
          accumulated_amortization_at_change: String(change.accumulatedAmortizationAtChange),
          accumulated_impairment_at_change: String(change.accumulatedImpairmentAtChange),
          periods_posted_at_change: change.periodsPostedAtChange,
          reason: change.reason,
          evidence_reference: change.evidenceReference,
          approved_by_name: change.approvedByName,
          changed_by_name: change.changedByName,
          created_at: change.createdAt,
        })),
      ),
      {
        effectivePeriodKey: effectivePeriod.key,
        previousUsefulLifeType: detail.asset.usefulLifeType,
        previousUsefulLifeMonths: detail.asset.usefulLifeMonths ?? 0,
        previousResidualValue: detail.asset.residualValue,
        usefulLifeMonths: newMonths ?? 0,
        residualValue: newResidual,
        remainingBase: Math.max(0, detail.asset.carryingAmount - newResidual),
      },
    ],
  });
  const remainingBase = Math.max(0, detail.asset.carryingAmount - newResidual);
  const monthlyAmount =
    newType === "finite" && newMonths && newMonths > 0 ? Math.round(remainingBase / newMonths) : null;
  return { remainingBase, monthlyAmount, totals, schedule };
}

export async function getIntangibleReconciliation(businessId: string): Promise<IntangibleReconciliation> {
  const { rows } = await query<{
    register_cost: string;
    register_amortization: string;
    register_impairment: string;
    unmapped_count: string;
    ledger_cost: string;
    ledger_amortization: string;
    ledger_impairment: string;
  }>(
    `WITH mapped AS (
       SELECT a.asset_account_id, a.accumulated_amortization_account_id, a.accumulated_impairment_account_id
         FROM intangible_assets a WHERE a.business_id = $1
     ),
     register AS (
       SELECT
         COALESCE((SELECT SUM(a.cost) FROM intangible_assets a
                    WHERE a.business_id = $1 AND a.status = 'active'), 0)::text AS register_cost,
         COALESCE((SELECT SUM(e.amount) FROM intangible_asset_amortization_entries e
                     JOIN intangible_assets a ON a.id = e.intangible_asset_id
                    WHERE a.business_id = $1 AND e.reversed_at IS NULL), 0)::text AS register_amortization,
         (COALESCE((SELECT SUM(i.impairment_amount) FROM intangible_asset_impairments i
                      JOIN intangible_assets a ON a.id = i.intangible_asset_id
                     WHERE a.business_id = $1 AND i.reversal_of IS NULL AND i.reversed_at IS NULL), 0)
          - COALESCE((SELECT SUM(i.impairment_amount) FROM intangible_asset_impairments i
                        JOIN intangible_assets a ON a.id = i.intangible_asset_id
                       WHERE a.business_id = $1 AND i.reversal_of IS NOT NULL), 0))::text AS register_impairment,
         (SELECT COUNT(*) FROM intangible_assets a
           WHERE a.business_id = $1 AND a.status = 'active'
             AND (a.asset_account_id IS NULL
                  OR (a.useful_life_type = 'finite' AND a.accumulated_amortization_account_id IS NULL)))::text
           AS unmapped_count
     ),
     live_lines AS (
       SELECT jl.account_id, SUM(jl.debit - jl.credit) AS net_debit
         FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.entry_id
        WHERE je.business_id = $1
          AND je.reversed_at IS NULL
          AND je.reverses_entry_id IS NULL
        GROUP BY jl.account_id
     )
     SELECT register.register_cost, register.register_amortization, register.register_impairment,
            register.unmapped_count,
            COALESCE((SELECT SUM(l.net_debit) FROM live_lines l
                        JOIN mapped m ON m.asset_account_id = l.account_id), 0)::text AS ledger_cost,
            COALESCE((SELECT -SUM(l.net_debit) FROM live_lines l
                        JOIN mapped m ON m.accumulated_amortization_account_id = l.account_id), 0)::text
              AS ledger_amortization,
            COALESCE((SELECT -SUM(l.net_debit) FROM live_lines l
                        JOIN mapped m ON m.accumulated_impairment_account_id = l.account_id), 0)::text
              AS ledger_impairment
       FROM register`,
    [businessId],
  );
  const r = rows[0];
  return reconcileIntangibleRegister({
    registerCost: BigInt(r.register_cost),
    registerAccumulatedAmortization: BigInt(r.register_amortization),
    registerAccumulatedImpairment: BigInt(r.register_impairment),
    ledgerCost: BigInt(r.ledger_cost),
    ledgerAccumulatedAmortization: BigInt(r.ledger_amortization),
    ledgerAccumulatedImpairment: BigInt(r.ledger_impairment),
    unmappedCount: Number(r.unmapped_count),
  });
}



// ---------------------------------------------------------------------------
// Reports and exports (issue #1326/ESH-163 phase 4). Every report reads the
// same live history the register and detail screen read — no second balance,
// no parallel calculation — and honours the same branch/class/life filters.
// ---------------------------------------------------------------------------

export interface IntangibleReportFilters extends IntangibleListFilters {
  /** Inclusive Jalali-period window derived from the screen's Shamsi dates. */
  periodFrom?: string | null;
  periodTo?: string | null;
}

export interface IntangibleReportBundle {
  register: IntangibleAsset[];
  schedule: (AmortizationScheduleRow & {
    intangibleAssetId: string;
    assetCode: string;
    assetName: string;
  })[];
  postedHistory: {
    id: string;
    intangibleAssetId: string;
    assetCode: string;
    assetName: string;
    periodKey: string;
    periodLabel: string;
    entryDate: string;
    amount: number;
    reversedAt: string | null;
    journalEntryId: string | null;
  }[];
  impairments: {
    id: string;
    intangibleAssetId: string;
    assetCode: string;
    assetName: string;
    assessmentDate: string;
    effectiveDate: string;
    recoverableAmount: number;
    carryingAmountBefore: number;
    impairmentAmount: number;
    reason: string;
    reversedAt: string | null;
    reversalOf: string | null;
    journalEntryId: string | null;
  }[];
  disposals: {
    id: string;
    code: string;
    name: string;
    kind: DisposalKind | null;
    disposalDate: string | null;
    proceeds: number;
    carryingAmount: number;
    gain: number;
    loss: number;
    reason: string | null;
    journalEntryId: string | null;
  }[];
  reconciliation: IntangibleReconciliation;
}

/**
 * The accountant's six reports as one bundle: register, period schedule,
 * posted amortization history, impairment and reversals, disposals, and the
 * register↔ledger reconciliation. Branch and date filters are applied in SQL
 * (register/postings/impairments) or on the derived rows (schedule), so a
 * filtered screen and its export describe exactly the same population.
 */
export async function getIntangibleReports(
  businessId: string,
  filters: IntangibleReportFilters = {},
): Promise<IntangibleReportBundle> {
  // The schedule must see assets acquired before the period window (an old
  // licence still amortizes in it), so the population is read without the
  // acquisition-date filter; the register report applies that filter itself.
  const assets = await listIntangibleAssets(businessId, { ...filters, dateFrom: null, dateTo: null });
  const registerAssets = assets.filter((asset) => {
    if (filters.dateFrom && asset.acquisitionDate < filters.dateFrom) return false;
    if (filters.dateTo && asset.acquisitionDate > filters.dateTo) return false;
    return true;
  });
  const ids = assets.map((asset) => asset.id);
  const idList = ids.length > 0 ? ids : ["00000000-0000-0000-0000-000000000000"];

  const [postingsResult, impairmentsResult, changesResult, reconciliation] = await Promise.all([
    query<{
      id: string;
      intangible_asset_id: string;
      period_key: string;
      period_label: string;
      entry_date: string;
      amount: string;
      reversed_at: string | null;
      journal_entry_id: string | null;
    }>(
      `SELECT e.id, e.intangible_asset_id, e.period_key, e.period_label,
              e.entry_date::text AS entry_date, e.amount::text AS amount,
              e.reversed_at::text AS reversed_at, je.id AS journal_entry_id
         FROM intangible_asset_amortization_entries e
         LEFT JOIN journal_entries je
           ON je.source_type = 'intangible_asset_amortization' AND je.source_id = e.id
          AND je.reverses_entry_id IS NULL
        WHERE e.intangible_asset_id = ANY($1::uuid[])
        ORDER BY e.period_key, e.entry_date`,
      [idList],
    ),
    query<{
      id: string;
      intangible_asset_id: string;
      assessment_date: string;
      effective_date: string;
      recoverable_amount: string;
      carrying_amount_before: string;
      impairment_amount: string;
      reason: string;
      reversed_at: string | null;
      reversal_of: string | null;
      journal_entry_id: string | null;
    }>(
      `SELECT i.id, i.intangible_asset_id, i.assessment_date::text AS assessment_date,
              i.effective_date::text AS effective_date,
              i.recoverable_amount::text AS recoverable_amount,
              i.carrying_amount_before::text AS carrying_amount_before,
              i.impairment_amount::text AS impairment_amount, i.reason,
              i.reversed_at::text AS reversed_at, i.reversal_of, i.journal_entry_id
         FROM intangible_asset_impairments i
        WHERE i.intangible_asset_id = ANY($1::uuid[])
        ORDER BY i.effective_date, i.created_at`,
      [idList],
    ),
    query<EstimateChangeRow & { intangible_asset_id: string }>(
      `SELECT c.intangible_asset_id, c.id, c.effective_date::text AS effective_date,
              c.effective_period_key, c.previous_useful_life_type, c.previous_useful_life_months,
              c.previous_residual_value::text AS previous_residual_value,
              c.new_useful_life_type, c.new_useful_life_months,
              c.new_residual_value::text AS new_residual_value,
              c.remaining_base::text AS remaining_base, c.remaining_life_months,
              c.accumulated_amortization_at_change::text AS accumulated_amortization_at_change,
              c.accumulated_impairment_at_change::text AS accumulated_impairment_at_change,
              c.periods_posted_at_change, c.reason, c.evidence_reference,
              c.created_at::text AS created_at, NULL::text AS approved_by_name, NULL::text AS changed_by_name
         FROM intangible_asset_estimate_changes c
        WHERE c.intangible_asset_id = ANY($1::uuid[])
        ORDER BY c.effective_period_key, c.created_at`,
      [idList],
    ),
    getIntangibleReconciliation(businessId),
  ]);

  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  const postingsByAsset = new Map<string, typeof postingsResult.rows>();
  for (const entry of postingsResult.rows) {
    const list = postingsByAsset.get(entry.intangible_asset_id) ?? [];
    list.push(entry);
    postingsByAsset.set(entry.intangible_asset_id, list);
  }
  const changesByAsset = new Map<string, EstimateChangeRow[]>();
  for (const change of changesResult.rows) {
    const list = changesByAsset.get(change.intangible_asset_id) ?? [];
    list.push(change);
    changesByAsset.set(change.intangible_asset_id, list);
  }

  const today = await businessToday(businessId);
  const todayPeriodKey = depreciationPeriodOfDate(today)?.key ?? "";
  const periodFrom =
    filters.periodFrom?.trim() || (filters.dateFrom ? depreciationPeriodOfDate(filters.dateFrom)?.key : null) || null;
  const periodTo =
    filters.periodTo?.trim() || (filters.dateTo ? depreciationPeriodOfDate(filters.dateTo)?.key : null) || null;

  const schedule: IntangibleReportBundle["schedule"] = [];
  for (const asset of assets) {
    if (asset.usefulLifeType !== "finite") continue;
    const entries = postingsByAsset.get(asset.id) ?? [];
    const { rows } = projectAmortization({
      usefulLifeType: "finite",
      asset: {
        cost: asset.cost,
        residualValue: asset.residualValue,
        usefulLifeMonths: asset.usefulLifeMonths ?? 0,
        availableForUseDate: asset.availableForUseDate,
      },
      livePostings: entries
        .filter((entry) => entry.reversed_at === null)
        .map((entry) => ({
          periodKey: entry.period_key,
          amount: Number(entry.amount),
          entryId: entry.id,
          journalEntryId: entry.journal_entry_id,
          periodLabel: entry.period_label,
        })),
      todayPeriodKey,
      accumulatedImpairment: asset.accumulatedImpairment,
      revisions: projectionRevisions(changesByAsset.get(asset.id) ?? []),
    });
    for (const row of rows) {
      if (periodFrom && row.periodKey < periodFrom) continue;
      if (periodTo && row.periodKey > periodTo) continue;
      schedule.push({ ...row, intangibleAssetId: asset.id, assetCode: asset.code, assetName: asset.name });
    }
  }

  const postedHistory = postingsResult.rows
    .filter((entry) => {
      if (filters.dateFrom && entry.entry_date < filters.dateFrom) return false;
      if (filters.dateTo && entry.entry_date > filters.dateTo) return false;
      return true;
    })
    .map((entry) => {
      const asset = assetById.get(entry.intangible_asset_id);
      return {
        id: entry.id,
        intangibleAssetId: entry.intangible_asset_id,
        assetCode: asset?.code ?? "",
        assetName: asset?.name ?? "",
        periodKey: entry.period_key,
        periodLabel: entry.period_label,
        entryDate: entry.entry_date,
        amount: Number(entry.amount),
        reversedAt: entry.reversed_at,
        journalEntryId: entry.journal_entry_id,
      };
    });

  const impairments = impairmentsResult.rows
    .filter((entry) => {
      if (filters.dateFrom && entry.effective_date < filters.dateFrom) return false;
      if (filters.dateTo && entry.effective_date > filters.dateTo) return false;
      return true;
    })
    .map((entry) => {
      const asset = assetById.get(entry.intangible_asset_id);
      return {
        id: entry.id,
        intangibleAssetId: entry.intangible_asset_id,
        assetCode: asset?.code ?? "",
        assetName: asset?.name ?? "",
        assessmentDate: entry.assessment_date,
        effectiveDate: entry.effective_date,
        recoverableAmount: Number(entry.recoverable_amount),
        carryingAmountBefore: Number(entry.carrying_amount_before),
        impairmentAmount: Number(entry.impairment_amount),
        reason: entry.reason,
        reversedAt: entry.reversed_at,
        reversalOf: entry.reversal_of,
        journalEntryId: entry.journal_entry_id,
      };
    });

  const disposals = assets
    .filter((asset) => asset.status === "disposed")
    .filter((asset) => {
      if (filters.dateFrom && asset.disposalDate && asset.disposalDate < filters.dateFrom) return false;
      if (filters.dateTo && asset.disposalDate && asset.disposalDate > filters.dateTo) return false;
      return true;
    })
    .map((asset) => {
      const outcome = intangibleDisposalOutcome({
        cost: asset.cost,
        accumulatedAmortization: asset.accumulatedAmortization,
        accumulatedImpairment: asset.accumulatedImpairment,
        proceeds: asset.disposalProceeds ?? 0,
      });
      return {
        id: asset.id,
        code: asset.code,
        name: asset.name,
        kind: asset.disposalKind,
        disposalDate: asset.disposalDate,
        proceeds: asset.disposalProceeds ?? 0,
        carryingAmount: outcome.netBookValue,
        gain: outcome.gain,
        loss: outcome.loss,
        reason: asset.disposalReason,
        journalEntryId: null,
      };
    });

  return { register: registerAssets, schedule, postedHistory, impairments, disposals, reconciliation };
}

export interface IntangibleExportResult {
  /** The workbook's sheets, in reading order. */
  sheets: SheetData[];
  /** Rows in the filtered register — the number the register sheet carries. */
  registerTotal: number;
}

/**
 * The accountant-grade outputs (issue #1326/ESH-163 phase 4): the filtered
 * register, the period amortization schedule (posted months from history and
 * future months as projection), the posted amortization history, impairment
 * and reversal history, the disposal report, the estimate-change history and
 * the register↔ledger reconciliation.
 *
 * Every sheet is built from `getIntangibleReports` — the same read the screen
 * uses — so the file and the screen can never disagree about a figure or about
 * which assets a filter admitted. No sheet is capped: the only refusal is the
 * xlsx format's own row ceiling.
 */
export async function intangibleAssetsExportSheets(
  businessId: string,
  filters: IntangibleListFilters = {},
): Promise<IntangibleExportResult> {
  const report = await getIntangibleReports(businessId, filters);
  const assetIds = report.register.map((asset) => asset.id);
  const idList = assetIds.length > 0 ? assetIds : ["00000000-0000-0000-0000-000000000000"];

  const changes = await query<EstimateChangeRow & { code: string; name: string; changed_by_name: string | null }>(
    `SELECT c.id, c.effective_date::text AS effective_date, c.effective_period_key,
            c.previous_useful_life_type, c.previous_useful_life_months,
            c.previous_residual_value::text AS previous_residual_value,
            c.new_useful_life_type, c.new_useful_life_months,
            c.new_residual_value::text AS new_residual_value,
            c.remaining_base::text AS remaining_base, c.remaining_life_months,
            c.accumulated_amortization_at_change::text AS accumulated_amortization_at_change,
            c.accumulated_impairment_at_change::text AS accumulated_impairment_at_change,
            c.periods_posted_at_change, c.reason, c.evidence_reference,
            c.created_at::text AS created_at,
            a.code, a.name, u.full_name AS changed_by_name
       FROM intangible_asset_estimate_changes c
       JOIN intangible_assets a ON a.id = c.intangible_asset_id
       LEFT JOIN users u ON u.id = c.changed_by
      WHERE c.intangible_asset_id = ANY($1::uuid[])
      ORDER BY a.code, c.effective_period_key, c.created_at`,
    [idList],
  );

  const registerRows = report.register.map((asset) => ({
    code: asset.code,
    name: asset.name,
    assetClass: INTANGIBLE_ASSET_CLASS_LABELS[asset.assetClass] ?? asset.assetClass,
    status: asset.status === "disposed" ? "واگذارشده" : "در جریان",
    lifeType: USEFUL_LIFE_TYPE_LABELS[asset.usefulLifeType],
    usefulLifeMonths: asset.usefulLifeMonths ?? "",
    acquisitionDate: asset.acquisitionDate,
    availableForUseDate: asset.availableForUseDate,
    directCost: asset.directlyAttributableCost,
    cost: asset.cost,
    residualValue: asset.residualValue,
    accumulatedAmortization: asset.accumulatedAmortization,
    accumulatedImpairment: asset.accumulatedImpairment,
    carryingAmount: asset.carryingAmount,
    remainingLifeMonths: asset.remainingLifeMonths ?? "",
    periodsPosted: asset.periodsPosted,
    locationName: asset.locationName ?? "",
    custodianName: asset.custodianName ?? "",
    capitalizationPolicyNote: asset.capitalizationPolicyNote ?? "",
    evidenceReference: asset.evidenceReference ?? "",
    lastPostingDate: asset.lastPostingDate ?? "",
    lastReviewDate: asset.lastReviewDate ?? "",
    disposalDate: asset.disposalDate ?? "",
  }));

  const scheduleRows = report.schedule.map((row) => ({
    code: row.assetCode,
    name: row.assetName,
    periodKey: row.periodKey,
    periodLabel: row.label,
    startsOn: row.startsOn,
    endsOn: row.endsOn,
    status: row.status === "posted" ? "ثبت‌شده" : "پیش‌بینی",
    openingCarrying: row.openingCarrying,
    amortization: row.amortization,
    closingCarrying: row.closingCarrying,
    accumulated: row.accumulated,
  }));

  const historyRows = report.postedHistory.map((entry) => ({
    code: entry.assetCode,
    name: entry.assetName,
    periodLabel: entry.periodLabel,
    entryDate: entry.entryDate,
    amount: entry.amount,
    reversed: entry.reversedAt ? "بله" : "خیر",
    journalEntryId: entry.journalEntryId ?? "",
  }));

  const impairmentRows = report.impairments.map((entry) => ({
    code: entry.assetCode,
    name: entry.assetName,
    assessmentDate: entry.assessmentDate,
    effectiveDate: entry.effectiveDate,
    recoverableAmount: entry.recoverableAmount,
    carryingAmountBefore: entry.carryingAmountBefore,
    impairmentAmount: entry.impairmentAmount,
    reversal: entry.reversalOf ? "برگشت کاهش ارزش" : entry.reversedAt ? "برگشت‌خورده" : "ثبت‌شده",
    reason: entry.reason,
  }));

  const disposalRows = report.disposals.map((entry) => ({
    code: entry.code,
    name: entry.name,
    kind: entry.kind ? DISPOSAL_KIND_LABELS[entry.kind] : "",
    disposalDate: entry.disposalDate ?? "",
    proceeds: entry.proceeds,
    carryingAmount: entry.carryingAmount,
    gain: entry.gain,
    loss: entry.loss,
    reason: entry.reason ?? "",
  }));

  const changeRows = changes.rows.map((change) => ({
    code: change.code,
    name: change.name,
    effectiveDate: change.effective_date,
    effectivePeriodKey: change.effective_period_key,
    previousLife:
      change.previous_useful_life_type === "finite"
        ? `${change.previous_useful_life_months ?? 0} ماه`
        : "نامحدود",
    newLife:
      change.new_useful_life_type === "finite" ? `${change.new_useful_life_months ?? 0} ماه` : "نامحدود",
    previousResidual: Number(change.previous_residual_value),
    newResidual: Number(change.new_residual_value),
    remainingBase: Number(change.remaining_base),
    reason: change.reason,
    evidenceReference: change.evidence_reference ?? "",
    changedByName: change.changed_by_name ?? "",
    createdAt: change.created_at,
  }));

  const reconciliation = report.reconciliation;
  const reconciliationRows: Record<string, unknown>[] = [
    { item: "بهای تمام‌شدهٔ ثبت دفتر", register: reconciliation.registerCost, ledger: reconciliation.ledgerCost, difference: reconciliation.costDifference },
    {
      item: "استهلاک انباشته",
      register: reconciliation.registerAccumulatedAmortization,
      ledger: reconciliation.ledgerAccumulatedAmortization,
      difference: reconciliation.amortizationDifference,
    },
    {
      item: "کاهش ارزش انباشته",
      register: reconciliation.registerAccumulatedImpairment,
      ledger: reconciliation.ledgerAccumulatedImpairment,
      difference: reconciliation.impairmentDifference,
    },
    {
      item: "وضعیت تطبیق",
      register: reconciliation.status === "reconciled" ? "مطابق" : "دارای اختلاف",
      ledger: "",
      difference: "",
    },
    {
      item: "دارایی‌های بدون نگاشت حساب",
      register: reconciliation.unmappedCount,
      ledger: "",
      difference: "",
    },
  ];

  const sheets: SheetData[] = [
    {
      name: "دفتر دارایی‌های نامشهود",
      columns: [
        { key: "code", label: "کد دارایی" },
        { key: "name", label: "نام دارایی" },
        { key: "assetClass", label: "طبقه" },
        { key: "status", label: "وضعیت" },
        { key: "lifeType", label: "نوع عمر" },
        { key: "usefulLifeMonths", label: "عمر مفید (ماه)", type: "integer" },
        { key: "acquisitionDate", label: "تاریخ تحصیل", type: "date" },
        { key: "availableForUseDate", label: "تاریخ آمادهٔ بهره‌برداری", type: "date" },
        { key: "cost", label: "بهای سرمایه‌ای‌شده", type: "money" },
        { key: "directCost", label: "هزینهٔ مستقیم قابل انتساب", type: "money" },
        { key: "residualValue", label: "ارزش باقی‌مانده", type: "money" },
        { key: "accumulatedAmortization", label: "استهلاک انباشته", type: "money" },
        { key: "accumulatedImpairment", label: "کاهش ارزش انباشته", type: "money" },
        { key: "carryingAmount", label: "ارزش دفتری جاری", type: "money" },
        { key: "remainingLifeMonths", label: "عمر باقی‌مانده (ماه)", type: "integer" },
        { key: "periodsPosted", label: "دوره‌های ثبت‌شده", type: "integer" },
        { key: "locationName", label: "شعبه" },
        { key: "custodianName", label: "متصدی" },
        { key: "capitalizationPolicyNote", label: "یادداشت سیاست سرمایه‌ای‌سازی" },
        { key: "evidenceReference", label: "مرجع مستندات" },
        { key: "lastPostingDate", label: "آخرین ثبت استهلاک", type: "date" },
        { key: "lastReviewDate", label: "آخرین بازبینی کاهش ارزش", type: "date" },
        { key: "disposalDate", label: "تاریخ واگذاری", type: "date" },
      ],
      rows: registerRows,
    },
    {
      name: "برنامه استهلاک دوره‌ای",
      columns: [
        { key: "code", label: "کد دارایی" },
        { key: "name", label: "نام دارایی" },
        { key: "periodKey", label: "دوره" },
        { key: "periodLabel", label: "عنوان دوره" },
        { key: "startsOn", label: "آغاز دوره", type: "date" },
        { key: "endsOn", label: "پایان دوره", type: "date" },
        { key: "status", label: "وضعیت" },
        { key: "openingCarrying", label: "ارزش دفتری ابتدای دوره", type: "money" },
        { key: "amortization", label: "استهلاک دوره", type: "money" },
        { key: "closingCarrying", label: "ارزش دفتری پایان دوره", type: "money" },
        { key: "accumulated", label: "استهلاک انباشته", type: "money" },
      ],
      rows: scheduleRows,
    },
    {
      name: "سابقهٔ استهلاک ثبت‌شده",
      columns: [
        { key: "code", label: "کد دارایی" },
        { key: "name", label: "نام دارایی" },
        { key: "periodLabel", label: "دوره" },
        { key: "entryDate", label: "تاریخ سند", type: "date" },
        { key: "amount", label: "مبلغ", type: "money" },
        { key: "reversed", label: "برگشت‌خورده" },
        { key: "journalEntryId", label: "شناسهٔ سند" },
      ],
      rows: historyRows,
    },
    {
      name: "کاهش ارزش و برگشت",
      columns: [
        { key: "code", label: "کد دارایی" },
        { key: "name", label: "نام دارایی" },
        { key: "assessmentDate", label: "تاریخ ارزیابی", type: "date" },
        { key: "effectiveDate", label: "تاریخ اجرا", type: "date" },
        { key: "recoverableAmount", label: "مبلغ بازیافتنی", type: "money" },
        { key: "carryingAmountBefore", label: "ارزش دفتری پیش از ثبت", type: "money" },
        { key: "impairmentAmount", label: "مبلغ کاهش ارزش", type: "money" },
        { key: "reversal", label: "نوع" },
        { key: "reason", label: "دلیل" },
      ],
      rows: impairmentRows,
    },
    {
      name: "واگذاری‌ها",
      columns: [
        { key: "code", label: "کد دارایی" },
        { key: "name", label: "نام دارایی" },
        { key: "kind", label: "نوع واگذاری" },
        { key: "disposalDate", label: "تاریخ واگذاری", type: "date" },
        { key: "proceeds", label: "مبلغ وصولی", type: "money" },
        { key: "carryingAmount", label: "ارزش دفتری", type: "money" },
        { key: "gain", label: "سود", type: "money" },
        { key: "loss", label: "زیان", type: "money" },
        { key: "reason", label: "دلیل" },
      ],
      rows: disposalRows,
    },
    {
      name: "تغییر برآوردها",
      columns: [
        { key: "code", label: "کد دارایی" },
        { key: "name", label: "نام دارایی" },
        { key: "effectiveDate", label: "تاریخ اجرا", type: "date" },
        { key: "effectivePeriodKey", label: "دورهٔ اجرا" },
        { key: "previousLife", label: "عمر پیشین" },
        { key: "newLife", label: "عمر جدید" },
        { key: "previousResidual", label: "ارزش باقی‌ماندهٔ پیشین", type: "money" },
        { key: "newResidual", label: "ارزش باقی‌ماندهٔ جدید", type: "money" },
        { key: "remainingBase", label: "مبنای استهلاک باقی‌مانده", type: "money" },
        { key: "reason", label: "دلیل" },
        { key: "evidenceReference", label: "مستندات تأیید" },
        { key: "changedByName", label: "ثبت‌کننده" },
        { key: "createdAt", label: "زمان ثبت", type: "date" },
      ],
      rows: changeRows,
    },
    {
      name: "تطبیق با دفتر کل",
      columns: [
        { key: "item", label: "شرح" },
        { key: "register", label: "دفتر دارایی نامشهود" },
        { key: "ledger", label: "دفتر کل" },
        { key: "difference", label: "اختلاف" },
      ],
      rows: reconciliationRows,
    },
  ];

  return { sheets, registerTotal: report.register.length };
}
