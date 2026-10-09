/**
 * Multicurrency accounting — the DB-touching half (issue #863).
 *
 * Currency configuration, exchange rates, foreign-currency posting,
 * settlement of foreign receivables/payables (realized FX) and optional
 * unrealized revaluation. Every arithmetic decision is delegated to the pure
 * `./multicurrency` module and covered by its unit suite plus
 * `integration/multicurrency.integration.test.ts`; this file owns
 * transactions, validation and SQL.
 *
 * The invariants this service keeps (each one pinned by a test):
 *
 *  - **Base is explicit.** `businesses.base_currency_code` is the only source
 *    of truth; every rate is quoted against it in one direction.
 *  - **Snapshots are immutable.** The entry stores which rate row it used, the
 *    rate value itself, the base currency, the rounding policy version and the
 *    rounding delta; the DB refuses edits to any of them (migration 0216's
 *    triggers). A later rate change can never rewrite history.
 *  - **Foreign and base reconcile exactly.** Lines carry both sides; the entry
 *    balances in the transaction currency AND in base, with any sub-unit
 *    residue stamped as `rounding_delta` under policy v1.
 *  - **FX results post through explicit rules.** Realized gain/loss is
 *    computed from FIFO-applied booked base versus settlement value and posted
 *    to 4930/5870; revaluation posts to 4935/5875. Nothing implicit.
 *  - **Idempotent posting.** A retried document (same `idempotencyKey`) returns
 *    the entry it already created — never a second one.
 *  - **Reversal is append-only.** A reversal is a new entry at the ORIGINAL
 *    rate snapshot (undoing the document, not revaluing it), stamped with the
 *    same `reverses_entry_id` link the manual journal uses.
 *
 * Every public operation runs in its own `withTenantTransaction`; the helpers
 * all use the ambient (pinned) `query()`, so a flow that composes several —
 * settlement posting a document and writing its applications — is still ONE
 * atomic transaction, the same way `ar-service.ts` composes posting calls.
 *
 * Like every DB-touching module in this repo, this file has no direct unit
 * test; the pure halves it delegates to are what `npm test` covers, and
 * `integration/multicurrency.integration.test.ts` covers these paths end to
 * end against a real Postgres.
 */
import { query, withTenantTransaction } from "./db";
import { WELL_KNOWN_CODES } from "./coa-template";
import { isValidIsoDate } from "./iso-date";
import { isUuid } from "./uuid";
import {
  buildMulticurrencyDocument,
  consumeOpenLots,
  convertToBaseMinor,
  isValidCurrencyCode,
  isValidCurrencyPrecision,
  isValidRateText,
  minorToMajorText,
  multicurrencyDocumentProblemMessage,
  rateToCanonical,
  realizedFxDifference,
  restateForeignBalance,
  ROUNDING_POLICY_VERSION,
  type CurrencyCode,
  type ForeignLotApplication,
  type ForeignOpenLot,
  type MulticurrencyDocument,
  type MulticurrencyLineInput,
  type SettlementDirection,
} from "./multicurrency";

/** Thrown with a stable machine code; routes map it straight to a status. */
export class MulticurrencyError extends Error {
  status: number;
  constructor(code: string, status = 400) {
    super(code);
    this.status = status;
  }
}

/** Journal source_type values this subsystem posts under. */
export const FX_SOURCE_TYPES = ["multicurrency", "fx_settlement", "fx_revaluation"] as const;
export type FxSourceType = (typeof FX_SOURCE_TYPES)[number];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseMinorAmountText(value: unknown, field: string): bigint {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) {
    throw new MulticurrencyError(`invalid_${field}`);
  }
  return BigInt(value);
}

// ---------------------------------------------------------------------------
// Currency configuration
// ---------------------------------------------------------------------------

export interface CurrencyRecord {
  code: string;
  name: string;
  symbol: string;
  precision: number;
  isActive: boolean;
}

export async function listCurrencies(includeInactive = false): Promise<CurrencyRecord[]> {
  const { rows } = await query<{
    code: string;
    name: string;
    symbol: string;
    precision: number;
    is_active: boolean;
  }>(
    `SELECT code, name, symbol, precision, is_active
       FROM currencies
      WHERE ($1::boolean OR is_active)
      ORDER BY code`,
    [includeInactive],
  );
  return rows.map((r) => ({
    code: r.code,
    name: r.name,
    symbol: r.symbol,
    precision: r.precision,
    isActive: r.is_active,
  }));
}

export async function createCurrency(input: {
  code: string;
  name: string;
  symbol?: string;
  precision: number;
}): Promise<CurrencyRecord> {
  const code = typeof input.code === "string" ? input.code.trim().toUpperCase() : "";
  if (!isValidCurrencyCode(code)) throw new MulticurrencyError("invalid_currency_code");
  if (typeof input.name !== "string" || input.name.trim().length === 0 || input.name.length > 80) {
    throw new MulticurrencyError("invalid_currency_name");
  }
  if (!isValidCurrencyPrecision(input.precision)) throw new MulticurrencyError("invalid_currency_precision");
  const symbol = typeof input.symbol === "string" ? input.symbol.slice(0, 16) : "";
  try {
    const { rows } = await query<{
      code: string;
      name: string;
      symbol: string;
      precision: number;
      is_active: boolean;
    }>(
      `INSERT INTO currencies (code, name, symbol, precision) VALUES ($1, $2, $3, $4)
       RETURNING code, name, symbol, precision, is_active`,
      [code, input.name.trim(), symbol, input.precision],
    );
    return { ...rows[0], isActive: rows[0].is_active };
  } catch (error) {
    if ((error as { code?: string }).code === "23505") throw new MulticurrencyError("currency_exists", 409);
    throw error;
  }
}

export async function updateCurrency(
  code: string,
  patch: { name?: string; symbol?: string; precision?: number; isActive?: boolean },
): Promise<CurrencyRecord> {
  if (!isValidCurrencyCode(code)) throw new MulticurrencyError("invalid_currency_code");
  if (patch.precision !== undefined && !isValidCurrencyPrecision(patch.precision)) {
    throw new MulticurrencyError("invalid_currency_precision");
  }
  // Precision is part of every stored amount's meaning; a currency with
  // postings cannot silently re-scale them.
  if (patch.precision !== undefined) {
    const { rows } = await query<{ used: boolean }>(
      `SELECT (EXISTS(SELECT 1 FROM journal_entries WHERE currency_code = $1)
            OR EXISTS(SELECT 1 FROM exchange_rates WHERE currency_code = $1)) AS used`,
      [code],
    );
    if (rows[0]?.used) throw new MulticurrencyError("currency_precision_locked", 409);
  }
  const { rows } = await query<{
    code: string;
    name: string;
    symbol: string;
    precision: number;
    is_active: boolean;
  }>(
    `UPDATE currencies SET
       name = COALESCE($2, name),
       symbol = COALESCE($3, symbol),
       precision = COALESCE($4, precision),
       is_active = COALESCE($5, is_active)
     WHERE code = $1
     RETURNING code, name, symbol, precision, is_active`,
    [code, patch.name ?? null, patch.symbol ?? null, patch.precision ?? null, patch.isActive ?? null],
  );
  if (!rows[0]) throw new MulticurrencyError("currency_not_found", 404);
  return { ...rows[0], isActive: rows[0].is_active };
}

export interface BusinessCurrencyConfig {
  baseCurrencyCode: string;
  baseCurrency: CurrencyRecord | null;
  /** The business's configured transaction currencies; `allowed` = switched on. */
  transactionCurrencies: (CurrencyRecord & { allowed: boolean })[];
}

export async function getBusinessCurrencyConfig(businessId: string): Promise<BusinessCurrencyConfig> {
  const [catalogue, config] = await Promise.all([
    listCurrencies(true),
    query<{
      base_currency_code: string;
      currency_code: string | null;
      is_active: boolean | null;
      name: string | null;
      symbol: string | null;
      precision: number | null;
    }>(
      `SELECT b.base_currency_code,
              bc.currency_code, bc.is_active,
              c.name, c.symbol, c.precision
         FROM businesses b
         LEFT JOIN business_currencies bc ON bc.business_id = b.id
         LEFT JOIN currencies c ON c.code = bc.currency_code
        WHERE b.id = $1
        ORDER BY bc.currency_code`,
      [businessId],
    ),
  ]);
  const baseCode = config.rows[0]?.base_currency_code ?? "IRR";
  const base = catalogue.find((c) => c.code === baseCode) ?? null;
  const transactionCurrencies = config.rows
    .filter((r) => r.currency_code !== null && r.name !== null)
    .map((r) => ({
      code: r.currency_code!,
      name: r.name!,
      symbol: r.symbol ?? "",
      precision: r.precision ?? 2,
      isActive: r.is_active ?? false,
      allowed: r.is_active ?? false,
    }));
  return { baseCurrencyCode: baseCode, baseCurrency: base, transactionCurrencies };
}

/**
 * Sets the business's base and allowed transaction currencies in one
 * transaction. Switching a currency off keeps its row with `is_active=false`
 * (and its rates with it) — a posted document never loses its currency.
 */
export async function setBusinessCurrencies(
  businessId: string,
  input: { baseCurrencyCode: string; transactionCurrencyCodes: unknown[] },
): Promise<BusinessCurrencyConfig> {
  const base = typeof input.baseCurrencyCode === "string" ? input.baseCurrencyCode.trim().toUpperCase() : "";
  const foreign: string[] = [];
  const seen = new Set<string>();
  for (const raw of input.transactionCurrencyCodes) {
    const code = typeof raw === "string" ? raw.trim().toUpperCase() : "";
    if (!isValidCurrencyCode(code)) throw new MulticurrencyError("invalid_currency_code");
    if (code === base) throw new MulticurrencyError("base_currency_not_a_transaction_currency");
    if (seen.has(code)) throw new MulticurrencyError("duplicate_currency");
    seen.add(code);
    foreign.push(code);
  }
  if (!isValidCurrencyCode(base)) throw new MulticurrencyError("invalid_currency_code");
  await withTenantTransaction(businessId, async () => {
    const { rows: known } = await query<{ code: string; is_active: boolean }>(
      `SELECT code, is_active FROM currencies WHERE code = ANY($1::text[])`,
      [[base, ...foreign]],
    );
    const knownMap = new Map(known.map((r) => [r.code, r.is_active]));
    if (!knownMap.has(base)) throw new MulticurrencyError("currency_not_found", 404);
    if (!knownMap.get(base)!) throw new MulticurrencyError("base_currency_inactive", 409);
    for (const code of foreign) {
      if (!knownMap.has(code)) throw new MulticurrencyError("currency_not_found", 404);
    }
    await query(`UPDATE businesses SET base_currency_code = $2 WHERE id = $1`, [businessId, base]);
    await query(
      `UPDATE business_currencies SET is_active = false
        WHERE business_id = $1 AND NOT (currency_code = ANY($2::text[])) AND is_active`,
      [businessId, foreign],
    );
    for (const code of foreign) {
      await query(
        `INSERT INTO business_currencies (business_id, currency_code, is_active)
         VALUES ($1, $2, true)
         ON CONFLICT (business_id, currency_code) DO UPDATE SET is_active = true`,
        [businessId, code],
      );
    }
  });
  return getBusinessCurrencyConfig(businessId);
}

// ---------------------------------------------------------------------------
// Exchange rates
// ---------------------------------------------------------------------------

export interface RateRecord {
  id: string;
  currencyCode: string;
  /** Canonical decimal text — base minor units per one major foreign unit. */
  rate: string;
  effectiveFrom: string;
  source: string;
  supersedesRateId: string | null;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
  voidedAt: string | null;
  voidReason: string | null;
}

async function loadRateRows(
  businessId: string,
  currencyCode: string | null,
  limit: number,
): Promise<RateRecord[]> {
  const { rows } = await query<{
    id: string;
    currency_code: string;
    rate: string;
    effective_from: Date;
    source: string;
    supersedes_rate_id: string | null;
    created_by: string | null;
    created_by_name: string | null;
    created_at: Date;
    voided_at: Date | null;
    void_reason: string | null;
  }>(
    `SELECT r.id, r.currency_code, trim_scale(r.rate)::text AS rate, r.effective_from, r.source,
            r.supersedes_rate_id, r.created_by, u.full_name AS created_by_name, r.created_at,
            v.voided_at, v.reason AS void_reason
       FROM exchange_rates r
       LEFT JOIN users u ON u.id = r.created_by
       LEFT JOIN exchange_rate_voids v ON v.rate_id = r.id
      WHERE r.business_id = $1
        AND ($2::text IS NULL OR r.currency_code = $2::text)
      ORDER BY r.currency_code, r.effective_from DESC, r.created_at DESC
      LIMIT $3`,
    [businessId, currencyCode, limit],
  );
  return rows.map((r) => ({
    id: r.id,
    currencyCode: r.currency_code,
    rate: r.rate,
    effectiveFrom: r.effective_from.toISOString(),
    source: r.source,
    supersedesRateId: r.supersedes_rate_id,
    createdBy: r.created_by,
    createdByName: r.created_by_name,
    createdAt: r.created_at.toISOString(),
    voidedAt: r.voided_at?.toISOString() ?? null,
    voidReason: r.void_reason,
  }));
}

export async function listRates(
  businessId: string,
  currencyCode: string | null,
  limit = 100,
): Promise<RateRecord[]> {
  if (currencyCode !== null && !isValidCurrencyCode(currencyCode)) throw new MulticurrencyError("invalid_currency");
  return loadRateRows(businessId, currencyCode, Math.min(Math.max(limit, 1), 500));
}

interface ResolvedRate {
  id: string;
  rate: string;
  currencyCode: string;
}

/**
 * The rate a document at `at` (default: now) would use: the latest row
 * effective at or before the moment, skipping voided rows. A document may pin
 * `rateId` instead — the only way to book at a *historical* rate, and the
 * service refuses a pinned rate whose currency or void-state disagrees.
 */
async function resolveRate(
  businessId: string,
  currencyCode: string,
  options: { rateId?: string | null; at?: Date | null; allowMissing?: boolean } = {},
): Promise<ResolvedRate> {
  if (options.rateId) {
    const { rows } = await query<{ id: string; rate: string; currency_code: string; voided: boolean }>(
      `SELECT r.id, trim_scale(r.rate)::text AS rate, r.currency_code, (v.id IS NOT NULL) AS voided
         FROM exchange_rates r
         LEFT JOIN exchange_rate_voids v ON v.rate_id = r.id
        WHERE r.id = $1 AND r.business_id = $2`,
      [options.rateId, businessId],
    );
    const row = rows[0];
    if (!row) {
      if (options.allowMissing) throw new MulticurrencyError("rate_not_found", 404);
      throw new MulticurrencyError("rate_not_found", 404);
    }
    if (row.currency_code !== currencyCode) throw new MulticurrencyError("rate_currency_mismatch", 409);
    if (row.voided) throw new MulticurrencyError("rate_voided", 409);
    return { id: row.id, rate: row.rate, currencyCode: row.currency_code };
  }
  const at = options.at ?? new Date();
  const { rows } = await query<{ id: string; rate: string }>(
    `SELECT r.id, trim_scale(r.rate)::text AS rate
       FROM exchange_rates r
       LEFT JOIN exchange_rate_voids v ON v.rate_id = r.id
      WHERE r.business_id = $1 AND r.currency_code = $2
        AND r.effective_from <= $3 AND v.id IS NULL
      ORDER BY r.effective_from DESC
      LIMIT 1`,
    [businessId, currencyCode, at.toISOString()],
  );
  if (!rows[0]) {
    if (options.allowMissing) return null as unknown as ResolvedRate;
    throw new MulticurrencyError("rate_not_configured", 409);
  }
  return { id: rows[0].id, rate: rows[0].rate, currencyCode };
}

/**
 * Records a manual rate. The value a lookup would have answered just before
 * is written to the audit ledger in the same transaction, and the new row
 * names the rate it supersedes — the manual-change audit trail.
 */
export async function recordRate(input: {
  businessId: string;
  currencyCode: string;
  rate: string;
  effectiveFrom?: string | null;
  actorId: string | null;
  source?: "manual" | "system";
}): Promise<RateRecord> {
  const currencyCode = input.currencyCode?.trim().toUpperCase();
  if (!isValidCurrencyCode(currencyCode)) throw new MulticurrencyError("invalid_currency");
  if (!isValidRateText(input.rate)) throw new MulticurrencyError("invalid_rate");
  const rate = rateToCanonical(input.rate);
  let effectiveFrom: Date;
  if (input.effectiveFrom != null && input.effectiveFrom !== "") {
    effectiveFrom = new Date(input.effectiveFrom);
    if (Number.isNaN(effectiveFrom.getTime())) throw new MulticurrencyError("invalid_effective_from");
  } else {
    effectiveFrom = new Date();
  }
  return withTenantTransaction(input.businessId, async () => {
    await assertCurrencyAvailable(input.businessId, currencyCode);
    const { rows: atInstant } = await query<{ id: string }>(
      `SELECT id FROM exchange_rates
        WHERE business_id = $1 AND currency_code = $2 AND effective_from = $3`,
      [input.businessId, currencyCode, effectiveFrom.toISOString()],
    );
    if (atInstant[0]) throw new MulticurrencyError("rate_already_recorded", 409);
    // The currency's first rate has no predecessor: supersedes NULL, old value NULL.
    const previous = await resolveRate(input.businessId, currencyCode, {
      at: effectiveFrom,
      allowMissing: true,
    });
    const { rows } = await query<{ id: string }>(
      `INSERT INTO exchange_rates
         (business_id, currency_code, rate, effective_from, source, supersedes_rate_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        input.businessId,
        currencyCode,
        rate,
        effectiveFrom.toISOString(),
        input.source ?? "manual",
        previous?.id ?? null,
        input.actorId,
      ],
    );
    await query(
      `INSERT INTO exchange_rate_changes
         (business_id, currency_code, action, old_rate, new_rate, new_effective_from, rate_id, actor_id)
       VALUES ($1, $2, 'record', $3, $4, $5, $6, $7)`,
      [
        input.businessId,
        currencyCode,
        previous?.rate ?? null,
        rate,
        effectiveFrom.toISOString(),
        rows[0].id,
        input.actorId,
      ],
    );
    const history = await loadRateRows(input.businessId, currencyCode, 50);
    const created = history.find((r) => r.id === rows[0].id);
    if (!created) throw new MulticurrencyError("rate_not_found", 404);
    return created;
  });
}

/** Voids a rate entered in error. Posted documents keep their snapshot; only future lookups skip it. */
export async function voidRate(input: {
  businessId: string;
  rateId: string;
  actorId: string | null;
  reason?: string | null;
}): Promise<void> {
  if (!isUuid(input.rateId)) throw new MulticurrencyError("invalid_rate_id");
  if (input.reason != null && (typeof input.reason !== "string" || input.reason.length > 500)) {
    throw new MulticurrencyError("invalid_reason");
  }
  await withTenantTransaction(input.businessId, async () => {
    const { rows } = await query<{ id: string; currency_code: string; rate: string; voided: boolean }>(
      `SELECT r.id, r.currency_code, trim_scale(r.rate)::text AS rate, (v.id IS NOT NULL) AS voided
         FROM exchange_rates r
         LEFT JOIN exchange_rate_voids v ON v.rate_id = r.id
        WHERE r.id = $1 AND r.business_id = $2`,
      [input.rateId, input.businessId],
    );
    const rate = rows[0];
    if (!rate) throw new MulticurrencyError("rate_not_found", 404);
    if (rate.voided) throw new MulticurrencyError("rate_already_voided", 409);
    await query(
      `INSERT INTO exchange_rate_voids (business_id, rate_id, voided_by, reason)
       VALUES ($1, $2, $3, $4)`,
      [input.businessId, input.rateId, input.actorId, input.reason ?? null],
    );
    await query(
      `INSERT INTO exchange_rate_changes
         (business_id, currency_code, action, voided_rate_id, voided_rate_value, reason, actor_id)
       VALUES ($1, $2, 'void', $3, $4, $5, $6)`,
      [input.businessId, rate.currency_code, input.rateId, rate.rate, input.reason ?? null, input.actorId],
    );
  });
}

// ---------------------------------------------------------------------------
// Shared posting validation
// ---------------------------------------------------------------------------

async function assertCurrencyAvailable(
  businessId: string,
  currencyCode: string,
): Promise<{ precision: number; baseCurrencyCode: string }> {
  const { rows } = await query<{
    precision: number;
    is_active: boolean;
    base_currency_code: string;
    allowed: boolean;
  }>(
    `SELECT c.precision, c.is_active,
            b.base_currency_code,
            (bc.currency_code IS NOT NULL AND bc.is_active) AS allowed
       FROM businesses b
       JOIN currencies c ON c.code = $2
       LEFT JOIN business_currencies bc ON bc.business_id = b.id AND bc.currency_code = $2
      WHERE b.id = $1`,
    [businessId, currencyCode],
  );
  const row = rows[0];
  if (!row) throw new MulticurrencyError("currency_not_found", 404);
  if (!row.is_active) throw new MulticurrencyError("currency_inactive", 409);
  if (row.base_currency_code === currencyCode) {
    throw new MulticurrencyError("base_currency_not_a_transaction_currency", 409);
  }
  if (!row.allowed) throw new MulticurrencyError("currency_not_allowed", 409);
  return { precision: row.precision, baseCurrencyCode: row.base_currency_code };
}

/**
 * Accounts a document touches must exist, be active, and — when they name a
 * currency (a foreign bank) — match the document's currency. Base-only legs
 * (the FX gain/loss lines) post to ordinary base accounts by design.
 */
async function assertAccountsUsable(
  businessId: string,
  accountIds: string[],
  currencyCode: string,
): Promise<void> {
  const unique = [...new Set(accountIds)];
  const { rows } = await query<{ id: string; is_active: boolean; currency_code: string | null }>(
    `SELECT id, is_active, currency_code FROM accounts WHERE business_id = $1 AND id = ANY($2::uuid[])`,
    [businessId, unique],
  );
  const map = new Map(rows.map((r) => [r.id, r]));
  for (const id of unique) {
    const account = map.get(id);
    if (!account) throw new MulticurrencyError("account_not_found", 404);
    if (!account.is_active) throw new MulticurrencyError("account_inactive", 409);
    if (account.currency_code !== null && account.currency_code !== currencyCode) {
      throw new MulticurrencyError("account_currency_mismatch", 409);
    }
  }
}

async function accountIdByCode(businessId: string, code: string): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM accounts WHERE business_id = $1 AND code = $2 AND is_active`,
    [businessId, code],
  );
  if (!rows[0]) throw new MulticurrencyError("ledger_account_missing", 409);
  return rows[0].id;
}

// ---------------------------------------------------------------------------
// Posting foreign-currency documents
// ---------------------------------------------------------------------------

export interface PostedMulticurrencyEntry {
  entryId: string;
  duplicate: boolean;
  currencyCode: string;
  rateId: string;
  rate: string;
  roundingDelta: string;
  foreignTotal: string;
  baseTotal: string;
}

export interface PostMulticurrencyEntryParams {
  businessId: string;
  locationId: string | null;
  entryDate: string | null;
  memo: string;
  currencyCode: string;
  rateId: string | null;
  lines: MulticurrencyLineInput[];
  createdBy: string | null;
  idempotencyKey: string | null;
  sourceType?: FxSourceType;
  sourceId?: string | null;
}

async function findEntryIdByIdempotencyKey(businessId: string, key: string): Promise<string | null> {
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM journal_entries WHERE business_id = $1 AND idempotency_key = $2`,
    [businessId, key],
  );
  return rows[0]?.id ?? null;
}

async function summarizePostedEntry(entryId: string, duplicate: boolean): Promise<PostedMulticurrencyEntry> {
  const { rows } = await query<{
    id: string;
    currency_code: string;
    exchange_rate_id: string;
    exchange_rate: string;
    rounding_delta: string;
    foreign_total: string;
    total_debit: string;
  }>(
    `SELECT je.id, je.currency_code, je.exchange_rate_id, je.exchange_rate,
            je.rounding_delta::text AS rounding_delta,
            COALESCE(fx.foreign_total, 0)::text AS foreign_total,
            COALESCE(totals.total_debit, 0)::text AS total_debit
       FROM journal_entries je
       LEFT JOIN LATERAL (
         SELECT sum(foreign_debit)::bigint AS foreign_total
           FROM journal_lines WHERE entry_id = je.id
       ) fx ON true
       LEFT JOIN LATERAL (
         SELECT sum(debit)::bigint AS total_debit FROM journal_lines WHERE entry_id = je.id
       ) totals ON true
      WHERE je.id = $1`,
    [entryId],
  );
  const row = rows[0];
  if (!row) throw new MulticurrencyError("entry_not_found", 404);
  return {
    entryId: row.id,
    duplicate,
    currencyCode: row.currency_code,
    rateId: row.exchange_rate_id,
    rate: row.exchange_rate,
    roundingDelta: row.rounding_delta,
    foreignTotal: row.foreign_total,
    baseTotal: row.total_debit,
  };
}

/** The one insert path for a foreign document (posting and settlement share it). */
async function insertForeignDocument(params: PostMulticurrencyEntryParams): Promise<PostedMulticurrencyEntry> {
  const currencyCode = params.currencyCode?.trim().toUpperCase();
  if (!isValidCurrencyCode(currencyCode)) throw new MulticurrencyError("invalid_currency");
  if (params.entryDate != null && !isValidIsoDate(params.entryDate)) {
    throw new MulticurrencyError("invalid_entry_date");
  }

  if (params.idempotencyKey) {
    const existing = await findEntryIdByIdempotencyKey(params.businessId, params.idempotencyKey);
    if (existing) return summarizePostedEntry(existing, true);
  }

  const currency = await assertCurrencyAvailable(params.businessId, currencyCode);
  const rate = await resolveRate(params.businessId, currencyCode, { rateId: params.rateId });

  const built = buildMulticurrencyDocument(params.lines, rate.rate, currency.precision);
  if (!built.ok) throw new MulticurrencyError(built.problem);
  const doc: MulticurrencyDocument = built.value;

  await assertAccountsUsable(
    params.businessId,
    doc.lines.map((l) => l.accountId),
    currencyCode,
  );

  const { rows } = await query<{ id: string }>(
    `INSERT INTO journal_entries
       (business_id, location_id, entry_date, memo, source_type, source_id, created_by,
        currency_code, base_currency_code, exchange_rate_id, exchange_rate, rounding_version, rounding_delta, idempotency_key)
     VALUES ($1, $2, COALESCE($3, CURRENT_DATE), $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     RETURNING id`,
    [
      params.businessId,
      params.locationId,
      params.entryDate,
      params.memo,
      params.sourceType ?? "multicurrency",
      params.sourceId ?? null,
      params.createdBy,
      currencyCode,
      currency.baseCurrencyCode,
      rate.id,
      rate.rate,
      ROUNDING_POLICY_VERSION,
      doc.roundingDelta.toString(),
      params.idempotencyKey,
    ],
  );
  const entryId = rows[0].id;
  for (const line of doc.lines) {
    await query(
      `INSERT INTO journal_lines
         (entry_id, account_id, debit, credit, foreign_debit, foreign_credit, party_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        entryId,
        line.accountId,
        line.baseDebit.toString(),
        line.baseCredit.toString(),
        line.foreignDebit.toString(),
        line.foreignCredit.toString(),
        line.partyId,
      ],
    );
  }
  return {
    entryId,
    duplicate: false,
    currencyCode,
    rateId: rate.id,
    rate: rate.rate,
    roundingDelta: doc.roundingDelta.toString(),
    foreignTotal: doc.foreignTotal.toString(),
    baseTotal: doc.baseTotal.toString(),
  };
}

export async function postMulticurrencyEntry(
  params: PostMulticurrencyEntryParams,
): Promise<PostedMulticurrencyEntry> {
  return withTenantTransaction(params.businessId, () => insertForeignDocument(params));
}

// ---------------------------------------------------------------------------
// Reversal — append-only, at the original snapshot
// ---------------------------------------------------------------------------

/**
 * Reverses a posted foreign-currency document. The reversing entry swaps every
 * base AND foreign amount and reuses the ORIGINAL rate snapshot — it undoes
 * the document as it was booked; reversing at today's rate would quietly
 * revalue history. A settlement's applications cascade away with its reversal
 * only if the settlement entry itself is ever deleted — which this code never
 * does; the applications stay as the settlement's history.
 */
export async function reverseFxEntry(params: {
  businessId: string;
  entryId: string;
  actorId: string | null;
  memo?: string | null;
  entryDate?: string | null;
}): Promise<{ entryId: string }> {
  if (!isUuid(params.entryId)) throw new MulticurrencyError("entry_not_found", 404);
  if (params.entryDate != null && !isValidIsoDate(params.entryDate)) {
    throw new MulticurrencyError("invalid_entry_date");
  }
  return withTenantTransaction(params.businessId, async () => {
    const { rows: entryRows } = await query<{
      id: string;
      source_type: string | null;
      currency_code: string | null;
      base_currency_code: string;
      exchange_rate_id: string | null;
      exchange_rate: string | null;
      rounding_version: number | null;
      reverses_entry_id: string | null;
      reversed_at: Date | null;
      location_id: string | null;
      memo: string | null;
    }>(
      `SELECT id, source_type, currency_code, base_currency_code, exchange_rate_id,
              exchange_rate, rounding_version,
              reverses_entry_id, reversed_at, location_id, memo
         FROM journal_entries WHERE id = $1 AND business_id = $2 FOR UPDATE`,
      [params.entryId, params.businessId],
    );
    const original = entryRows[0];
    if (!original) throw new MulticurrencyError("entry_not_found", 404);
    if (!original.currency_code) throw new MulticurrencyError("not_a_foreign_entry", 409);
    if (original.reverses_entry_id) throw new MulticurrencyError("cannot_reverse_a_reversal", 409);
    if (original.reversed_at) throw new MulticurrencyError("already_reversed", 409);
    if (original.source_type !== null && !FX_SOURCE_TYPES.includes(original.source_type as FxSourceType)) {
      throw new MulticurrencyError("not_reversible_here", 409);
    }

    const { rows: lineRows } = await query<{
      account_id: string;
      debit: string;
      credit: string;
      foreign_debit: string;
      foreign_credit: string;
      party_id: string | null;
    }>(
      `SELECT account_id, debit::text AS debit, credit::text AS credit,
              foreign_debit::text AS foreign_debit, foreign_credit::text AS foreign_credit, party_id
         FROM journal_lines WHERE entry_id = $1 ORDER BY id`,
      [params.entryId],
    );
    if (lineRows.length === 0) throw new MulticurrencyError("entry_has_no_lines", 409);

    const memo =
      (typeof params.memo === "string" && params.memo.trim()) ||
      `برگشت سند ارزی: ${original.memo ?? ""}`.trim();
    const { rows: inserted } = await query<{ id: string }>(
      `INSERT INTO journal_entries
         (business_id, location_id, entry_date, memo, source_type, created_by,
          currency_code, base_currency_code, exchange_rate_id, exchange_rate, rounding_version, rounding_delta)
       VALUES ($1, $2, COALESCE($3, CURRENT_DATE), $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id`,
      [
        params.businessId,
        original.location_id,
        params.entryDate,
        memo,
        original.source_type ?? "multicurrency",
        params.actorId,
        original.currency_code,
        original.base_currency_code,
        original.exchange_rate_id,
        original.exchange_rate,
        original.rounding_version,
        "0",
      ],
    );
    const reversalId = inserted[0].id;
    for (const line of lineRows) {
      await query(
        `INSERT INTO journal_lines
           (entry_id, account_id, debit, credit, foreign_debit, foreign_credit, party_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          reversalId,
          line.account_id,
          line.credit,
          line.debit,
          line.foreign_credit,
          line.foreign_debit,
          line.party_id,
        ],
      );
    }
    await query(`UPDATE journal_entries SET reverses_entry_id = $2 WHERE id = $1`, [reversalId, params.entryId]);
    await query(`UPDATE journal_entries SET reversed_at = now(), reversed_by = $2 WHERE id = $1`, [
      params.entryId,
      params.actorId,
    ]);
    return { entryId: reversalId };
  });
}

// ---------------------------------------------------------------------------
// Settlement of foreign A/R and A/P — realized FX
// ---------------------------------------------------------------------------

interface OpenLotRow extends Record<string, unknown> {
  line_id: string;
  entry_id: string;
  foreign_remaining: string;
  base_remaining: string;
}

/**
 * Open foreign items of one party in one currency: lines on the control
 * account (foreign-currency entries only), minus what earlier settlements
 * already applied. FIFO order = document date, then posting time, then the
 * line's identity.
 */
async function loadOpenLots(
  businessId: string,
  direction: SettlementDirection,
  currencyCode: string,
  partyId: string,
  entryIdFilter: string[] | null,
): Promise<ForeignOpenLot[]> {
  const controlCode =
    direction === "receivable" ? WELL_KNOWN_CODES.accountsReceivable : WELL_KNOWN_CODES.accountsPayable;
  const { rows } = await query<OpenLotRow>(
    `WITH applied AS (
       SELECT lot_line_id, sum(foreign_applied)::bigint AS foreign_applied, sum(base_applied)::bigint AS base_applied
         FROM fx_settlement_applications
        WHERE business_id = $1 AND direction = $2 AND currency_code = $3
        GROUP BY lot_line_id
     )
     SELECT jl.id::text AS line_id, je.id::text AS entry_id,
            (CASE WHEN $4 = 'receivable'
                  THEN jl.foreign_debit - jl.foreign_credit
                  ELSE jl.foreign_credit - jl.foreign_debit END
              - COALESCE(ap.foreign_applied, 0))::text AS foreign_remaining,
            (CASE WHEN $4 = 'receivable'
                  THEN jl.debit - jl.credit
                  ELSE jl.credit - jl.debit END
              - COALESCE(ap.base_applied, 0))::text AS base_remaining
       FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.entry_id
       JOIN accounts a ON a.id = jl.account_id
       LEFT JOIN applied ap ON ap.lot_line_id = jl.id
      WHERE je.business_id = $1
        AND je.currency_code = $3
        AND jl.party_id = $5
        AND a.code = $6
        AND ($7::uuid[] IS NULL OR je.id = ANY($7::uuid[]))
      ORDER BY je.entry_date, je.posted_at, jl.id`,
    [businessId, direction, currencyCode, direction, partyId, controlCode, entryIdFilter],
  );
  return rows
    .map((r) => ({
      lineId: r.line_id,
      entryId: r.entry_id,
      foreignRemaining: BigInt(r.foreign_remaining),
      baseRemaining: BigInt(r.base_remaining),
    }))
    .filter((l) => l.foreignRemaining > 0n);
}

export interface SettlementResult {
  entryId: string;
  duplicate: boolean;
  currencyCode: string;
  rateId: string;
  rate: string;
  foreignSettled: string;
  baseSettledAtBooking: string;
  baseSettledAtSettlementRate: string;
  /** Positive = realized FX gain; negative = realized FX loss; 0 = none. */
  realizedDifference: string;
  applications: { lotEntryId: string; foreignApplied: string; baseApplied: string }[];
}

export interface SettleParams {
  businessId: string;
  locationId: string | null;
  direction: SettlementDirection;
  partyId: string;
  currencyCode: string;
  rateId: string | null;
  settlementAccountId: string;
  /** Settle FIFO from the oldest open items up to this foreign amount (minor units as text). */
  autoAmount: string | null;
  /** Explicit open entries to consume (mutually exclusive with autoAmount). */
  items: { entryId: string; amount: string }[];
  entryDate: string | null;
  memo: string;
  actorId: string | null;
  idempotencyKey: string | null;
}

/**
 * Settles foreign open items FIFO at the current (or pinned) rate and posts
 * the realized gain/loss through the explicit FX accounts:
 *
 *   receivable: Dr settlement account (foreign at settlement rate)
 *               Cr A/R per consumed lot (its booked base)
 *               Cr 4930 / Dr 5870 the exact difference
 *   payable:    Dr A/P per consumed lot (booked base)
 *               Cr settlement account (foreign at settlement rate)
 *               Cr 4930 / Dr 5870 the exact difference
 */
export async function settleForeignDocument(params: SettleParams): Promise<SettlementResult> {
  const currencyCode = params.currencyCode?.trim().toUpperCase();
  if (!isValidCurrencyCode(currencyCode)) throw new MulticurrencyError("invalid_currency");
  if (!UUID_RE.test(params.partyId)) throw new MulticurrencyError("invalid_party");
  if (!UUID_RE.test(params.settlementAccountId)) throw new MulticurrencyError("invalid_account");
  if (params.entryDate != null && !isValidIsoDate(params.entryDate)) {
    throw new MulticurrencyError("invalid_entry_date");
  }
  if (params.autoAmount !== null && params.items.length > 0) throw new MulticurrencyError("either_auto_or_items");

  return withTenantTransaction(params.businessId, async () => {
    if (params.idempotencyKey) {
      const existing = await findEntryIdByIdempotencyKey(params.businessId, params.idempotencyKey);
      if (existing) return summarizeSettlement(existing, true);
    }

    const currency = await assertCurrencyAvailable(params.businessId, currencyCode);
    await assertAccountsUsable(params.businessId, [params.settlementAccountId], currencyCode);
    const { rows: party } = await query<{ id: string }>(
      `SELECT id FROM parties WHERE id = $1 AND business_id = $2`,
      [params.partyId, params.businessId],
    );
    if (!party[0]) throw new MulticurrencyError("party_not_found", 404);

    const rate = await resolveRate(params.businessId, currencyCode, { rateId: params.rateId });
    const entryIdFilter = params.items.length > 0 ? params.items.map((i) => i.entryId) : null;
    for (const item of params.items) {
      if (!UUID_RE.test(item.entryId)) throw new MulticurrencyError("invalid_entry_reference");
      parseMinorAmountText(item.amount, "amount");
    }
    const lots = await loadOpenLots(
      params.businessId,
      params.direction,
      currencyCode,
      params.partyId,
      entryIdFilter,
    );

    let applications: ForeignLotApplication[];
    if (params.autoAmount !== null) {
      const amount = parseMinorAmountText(params.autoAmount, "amount");
      const consumed = consumeOpenLots(lots, amount);
      if (!consumed.ok) {
        throw new MulticurrencyError(
          consumed.problem === "insufficient_open_balance" ? "insufficient_open_balance" : "invalid_amount",
          consumed.problem === "insufficient_open_balance" ? 409 : 400,
        );
      }
      applications = consumed.value;
    } else {
      // Explicit entries: consume each named entry's lots FIFO by the given amount.
      applications = [];
      for (const item of params.items) {
        const amount = parseMinorAmountText(item.amount, "amount");
        const consumed = consumeOpenLots(
          lots.filter((l) => l.entryId === item.entryId),
          amount,
        );
        if (!consumed.ok) {
          throw new MulticurrencyError(
            consumed.problem === "insufficient_open_balance" ? "insufficient_open_balance" : "invalid_amount",
            consumed.problem === "insufficient_open_balance" ? 409 : 400,
          );
        }
        applications.push(...consumed.value);
      }
    }
    if (applications.length === 0) throw new MulticurrencyError("nothing_to_settle", 409);
    if (applications.length > 200) throw new MulticurrencyError("too_many_items", 409);

    const foreignTotal = applications.reduce((sum, a) => sum + a.foreignApplied, 0n);
    const bookedBase = applications.reduce((sum, a) => sum + a.baseApplied, 0n);
    const settlementBase = convertToBaseMinor(foreignTotal, rate.rate, currency.precision);
    // For a receivable, settling above the booked base is a gain. For a
    // payable the obligation view flips: parting with LESS base than the
    // liability was booked at is a gain, parting with more is a loss.
    const difference =
      params.direction === "receivable"
        ? realizedFxDifference(settlementBase, bookedBase)
        : -realizedFxDifference(settlementBase, bookedBase);

    const controlAccountId = await accountIdByCode(
      params.businessId,
      params.direction === "receivable"
        ? WELL_KNOWN_CODES.accountsReceivable
        : WELL_KNOWN_CODES.accountsPayable,
    );

    const lines: MulticurrencyLineInput[] = [];
    // The settlement side: foreign value moves at the settlement rate.
    lines.push({
      accountId: params.settlementAccountId,
      side: params.direction === "receivable" ? "debit" : "credit",
      foreignMinor: foreignTotal,
    });
    // The control side: released at booked base — one line per consumed lot.
    for (const application of applications) {
      lines.push({
        accountId: controlAccountId,
        side: params.direction === "receivable" ? "credit" : "debit",
        foreignMinor: application.foreignApplied,
        baseMinor: application.baseApplied,
        partyId: params.partyId,
      });
    }
    // The realized difference, through the explicit FX pair.
    if (difference !== 0n) {
      const gain = difference > 0n;
      lines.push({
        accountId: await accountIdByCode(
          params.businessId,
          gain ? WELL_KNOWN_CODES.fxRealizedGain : WELL_KNOWN_CODES.fxRealizedLoss,
        ),
        side: gain ? "credit" : "debit",
        baseMinor: gain ? difference : -difference,
      });
    }

    const posted = await insertForeignDocument({
      businessId: params.businessId,
      locationId: params.locationId,
      entryDate: params.entryDate,
      memo: params.memo || (params.direction === "receivable" ? "تسویه دریافت ارزی" : "تسویه پرداخت ارزی"),
      currencyCode,
      rateId: rate.id,
      lines,
      createdBy: params.actorId,
      idempotencyKey: params.idempotencyKey,
      sourceType: "fx_settlement",
    });

    for (const application of applications) {
      await query(
        `INSERT INTO fx_settlement_applications
           (business_id, settlement_entry_id, lot_entry_id, lot_line_id, direction, currency_code, party_id, foreign_applied, base_applied)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          params.businessId,
          posted.entryId,
          application.entryId,
          application.lineId,
          params.direction,
          currencyCode,
          params.partyId,
          application.foreignApplied.toString(),
          application.baseApplied.toString(),
        ],
      );
    }
    return {
      entryId: posted.entryId,
      duplicate: posted.duplicate,
      currencyCode,
      rateId: posted.rateId,
      rate: posted.rate,
      foreignSettled: foreignTotal.toString(),
      baseSettledAtBooking: bookedBase.toString(),
      baseSettledAtSettlementRate: settlementBase.toString(),
      realizedDifference: difference.toString(),
      applications: applications.map((a) => ({
        lotEntryId: a.entryId,
        foreignApplied: a.foreignApplied.toString(),
        baseApplied: a.baseApplied.toString(),
      })),
    };
  });
}

async function summarizeSettlement(entryId: string, duplicate: boolean): Promise<SettlementResult> {
  const { rows } = await query<{
    currency_code: string;
    exchange_rate: string;
    precision: number;
    foreign_applied: string;
    base_applied: string;
  }>(
    `SELECT je.currency_code, je.exchange_rate, c.precision,
            COALESCE(sum(app.foreign_applied), 0)::text AS foreign_applied,
            COALESCE(sum(app.base_applied), 0)::text AS base_applied
       FROM journal_entries je
       JOIN currencies c ON c.code = je.currency_code
       LEFT JOIN fx_settlement_applications app ON app.settlement_entry_id = je.id
      WHERE je.id = $1
      GROUP BY je.currency_code, je.exchange_rate, c.precision`,
    [entryId],
  );
  const row = rows[0];
  if (!row) throw new MulticurrencyError("entry_not_found", 404);
  const foreignApplied = BigInt(row.foreign_applied);
  const baseApplied = BigInt(row.base_applied);
  const settlementBase = convertToBaseMinor(foreignApplied, row.exchange_rate, row.precision);
  return {
    entryId,
    duplicate,
    currencyCode: row.currency_code,
    rateId: "",
    rate: row.exchange_rate,
    foreignSettled: foreignApplied.toString(),
    baseSettledAtBooking: baseApplied.toString(),
    baseSettledAtSettlementRate: settlementBase.toString(),
    realizedDifference: (settlementBase - baseApplied).toString(),
    applications: [],
  };
}

// ---------------------------------------------------------------------------
// Unrealized revaluation (optional)
// ---------------------------------------------------------------------------

export interface RevaluationResult {
  revaluationId: string;
  entryId: string | null;
  currencyCode: string;
  rateId: string;
  rate: string;
  asOf: string;
  totalGain: string;
  totalLoss: string;
  lines: {
    accountId: string;
    foreignBalance: string;
    bookBaseBalance: string;
    newBaseValue: string;
    difference: string;
  }[];
  duplicate: boolean;
}

export interface RevaluateParams {
  businessId: string;
  currencyCode: string;
  asOf: string;
  rateId: string | null;
  actorId: string | null;
  idempotencyKey: string | null;
}

interface RevaluationOutcomeRow {
  accountId: string;
  foreignBalance: bigint;
  bookBase: bigint;
  outcome: ReturnType<typeof restateForeignBalance>;
}

/**
 * Restates every foreign-currency account of one currency at one rate. The
 * posted entry is a BASE-ONLY adjustment (the foreign balance itself does not
 * move) with `source_type='fx_revaluation'` and `posting_kind='fx_revaluation'`,
 * so the exposure reports keep reconstructing foreign balances from lines
 * untouched. Because the restatement compares the account's *current book
 * base* (which already includes earlier revaluations) against the new rate,
 * runs compose without reversal entries.
 */
export async function runFxRevaluation(params: RevaluateParams): Promise<RevaluationResult> {
  const currencyCode = params.currencyCode?.trim().toUpperCase();
  if (!isValidCurrencyCode(currencyCode)) throw new MulticurrencyError("invalid_currency");
  if (!isValidIsoDate(params.asOf)) throw new MulticurrencyError("invalid_as_of");
  return withTenantTransaction(params.businessId, async () => {
    if (params.idempotencyKey) {
      const { rows: existing } = await query<{
        id: string;
        entry_id: string | null;
        currency_code: string;
        rate_id: string;
        rate: string;
        as_of: Date;
        total_gain: string;
        total_loss: string;
      }>(
        `SELECT id, entry_id, currency_code, rate_id, rate, as_of,
                total_gain::text AS total_gain, total_loss::text AS total_loss
           FROM fx_revaluations WHERE business_id = $1 AND idempotency_key = $2`,
        [params.businessId, params.idempotencyKey],
      );
      if (existing[0]) {
        return {
          revaluationId: existing[0].id,
          entryId: existing[0].entry_id,
          currencyCode: existing[0].currency_code,
          rateId: existing[0].rate_id,
          rate: existing[0].rate,
          asOf: existing[0].as_of.toISOString().slice(0, 10),
          totalGain: existing[0].total_gain,
          totalLoss: existing[0].total_loss,
          lines: await loadRevaluationLines(existing[0].id),
          duplicate: true,
        };
      }
    }

    const currency = await assertCurrencyAvailable(params.businessId, currencyCode);
    const rate = await resolveRate(params.businessId, currencyCode, { rateId: params.rateId });

    // Book base = the account's WHOLE balance (any posting that moved it);
    // foreign balance = the currency's own lines. The restatement brings the
    // book value to rate × foreign, absorbing anything else on the account.
    const { rows: accounts } = await query<{
      id: string;
      type: string;
      foreign_balance: string;
      book_base: string;
    }>(
      `SELECT a.id, a.type::text AS type,
              (SELECT COALESCE(sum(jl.foreign_debit) - sum(jl.foreign_credit), 0)
                 FROM journal_lines jl
                 JOIN journal_entries je ON je.id = jl.entry_id
                WHERE jl.account_id = a.id AND je.currency_code = $2)::text AS foreign_balance,
              (SELECT COALESCE(sum(jl.debit) - sum(jl.credit), 0)
                 FROM journal_lines jl
                WHERE jl.account_id = a.id)::text AS book_base
         FROM accounts a
        WHERE a.business_id = $1 AND a.currency_code = $2`,
      [params.businessId, currencyCode],
    );

    const outcomes: RevaluationOutcomeRow[] = accounts
      .map((a) => ({
        accountId: a.id,
        foreignBalance: BigInt(a.foreign_balance),
        bookBase: BigInt(a.book_base),
        outcome: restateForeignBalance({
          foreignBalanceMinor: BigInt(a.foreign_balance),
          bookBaseMinor: BigInt(a.book_base),
          rate: rate.rate,
          precision: currency.precision,
          debitNormal: a.type === "asset" || a.type === "expense",
        }),
      }))
      .filter((o) => o.outcome.difference !== 0n);
    const effective = outcomes;

    const { rows: runRows } = await query<{ id: string }>(
      `INSERT INTO fx_revaluations
         (business_id, currency_code, as_of, rate_id, rate, rounding_version, total_gain, total_loss, idempotency_key, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        params.businessId,
        currencyCode,
        params.asOf,
        rate.id,
        rate.rate,
        ROUNDING_POLICY_VERSION,
        effective.reduce((s, o) => s + o.outcome.gain, 0n).toString(),
        effective.reduce((s, o) => s + o.outcome.loss, 0n).toString(),
        params.idempotencyKey,
        params.actorId,
      ],
    );
    const revaluationId = runRows[0].id;

    // The posted adjustment: uniform rule — gain debits the account and
    // credits 4935; loss debits 5875 and credits the account. (The
    // debit/credit-normal flip lives in the gain/loss computation, not here.)
    let entryId: string | null = null;
    if (effective.length > 0) {
      const fxGainId = await accountIdByCode(params.businessId, WELL_KNOWN_CODES.fxUnrealizedGain);
      const fxLossId = await accountIdByCode(params.businessId, WELL_KNOWN_CODES.fxUnrealizedLoss);
      const lines: { accountId: string; debit: bigint; credit: bigint }[] = [];
      for (const o of effective) {
        if (o.outcome.gain > 0n) {
          lines.push({ accountId: o.accountId, debit: o.outcome.gain, credit: 0n });
          lines.push({ accountId: fxGainId, debit: 0n, credit: o.outcome.gain });
        } else {
          lines.push({ accountId: fxLossId, debit: o.outcome.loss, credit: 0n });
          lines.push({ accountId: o.accountId, debit: 0n, credit: o.outcome.loss });
        }
      }
      let totalDebit = 0n;
      let totalCredit = 0n;
      for (const line of lines) {
        totalDebit += line.debit;
        totalCredit += line.credit;
      }
      if (totalDebit !== totalCredit) throw new MulticurrencyError("revaluation_entry_unbalanced", 500);

      const { rows: entryRows } = await query<{ id: string }>(
        `INSERT INTO journal_entries
           (business_id, location_id, entry_date, memo, source_type, source_id, posting_kind, created_by)
         VALUES ($1, NULL, $2, $3, 'fx_revaluation', $4, 'fx_revaluation', $5)
         RETURNING id`,
        [params.businessId, params.asOf, `ارزش‌گذاری حساب‌های ارزی (${currencyCode})`, revaluationId, params.actorId],
      );
      entryId = entryRows[0].id;
      for (const line of lines) {
        if (line.debit === 0n && line.credit === 0n) continue;
        await query(
          `INSERT INTO journal_lines (entry_id, account_id, debit, credit) VALUES ($1, $2, $3, $4)`,
          [entryId, line.accountId, line.debit.toString(), line.credit.toString()],
        );
      }
      await query(`UPDATE fx_revaluations SET entry_id = $2 WHERE id = $1`, [revaluationId, entryId]);
    }

    for (const o of effective) {
      await query(
        `INSERT INTO fx_revaluation_lines
           (revaluation_id, business_id, account_id, foreign_balance, book_base_balance, new_base_value, difference)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          revaluationId,
          params.businessId,
          o.accountId,
          o.foreignBalance.toString(),
          o.bookBase.toString(),
          o.outcome.newValue.toString(),
          o.outcome.difference.toString(),
        ],
      );
    }

    return {
      revaluationId,
      entryId,
      currencyCode,
      rateId: rate.id,
      rate: rate.rate,
      asOf: params.asOf,
      totalGain: effective.reduce((s, o) => s + o.outcome.gain, 0n).toString(),
      totalLoss: effective.reduce((s, o) => s + o.outcome.loss, 0n).toString(),
      lines: effective.map((o) => ({
        accountId: o.accountId,
        foreignBalance: o.foreignBalance.toString(),
        bookBaseBalance: o.bookBase.toString(),
        newBaseValue: o.outcome.newValue.toString(),
        difference: o.outcome.difference.toString(),
      })),
      duplicate: false,
    };
  });
}

async function loadRevaluationLines(revaluationId: string) {
  const { rows } = await query<{
    account_id: string;
    foreign_balance: string;
    book_base_balance: string;
    new_base_value: string;
    difference: string;
  }>(
    `SELECT account_id::text AS account_id, foreign_balance::text AS foreign_balance,
            book_base_balance::text AS book_base_balance, new_base_value::text AS new_base_value,
            difference::text AS difference
       FROM fx_revaluation_lines WHERE revaluation_id = $1 ORDER BY id`,
    [revaluationId],
  );
  return rows.map((r) => ({
    accountId: r.account_id,
    foreignBalance: r.foreign_balance,
    bookBaseBalance: r.book_base_balance,
    newBaseValue: r.new_base_value,
    difference: r.difference,
  }));
}

/** Major-unit presentation helper re-exported for the routes/reports. */
export { minorToMajorText };
export type { CurrencyCode };
