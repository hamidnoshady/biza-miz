/**
 * Phase 26 (issue #125) Wave 5 — the pure planning half of accounting import.
 *
 * Holoo vouchers remain document-atomic: lines are normalized in exact Rial
 * arithmetic, and an unbalanced document is reported rather than plugged with
 * a synthetic adjustment. The plan is shared by migration preview and apply.
 */

export interface HolooVoucherLine {
  accountCode: string;
  debitRial?: bigint | number | string | null;
  creditRial?: bigint | number | string | null;
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

/** One netted line — debit XOR credit, both non-negative exact Rial. */
export interface NormalizedLine {
  accountCode: string;
  debit: bigint;
  credit: bigint;
}

/** Net a possibly-two-sided line to a single side without Number conversion. */
export function normalizeLine(line: HolooVoucherLine): NormalizedLine {
  if (!line.accountCode || line.accountCode.trim() !== line.accountCode) throw new Error("invalid_holoo_account_code");
  const debit = rialBigInt(line.debitRial);
  const credit = rialBigInt(line.creditRial);
  const net = debit - credit;
  if (net >= 0n) return { accountCode: line.accountCode, debit: net, credit: 0n };
  return { accountCode: line.accountCode, debit: 0n, credit: -net };
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
