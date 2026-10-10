/**
 * Phase 26 (issue #125) Wave 5 — the pure planning half of accounting import.
 *
 * Holoo vouchers remain document-atomic: lines are normalized in exact Rial
 * arithmetic, and an unbalanced document is reported rather than plugged with
 * a synthetic adjustment. The plan is shared by migration preview and apply.
 *
 * Each line may also carry optional accounting-dimension codes (issue #868):
 * `costCenterCode`, `profitCenterCode`, `departmentCode`, `detailCode`. Blank
 * cells leave the line unattributed for that kind; any code is validated by
 * the importer against this business's own catalogue, the way the expense
 * importer validates them, and an unknown or archived code refuses the row.
 */

export interface HolooVoucherLine {
  accountCode: string;
  debitRial?: bigint | number | string | null;
  creditRial?: bigint | number | string | null;
  /** Optional cost-centre code (issue #868). */
  costCenterCode?: string | null;
  /** Optional profit-centre code (issue #868). */
  profitCenterCode?: string | null;
  /** Optional department code (issue #868). */
  departmentCode?: string | null;
  /** Optional detail-dimension code (issue #868). */
  detailCode?: string | null;
}

export interface HolooVoucher {
  remoteId: string;
  /** ISO date. */
  entryDate: string;
  memo?: string | null;
  lines: HolooVoucherLine[];
}

function rialBigInt(value: unknown): bigint {
  if (typeof value === "bigint") {
    if (value < 0n) throw new Error("invalid_holoo_amount");
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("invalid_holoo_amount");
    return BigInt(value);
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return BigInt(value.trim());
  if (value === null || value === undefined || value === "") return 0n;
  throw new Error("invalid_holoo_amount");
}

function assertJournalDate(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("invalid_holoo_date");
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error("invalid_holoo_date");
  }
}

/** One netted line — debit XOR credit, both non-negative exact Rial.
 *
 * Dimension codes are normalized from the raw input by trimming whitespace
 * and converting null/undefined to the empty string (meaning "unattributed")
 * so the importer's code-resolution step receives a stable shape.
 */
export interface NormalizedLine {
  accountCode: string;
  debit: bigint;
  credit: bigint;
  costCenterCode: string;
  profitCenterCode: string;
  departmentCode: string;
  detailCode: string;
}

/** Net a possibly-two-sided line to a single side without Number conversion. */
export function normalizeLine(line: HolooVoucherLine): NormalizedLine {
  if (!line.accountCode || line.accountCode.trim() !== line.accountCode) throw new Error("invalid_holoo_account_code");
  const debit = rialBigInt(line.debitRial);
  const credit = rialBigInt(line.creditRial);
  const net = debit - credit;
  const trim = (v: string | null | undefined) => (typeof v === "string" ? v.trim() : "");
  return net >= 0n
    ? {
        accountCode: line.accountCode,
        debit: net,
        credit: 0n,
        costCenterCode: trim(line.costCenterCode),
        profitCenterCode: trim(line.profitCenterCode),
        departmentCode: trim(line.departmentCode),
        detailCode: trim(line.detailCode),
      }
    : {
        accountCode: line.accountCode,
        debit: 0n,
        credit: -net,
        costCenterCode: trim(line.costCenterCode),
        profitCenterCode: trim(line.profitCenterCode),
        departmentCode: trim(line.departmentCode),
        detailCode: trim(line.detailCode),
      };
}

export interface NormalizedVoucher {
  remoteId: string;
  entryDate: string;
  memo: string | null;
  lines: NormalizedLine[];
  balanced: boolean;
  difference: bigint;
}

export function normalizeVoucher(voucher: HolooVoucher): NormalizedVoucher {
  if (!voucher.remoteId || voucher.remoteId.trim() !== voucher.remoteId) throw new Error("invalid_holoo_remote_id");
  assertJournalDate(voucher.entryDate);
  if (!Array.isArray(voucher.lines)) throw new Error("invalid_holoo_journal_lines");
  const lines = voucher.lines.map(normalizeLine);
  let totalDebit = 0n;
  let totalCredit = 0n;
  for (const line of lines) {
    totalDebit += line.debit;
    totalCredit += line.credit;
  }
  return {
    remoteId: voucher.remoteId,
    entryDate: voucher.entryDate,
    memo: voucher.memo ?? null,
    lines,
    balanced: totalDebit === totalCredit,
    difference: totalDebit - totalCredit,
  };
}

export interface JournalImportPlan {
  balanced: NormalizedVoucher[];
  unbalanced: NormalizedVoucher[];
}

/** Split vouchers into balanced (importable) and unbalanced (discrepancy). */
export function planJournalImport(vouchers: HolooVoucher[]): JournalImportPlan {
  const balanced: NormalizedVoucher[] = [];
  const unbalanced: NormalizedVoucher[] = [];
  const remoteIds = new Set<string>();
  for (const voucher of vouchers) {
    if (remoteIds.has(voucher.remoteId)) throw new Error("duplicate_holoo_remote_id:journal");
    remoteIds.add(voucher.remoteId);
    const normalized = normalizeVoucher(voucher);
    (normalized.balanced ? balanced : unbalanced).push(normalized);
  }
  return { balanced, unbalanced };
}
