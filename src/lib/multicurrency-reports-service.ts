/**
 * Multicurrency reports (issue #863) — the read half of the subsystem.
 *
 * Six views, all reconstructed from the same posted journal lines the ledger
 * keeps (never a shadow balance), all exact (BigInt over bigint text columns),
 * all scoped to one business and date-bounded the way the trial balance is:
 *
 *  1. `foreignTrialBalance` — the trial balance's foreign twin: per account ×
 *     currency, the foreign debit/credit beside the base movement.
 *  2. `accountStatement` — one account's lines with the foreign amount, the
 *     frozen rate and the base amount side by side, running in both.
 *  3. `foreignPartyBalances` — open foreign A/R and A/P per party per
 *     currency: what is still unsettled in foreign units and at what booked
 *     base value.
 *  4. `realizedGainLossReport` — every settlement's realized difference, plus
 *     the revaluation runs' unrealized totals, per currency per period.
 *  5. `currencyExposure` — per currency: foreign assets vs liabilities, net
 *     position, and what the current rate would make of it (the unrealized
 *     potential, shown — not posted).
 *  6. `foreignBankBalances` — the foreign-currency accounts' book value vs
 *     restated value at the current rate.
 *
 * Historical figures never consult the current rate: a posted line's base
 * amount is its own truth, and the current rate appears only where a report
 * is explicitly *about* restating (5 and 6).
 *
 * DB-touching, so per repo convention there is no direct unit test; the
 * integration suite asserts each report's reconciliation against postings.
 */
import { query } from "./db";
import { isValidIsoDate } from "./iso-date";
import { isUuid } from "./uuid";
import { WELL_KNOWN_CODES } from "./coa-template";
import { convertToBaseMinor } from "./multicurrency";

/**
 * Restatement that tolerates a NEGATIVE net exposure (an overpaid party, a
 * net short currency): the conversion is linear in the amount, so the sign
 * rides through. convertToBaseMinor itself refuses negatives because a
 * negative *document amount* is always a bug; a negative *net position* is
 * information.
 */
function restateSigned(foreignMinor: bigint, rate: string, precision: number): bigint {
  if (foreignMinor >= 0n) return convertToBaseMinor(foreignMinor, rate, precision);
  return -convertToBaseMinor(-foreignMinor, rate, precision);
}
import { MulticurrencyError } from "./multicurrency-service";


interface DateRange {
  dateFrom?: string | null;
  dateTo?: string | null;
}

function assertDateRange(range: DateRange): void {
  if (range.dateFrom != null && !isValidIsoDate(range.dateFrom)) throw new MulticurrencyError("invalid_date_from");
  if (range.dateTo != null && !isValidIsoDate(range.dateTo)) throw new MulticurrencyError("invalid_date_to");
}

/** The business's base currency — every report names it. */
async function baseCurrencyOf(businessId: string): Promise<string> {
  const { rows } = await query<{ base_currency_code: string }>(
    `SELECT base_currency_code FROM businesses WHERE id = $1`,
    [businessId],
  );
  if (!rows[0]) throw new MulticurrencyError("business_not_found", 404);
  return rows[0].base_currency_code;
}

/** Current (latest non-voided, effective now) rate per currency, for restatement columns. */
async function currentRates(businessId: string, currencyCodes: string[]): Promise<Map<string, { rate: string; rateId: string; effectiveFrom: string }>> {
  const map = new Map<string, { rate: string; rateId: string; effectiveFrom: string }>();
  if (currencyCodes.length === 0) return map;
  const { rows } = await query<{ currency_code: string; rate: string; id: string; effective_from: Date }>(
    `SELECT DISTINCT ON (r.currency_code) r.currency_code, trim_scale(r.rate)::text AS rate, r.id, r.effective_from
       FROM exchange_rates r
       LEFT JOIN exchange_rate_voids v ON v.rate_id = r.id
      WHERE r.business_id = $1
        AND r.currency_code = ANY($2::text[])
        AND r.effective_from <= now()
        AND v.id IS NULL
      ORDER BY r.currency_code, r.effective_from DESC`,
    [businessId, currencyCodes],
  );
  for (const row of rows) {
    map.set(row.currency_code, { rate: row.rate, rateId: row.id, effectiveFrom: row.effective_from.toISOString() });
  }
  return map;
}

interface CurrencyPrecisionRow extends Record<string, unknown> {
  code: string;
  precision: number;
}

async function currencyPrecisions(): Promise<Map<string, number>> {
  const { rows } = await query<CurrencyPrecisionRow>(`SELECT code, precision FROM currencies`);
  return new Map(rows.map((r) => [r.code, r.precision]));
}

// ---------------------------------------------------------------------------
// 1. Foreign-currency trial balance view
// ---------------------------------------------------------------------------

export interface ForeignTrialBalanceRow {
  accountId: string;
  code: string;
  name: string;
  type: string;
  currencyCode: string;
  foreignDebit: string;
  foreignCredit: string;
  /** Signed foreign balance, in the currency's minor units. */
  foreignBalance: string;
  baseDebit: string;
  baseCredit: string;
  /** Signed base balance (these lines' contribution). */
  baseBalance: string;
}

export interface ForeignTrialBalanceReport {
  baseCurrencyCode: string;
  dateFrom: string | null;
  dateTo: string | null;
  rows: ForeignTrialBalanceRow[];
  /** Per-currency totals: foreign sides balance exactly; base sides balance exactly. */
  totals: {
    currencyCode: string;
    foreignDebit: string;
    foreignCredit: string;
    baseDebit: string;
    baseCredit: string;
  }[];
  /** Grand base totals across all currencies — must balance to zero. */
  baseTotals: { baseDebit: string; baseCredit: string };
}

export async function foreignTrialBalance(
  businessId: string,
  range: DateRange = {},
): Promise<ForeignTrialBalanceReport> {
  assertDateRange(range);
  const { rows } = await query<{
    account_id: string;
    code: string;
    name: string;
    type: string;
    currency_code: string;
    foreign_debit: string;
    foreign_credit: string;
    base_debit: string;
    base_credit: string;
  }>(
    `SELECT a.id::text AS account_id, a.code, a.name, a.type::text AS type,
            je.currency_code,
            COALESCE(sum(jl.foreign_debit), 0)::text AS foreign_debit,
            COALESCE(sum(jl.foreign_credit), 0)::text AS foreign_credit,
            COALESCE(sum(jl.debit), 0)::text AS base_debit,
            COALESCE(sum(jl.credit), 0)::text AS base_credit
       FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.entry_id
       JOIN accounts a ON a.id = jl.account_id
      WHERE je.business_id = $1
        AND je.currency_code IS NOT NULL
        AND ($2::date IS NULL OR je.entry_date >= $2::date)
        AND ($3::date IS NULL OR je.entry_date <= $3::date)
      GROUP BY a.id, a.code, a.name, a.type, je.currency_code
      ORDER BY a.code, je.currency_code`,
    [businessId, range.dateFrom ?? null, range.dateTo ?? null],
  );

  const byCurrency = new Map<string, { fd: bigint; fc: bigint; bd: bigint; bc: bigint }>();
  let totalBaseDebit = 0n;
  let totalBaseCredit = 0n;
  const reportRows: ForeignTrialBalanceRow[] = rows.map((r) => {
    const fd = BigInt(r.foreign_debit);
    const fc = BigInt(r.foreign_credit);
    const bd = BigInt(r.base_debit);
    const bc = BigInt(r.base_credit);
    const totals = byCurrency.get(r.currency_code) ?? { fd: 0n, fc: 0n, bd: 0n, bc: 0n };
    totals.fd += fd;
    totals.fc += fc;
    totals.bd += bd;
    totals.bc += bc;
    byCurrency.set(r.currency_code, totals);
    totalBaseDebit += bd;
    totalBaseCredit += bc;
    return {
      accountId: r.account_id,
      code: r.code,
      name: r.name,
      type: r.type,
      currencyCode: r.currency_code,
      foreignDebit: fd.toString(),
      foreignCredit: fc.toString(),
      foreignBalance: (fd - fc).toString(),
      baseDebit: bd.toString(),
      baseCredit: bc.toString(),
      baseBalance: (bd - bc).toString(),
    };
  });

  return {
    baseCurrencyCode: await baseCurrencyOf(businessId),
    dateFrom: range.dateFrom ?? null,
    dateTo: range.dateTo ?? null,
    rows: reportRows,
    totals: [...byCurrency.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([currencyCode, t]) => ({
        currencyCode,
        foreignDebit: t.fd.toString(),
        foreignCredit: t.fc.toString(),
        baseDebit: t.bd.toString(),
        baseCredit: t.bc.toString(),
      })),
    baseTotals: { baseDebit: totalBaseDebit.toString(), baseCredit: totalBaseCredit.toString() },
  };
}

// ---------------------------------------------------------------------------
// 2. Account statement with foreign + base amounts
// ---------------------------------------------------------------------------

export interface StatementLine {
  entryId: string;
  entryDate: string;
  memo: string;
  sourceType: string | null;
  currencyCode: string | null;
  /** Signed foreign movement in minor units (null on base-only lines). */
  foreignAmount: string | null;
  /** The frozen rate snapshot of the entry (null on base-only lines). */
  exchangeRate: string | null;
  /** Signed base movement. */
  baseAmount: string;
  /** Running base balance, oldest first. */
  baseRunning: string;
  /** Running foreign balance *within this line's currency* (null on base-only lines). */
  foreignRunning: string | null;
}

export interface AccountStatementReport {
  baseCurrencyCode: string;
  accountId: string;
  accountCode: string;
  accountName: string;
  currencyFilter: string | null;
  dateFrom: string | null;
  dateTo: string | null;
  lines: StatementLine[];
  totals: { baseDebit: string; baseCredit: string; baseClosing: string };
}

export async function accountStatement(
  businessId: string,
  accountId: string,
  options: { currencyCode?: string | null; dateFrom?: string | null; dateTo?: string | null } = {},
): Promise<AccountStatementReport> {
  if (!isUuid(accountId)) throw new MulticurrencyError("invalid_account_id");
  assertDateRange(options);
  if (options.currencyCode != null && !/^[A-Z]{3}$/.test(options.currencyCode)) {
    throw new MulticurrencyError("invalid_currency");
  }
  const [baseCurrencyCode, accountRows] = await Promise.all([
    baseCurrencyOf(businessId),
    query<{ id: string; code: string; name: string }>(
      `SELECT id::text AS id, code, name FROM accounts WHERE id = $1 AND business_id = $2`,
      [accountId, businessId],
    ),
  ]);
  const account = accountRows.rows[0];
  if (!account) throw new MulticurrencyError("account_not_found", 404);

  const { rows } = await query<{
    entry_id: string;
    entry_date: string;
    memo: string | null;
    source_type: string | null;
    currency_code: string | null;
    exchange_rate: string | null;
    foreign_debit: string;
    foreign_credit: string;
    debit: string;
    credit: string;
  }>(
    `SELECT je.id::text AS entry_id, je.entry_date::text AS entry_date, je.memo, je.source_type,
            je.currency_code, je.exchange_rate,
            jl.foreign_debit::text AS foreign_debit, jl.foreign_credit::text AS foreign_credit,
            jl.debit::text AS debit, jl.credit::text AS credit
       FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.entry_id
      WHERE je.business_id = $1
        AND jl.account_id = $2
        AND ($3::text IS NULL OR je.currency_code = $3::text)
        AND ($4::date IS NULL OR je.entry_date >= $4::date)
        AND ($5::date IS NULL OR je.entry_date <= $5::date)
      ORDER BY je.entry_date, je.posted_at, jl.id`,
    [businessId, accountId, options.currencyCode ?? null, options.dateFrom ?? null, options.dateTo ?? null],
  );

  const foreignRunningByCurrency = new Map<string, bigint>();
  let baseRunning = 0n;
  let baseDebit = 0n;
  let baseCredit = 0n;
  const lines: StatementLine[] = rows.map((r) => {
    const debit = BigInt(r.debit);
    const credit = BigInt(r.credit);
    baseDebit += debit;
    baseCredit += credit;
    baseRunning += debit - credit;
    const line: StatementLine = {
      entryId: r.entry_id,
      entryDate: r.entry_date,
      memo: r.memo ?? "",
      sourceType: r.source_type,
      currencyCode: r.currency_code,
      foreignAmount: null,
      exchangeRate: r.exchange_rate,
      baseAmount: (debit - credit).toString(),
      baseRunning: baseRunning.toString(),
      foreignRunning: null,
    };
    if (r.currency_code) {
      const signed = BigInt(r.foreign_debit) - BigInt(r.foreign_credit);
      const running = (foreignRunningByCurrency.get(r.currency_code) ?? 0n) + signed;
      foreignRunningByCurrency.set(r.currency_code, running);
      line.foreignAmount = signed.toString();
      line.foreignRunning = running.toString();
    }
    return line;
  });

  return {
    baseCurrencyCode,
    accountId: account.id,
    accountCode: account.code,
    accountName: account.name,
    currencyFilter: options.currencyCode ?? null,
    dateFrom: options.dateFrom ?? null,
    dateTo: options.dateTo ?? null,
    lines,
    totals: {
      baseDebit: baseDebit.toString(),
      baseCredit: baseCredit.toString(),
      baseClosing: baseRunning.toString(),
    },
  };
}

// ---------------------------------------------------------------------------
// 3. Foreign A/R and A/P balances per party
// ---------------------------------------------------------------------------

export interface ForeignPartyBalance {
  partyId: string;
  partyName: string;
  partyCode: string | null;
  direction: "receivable" | "payable";
  currencyCode: string;
  /** Open foreign amount, minor units, positive. */
  foreignOpen: string;
  /** Booked base value of the open amount (the historical snapshots). */
  baseBooked: string;
  currentRate: string | null;
  /** Open foreign at the current rate — the unrealized view, shown not posted. */
  baseRestated: string | null;
  unrealizedDifference: string | null;
}

export interface ForeignPartyBalancesReport {
  baseCurrencyCode: string;
  direction: "receivable" | "payable" | "both";
  balances: ForeignPartyBalance[];
  /** Σ per currency of the booked base — reconciles to the control accounts. */
  totals: { currencyCode: string; foreignOpen: string; baseBooked: string }[];
}

async function foreignPartyBalancesForDirection(
  businessId: string,
  direction: "receivable" | "payable",
): Promise<ForeignPartyBalance[]> {
  // The control account's own lines ARE the open balance: every settlement
  // posts its release as an opposite party-attributed control line at the
  // booked base, so plain netting per party × currency is exact. (Subtracting
  // fx_settlement_applications here as well counts every settlement twice —
  // the applications are the lot-level FIFO trail, not a second balance.)
  // Negative nets are real (advance payments) and restated as such.
  const controlCode =
    direction === "receivable" ? WELL_KNOWN_CODES.accountsReceivable : WELL_KNOWN_CODES.accountsPayable;
  const { rows } = await query<{
    party_id: string;
    party_name: string;
    party_code: string | null;
    currency_code: string;
    foreign_open: string;
    base_booked: string;
  }>(
    `SELECT jl.party_id::text AS party_id, max(p.name) AS party_name, max(p.accounting_code) AS party_code,
            je.currency_code,
            sum(CASE WHEN $2 = 'receivable'
                     THEN jl.foreign_debit - jl.foreign_credit
                     ELSE jl.foreign_credit - jl.foreign_debit END)::bigint AS foreign_open,
            sum(CASE WHEN $2 = 'receivable'
                     THEN jl.debit - jl.credit
                     ELSE jl.credit - jl.debit END)::bigint AS base_booked
       FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.entry_id
       JOIN accounts a ON a.id = jl.account_id
       JOIN parties p ON p.id = jl.party_id
      WHERE je.business_id = $1
        AND je.currency_code IS NOT NULL
        AND jl.party_id IS NOT NULL
        AND a.code = $3
      GROUP BY jl.party_id, je.currency_code
     HAVING sum(CASE WHEN $2 = 'receivable'
                     THEN jl.foreign_debit - jl.foreign_credit
                     ELSE jl.foreign_credit - jl.foreign_debit END) <> 0
      ORDER BY party_name, je.currency_code`,
    [businessId, direction, controlCode],
  );
  return rows.map((r) => ({
    partyId: r.party_id,
    partyName: r.party_name,
    partyCode: r.party_code,
    direction,
    currencyCode: r.currency_code,
    foreignOpen: r.foreign_open,
    baseBooked: r.base_booked,
    currentRate: null,
    baseRestated: null,
    unrealizedDifference: null,
  }));
}

export async function foreignPartyBalances(
  businessId: string,
  options: { direction?: "receivable" | "payable" | "both"; currencyCode?: string | null } = {},
): Promise<ForeignPartyBalancesReport> {
  const direction = options.direction ?? "both";
  const [baseCurrencyCode, precisions] = await Promise.all([
    baseCurrencyOf(businessId),
    currencyPrecisions(),
  ]);
  const directions: ("receivable" | "payable")[] =
    direction === "both" ? ["receivable", "payable"] : [direction];
  const collected = (await Promise.all(directions.map((d) => foreignPartyBalancesForDirection(businessId, d)))).flat();
  const filtered = options.currencyCode
    ? collected.filter((b) => b.currencyCode === options.currencyCode)
    : collected;

  const rates = await currentRates(
    businessId,
    [...new Set(filtered.map((b) => b.currencyCode))],
  );
  for (const balance of filtered) {
    const rate = rates.get(balance.currencyCode);
    if (rate) {
      const precision = precisions.get(balance.currencyCode) ?? 2;
      const restated = restateSigned(BigInt(balance.foreignOpen), rate.rate, precision);
      balance.currentRate = rate.rate;
      balance.baseRestated = restated.toString();
      balance.unrealizedDifference = (restated - BigInt(balance.baseBooked)).toString();
    }
  }

  const totals = new Map<string, { foreignOpen: bigint; baseBooked: bigint }>();
  for (const balance of filtered) {
    const t = totals.get(balance.currencyCode) ?? { foreignOpen: 0n, baseBooked: 0n };
    t.foreignOpen += BigInt(balance.foreignOpen);
    t.baseBooked += BigInt(balance.baseBooked);
    totals.set(balance.currencyCode, t);
  }

  return {
    baseCurrencyCode,
    direction,
    balances: filtered,
    totals: [...totals.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([currencyCode, t]) => ({
        currencyCode,
        foreignOpen: t.foreignOpen.toString(),
        baseBooked: t.baseBooked.toString(),
      })),
  };
}

// ---------------------------------------------------------------------------
// 4. Realized & unrealized gain/loss report
// ---------------------------------------------------------------------------

export interface RealizedSettlementRow {
  settlementEntryId: string;
  entryDate: string;
  direction: "receivable" | "payable";
  currencyCode: string;
  partyId: string | null;
  partyName: string | null;
  foreignApplied: string;
  baseAtBooking: string;
  settlementRate: string;
  baseAtSettlement: string;
  /** Positive = gain, negative = loss. */
  difference: string;
}

export interface RevaluationRow {
  revaluationId: string;
  entryId: string | null;
  entryDate: string;
  currencyCode: string;
  rate: string;
  totalGain: string;
  totalLoss: string;
}

export interface GainLossReport {
  baseCurrencyCode: string;
  dateFrom: string | null;
  dateTo: string | null;
  realized: RealizedSettlementRow[];
  realizedTotals: { currencyCode: string; gain: string; loss: string; net: string }[];
  revaluations: RevaluationRow[];
  revaluationTotals: { currencyCode: string; gain: string; loss: string }[];
}

export async function gainLossReport(
  businessId: string,
  range: DateRange = {},
): Promise<GainLossReport> {
  assertDateRange(range);
  const [baseCurrencyCode, settlements, revaluations] = await Promise.all([
    baseCurrencyOf(businessId),
    query<{
      settlement_entry_id: string;
      entry_date: string;
      direction: string;
      currency_code: string;
      party_id: string | null;
      party_name: string | null;
      foreign_applied: string;
      base_at_booking: string;
      settlement_rate: string;
      base_at_settlement: string;
      difference: string;
    }>(
      `WITH legs AS (
         SELECT jl.entry_id,
                COALESCE(sum(jl.credit) FILTER (WHERE a.code = $4), 0)::bigint AS gain_credit,
                COALESCE(sum(jl.debit) FILTER (WHERE a.code = $5), 0)::bigint AS loss_debit
           FROM journal_lines jl
           JOIN accounts a ON a.id = jl.account_id
          GROUP BY jl.entry_id
       )
       SELECT app.settlement_entry_id::text AS settlement_entry_id,
              je.entry_date::text AS entry_date,
              app.direction, app.currency_code,
              app.party_id::text AS party_id, max(p.name) AS party_name,
              sum(app.foreign_applied)::text AS foreign_applied,
              sum(app.base_applied)::text AS base_at_booking,
              je.exchange_rate AS settlement_rate,
              -- What the settlement actually MOVED, on each side's own view:
              -- a receivable's money in is the booked base plus a gain
              -- (minus a loss); a payable's money out is the booked base
              -- MINUS a gain (plus a loss) — parting with less than the
              -- booked 600, say 550, must report 550, not 650.
              CASE WHEN app.direction = 'receivable'
                   THEN sum(app.base_applied) + legs.gain_credit - legs.loss_debit
                   ELSE sum(app.base_applied) - legs.gain_credit + legs.loss_debit
              END::text AS base_at_settlement,
              (legs.gain_credit - legs.loss_debit)::text AS difference
         FROM fx_settlement_applications app
         JOIN journal_entries je ON je.id = app.settlement_entry_id
         JOIN legs ON legs.entry_id = app.settlement_entry_id
         LEFT JOIN parties p ON p.id = app.party_id
        WHERE app.business_id = $1
          -- A settlement that was itself reversed is not realized anymore:
          -- its entry was undone, so the report must not keep counting FX
          -- results the GL no longer carries.
          AND je.reversed_at IS NULL
          AND je.reverses_entry_id IS NULL
          AND ($2::date IS NULL OR je.entry_date >= $2::date)
          AND ($3::date IS NULL OR je.entry_date <= $3::date)
        GROUP BY app.settlement_entry_id, je.entry_date, app.direction, app.currency_code,
                 app.party_id, je.exchange_rate, legs.gain_credit, legs.loss_debit
        ORDER BY je.entry_date, app.settlement_entry_id`,
      [businessId, range.dateFrom ?? null, range.dateTo ?? null, WELL_KNOWN_CODES.fxRealizedGain, WELL_KNOWN_CODES.fxRealizedLoss],
    ),
    query<{
      id: string;
      entry_id: string | null;
      as_of: string;
      currency_code: string;
      rate: string;
      total_gain: string;
      total_loss: string;
    }>(
      `SELECT r.id::text AS id, r.entry_id::text AS entry_id, r.as_of::text AS as_of,
              r.currency_code, r.rate,
              r.total_gain::text AS total_gain, r.total_loss::text AS total_loss
         FROM fx_revaluations r
        WHERE r.business_id = $1
          AND ($2::date IS NULL OR r.as_of >= $2::date)
          AND ($3::date IS NULL OR r.as_of <= $3::date)
        ORDER BY r.as_of DESC, r.created_at DESC`,
      [businessId, range.dateFrom ?? null, range.dateTo ?? null],
    ),
  ]);

  const realized: RealizedSettlementRow[] = settlements.rows.map((r) => ({
    settlementEntryId: r.settlement_entry_id,
    entryDate: r.entry_date,
    direction: r.direction as "receivable" | "payable",
    currencyCode: r.currency_code,
    partyId: r.party_id,
    partyName: r.party_name,
    foreignApplied: r.foreign_applied,
    baseAtBooking: r.base_at_booking,
    settlementRate: r.settlement_rate,
    baseAtSettlement: r.base_at_settlement,
    difference: r.difference,
  }));

  const realizedTotals = new Map<string, { gain: bigint; loss: bigint }>();
  for (const row of realized) {
    const t = realizedTotals.get(row.currencyCode) ?? { gain: 0n, loss: 0n };
    const diff = BigInt(row.difference);
    if (diff > 0n) t.gain += diff;
    else t.loss += -diff;
    realizedTotals.set(row.currencyCode, t);
  }

  const revaluationTotals = new Map<string, { gain: bigint; loss: bigint }>();
  const revaluationRows: RevaluationRow[] = revaluations.rows.map((r) => {
    const t = revaluationTotals.get(r.currency_code) ?? { gain: 0n, loss: 0n };
    t.gain += BigInt(r.total_gain);
    t.loss += BigInt(r.total_loss);
    revaluationTotals.set(r.currency_code, t);
    return {
      revaluationId: r.id,
      entryId: r.entry_id,
      entryDate: r.as_of,
      currencyCode: r.currency_code,
      rate: r.rate,
      totalGain: r.total_gain,
      totalLoss: r.total_loss,
    };
  });

  return {
    baseCurrencyCode,
    dateFrom: range.dateFrom ?? null,
    dateTo: range.dateTo ?? null,
    realized,
    realizedTotals: [...realizedTotals.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([currencyCode, t]) => ({
        currencyCode,
        gain: t.gain.toString(),
        loss: t.loss.toString(),
        net: (t.gain - t.loss).toString(),
      })),
    revaluations: revaluationRows,
    revaluationTotals: [...revaluationTotals.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([currencyCode, t]) => ({
        currencyCode,
        gain: t.gain.toString(),
        loss: t.loss.toString(),
      })),
  };
}

// ---------------------------------------------------------------------------
// 5. Currency exposure summary & 6. foreign bank balances
// ---------------------------------------------------------------------------

export interface ForeignAccountPosition {
  accountId: string;
  code: string;
  name: string;
  type: string;
  currencyCode: string;
  /** Signed foreign balance (asset-normal sign). */
  foreignBalance: string;
  /** Signed book base balance. */
  bookBase: string;
  currentRate: string | null;
  restatedBase: string | null;
  /** restated − book, asset-normal (shown, never posted here). */
  unrealizedDifference: string | null;
}

export interface CurrencyExposure {
  currencyCode: string;
  currentRate: string | null;
  /** Foreign-currency accounts (banks & friends), signed asset-normal. */
  accountForeign: string;
  accountBookBase: string;
  /** Open foreign receivables / payables across parties. */
  receivableForeign: string;
  receivableBookBase: string;
  payableForeign: string;
  payableBookBase: string;
  /** Net foreign position: accounts + receivables − payables. */
  netForeign: string;
  baseRestated: string | null;
  unrealizedDifference: string | null;
}

export interface ExposureReport {
  baseCurrencyCode: string;
  currencies: CurrencyExposure[];
  foreignAccounts: ForeignAccountPosition[];
}

export async function currencyExposure(businessId: string): Promise<ExposureReport> {
  const [baseCurrencyCode, precisions] = await Promise.all([
    baseCurrencyOf(businessId),
    currencyPrecisions(),
  ]);

  const accounts = await foreignAccountPositions(businessId);
  const [receivable, payable] = await Promise.all([
    foreignPartyBalancesForDirection(businessId, "receivable"),
    foreignPartyBalancesForDirection(businessId, "payable"),
  ]);

  const codes = [
    ...new Set([
      ...accounts.map((a) => a.currencyCode),
      ...receivable.map((b) => b.currencyCode),
      ...payable.map((b) => b.currencyCode),
    ]),
  ].sort();
  const rates = await currentRates(businessId, codes);

  const currencies: CurrencyExposure[] = codes.map((code) => {
    const precision = precisions.get(code) ?? 2;
    const rate = rates.get(code)?.rate ?? null;
    const accountRows = accounts.filter((a) => a.currencyCode === code);
    const accountForeign = accountRows.reduce((s, a) => s + BigInt(a.foreignBalance), 0n);
    const accountBookBase = accountRows.reduce((s, a) => s + BigInt(a.bookBase), 0n);
    const recForeign = receivable
      .filter((b) => b.currencyCode === code)
      .reduce((s, b) => s + BigInt(b.foreignOpen), 0n);
    const recBook = receivable
      .filter((b) => b.currencyCode === code)
      .reduce((s, b) => s + BigInt(b.baseBooked), 0n);
    const payForeign = payable
      .filter((b) => b.currencyCode === code)
      .reduce((s, b) => s + BigInt(b.foreignOpen), 0n);
    const payBook = payable
      .filter((b) => b.currencyCode === code)
      .reduce((s, b) => s + BigInt(b.baseBooked), 0n);
    const netForeign = accountForeign + recForeign - payForeign;
    let restated: bigint | null = null;
    let unrealized: bigint | null = null;
    if (rate) {
      restated = restateSigned(netForeign, rate, precision);
      const bookNet = accountBookBase + recBook - payBook;
      unrealized = restated - bookNet;
    }
    return {
      currencyCode: code,
      currentRate: rate,
      accountForeign: accountForeign.toString(),
      accountBookBase: accountBookBase.toString(),
      receivableForeign: recForeign.toString(),
      receivableBookBase: recBook.toString(),
      payableForeign: payForeign.toString(),
      payableBookBase: payBook.toString(),
      netForeign: netForeign.toString(),
      baseRestated: restated?.toString() ?? null,
      unrealizedDifference: unrealized?.toString() ?? null,
    };
  });

  return {
    baseCurrencyCode,
    currencies,
    foreignAccounts: accounts,
  };
}

/** Foreign-currency accounts (accounts that name a currency) and where they stand. */
export async function foreignBankBalances(businessId: string): Promise<{
  baseCurrencyCode: string;
  accounts: ForeignAccountPosition[];
}> {
  const baseCurrencyCode = await baseCurrencyOf(businessId);
  const accounts = await foreignAccountPositions(businessId);
  return { baseCurrencyCode, accounts };
}

async function foreignAccountPositions(businessId: string): Promise<ForeignAccountPosition[]> {
  const { rows } = await query<{
    id: string;
    code: string;
    name: string;
    type: string;
    currency_code: string;
    foreign_balance: string;
    book_base: string;
  }>(
    `SELECT a.id::text AS id, a.code, a.name, a.type::text AS type, a.currency_code,
            (SELECT COALESCE(sum(jl.foreign_debit) - sum(jl.foreign_credit), 0)
               FROM journal_lines jl
               JOIN journal_entries je ON je.id = jl.entry_id
              WHERE jl.account_id = a.id AND je.currency_code = a.currency_code)::text AS foreign_balance,
            (SELECT COALESCE(sum(jl.debit) - sum(jl.credit), 0)
               FROM journal_lines jl
              WHERE jl.account_id = a.id)::text AS book_base
       FROM accounts a
      WHERE a.business_id = $1 AND a.currency_code IS NOT NULL
      ORDER BY a.code`,
    [businessId],
  );
  const rates = await currentRates(businessId, [...new Set(rows.map((r) => r.currency_code))]);
  const precisions = await currencyPrecisions();
  return rows.map((r) => {
    const rate = rates.get(r.currency_code) ?? null;
    const foreign = BigInt(r.foreign_balance);
    const book = BigInt(r.book_base);
    let restated: string | null = null;
    let difference: string | null = null;
    if (rate) {
      const value = restateSigned(foreign, rate.rate, precisions.get(r.currency_code) ?? 2);
      restated = value.toString();
      difference = (value - book).toString();
    }
    return {
      accountId: r.id,
      code: r.code,
      name: r.name,
      type: r.type,
      currencyCode: r.currency_code,
      foreignBalance: foreign.toString(),
      bookBase: book.toString(),
      currentRate: rate?.rate ?? null,
      restatedBase: restated,
      unrealizedDifference: difference,
    };
  });
}
