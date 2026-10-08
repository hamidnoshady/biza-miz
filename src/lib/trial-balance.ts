/**
 * The trial balance's contract and its presentation rules — the pure half.
 *
 * Split out of `ledger-reports-service.ts` for one concrete reason: the screen
 * at `/accounting/trial-balance` needs these *types*, and that service touches
 * the database. A client component importing a DB module is a bundle bug
 * waiting for someone to drop the `type` keyword, so the shared vocabulary
 * lives here, with no I/O, and the service imports it rather than the reverse.
 *
 * What is here beyond types is the presentation filter: which rows a report
 * shows once the accountant has set a search, a type filter, an active/archived
 * filter and the zero-balance toggle. It is pure so the screen and the
 * CSV/Excel/PDF exporter cannot drift — an export that showed a different set
 * of accounts from the one on screen would be a different report.
 *
 * Every amount is a decimal Rial string. Comparisons are string comparisons and
 * arithmetic is `BigInt`: a balance above `Number.MAX_SAFE_INTEGER` must still
 * be exactly zero or exactly not.
 */
import type { AccountLevel, AccountType, NormalBalance } from "./coa-template";

export type { AccountLevel, AccountType, NormalBalance };

/** What the report is asked for. Exactly one of the two shapes is valid. */
export interface TrialBalanceFilters {
  /** Detailed view: everything posted before this date is the opening balance. */
  dateFrom?: string;
  /** Inclusive closing date, for both the detailed and the compact view. */
  dateTo?: string;
  /** Compact closing-only view; mutually exclusive with `dateFrom`/`dateTo`. */
  asOf?: string;
}

export interface TrialBalanceRow {
  id: string;
  code: string;
  name: string;
  type: AccountType;
  /** False for an archived account, which still reports the postings it received. */
  isActive: boolean;
  parentId: string | null;
  parentCode: string | null;
  /** گروه / کل / معین / تفصیلی — the chart's own tier (migration 0056). */
  level: AccountLevel;
  hasChildren: boolean;
  isContra: boolean;
  /**
   * The side this account's balance is *expected* on: its type's normal side,
   * flipped for a contra account. A balance on the other side is not an error,
   * but it is worth naming — see `isAbnormalBalance`.
   */
  normalBalance: NormalBalance;
  /**
   * A non-zero closing balance on the unexpected side. Never hidden and never
   * sign-flipped: an asset in credit reports its amount in `closingCredit`.
   */
  isAbnormalBalance: boolean;
  openingDebit: string;
  openingCredit: string;
  periodDebit: string;
  periodCredit: string;
  closingDebit: string;
  closingCredit: string;
}

export interface TrialBalanceTotals {
  openingDebit: string;
  openingCredit: string;
  periodDebit: string;
  periodCredit: string;
  closingDebit: string;
  closingCredit: string;
  /** Closing debit less closing credit; a signed decimal Rial string. */
  closingDifference: string;
}

export interface TrialBalanceReport {
  businessName: string;
  mode: "detailed" | "closing";
  /** Null in the compact as-of view, which has no period start. */
  periodFrom: string | null;
  periodTo: string;
  asOf: string | null;
  accounts: TrialBalanceRow[];
  totals: TrialBalanceTotals;
  /**
   * Whether the *displayed* closing columns meet. Deliberately not the same
   * question as `integrity.ledgerHealthy`: two corrupt entries can offset each
   * other and leave equal columns over an unhealthy book.
   */
  trialBalanceBalanced: boolean;
  /** Entries and lines inside this report's date, as opposed to the whole ledger. */
  activity: { entryCount: number; lineCount: number };
  /** Whole-ledger health, so a period report cannot hide a broken document. */
  integrity: {
    ledgerHealthy: boolean;
    entryCount: number;
    lineCount: number;
    unbalancedEntryCount: number;
    invalidEntryCount: number;
    /** Whole-ledger debit minus credit, as an exact Rial string. */
    balanceDifference: string;
  };
}

/**
 * Detailed shows opening / movement / closing; closing shows only the net
 * balance as of a date. Both are the same report at different depths, never
 * two different accounting semantics.
 */
export type TrialBalancePresentation = "detailed" | "closing";
export type TrialBalanceAccountStatus = "all" | "active" | "archived";

export interface TrialBalanceDisplayRow {
  code: string;
  name: string;
  type: AccountType;
  isActive: boolean;
  openingDebit: string;
  openingCredit: string;
  periodDebit: string;
  periodCredit: string;
  closingDebit: string;
  closingCredit: string;
}

export interface TrialBalanceDisplayFilters {
  presentation: TrialBalancePresentation;
  search?: string;
  accountType?: AccountType | "all";
  accountStatus?: TrialBalanceAccountStatus;
  includeZeroBalances?: boolean;
}

/** No floating-point conversion: zero detection stays exact for BIGINT amounts. */
export function isZeroTrialBalanceRow(
  row: TrialBalanceDisplayRow,
  presentation: TrialBalancePresentation,
): boolean {
  if (row.closingDebit !== "0" || row.closingCredit !== "0") return false;
  if (presentation === "closing") return true;
  return (
    row.openingDebit === "0" &&
    row.openingCredit === "0" &&
    row.periodDebit === "0" &&
    row.periodCredit === "0"
  );
}

/** Shared by the on-screen report and the CSV/Excel/PDF export. */
export function filterTrialBalanceRows<T extends TrialBalanceDisplayRow>(
  rows: readonly T[],
  filters: TrialBalanceDisplayFilters,
): T[] {
  const needle = filters.search?.trim().toLocaleLowerCase() ?? "";
  return rows.filter((row) => {
    if (filters.accountType && filters.accountType !== "all" && row.type !== filters.accountType) {
      return false;
    }
    if (filters.accountStatus === "active" && !row.isActive) return false;
    if (filters.accountStatus === "archived" && row.isActive) return false;
    if (!filters.includeZeroBalances && isZeroTrialBalanceRow(row, filters.presentation)) return false;
    if (needle && !`${row.code} ${row.name}`.toLocaleLowerCase().includes(needle)) return false;
    return true;
  });
}
