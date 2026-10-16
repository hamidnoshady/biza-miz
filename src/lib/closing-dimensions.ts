/**
 * «بستن سال مالی با ابعاد» — the exact, dimension-grouped closing calculation
 * (issue #868, Phase 4), pure rules.
 *
 * The year-end closing entry closes every revenue/expense balance to retained
 * earnings. With accounting dimensions the balances come grouped by
 * (account × dimension tuple); this module closes **each group against a
 * retained-earnings line carrying the same tuple**, so:
 *
 *   * every dimension group balances within itself (a group's closing lines
 *     net to zero inside the group);
 *   * a year with no attribution produces exactly the entry the old
 *     one-RE-line calculation produced (same lines, same order);
 *   * attribution is carried onto the equity line deliberately — the split of
 *     the year's result by cost centre is the fact the reports showed all
 *     year. Clearing it is a manual reclassification, never this generator.
 *
 * Money is bigint Rial end to end; PostgreSQL aggregates arrive as decimal
 * strings and never cross JavaScript's floating-point boundary.
 */
import type { RialText } from "./inventory-exact";
import type { LineDimensions } from "./accounting-dimensions";
import { allocationTupleKey, dimensionsFromTupleKey } from "./payroll-dimensions";
import type { ExactJournalLine } from "./ledger-service";

export interface DimensionTupleRow {
  accountId: string;
  accountType: "revenue" | "expense";
  /** Exact signed Rial. */
  debit: bigint;
  credit: bigint;
  /** The tuple this balance sits in; `{}` for the unattributed group. */
  dimensions: LineDimensions;
}

/**
 * Shapes the SQL aggregation (decimal strings + four nullable columns) into
 * exact rows the pure calculation takes. One row per (account × tuple).
 */
export function closingTupleRows(
  rows: ReadonlyArray<{
    account_id: string;
    account_type: string;
    debit: string;
    credit: string;
    cost_center_id?: string | null;
    profit_center_id?: string | null;
    department_id?: string | null;
    detail_dimension_id?: string | null;
  }>,
): DimensionTupleRow[] {
  return rows.map((row) => {
    const dimensions: LineDimensions = {};
    if (row.cost_center_id) dimensions.cost_center = row.cost_center_id;
    if (row.profit_center_id) dimensions.profit_center = row.profit_center_id;
    if (row.department_id) dimensions.department = row.department_id;
    if (row.detail_dimension_id) dimensions.detail = row.detail_dimension_id;
    return {
      accountId: row.account_id,
      accountType: row.account_type === "revenue" ? "revenue" : "expense",
      debit: BigInt(row.debit),
      credit: BigInt(row.credit),
      dimensions,
    };
  });
}

export interface DimensionalClosingResult {
  /** Every closing line, retained earnings included, exact money as RialText. */
  lines: ExactJournalLine[];
  /** Exact signed integer Rial, serialized as a decimal string. */
  netIncome: bigint;
  /** The distinct tuples that received a retained-earnings line. */
  tuples: LineDimensions[];
}

/**
 * The closing lines for one year's P&L balances, split by dimension tuple.
 *
 * - A revenue balance (credit normal) closes with a debit; an expense balance
 *   (debit normal) closes with a credit — the same rule
 *   `calculateClosingLines` applies account by account.
 * - The retained-earnings side of each tuple carries that tuple's attribution.
 * - `netIncome` is the whole year's, exact: sum of revenue balances minus sum
 *   of expense balances across every group.
 */
export function calculateDimensionalClosingLines(
  rows: readonly DimensionTupleRow[],
  retainedEarningsId: string,
): DimensionalClosingResult {
  const zero = "0" as RialText;
  const lines: ExactJournalLine[] = [];
  const netByTuple = new Map<string, { dimensions: LineDimensions; amount: bigint }>();
  let netIncome = 0n;

  for (const row of rows) {
    const debit = row.debit;
    const credit = row.credit;
    if (debit < 0n || credit < 0n) throw new Error("invalid_closing_balance");
    const key = allocationTupleKey(row.dimensions);
    const bucket = netByTuple.get(key) ?? { dimensions: row.dimensions, amount: 0n };

    if (row.accountType === "revenue") {
      const balance = credit - debit; // normal credit balance; close with a debit
      netIncome += balance;
      bucket.amount += balance;
      lines.push({
        accountId: row.accountId,
        debit: (balance > 0n ? balance : 0n).toString() as RialText,
        credit: (balance < 0n ? -balance : 0n).toString() as RialText,
        dimensions: row.dimensions,
      });
    } else {
      const balance = debit - credit; // normal debit balance; close with a credit
      netIncome -= balance;
      bucket.amount -= balance;
      lines.push({
        accountId: row.accountId,
        debit: (balance < 0n ? -balance : 0n).toString() as RialText,
        credit: (balance > 0n ? balance : 0n).toString() as RialText,
        dimensions: row.dimensions,
      });
    }
    netByTuple.set(key, bucket);
  }

  // One retained-earnings line per tuple with a result. The unattributed
  // tuple (when it is the only one) is exactly the single line the pre-#868
  // calculation produced — same account, same amount, appended last.
  const tuples: LineDimensions[] = [];
  for (const { dimensions, amount } of netByTuple.values()) {
    if (amount === 0n) continue;
    lines.push({
      accountId: retainedEarningsId,
      debit: (amount < 0n ? -amount : 0n).toString() as RialText,
      credit: (amount > 0n ? amount : 0n).toString() as RialText,
      dimensions,
    });
    tuples.push(dimensions);
  }

  return { lines, netIncome, tuples };
}
