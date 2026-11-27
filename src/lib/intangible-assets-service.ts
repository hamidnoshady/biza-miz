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
import { getPool, query } from "./db";
import { postExactMirrorEntry, postJournalEntry } from "./ledger-service";
import { WELL_KNOWN_CODES } from "./coa-template";
import { businessToday } from "./business-day-service";
import { isValidIsoDate } from "./jalali";
import { isUuid } from "./uuid";
import { depreciationPeriodOfDate } from "./depreciation";
import {
  amortizableBase,
  impairmentCharge,
  intangibleDisposalOutcome,
  intrinsicCarryingAmount,
  planAmortization,
  projectAmortization,
  reconcileIntangibleRegister,
  reversibleImpairment,
  validateIntangibleAsset,
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
         a.capitalization_policy_note, a.evidence_reference, a.custodian_party_id, a.notes,
         a.status, a.location_id, a.disposal_kind,
         a.disposal_date::text AS disposal_date,
         a.disposal_proceeds::text AS disposal_proceeds,
         a.disposal_reason,
         a.created_at::text AS created_at,
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
    FROM intangible_assets a`;

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

export interface IntangibleAssetDetail {
  asset: IntangibleAsset;
  entries: IntangibleAmortizationEntry[];
  impairments: IntangibleImpairment[];
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
      periodKey: params.periodKey,
      entryDate: params.entryDate,
      today,
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


